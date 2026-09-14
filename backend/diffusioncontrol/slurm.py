import os
import re
import subprocess
from datetime import datetime, timedelta
from pathlib import Path

from .adapter import clean_environment


class SchedulerError(Exception):
    pass


class UncertainSubmission(SchedulerError):
    pass


class RejectedSubmission(SchedulerError):
    pass


class Slurm:
    def __init__(self, settings):
        self.settings = settings

    def run(self, name, args):
        try:
            result = subprocess.run([self.settings.slurm[name]] + args, stdin=subprocess.DEVNULL,
                                    capture_output=True, text=True, timeout=self.settings.command_timeout,
                                    cwd=str(self.settings.root), env=clean_environment())
        except (subprocess.TimeoutExpired, OSError) as error:
            raise SchedulerError(type(error).__name__ + ": " + str(error)[:500])
        if result.returncode:
            if name == "sbatch" and not result.stdout.strip() and "Batch job submission failed:" in result.stderr:
                raise RejectedSubmission(result.stderr[-1500:])
            raise SchedulerError((result.stderr or result.stdout or "Slurm command failed")[-1500:])
        return result.stdout

    def submit_argv(self, job):
        directory = Path(job["directory"])
        return [self.settings.slurm["sbatch"], "--parsable", "--no-requeue",
                "--job-name=dc-" + job["id"], "--comment=dc-" + job["id"],
                "--chdir=" + job["plan"]["workdir"], "--output=" + str(directory / "stdout.log"),
                "--error=" + str(directory / "stderr.log"),
                str(directory / "submission" / job["request"]["execution"]["scriptName"]),
                "ENVNAME=" + job["plan"].get("environmentPrefix", job["request"]["execution"]["envName"])] + job["plan"]["argv"]

    def submit(self, job):
        try:
            output = self.run("sbatch", self.submit_argv(job)[1:]).strip()
        except RejectedSubmission:
            raise
        except SchedulerError as error:
            # Conservatively reconcile all failures; never retry sbatch blindly.
            raise UncertainSubmission(str(error))
        match = re.fullmatch(r"([1-9][0-9]*)(?:;([A-Za-z0-9_.-]+))?", output)
        if not match:
            raise UncertainSubmission("sbatch 返回无法解析，需与调度器对账")
        return match.group(1), match.group(2)

    def cancel(self, job):
        args = ["--clusters=" + job["cluster"]] if job.get("cluster") else []
        self.run("scancel", args + [job["slurmId"]])

    def snapshot(self, jobs):
        """One squeue + one sacct per cluster per cycle, including missing-ID jobs."""
        groups, records = {}, {}
        for job in jobs:
            groups.setdefault(job.get("cluster"), []).append(job)
        for cluster, group in groups.items():
            option = ["--clusters=" + cluster] if cluster else []
            tags = {"dc-" + job["id"] for job in group}
            since = min(datetime.fromisoformat(job["createdAt"]) for job in group) - timedelta(days=1)
            queued = self.run("squeue", option + ["--user=" + str(os.getuid()), "--noheader", "--format=%i|%100j|%T|%R"])
            accounting = self.run("sacct", option + ["--user=" + str(os.getuid()), "--starttime=" + since.strftime("%Y-%m-%dT00:00:00"),
                                   "--name=" + ",".join(sorted(tags)), "--allocations", "--noheader", "--parsable2",
                                   "--format=JobIDRaw,JobName%100,State%40,ExitCode"])
            # Queue facts override older accounting records during completion.
            found = {}
            for text, in_queue in ((accounting, False), (queued, True)):
                for line in text.splitlines():
                    parts = [part.strip() for part in line.split("|")]
                    if len(parts) < 4:
                        continue
                    slurm_id, tag, state, detail = parts[:4]
                    if tag not in tags or not re.fullmatch(r"[1-9][0-9]*", slurm_id):
                        continue
                    state = state.split(" ", 1)[0].rstrip("+")
                    found[(tag, slurm_id)] = {"slurmId": slurm_id, "state": state, "detail": detail,
                                            "inQueue": in_queue, "cluster": cluster}
            for (tag, _), record in found.items():
                records.setdefault(tag[3:], []).append(record)
        return records
