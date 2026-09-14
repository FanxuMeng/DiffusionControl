import copy
import base64
import io
import importlib.util
import json
import unittest
from pathlib import Path

from .support import Fixture, request

HTTP_AVAILABLE = importlib.util.find_spec("fastapi") is not None


@unittest.skipUnless(HTTP_AVAILABLE, "FastAPI not installed in Conda base; HTTP integration not verified")
class HttpTests(unittest.TestCase):
    def setUp(self):
        from fastapi.testclient import TestClient
        from backend.diffusioncontrol.http import create_app
        self.fixture = Fixture()
        self.fixture.settings.allowed_hosts.add("compute.example")
        # Application lifespan owns the store; release the fixture's instance first.
        self.fixture.store.close()
        self.app = create_app(self.fixture.settings, self.fixture.scheduler, start_worker=False)
        self.client = TestClient(self.app, base_url="http://127.0.0.1:8000")
        self.client.__enter__()
        self.addCleanup(self.fixture.temporary.cleanup)
        self.addCleanup(self.client.__exit__, None, None, None)

    def login(self):
        token = (self.fixture.settings.state / "access-token").read_text().strip()
        response = self.client.post("/api/session", json={"token": token})
        self.assertEqual(response.status_code, 200)
        self.assertIn("HttpOnly", response.headers["set-cookie"])
        self.assertIn("SameSite=strict", response.headers["set-cookie"])

    def submit(self, raw=None):
        raw = raw or request()
        return self.client.post("/api/inference/jobs", json=raw, headers={"Idempotency-Key": raw["requestId"]})

    def test_health_public_and_api_auth_required(self):
        self.assertEqual(self.client.get("/api/health").status_code, 200)
        self.assertEqual(self.client.get("/api/inference/capabilities").status_code, 401)
        self.assertEqual(self.client.get("/login").status_code, 200)
        self.login()
        self.assertEqual(self.client.get("/api/inference/capabilities").json()["apiVersion"], 2)

    def test_host_origin_and_wrong_token(self):
        self.assertEqual(self.client.get("/api/health", headers={"host": "evil.example"}).status_code, 403)
        self.assertEqual(self.client.post("/api/session", json={"token": "wrong"}).status_code, 401)
        self.assertEqual(self.client.post("/api/session", json={}, headers={"origin": "https://evil.example"}).status_code, 403)

    def test_configured_network_host_accepts_matching_origin(self):
        token = (self.fixture.settings.state / "access-token").read_text().strip()
        headers = {"Host": "compute.example:8000", "Origin": "http://compute.example:8000"}
        self.assertEqual(self.client.post("/api/session", json={"token": token}, headers=headers).status_code, 200)
        headers["Origin"] = "http://another.example:8000"
        self.assertEqual(self.client.post("/api/session", json={"token": token}, headers=headers).status_code, 403)

    def test_request_lifecycle_and_idempotency(self):
        self.login()
        accepted = self.submit()
        self.assertEqual(accepted.status_code, 202)
        self.assertEqual(self.submit().json()["id"], accepted.json()["id"])
        job_id = accepted.json()["id"]
        self.app.state.service.tick()
        job = self.client.get("/api/inference/jobs/" + job_id).json()
        self.assertEqual(job["requestId"], "request-1")
        self.assertEqual(job["status"], "queued")
        self.assertEqual(len(self.fixture.scheduler.submissions), 1)

    def test_rejections_leave_no_job_and_conflicts_are_409(self):
        self.login()
        bad = request()
        bad["parameters"]["seed"] = 77
        self.assertEqual(self.submit(bad).status_code, 422)
        self.assertEqual(self.app.state.store.active(), [])
        self.assertEqual(self.submit().status_code, 202)
        bad = request()
        bad["projectName"] = "changed"
        self.assertEqual(self.submit(bad).status_code, 409)

    def test_invalid_json_content_type_and_size(self):
        self.login()
        for body in ('{"x":1,"x":2}', '{"x":NaN}', 'not-json'):
            response = self.client.post("/api/inference/jobs", content=body, headers={"Content-Type": "application/json"})
            self.assertEqual(response.status_code, 400)
        self.assertEqual(self.client.post("/api/inference/jobs", content="{}").status_code, 400)
        self.assertEqual(self.client.post("/api/inference/jobs", content="x" * (1024 * 1024 + 1), headers={"Content-Type": "application/json"}).status_code, 413)

    def test_cancel_and_bounded_logs(self):
        self.login()
        job_id = self.submit().json()["id"]
        response = self.client.post("/api/inference/jobs/" + job_id + "/cancel", json={})
        self.assertTrue(response.json()["cancelRequested"])
        self.assertEqual(response.json()["status"], "queued")
        self.app.state.service.tick()
        self.assertEqual(self.client.get("/api/inference/jobs/" + job_id).json()["status"], "cancelled")
        directory = Path(self.app.state.store.get(job_id)['directory'])
        (directory / "stdout.log").write_text("a" * 100000)
        logs = self.client.get("/api/inference/jobs/" + job_id + "/logs").json()
        self.assertEqual(len(logs["stdout.log"]["text"]), 65536)
        self.assertTrue(logs["stdout.log"]["truncated"])

    def test_output_range_and_auth(self):
        self.login()
        job_id = self.submit().json()["id"]
        self.app.state.service.tick()
        job = self.app.state.store.get(job_id)
        self.fixture.video(job)
        self.fixture.scheduler.state(job_id, "COMPLETED")
        self.app.state.service.tick()
        url = "/api/inference/jobs/" + job_id + "/outputs/0"
        response = self.client.get(url, headers={"Range": "bytes=0-11"})
        self.assertEqual(response.status_code, 206)
        self.assertEqual(len(response.content), 12)
        self.assertEqual(self.client.get(url, headers={"Range": "bytes=0-1,3-4"}).status_code, 416)
        self.client.cookies.clear()
        self.assertEqual(self.client.get(url).status_code, 401)

    def test_unknown_api_is_json_not_spa(self):
        self.login()
        response = self.client.get("/api/does-not-exist")
        self.assertEqual(response.status_code, 404)
        self.assertIn("application/json", response.headers["content-type"])

    def test_project_snapshot_delete_restore_and_package_http(self):
        import time
        self.assertEqual(self.client.get('/api/projects').status_code, 401)
        self.login()
        project = {'id': 'http-project', 'name': 'HTTP 项目', 'demoScene': None, 'reference': None, 'objects': [], 'generation': {'submissions': []}}
        saved = self.client.post('/api/projects/save', json={'project': project, 'revision': 0})
        self.assertEqual(saved.status_code, 200, saved.text)
        key = saved.json()['key']
        self.assertEqual(self.client.post('/api/projects/save', json={'project': project, 'revision': 0}).status_code, 409)
        removed = self.client.post('/api/projects/snapshots/'+key+'/delete', json={'revision': 1})
        self.assertTrue(removed.json()['deleted'])
        self.assertEqual(self.app.state.store.active(), [])
        op = self.client.post('/api/projects/export', json={'project': project})
        self.assertEqual(op.status_code, 202)
        for _ in range(100):
            status = self.client.get('/api/projects/operations/'+op.json()['id']).json()
            if status['status'] in ('succeeded', 'failed'): break
            time.sleep(.02)
        self.assertEqual(status['status'], 'succeeded', status)
        package = self.client.get(status['result']['url'])
        self.assertEqual(package.status_code, 200)
        self.assertTrue(package.content.startswith(b'PK'))
        name = status['result']['name']
        info = self.client.get('/api/projects/packages/'+name+'/info').json()
        self.assertEqual(info['revision'], 2)
        op = self.client.post('/api/projects/import', json={'name': name, 'revision': 2})
        for _ in range(100):
            status = self.client.get('/api/projects/operations/'+op.json()['id']).json()
            if status['status'] in ('succeeded', 'failed'): break
            time.sleep(.02)
        self.assertEqual(status['status'], 'succeeded', status)
        self.assertFalse(status['result']['deleted'])
        self.assertEqual(self.fixture.scheduler.submissions, [])

    def test_workflow_upload_settings_and_job_lifecycle_share_auth_and_scheduler(self):
        from PIL import Image
        from .support import SCRIPT
        self.assertEqual(self.client.get("/api/workflow/capabilities").status_code, 401)
        self.login()
        saved = self.client.put("/api/settings/execution", json={"revision": 0, "scriptName": "job.gpu", "scriptContent": SCRIPT})
        self.assertEqual(saved.status_code, 200)
        self.assertEqual(self.client.get("/api/settings/execution").json()["revision"], 1)
        source = self.fixture.root / "third_party/sam2/sam2/build_sam.py"
        source.parent.mkdir(parents=True)
        source.write_text("# test fixture")
        checkpoint = self.fixture.root / "checkpoint.pt"
        checkpoint.write_bytes(b"not loaded")
        self.fixture.settings.workflow = {"tasks": {"sam2": {"enabled": True, "environment": "base", "checkpoint": str(checkpoint)}}}
        image = io.BytesIO()
        Image.new("RGB", (32, 16), "blue").save(image, format="PNG")
        asset = self.client.post("/api/workflow/assets", json={"image": "data:image/png;base64,"+base64.b64encode(image.getvalue()).decode()})
        self.assertEqual(asset.status_code, 201)
        self.assertEqual(self.client.get(asset.json()["url"]).headers["content-type"], "image/png")
        raw = {"version": 1, "requestId": "sam-request", "projectId": "p1", "projectName": "p", "createdAt": "2026-09-09T00:00:00Z",
            "kind": "sam2", "inputs": {"referenceAssetId": asset.json()["id"]}, "options": {"points": [[2, 2, 1]]},
            "execution": {"version": 1, "kind": "slurm_sbatch", "envName": "base", "scriptName": "job.gpu", "scriptContent": SCRIPT}}
        accepted = self.client.post("/api/workflow/jobs", json=raw, headers={"Idempotency-Key": "sam-request"})
        self.assertEqual(accepted.status_code, 202, accepted.text)
        again = self.client.post("/api/workflow/jobs", json=raw, headers={"Idempotency-Key": "sam-request"})
        self.assertEqual(again.json()["id"], accepted.json()["id"])
        jobs = self.client.get("/api/workflow/projects/p1/jobs").json()["jobs"]
        self.assertEqual(jobs[0]["kind"], "sam2")
        self.app.state.service.tick()
        self.assertEqual(len(self.fixture.scheduler.submissions), 1)
        job_id = accepted.json()["id"]
        self.client.post("/api/inference/jobs/"+job_id+"/cancel", json={})
        self.app.state.service.tick()
        self.assertEqual(self.fixture.scheduler.cancellations, ["123"])


if __name__ == "__main__":
    unittest.main()
