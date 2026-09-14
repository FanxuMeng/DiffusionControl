import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import time
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from starlette.exceptions import HTTPException
from starlette.concurrency import run_in_threadpool

from .common import Problem, atomic_write, within
from .config import Settings
from .service import Service
from .slurm import Slurm
from .store import Store, public_job
from .workflow import Workflow
from .projects import Projects

COOKIE = "diffusioncontrol_session"
LOG = logging.getLogger(__name__)


def problem_response(problem):
    body = {"code": problem.code, "message": problem.message, "retryable": problem.status >= 500}
    if problem.field:
        body["field"] = problem.field
    return JSONResponse(body, status_code=problem.status)


class Session:
    def __init__(self, root):
        path = root / "access-token"
        if path.is_symlink():
            raise RuntimeError("access-token 不允许符号链接")
        if not path.exists():
            atomic_write(path, secrets.token_urlsafe(32) + "\n")
        path.chmod(0o600)
        self.token = path.read_text().strip()
        if len(self.token) < 32:
            raise RuntimeError("访问令牌过短")

    def issue(self):
        stamp = str(int(time.time()))
        signature = hmac.new(self.token.encode(), stamp.encode(), hashlib.sha256).hexdigest()
        return stamp + "." + signature

    def valid(self, value):
        try:
            stamp, signature = value.split(".", 1)
            age = time.time() - int(stamp)
            expected = hmac.new(self.token.encode(), stamp.encode(), hashlib.sha256).hexdigest()
            return 0 <= age < 8 * 3600 and hmac.compare_digest(signature, expected)
        except (ValueError, AttributeError):
            return False


class Boundary:
    """Host/origin/session gate and bounded JSON bodies before route parsing."""
    def __init__(self, app, owner, allowed_hosts):
        self.app, self.owner, self.allowed_hosts = app, owner, allowed_hosts

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        request = Request(scope)

        async def deny(problem):
            await problem_response(problem)(scope, receive, send)

        host = request.headers.get("host", "")
        if not re.fullmatch(r"[A-Za-z0-9._-]+(?::[0-9]{1,5})?", host) or host.split(":", 1)[0].lower() not in self.allowed_hosts:
            return await deny(Problem("访问域名未在 allowedHosts 中配置", "host_forbidden", 403))
        origin = request.headers.get("origin")
        if origin:
            parsed = urlsplit(origin)
            if parsed.scheme not in ("http", "https") or parsed.netloc != host or parsed.path or parsed.query or parsed.fragment:
                return await deny(Problem("请求来源不匹配", "origin_forbidden", 403))
        if request.headers.get("sec-fetch-site") in ("cross-site", "same-site") and not origin:
            return await deny(Problem("请从当前站点访问", "origin_forbidden", 403))
        byte_range = request.headers.get("range")
        if byte_range and (len(byte_range) > 100 or not re.fullmatch(r"bytes=(?:[0-9]{1,20}-[0-9]{0,20}|-[0-9]{1,20})", byte_range)):
            return await deny(Problem("仅支持单个字节范围", "range_invalid", 416))
        public = request.url.path in ("/login", "/api/session", "/api/health")
        if not public and not self.owner.state.session.valid(request.cookies.get(COOKIE)):
            if request.url.path.startswith("/api/"):
                return await deny(Problem("请先在 /login 输入访问令牌", "authentication_required", 401))
            return await RedirectResponse("/login", status_code=303)(scope, receive, send)
        if request.method in ("POST", "PUT", "PATCH"):
            if request.headers.get("content-type", "").split(";", 1)[0].strip() != "application/json":
                return await deny(Problem("请求必须使用 application/json", "content_type_invalid", 400))
            chunks, size = [], 0
            while True:
                message = await receive()
                if message["type"] == "http.disconnect":
                    return
                chunk = message.get("body", b"")
                size += len(chunk)
                maximum = (64 * 1024 * 1024 if request.url.path.startswith('/api/projects') else
                           46 * 1024 * 1024 if request.url.path == "/api/workflow/assets" else 1024 * 1024)
                if size > maximum:
                    return await deny(Problem("请求超过此接口的大小限制", "request_too_large", 413))
                chunks.append(chunk)
                if not message.get("more_body"):
                    break
            delivered = False

            async def buffered():
                nonlocal delivered
                if delivered:
                    return await receive()
                delivered = True
                return {"type": "http.request", "body": b"".join(chunks), "more_body": False}

            return await self.app(scope, buffered, send)
        return await self.app(scope, receive, send)


async def json_body(request):
    try:
        # Duplicate keys and NaN must not create ambiguous immutable snapshots.
        def pairs(items):
            result = {}
            for key, value in items:
                if key in result:
                    raise ValueError("JSON 属性重复")
                result[key] = value
            return result

        def bad_constant(value):
            raise ValueError("JSON 不允许非有限数值")

        raw = json.loads(await request.body(), object_pairs_hook=pairs, parse_constant=bad_constant)
        json.dumps(raw, allow_nan=False)
        return raw
    except (ValueError, UnicodeDecodeError):
        raise Problem("请求不是无歧义的有效 JSON", "json_invalid", 400)


LOGIN_HTML = """<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>DiffusionControl 登录</title>
<style>body{font:16px system-ui;background:#f5f6f8;color:#263244;max-width:460px;margin:12vh auto;padding:24px}input,button{box-sizing:border-box;width:100%;padding:12px;margin:10px 0}button{background:#284f79;color:white;border:0;border-radius:6px}p{line-height:1.7}#message{color:#ac263b}</style>
<h1>DiffusionControl</h1><p>输入当前服务的访问令牌。令牌位于登录节点项目目录中的 <code>var/access-token</code>。</p>
<form id="form"><label for="token">访问令牌</label><input id="token" type="password" autocomplete="current-password" required><button>进入工作区</button></form><p id="message" role="status"></p>
<script>document.querySelector('#form').onsubmit=async e=>{e.preventDefault();try{const r=await fetch('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:document.querySelector('#token').value.trim()})});const b=await r.json();if(!r.ok)throw new Error(b.message);location.replace('/')}catch(e){document.querySelector('#message').textContent=e.message}};</script></html>"""


def create_app(settings=None, scheduler=None, start_worker=True):
    settings = settings or Settings.load()

    @asynccontextmanager
    async def lifespan(app):
        store = Store(settings.state, settings.projects)
        try:
            atomic_write(settings.state / "backend.pid", str(os.getpid()) + "\n")
            app.state.store = store
            app.state.session = Session(settings.state)
            service = Service(settings, store, scheduler or Slurm(settings))
            app.state.service = service
            app.state.workflow = Workflow(settings, store)
            app.state.projects = Projects(settings, store, app.state.workflow)
            if start_worker:
                service.start()
            try:
                yield
            finally:
                await run_in_threadpool(app.state.projects.close)
                await run_in_threadpool(service.close)
        finally:
            store.close()

    app = FastAPI(title="DiffusionControl CE API", version="2.0", lifespan=lifespan,
                  docs_url=None, redoc_url=None, openapi_url="/api/openapi.json")
    app.add_middleware(Boundary, owner=app, allowed_hosts={host.lower() for host in settings.allowed_hosts})

    @app.exception_handler(Problem)
    async def handle_problem(request, error):
        return problem_response(error)

    @app.exception_handler(RequestValidationError)
    async def handle_validation(request, error):
        return problem_response(Problem("HTTP 参数格式无效"))

    @app.exception_handler(HTTPException)
    async def handle_http(request, error):
        return problem_response(Problem(str(error.detail), "http_error", error.status_code))

    @app.exception_handler(Exception)
    async def handle_internal(request, error):
        LOG.exception("API request failed", exc_info=error)
        return problem_response(Problem("服务内部错误；提交请以原 requestId 重试查询", "internal_error", 500))

    @app.get("/api/health")
    def health():
        return {"status": "ok", "apiVersion": 2}

    @app.get("/login", response_class=HTMLResponse)
    def login():
        return HTMLResponse(LOGIN_HTML, headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"})

    @app.post("/api/session")
    async def session(request: Request):
        raw = await json_body(request)
        token = raw.get("token") if isinstance(raw, dict) else None
        if not isinstance(token, str) or not hmac.compare_digest(token, app.state.session.token):
            raise Problem("访问令牌无效", "authentication_failed", 401)
        response = JSONResponse({"status": "ok"}, headers={"Cache-Control": "no-store"})
        response.set_cookie(COOKIE, app.state.session.issue(), httponly=True, samesite="strict", max_age=8 * 3600, path="/")
        return response

    @app.get("/api/inference/capabilities")
    def capabilities():
        return settings.capabilities()

    @app.get("/api/settings/execution")
    def execution_settings():
        return app.state.workflow.global_execution()

    @app.put("/api/settings/execution")
    async def save_execution(request: Request):
        return await run_in_threadpool(app.state.workflow.save_execution, await json_body(request))

    @app.get("/api/workflow/capabilities")
    def workflow_capabilities():
        return app.state.workflow.capabilities()

    @app.post("/api/workflow/assets", status_code=201)
    async def upload_asset(request: Request):
        return await run_in_threadpool(app.state.workflow.upload, await json_body(request))

    @app.get("/api/workflow/assets/{asset_id}/image")
    def reference_image(asset_id: str):
        metadata, path = app.state.workflow.asset(asset_id)
        return FileResponse(path, media_type="image/png", headers={"Cache-Control": "private, max-age=3600",
                                                                  "ETag": '"' + metadata["sha256"] + '"'})

    @app.post("/api/workflow/jobs", status_code=202)
    async def submit_workflow(request: Request):
        result = await run_in_threadpool(app.state.workflow.submit, await json_body(request), request.headers.get("idempotency-key"))
        return public_job(result)

    @app.get("/api/workflow/projects/{project_id}/jobs")
    def workflow_jobs(project_id: str):
        return {"jobs": [public_job(item) for item in app.state.store.project_jobs(project_id)]}

    @app.post("/api/inference/jobs", status_code=202)
    async def submit(request: Request):
        raw = await json_body(request)
        job = await run_in_threadpool(app.state.service.submit, raw, request.headers.get("idempotency-key"))
        return public_job(job)

    @app.get("/api/inference/jobs/{job_id}")
    def job(job_id: str):
        return public_job(app.state.store.get(job_id))

    @app.post("/api/inference/jobs/{job_id}/cancel")
    def cancel(job_id: str):
        return public_job(app.state.store.cancel(job_id))

    @app.get("/api/inference/jobs/{job_id}/logs")
    def logs(job_id: str):
        job = app.state.store.get(job_id)
        directory, result = Path(job["directory"]), {}
        for name in ("stdout.log", "stderr.log"):
            path = directory / name
            within(path, [directory.resolve()])
            if path.is_symlink():
                raise Problem("日志不允许符号链接", "log_invalid", 409)
            if not path.is_file():
                result[name] = {"text": "", "available": False}
                continue
            with path.open("rb") as stream:
                size = os.fstat(stream.fileno()).st_size
                stream.seek(max(0, size - 65536))
                result[name] = {"text": stream.read(65536).decode("utf-8", errors="replace"),
                                "available": True, "truncated": size > 65536}
        return JSONResponse(result, headers={"Cache-Control": "no-store"})

    @app.get("/api/inference/jobs/{job_id}/outputs/{output_id}")
    def output(job_id: str, output_id: str):
        job = app.state.store.get(job_id)
        entry = next((item for item in job["outputs"] if item["id"] == output_id), None)
        if not entry or job["status"] != "succeeded":
            raise Problem("产物不存在或未发布", "output_not_found", 404)
        path = app.state.store.output_path(job, entry['relativePath'])
        stat = path.stat() if path.is_file() else None
        if not stat or stat.st_size != entry["size"] or stat.st_mtime_ns != entry["mtimeNs"] or stat.st_ino != entry["inode"]:
            raise Problem("已发布产物发生变化或不可用", "output_changed", 409)
        return FileResponse(path, filename=path.name, headers={"ETag": '"' + entry["sha256"] + '"', "Cache-Control": "private, no-cache"})

    @app.get('/api/projects')
    def projects_list():
        return app.state.projects.listing()

    async def project_body(request):
        raw = await json_body(request)
        if not isinstance(raw, dict):
            raise Problem('项目接口请求须为 JSON 对象')
        return raw

    @app.post('/api/projects/save')
    async def projects_save(request: Request):
        raw = await project_body(request)
        return await run_in_threadpool(app.state.projects.save, raw.get('project'), raw.get('revision'))

    @app.get('/api/projects/snapshots/{key}')
    def projects_open(key: str):
        return app.state.projects.snapshot(key)

    @app.post('/api/projects/snapshots/{key}/delete')
    async def projects_delete(key: str, request: Request):
        raw = await project_body(request)
        return await run_in_threadpool(app.state.projects.delete, key, raw.get('revision'))

    @app.post('/api/projects/export', status_code=202)
    async def projects_export(request: Request):
        raw = await project_body(request)
        return app.state.projects.start('export', lambda: app.state.projects.export(raw.get('project')))

    @app.post('/api/projects/import', status_code=202)
    async def projects_import(request: Request):
        raw = await project_body(request)
        return app.state.projects.start('import', lambda: app.state.projects.restore(raw.get('name'), raw.get('revision', 0)))

    @app.get('/api/projects/operations/{operation_id}')
    def projects_operation(operation_id: str):
        return app.state.projects.operation(operation_id)

    @app.post('/api/projects/uploads')
    async def projects_upload(request: Request):
        return await run_in_threadpool(app.state.projects.upload, await project_body(request))

    @app.get('/api/projects/packages/{name}')
    def projects_package(name: str):
        return FileResponse(app.state.projects.package_path(name), filename=name, media_type='application/zip', headers={'Cache-Control': 'private, no-store'})

    @app.get('/api/projects/packages/{name}/info')
    def projects_package_info(name: str):
        return app.state.projects.package_info(name)

    @app.get("/{path:path}")
    def static(path: str):
        if path == "api" or path.startswith("api/"):
            raise Problem("API 路径不存在", "route_not_found", 404)
        dist = (settings.root / "dist").resolve()
        file = within(dist / (path or "index.html"), [dist])
        if not file.is_file():
            raise Problem("前端资源尚未构建或路径不存在，请先运行 npm run build", "static_not_found", 404)
        return FileResponse(file, headers={"Cache-Control": "no-cache" if file.name == "index.html" else "private, max-age=3600"})

    return app
