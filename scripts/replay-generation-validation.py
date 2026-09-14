"""Replay a supplied generation request once, preserving model settings and evidence."""
import argparse
import json
import uuid
from datetime import datetime, timezone
from http.cookiejar import CookieJar
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import HTTPCookieProcessor, ProxyHandler, Request, build_opener

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--request', type=Path)
parser.add_argument('--output', required=True, type=Path)
parser.add_argument('--action', choices=['submit', 'status'], default='status')
parser.add_argument('--port', type=int, default=8000)
args = parser.parse_args()
folder = args.output.resolve()
folder.relative_to(ROOT)
folder.mkdir(parents=True, exist_ok=True)
base = 'http://127.0.0.1:'+str(args.port)
client = build_opener(ProxyHandler({}), HTTPCookieProcessor(CookieJar()))


def save(name, value):
    (folder/name).write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n')


def call(path, data=None, key=None):
    headers = {'Content-Type': 'application/json', 'Origin': base}
    if key: headers['Idempotency-Key'] = key
    request = Request(base+path, data=json.dumps(data).encode() if data is not None else None, headers=headers)
    try:
        with client.open(request, timeout=45) as response:
            return json.loads(response.read())
    except HTTPError as error:
        raise RuntimeError('HTTP %d: %s' % (error.code, error.read().decode())) from error


call('/api/session', {'token': (ROOT/'var/access-token').read_text().strip()})
if args.action == 'submit':
    if (folder/'request.json').exists():
        request = json.loads((folder/'request.json').read_text())
    else:
        if not args.request: raise ValueError('--request is required for the first submission')
        original = json.loads(args.request.read_text())
        if original['execution']['envName'] != 'symphomotion':
            raise ValueError('This validation must use the existing symphomotion environment')
        save('original-request.json', original)
        request = dict(original, requestId='memory-validation-'+uuid.uuid4().hex,
                       createdAt=datetime.now(timezone.utc).isoformat())
        save('request.json', request)
    if not (folder/'worker.py').exists():
        (folder/'worker.py').write_bytes((ROOT/'backend/workers/symphomotion.py').read_bytes())
    job = call('/api/inference/jobs', request, request['requestId'])
    save('submission.json', job)
else:
    job = json.loads((folder/'submission.json').read_text())
job = call('/api/inference/jobs/'+job['id'])
save('job.json', job)
save('logs.json', call('/api/inference/jobs/'+job['id']+'/logs'))
print(json.dumps({key: job.get(key) for key in ('id', 'status', 'slurmId', 'message', 'artifactDirectory', 'outputs')},
                 ensure_ascii=False), flush=True)
if job['status'] in ('failed', 'cancelled'): raise SystemExit(1)
