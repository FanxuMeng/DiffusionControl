import hashlib
import logging
import threading
from pathlib import Path

from .adapter import check_input_evidence, collect_outputs, resolved_argv, validate_inputs, validate_script
from .common import Problem, atomic_write, canonical, identifier, now
from .slurm import RejectedSubmission, SchedulerError, UncertainSubmission
from .store import TERMINAL
from .validation import validate_request

LOG = logging.getLogger(__name__)
FAILURES = {"BOOT_FAIL", "DEADLINE", "FAILED", "NODE_FAIL", "OUT_OF_MEMORY", "PREEMPTED", "TIMEOUT", "REVOKED", "SPECIAL_EXIT"}


class Service:
    def __init__(self, settings, store, scheduler):
        self.settings, self.store, self.scheduler = settings, store, scheduler
        self.stop_event = threading.Event()
        self.thread = None

    def start(self):
        self.thread = threading.Thread(target=self.loop, daemon=True, name="slurm-coordinator")
        self.thread.start()

    def close(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join()  # Do not close SQLite while the coordinator can still write.

    def submit(self, raw, key):
        if not isinstance(raw, dict):
            raise Problem("请求必须为 JSON 对象")
        identifier(raw.get("requestId"), "requestId")
        if key != raw["requestId"]:
            raise Problem("Idempotency-Key 必须与 requestId 一致", "idempotency_key_mismatch", 400)
        previous = self.store.replay(raw)
        if previous:
            return previous
        model = self.settings.model(raw)
        request = validate_request(raw, key, model["profile"])
        validate_script(request["execution"]["scriptContent"], self.settings, request["execution"]["envName"])
        try:
            evidence = validate_inputs(model, request, self.settings)
        except (OSError, ValueError, KeyError) as error:
            raise Problem("模型输入检查失败：" + str(error)[:500], "input_invalid")

        def prepare(directory):
            return {"workdir": str(model["workdir"]), "argv": resolved_argv(model, request, directory / "outputs"),
                    "environmentPrefix": str(self.settings.environments[request["execution"]["envName"]]),
                    "outputDirectory": str(directory / "outputs"), "inputEvidence": evidence,
                    "scriptSha256": hashlib.sha256(request["execution"]["scriptContent"].encode()).hexdigest(),
                    "profile": model["profile"], "adapter": model["adapter"],
                    "outputGlobs": model.get("outputGlobs", ["generated_videos/*.mp4", "concat_videos/*.mp4"])}

        return self.store.create(request, prepare)

    def loop(self):
        while not self.stop_event.is_set():
            try:
                self.tick()
            except Exception:
                LOG.exception("作业协调失败；保留持久化状态，下周期继续")
            self.stop_event.wait(self.settings.poll_seconds)

    def tick(self):
        for job in self.store.active():
            if self.stop_event.is_set():
                return
            # Serialize cancellation against the transition BEFORE external submission.
            with self.store.lock:
                job = self.store.get(job["id"])
                if job["phase"] != "prepared":
                    continue
                if job["cancelRequested"]:
                    self.store.update(job["id"], status="cancelled", phase="terminal", message="已在提交前取消", finishedAt=now())
                    continue
                try:
                    check_input_evidence(job["plan"]["inputEvidence"], self.settings.read_roots)
                except (Problem, OSError) as error:
                    self.store.update(job["id"], status="failed", phase="terminal", message="提交前输入校验失败：" + str(error)[:1000], finishedAt=now())
                    continue
                self.store.update(job["id"], phase="submitting", submitArgv=self.scheduler.submit_argv(job), message="正在提交 Slurm")
            try:
                slurm_id, cluster = self.scheduler.submit(job)
                self.store.update(job["id"], slurmId=slurm_id, cluster=cluster, phase="submitted", message="Slurm 已接收，等待资源")
            except UncertainSubmission as error:
                self.store.update(job["id"], phase="uncertain", message="提交结果待确认；不会重复提交：" + str(error)[:1000])
            except RejectedSubmission as error:
                self.store.update(job["id"], status="failed", phase="terminal", message="Slurm 明确拒绝提交：" + str(error)[:1000], finishedAt=now())
        active = self.store.active()
        if not active:
            return
        # A broken accounting query must not prevent cancellation of a known job.
        for job in active:
            if job["cancelRequested"] and job["slurmId"]:
                try:
                    self.scheduler.cancel(job)
                    self.store.update(job["id"], message="已请求取消，等待 Slurm 确认")
                except SchedulerError as error:
                    self.store.update(job["id"], message="取消尚未确认，将继续重试：" + str(error)[:800])
        try:
            snapshot = self.scheduler.snapshot(active)
        except SchedulerError as error:
            for job in active:
                self.store.update(job["id"], message="调度状态待确认：" + str(error)[:1000])
            return
        for previous in active:
            job = self.store.get(previous["id"])
            matches = snapshot.get(job["id"], [])
            if job["slurmId"]:
                matches = [record for record in matches if record["slurmId"] == job["slurmId"]]
            if len(matches) != 1:
                self.store.update(job["id"], message="调度记录尚未出现或匹配不唯一，继续对账；不会重复提交")
                continue
            record = matches[0]
            job = self.store.update(job["id"], slurmId=record["slurmId"], cluster=record["cluster"],
                                    phase="submitted", schedulerState=record["state"])
            state = record["state"]
            if state == "CANCELLED":
                self.store.update(job["id"], status="cancelled", phase="terminal", message="Slurm 已确认取消", finishedAt=now())
            elif state in FAILURES:
                self.store.update(job["id"], status="failed", phase="terminal", message="Slurm 终态：" + state + " " + record["detail"], finishedAt=now())
            elif state == "COMPLETED" and not record["inQueue"]:
                self.finish(job, record)
            else:
                running = state in ("RUNNING", "COMPLETING", "SUSPENDED", "STAGE_OUT", "SIGNALING")
                self.store.update(job["id"], status="running" if running else "queued", message="Slurm：" + state + " " + record["detail"][:500])
                if job["cancelRequested"]:
                    self.store.update(job["id"], message="取消已请求，等待 Slurm 确认")

    def finish(self, job, record):
        if record["detail"] != "0:0":
            self.store.update(job["id"], status="failed", phase="terminal", message="作业非零退出：" + record["detail"], finishedAt=now())
            return
        try:
            check_input_evidence(job["plan"]["inputEvidence"], self.settings.read_roots)
            outputs = collect_outputs(Path(job["plan"]["outputDirectory"]), job["plan"])
            atomic_write(Path(job["directory"]) / "outputs.json", canonical(outputs))
        except (Problem, OSError) as error:
            self.store.update(job["id"], status="failed", phase="terminal", message="产物检查失败：" + str(error)[:1000], finishedAt=now())
            return
        message = "推理退出成功，产物通过文件完整性检查"
        if job["cancelRequested"]:
            message += "；完成早于取消确认，结果仅保留为历史产物"
        self.store.update(job["id"], status="succeeded", phase="terminal", outputs=outputs, message=message, finishedAt=now())
