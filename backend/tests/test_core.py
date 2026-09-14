import copy
import json
import os
import shlex
import subprocess
import sys
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from backend.diffusioncontrol.adapter import collect_outputs, validate_script
from backend.diffusioncontrol.common import Problem, within
from backend.diffusioncontrol.config import PROJECT_ROOT
from backend.diffusioncontrol.service import Service
from backend.diffusioncontrol.slurm import RejectedSubmission, Slurm, UncertainSubmission
from backend.diffusioncontrol.store import Store, public_job
from backend.diffusioncontrol.validation import parse_parameters, tokenize, validate_request
from .support import Fixture, PROFILE, SCRIPT, request


class RequestTests(unittest.TestCase):
    def test_full_command_roundtrip(self):
        raw = request()
        self.assertEqual(validate_request(raw, "request-1", PROFILE), raw)
        self.assertEqual(tokenize(raw["command"]), raw["argv"])

    def test_grammar_rejects_shell_and_preserves_quoted_literals(self):
        for command in ("python a; rm x", "python $HOME", 'python "$(cmd)"', "python a\npython b", "python 'unclosed"):
            with self.subTest(command=command), self.assertRaises(Problem):
                tokenize(command)
        self.assertEqual(tokenize("python 'a; $HOME' ''"), ["python", "a; $HOME", ""])

    def test_typed_parameters_cannot_disagree(self):
        for key, value in (("seed", True), ("enabled", 0), ("items", "a"), ("seed", -8)):
            raw = request()
            raw["parameters"][key] = value
            with self.subTest(key=key), self.assertRaises(Problem):
                validate_request(raw, raw["requestId"], PROFILE)

    def test_defaults_equals_and_required_flags(self):
        result = parse_parameters(PROFILE, ["python3", "infer.py", "--output_dir=x"])
        self.assertEqual(result["seed"], 42)
        self.assertTrue(result["enabled"])
        self.assertEqual(result["prompt"], "")
        for argv in (["python3", "infer.py"], ["python3", "infer.py", "--output_dir", "x", "--seed", "1", "--seed", "2"]):
            with self.assertRaises(Problem):
                parse_parameters(PROFILE, argv)

    def test_v1_bad_envelope_and_bad_idempotency_rejected(self):
        mutations = [lambda r: r.update(apiVersion=1), lambda r: r["execution"].update(scriptName="../request.json"),
                     lambda r: r["execution"].update(argv=["sbatch", "wrong"]), lambda r: r.update(createdAt="no-date")]
        for mutation in mutations:
            raw = request()
            mutation(raw)
            with self.assertRaises(Problem):
                validate_request(raw, raw["requestId"], PROFILE)
        with self.assertRaises(Problem) as caught:
            validate_request(request(), "wrong", PROFILE)
        self.assertEqual(caught.exception.status, 400)

    def test_frontend_contract_fixture(self):
        path = PROJECT_ROOT / "var/frontend-contract-request.json"
        if not path.exists():
            self.skipTest("Run frontend backendContract.test.ts first")
        profile = json.loads((PROJECT_ROOT / "backend/profiles/symphomotion-single-gpu.json").read_text())
        raw = json.loads(path.read_text())
        self.assertEqual(validate_request(raw, raw["requestId"], profile), raw)
        sharded = json.loads((PROJECT_ROOT / "var/frontend-contract-sharded-request.json").read_text())
        sharded_profile = json.loads((PROJECT_ROOT / "backend/profiles/symphomotion-multi-gpu.json").read_text())
        self.assertEqual(validate_request(sharded, sharded["requestId"], sharded_profile), sharded)


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.fixture = Fixture()
        self.addCleanup(self.fixture.close)
        self.store, self.service, self.scheduler = self.fixture.store, self.fixture.service, self.fixture.scheduler

    def test_concurrent_idempotency_submits_once(self):
        with ThreadPoolExecutor(max_workers=6) as pool:
            jobs = list(pool.map(lambda _: self.fixture.submit(), range(12)))
        self.assertEqual(len({job["id"] for job in jobs}), 1)
        self.service.tick()
        self.service.tick()
        self.assertEqual(len(self.scheduler.submissions), 1)

    def test_conflicting_content_and_disabled_replay(self):
        original = self.fixture.submit()
        changed = request()
        changed["projectName"] = "changed"
        with self.assertRaises(Problem) as caught:
            self.service.submit(changed, changed["requestId"])
        self.assertEqual(caught.exception.status, 409)
        self.fixture.settings.models[("test-model", 1)]["enabled"] = False
        self.assertEqual(self.fixture.submit()["id"], original["id"])

    def test_invalid_request_does_not_create_job(self):
        raw = request()
        raw["parameters"]["seed"] = 99
        with self.assertRaises(Problem):
            self.service.submit(raw, raw["requestId"])
        self.assertEqual(self.store.active(), [])
        self.assertEqual(self.scheduler.submissions, [])

    def test_snapshot_failure_never_submits(self):
        with patch("backend.diffusioncontrol.store.atomic_write", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                self.fixture.submit()
        self.service.tick()
        self.assertEqual(self.scheduler.submissions, [])

    def test_snapshot_and_output_isolation(self):
        first, second = self.fixture.submit(), self.fixture.submit("request-2")
        self.assertNotEqual(first["plan"]["outputDirectory"], second["plan"]["outputDirectory"])
        self.assertEqual(first["request"]["parameters"]["output_dir"], "outputs")
        self.assertIn(first["plan"]["outputDirectory"], first["plan"]["argv"])
        path = Path(first["directory"])
        self.assertEqual(json.loads((path / "request.json").read_text()), request())
        self.assertEqual((path / "submission/job.gpu").read_text(), SCRIPT)

    def test_script_name_cannot_overwrite_metadata(self):
        raw = request()
        raw["execution"]["scriptName"] = "request.json"
        raw["execution"]["argv"][1] = "request.json"
        raw["execution"]["command"] = shlex.join(raw["execution"]["argv"])
        job = self.service.submit(raw, raw["requestId"])
        self.assertEqual(json.loads((Path(job["directory"]) / "request.json").read_text()), raw)

    def test_timeout_reconciles_without_duplicate(self):
        self.scheduler.uncertain = True
        job = self.fixture.submit()
        self.service.tick()
        self.assertEqual(self.store.get(job["id"])["slurmId"], "123")
        self.service.tick()
        self.assertEqual(len(self.scheduler.submissions), 1)

    def test_restart_recovers_submission_window(self):
        job = self.fixture.submit()
        self.store.update(job["id"], phase="submitting")
        self.scheduler.state(job["id"], "RUNNING", "node", True)
        self.store.close()
        self.store = self.fixture.store = Store(self.fixture.settings.state)
        self.service = Service(self.fixture.settings, self.store, self.scheduler)
        self.service.tick()
        self.assertEqual(self.store.get(job["id"])["status"], "running")
        self.assertEqual(self.scheduler.submissions, [])

    def test_uncertain_missing_and_offline_do_not_finish_or_resubmit(self):
        job = self.fixture.submit()
        self.store.update(job["id"], phase="uncertain")
        self.service.tick()
        self.scheduler.offline = True
        self.service.tick()
        self.assertEqual(self.store.get(job["id"])["status"], "queued")
        self.assertEqual(self.scheduler.submissions, [])

    def test_cancel_before_submission(self):
        job = self.fixture.submit()
        self.store.cancel(job["id"])
        self.service.tick()
        self.assertEqual(self.store.get(job["id"])["status"], "cancelled")
        self.assertEqual(self.scheduler.submissions, [])

    def test_cancel_is_sent_even_when_accounting_is_offline(self):
        job = self.fixture.submit()
        self.service.tick()
        self.store.cancel(job["id"])
        self.scheduler.offline = True
        self.service.tick()
        self.assertEqual(self.scheduler.cancellations, ["123"])
        self.assertNotEqual(self.store.get(job["id"])["status"], "cancelled")

    def test_changed_input_is_detected_before_submission(self):
        job = self.fixture.submit()
        path = self.fixture.root / "model/infer.py"
        stat = path.stat()
        plan = job["plan"]
        plan["inputEvidence"] = [{"path": str(path), "size": stat.st_size, "mtimeNs": stat.st_mtime_ns, "field": "entrypoint"}]
        self.store.update(job["id"], plan=plan)
        path.write_text("changed input")
        self.service.tick()
        self.assertEqual(self.store.get(job["id"])["status"], "failed")
        self.assertEqual(self.scheduler.submissions, [])

    def test_cancel_waits_for_scheduler_and_handles_completion_race(self):
        job = self.fixture.submit()
        self.service.tick()
        self.store.cancel(job["id"])
        self.service.tick()
        self.assertEqual(self.scheduler.cancellations, ["123"])
        self.assertEqual(self.store.get(job["id"])["status"], "queued")
        self.fixture.video(job)
        self.scheduler.state(job["id"], "COMPLETED")
        self.service.tick()
        finished = self.store.get(job["id"])
        self.assertEqual(finished["status"], "succeeded")
        self.assertTrue(finished["cancelRequested"])
        self.assertIn("历史", finished["message"])

    def test_queue_completed_is_not_success_before_accounting(self):
        job = self.fixture.submit()
        self.service.tick()
        self.scheduler.state(job["id"], "COMPLETED", in_queue=True)
        self.service.tick()
        self.assertNotEqual(self.store.get(job["id"])["status"], "succeeded")

    def test_completed_without_outputs_fails(self):
        job = self.fixture.submit()
        self.service.tick()
        self.scheduler.state(job["id"], "COMPLETED")
        self.service.tick()
        self.assertEqual(self.store.get(job["id"])["status"], "failed")

    def test_nonzero_and_scheduler_failures(self):
        for index, state in enumerate(("OUT_OF_MEMORY", "TIMEOUT", "COMPLETED", "CANCELLED")):
            job = self.fixture.submit("request-" + str(index))
            self.service.tick()
            self.scheduler.state(job["id"], state, "1:0")
            self.service.tick()
            self.assertEqual(self.store.get(job["id"])["status"], "cancelled" if state == "CANCELLED" else "failed")

    def test_result_manifest_and_job_compatible_response(self):
        job = self.fixture.submit()
        self.service.tick()
        self.fixture.video(job)
        self.scheduler.state(job["id"], "COMPLETED")
        self.service.tick()
        job = self.store.get(job["id"])
        self.assertEqual(len(job["outputs"][0]["sha256"]), 64)
        self.assertTrue((Path(job["directory"]) / "outputs.json").is_file())
        public = public_job(job)
        self.assertNotIn("request", public)
        self.assertTrue(public["outputs"][0]["url"].startswith("inference/jobs/"))

    def test_path_and_symlink_rejection(self):
        job = self.fixture.submit()
        directory = Path(job["plan"]["outputDirectory"])
        (self.fixture.root / "outside.mp4").write_bytes(b"outside")
        (directory / "escape.mp4").symlink_to(self.fixture.root / "outside.mp4")
        with self.assertRaises(Problem):
            collect_outputs(directory, job["plan"])
        with self.assertRaises(Problem):
            within(directory / "../../../../../not-allowed", [directory])

    def test_cross_process_single_service_lock(self):
        command = "from pathlib import Path; from backend.diffusioncontrol.store import Store; Store(Path(%r))" % str(self.fixture.settings.state)
        result = subprocess.run([sys.executable, "-c", command], cwd=str(PROJECT_ROOT), capture_output=True, text=True,
                                env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("只允许单进程", result.stderr)

    def test_script_syntax_is_checked_without_execution(self):
        marker = self.fixture.root / "must-not-exist"
        script = SCRIPT.replace("set -euo pipefail", "set -euo pipefail\ntouch " + shlex.quote(str(marker)))
        validate_script(script, self.fixture.settings, "base")
        self.assertFalse(marker.exists())
        for bad in (SCRIPT.replace("exec", "if exec"), SCRIPT.replace("set -euo pipefail", "conda init bash")):
            with self.assertRaises(Problem):
                validate_script(bad, self.fixture.settings, "base")

    def test_slurm_argv_and_cluster_response(self):
        job = self.fixture.submit()
        slurm = Slurm(self.fixture.settings)
        argv = slurm.submit_argv(job)
        self.assertIn("--chdir=" + str(self.fixture.root / "model"), argv)
        self.assertIn("--no-requeue", argv)
        with patch.object(slurm, "run", return_value="123;cluster-a\n"):
            self.assertEqual(slurm.submit(job), ("123", "cluster-a"))
        with patch.object(slurm, "run", return_value="accepted maybe"):
            with self.assertRaises(UncertainSubmission):
                slurm.submit(job)

    def test_definite_scheduler_rejection_keeps_terminal_job(self):
        job = self.fixture.submit()
        with patch.object(self.scheduler, "submit", side_effect=RejectedSubmission("Invalid partition")):
            self.service.tick()
        self.assertEqual(self.store.get(job["id"])["status"], "failed")
        self.assertEqual(self.fixture.submit()["id"], job["id"])

    def test_sbatch_explicit_rejection_is_distinct_from_timeout(self):
        slurm = Slurm(self.fixture.settings)
        job = self.fixture.submit()
        result = subprocess.CompletedProcess([], 1, stdout="", stderr="sbatch: error: Batch job submission failed: Invalid partition")
        with patch("backend.diffusioncontrol.slurm.subprocess.run", return_value=result):
            with self.assertRaises(RejectedSubmission):
                slurm.submit(job)

    def test_accounting_ignores_steps_and_queue_wins(self):
        job = self.fixture.submit()
        slurm = Slurm(self.fixture.settings)
        tag = "dc-" + job["id"]
        queue = "123|%s|COMPLETING|node\n" % tag
        accounting = "123.batch|%s|FAILED|1:0\n123|%s|COMPLETED|0:0\n" % (tag, tag)
        with patch.object(slurm, "run", side_effect=[queue, accounting]):
            snapshot = slurm.snapshot([job])
        self.assertEqual(len(snapshot[job["id"]]), 1)
        self.assertEqual(snapshot[job["id"]][0]["state"], "COMPLETING")


if __name__ == "__main__":
    unittest.main()
