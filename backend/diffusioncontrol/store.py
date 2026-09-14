import fcntl
import json
import os
import sqlite3
import threading
import uuid
import hashlib
import re
from pathlib import Path

from .common import Problem, atomic_write, canonical, digest, now, identifier, regular_path

TERMINAL = {"succeeded", "failed", "cancelled"}


class Store:
    def __init__(self, root, projects_root=None):
        self.root = root
        self.projects_root = Path(projects_root) if projects_root is not None else root.parent / 'projects'
        regular_path(self.projects_root, self.projects_root)
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(str(root), 0o700)
        self.lock_file = (root / "service.lock").open("a+")
        try:
            fcntl.flock(self.lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.lock_file.close()
            raise RuntimeError("同一运行目录已有后端服务；只允许单进程启动")
        self.lock = threading.RLock()
        self.db = sqlite3.connect(str(root / "jobs.sqlite3"), timeout=10, check_same_thread=False)
        version = self.db.execute("PRAGMA user_version").fetchone()[0]
        if version not in (0, 1):
            self.db.close()
            self.lock_file.close()
            raise RuntimeError("不支持此作业数据库版本，拒绝自动降级")
        self.db.execute("PRAGMA journal_mode=DELETE")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("PRAGMA busy_timeout=10000")
        self.db.execute("CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL)")
        self.db.execute("PRAGMA user_version=1")
        self.db.commit()
        os.chmod(str(root / "jobs.sqlite3"), 0o600)

    def close(self):
        self.db.close()
        fcntl.flock(self.lock_file, fcntl.LOCK_UN)
        self.lock_file.close()

    def get(self, job_id):
        with self.lock:
            row = self.db.execute("SELECT body FROM jobs WHERE id=?", (job_id,)).fetchone()
        if not row:
            raise Problem("作业不存在", "job_not_found", 404)
        return json.loads(row[0])

    def replay(self, request):
        with self.lock:
            row = self.db.execute("SELECT request_hash,body FROM jobs WHERE request_id=?", (request.get("requestId"),)).fetchone()
        if not row:
            return None
        if row[0] != digest(request):
            raise Problem("同一 requestId 已用于另一份请求", "idempotency_conflict", 409)
        return json.loads(row[1])

    def active(self):
        with self.lock:
            rows = self.db.execute("SELECT body FROM jobs WHERE status NOT IN ('succeeded','failed','cancelled')").fetchall()
        return [json.loads(row[0]) for row in rows]

    def project_jobs(self, project_id, limit=100):
        with self.lock:
            rows = self.db.execute("SELECT body FROM jobs ORDER BY rowid DESC").fetchall()
        result = []
        for row in rows:
            job = json.loads(row[0])
            if job["request"].get("projectId") == project_id and job["plan"].get("adapter") == "workflow":
                result.append(job)
                if len(result) == limit:
                    break
        return result

    def project_directory(self, project_id):
        identifier(project_id, 'project.id')
        # '~' cannot collide with a normal ID directory, including IDs resembling hashes.
        name = project_id if re.fullmatch(r'[A-Za-z0-9_-]{1,200}', project_id) else '~'+hashlib.sha256(project_id.encode()).hexdigest()
        return regular_path(self.projects_root / name, self.projects_root)

    def note_project(self, project_id, name):
        directory = self.project_directory(project_id)
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        path = regular_path(directory / 'project-info.json', self.projects_root)
        atomic_write(path, canonical({'id': project_id, 'name': name, 'updatedAt': now()}))
        return directory

    def job_directory(self, project_id, job_id):
        if str(uuid.UUID(job_id)) != job_id:
            raise Problem('作业 ID 必须采用规范 UUID')
        return regular_path(self.project_directory(project_id) / 'jobs' / job_id, self.projects_root)

    def output_path(self, job, relative):
        directory = Path(job['plan']['outputDirectory'])
        allowed = (self.root / 'jobs' / job['id'] / 'outputs',
                   self.job_directory(job['request']['projectId'], job['id']) / 'outputs')
        if directory not in allowed:
            raise Problem('作业产物目录与项目归属不一致')
        root = self.root if directory == allowed[0] else self.projects_root
        return regular_path(directory / relative, root)

    def create(self, request, prepare):
        with self.lock:
            previous = self.replay(request)
            if previous:
                return previous
            if len(self.active()) >= 50:
                raise Problem("未结束作业已达 50 个，请先等待或处理现有作业", "active_job_limit", 429)
            job_id = str(uuid.uuid4())
            self.note_project(request['projectId'], request['projectName'])
            directory = self.job_directory(request['projectId'], job_id)
            (directory / "submission").mkdir(parents=True, mode=0o700)
            (directory / "outputs").mkdir(mode=0o700)
            plan = prepare(directory)
            script = directory / "submission" / request["execution"]["scriptName"]
            atomic_write(script, request["execution"]["scriptContent"])
            atomic_write(directory / "request.json", canonical(request))
            atomic_write(directory / "execution-plan.json", canonical(plan))
            for path in (script, directory / "request.json", directory / "execution-plan.json"):
                path.chmod(0o400)
            job = {"id": job_id, "requestId": request["requestId"], "request": request,
                   "status": "queued", "message": "已持久化，等待提交 Slurm", "phase": "prepared",
                   "createdAt": now(), "updatedAt": now(), "cancelRequested": False,
                   "slurmId": None, "cluster": None, "schedulerState": None,
                   "plan": plan, "outputs": [], "directory": str(directory)}
            with self.db:
                self.db.execute("INSERT INTO jobs VALUES (?,?,?,?,?)", (job_id, job["requestId"], digest(request), "queued", canonical(job)))
            return job

    def update(self, job_id, **patch):
        with self.lock:
            job = self.get(job_id)
            job.update(patch, updatedAt=now())
            with self.db:
                self.db.execute("UPDATE jobs SET status=?,body=? WHERE id=?", (job["status"], canonical(job), job_id))
            return job

    def cancel(self, job_id):
        with self.lock:
            job = self.get(job_id)
            if job["status"] in TERMINAL or job["cancelRequested"]:
                return job
            return self.update(job_id, cancelRequested=True, message="取消已请求，等待调度器确认")


def public_job(job):
    return {
        **{key: job[key] for key in ("id", "requestId", "status", "message", "createdAt", "updatedAt",
                                   "cancelRequested", "slurmId", "cluster", "schedulerState")},
        "submissionPhase": job["phase"], "outputDirectory": str(job["plan"]["outputDirectory"]),
        "actualArgv": job.get("submitArgv", []),
        **({"kind": job["request"]["kind"], "inputs": job["request"]["inputs"],
            "options": job["request"]["options"]} if job["plan"].get("adapter") == "workflow" else {}),
        "outputs": [{"name": output["name"], "url": "inference/jobs/{}/outputs/{}".format(job["id"], output["id"])}
                    for output in job["outputs"]],
    }
