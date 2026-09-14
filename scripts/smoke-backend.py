"""Check a configured live service address without creating Slurm jobs."""
import argparse
import json
from http.cookiejar import CookieJar
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import HTTPCookieProcessor, ProxyHandler, Request, build_opener

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, default=8000)
parser.add_argument("--host", default="127.0.0.1")
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
config_path = root / "backend/config.local.json"
if not config_path.exists():
    config_path = root / "backend/config.example.json"
allowed_hosts = json.loads(config_path.read_text()).get("allowedHosts", ["127.0.0.1", "localhost"])
if args.host not in allowed_hosts:
    parser.error("host must already be listed in the server's allowedHosts")
base = "http://%s:%d" % (args.host, args.port)
client = build_opener(ProxyHandler({}), HTTPCookieProcessor(CookieJar()))


def get(path, expected=200, data=None):
    headers = {"Content-Type": "application/json"} if data is not None else {}
    request = Request(base + path, data=json.dumps(data).encode() if data is not None else None, headers=headers)
    try:
        response = client.open(request, timeout=5)
    except HTTPError as error:
        response = error
    with response:
        body = response.read()
        assert response.code == expected, (path, response.code, body[:200])
        print(path, response.code)
        return body


assert json.loads(get("/api/health"))["status"] == "ok"
get("/api/inference/capabilities", expected=401)
get("/login")
token = (root / "var/access-token").read_text().strip()
get("/api/session", data={"token": token})
html = get("/").decode()
assert '<div id="root">' in html
capabilities = json.loads(get("/api/inference/capabilities"))
assert capabilities["apiVersion"] == 2
print("Enabled model profiles:", capabilities["profiles"])
print("Unavailable model profiles:", capabilities.get("unavailableProfiles", []))
workflow = json.loads(get("/api/workflow/capabilities"))
assert {task["kind"] for task in workflow["tasks"]} == {"depth", "sam2", "associate", "export"}
print("Workflow tasks:", [{"kind": task["kind"], "available": task["available"]} for task in workflow["tasks"]])
execution = json.loads(get("/api/settings/execution"))
assert execution["revision"] >= 0 and 'exec "$@"' in execution["scriptContent"]
assert json.loads(get("/api/workflow/projects/smoke-nonexistent/jobs"))["jobs"] == []
get("/api/inference/jobs/smoke-nonexistent", expected=404)
get("/api/does-not-exist", expected=404)
print("Live HTTP checks passed; no inference jobs were submitted.")
