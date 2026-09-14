import copy
import json
import shlex
import tempfile
from pathlib import Path

from backend.diffusioncontrol.config import PROJECT_ROOT, Settings
from backend.diffusioncontrol.service import Service
from backend.diffusioncontrol.store import Store
from backend.diffusioncontrol.slurm import SchedulerError, UncertainSubmission

PROFILE = {"id": "test-model", "version": 1, "commandPrefix": ["python3", "infer.py"], "parameters": [
    {"key": "output_dir", "flag": "--output_dir", "type": "path", "defaultValue": "outputs", "required": True},
    {"key": "seed", "flag": "--seed", "type": "integer", "defaultValue": "42"},
    {"key": "prompt", "flag": "--prompt", "type": "string", "defaultValue": ""},
    {"key": "enabled", "flag": "--enabled", "falseFlag": "--no-enabled", "type": "boolean", "defaultValue": "true"},
    {"key": "items", "flag": "--items", "type": "list", "nargs": "+", "defaultValue": '["a"]'},
]}
SCRIPT = '''#!/bin/bash
#SBATCH -p example
set -euo pipefail
source /registered/conda.sh
ENVNAME="base"
if [[ "${1:-}" == ENVNAME=* ]]; then
    ENVNAME="${1#ENVNAME=}"
    shift
fi
conda activate "$ENVNAME"
exec "$@"
'''


def request(request_id="request-1"):
    argv = ["python3", "infer.py", "--output_dir", "outputs", "--seed", "-9", "--prompt", "中文 O'Brien $literal ;", "--no-enabled", "--items", "a b", "c"]
    wrapped = ["sbatch", "job.gpu", "ENVNAME=base"] + argv
    return {"apiVersion": 2, "requestId": request_id, "createdAt": "2026-09-09T00:00:00.000Z", "projectId": "project-1",
            "projectName": "test", "projectProfileId": "config-1", "profileId": "test-model", "profileVersion": 1,
            "parameters": {"output_dir": "outputs", "seed": -9, "prompt": "中文 O'Brien $literal ;", "enabled": False, "items": ["a b", "c"]},
            "argv": argv, "command": shlex.join(argv),
            "execution": {"kind": "slurm_sbatch", "version": 1, "envName": "base", "scriptName": "job.gpu", "scriptContent": SCRIPT,
                          "argv": wrapped, "command": shlex.join(wrapped)}}


class FakeSlurm:
    def __init__(self):
        self.submissions, self.cancellations, self.records = [], [], {}
        self.uncertain, self.offline = False, False

    def submit_argv(self, job):
        return ["sbatch", "job.gpu", "ENVNAME=base"] + job["plan"]["argv"]

    def submit(self, job):
        self.submissions.append(job["id"])
        self.records[job["id"]] = [{"slurmId": "123", "cluster": None, "state": "PENDING", "detail": "Resources", "inQueue": True}]
        if self.uncertain:
            raise UncertainSubmission("timeout after acceptance")
        return "123", None

    def snapshot(self, jobs):
        if self.offline:
            raise SchedulerError("offline")
        return self.records

    def cancel(self, job):
        self.cancellations.append(job["slurmId"])

    def state(self, job_id, state, detail="0:0", in_queue=False):
        self.records[job_id] = [{"slurmId": "123", "cluster": None, "state": state, "detail": detail, "inQueue": in_queue}]


class Fixture:
    def __init__(self):
        parent = PROJECT_ROOT / "var" / "tests"
        parent.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=str(parent))
        self.root = Path(self.temporary.name)
        (self.root / "model").mkdir()
        (self.root / "model/infer.py").write_text("# Never executed by these tests\n")
        (self.root / "env/bin").mkdir(parents=True)
        (self.root / "env/bin/python").touch()
        (self.root / "profile.json").write_text(json.dumps(PROFILE))
        self.settings = Settings({"stateRoot": "var", "allowedReadRoots": [str(self.root)],
            "environments": {"base": str(self.root / "env")},
            "slurm": {name: "/usr/bin/" + name for name in ("sbatch", "squeue", "sacct", "scancel")},
            "models": [{"profile": "profile.json", "workdir": str(self.root / "model"), "adapter": "generic", "enabled": True,
                        "environmentNames": ["base"], "outputGlobs": ["*.mp4"]}]}, self.root)
        self.store = Store(self.settings.state, self.settings.projects)
        self.scheduler = FakeSlurm()
        self.service = Service(self.settings, self.store, self.scheduler)

    def close(self):
        self.store.close()
        self.temporary.cleanup()

    def submit(self, request_id="request-1"):
        return self.service.submit(request(request_id), request_id)

    def video(self, job):
        path = Path(job["plan"]["outputDirectory"]) / "video.mp4"
        path.write_bytes(b"\x00\x00\x00\x18ftypisom" + b"test-container" * 10)
        return path
