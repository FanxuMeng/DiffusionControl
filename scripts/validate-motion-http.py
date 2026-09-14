"""Bounded real association -> render -> dual-GPU OMM inference, resumable evidence."""
import argparse
import json
import re
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from http.cookiejar import CookieJar
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import HTTPCookieProcessor, ProxyHandler, Request, build_opener

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--port', type=int, default=5192)
parser.add_argument('--stage', choices=['associate', 'export', 'generation', 'all'], default='all')
parser.add_argument('--output', type=Path, default=ROOT/'var/validation/20260911-motion')
args = parser.parse_args()
folder = args.output.resolve()
folder.relative_to(ROOT)
folder.mkdir(parents=True, exist_ok=True)
base = 'http://127.0.0.1:'+str(args.port)
client = build_opener(ProxyHandler({}), HTTPCookieProcessor(CookieJar()))


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n')


def call(path, data=None, key=None):
    headers = {'Content-Type': 'application/json', 'Origin': base}
    if key: headers['Idempotency-Key'] = key
    request = Request(base+path, data=json.dumps(data).encode() if data is not None else None, headers=headers)
    try:
        with client.open(request, timeout=45) as response:
            return json.loads(response.read())
    except HTTPError as error:
        raise RuntimeError('HTTP %d: %s' % (error.code, error.read().decode())) from error


def run_job(kind, request):
    output = folder/kind
    output.mkdir(exist_ok=True)
    if (output/'request.json').exists():
        request = json.loads((output/'request.json').read_text())
    else:
        save(output/'request.json', request)
    endpoint = '/api/inference/jobs' if kind == 'generation' else '/api/workflow/jobs'
    job = call(endpoint, request, request['requestId'])
    save(output/'submission.json', job)
    print(kind, 'submitted', job['id'], flush=True)
    previous = None
    deadline = time.monotonic()+1800
    while True:
        job = call('/api/inference/jobs/'+job['id'])
        save(output/'job.json', job)
        if job['status'] != previous:
            print(kind, job['status'], job.get('slurmId'), job.get('message'), flush=True)
            previous = job['status']
        if job['status'] in ('succeeded', 'failed', 'cancelled'):
            save(output/'logs.json', call('/api/inference/jobs/'+job['id']+'/logs'))
            if job['status'] != 'succeeded': raise RuntimeError('Job failed; retained '+str(output))
            for artifact in job['outputs']:
                # Avoid duplicating million-point NPZs; paths remain in job.json.
                if artifact['name'].endswith(('.json', '.mp4', '.csv')):
                    target = output/artifact['name']; target.parent.mkdir(parents=True, exist_ok=True)
                    with client.open(base+'/api/'+artifact['url'], timeout=45) as response:
                        target.write_bytes(response.read())
            return job
        if time.monotonic() > deadline: raise RuntimeError('Polling timeout; retained job remains queryable')
        time.sleep(3)


def prepare(generation=False):
    if not generation and (folder/'project.json').exists() and (folder/'snapshot.json').exists():
        return  # Resume the exported trajectory/clip identities, not a new take.
    subprocess.run([str(ROOT/'node_modules/.bin/esbuild'), 'scripts/prepare-motion-validation.ts', '--bundle', '--platform=node',
                    '--format=cjs', '--outfile='+str(folder/'prepare.cjs')], cwd=ROOT, check=True)
    subprocess.run(['node', str(folder/'prepare.cjs'), str(folder)]+(['--generation'] if generation else []), cwd=ROOT, check=True)


call('/api/session', {'token': (ROOT/'var/access-token').read_text().strip()})
save(folder/'capabilities.json', call('/api/inference/capabilities'))
shared = call('/api/settings/execution')
script = shared['scriptContent']
for pattern, replacement in [(r'^#SBATCH --cpus-per-task=.*$', '#SBATCH --cpus-per-task=4'),
                             (r'^#SBATCH -t .*$', '#SBATCH -t 00:15:00'), (r'^#SBATCH -G .*$', '#SBATCH -G 2')]:
    script, count = re.subn(pattern, replacement, script, flags=re.MULTILINE)
    if count != 1: raise RuntimeError('Unexpected global template; no submission')
execution = {'kind': 'slurm_sbatch', 'version': 1, 'envName': 'depthpro', 'scriptName': 'job.gpu', 'scriptContent': script}
save(folder/'execution.json', execution)
fixture = json.loads((ROOT/'var/validation/20260910-workflow-resume/http-workflow-ready/frontend-project.json').read_text())
inputs = {'referenceAssetId': fixture['workflow']['referenceAssetId'], 'sceneJobId': fixture['workflow']['sceneJobId']}


def workflow(kind, options, extra):
    return {'version': 1, 'requestId': 'motion-validation-'+uuid.uuid4().hex, 'createdAt': datetime.now(timezone.utc).isoformat(),
            'projectId': fixture['id'], 'projectName': 'Rendered Frames 与 OMM 模块验证', 'kind': kind,
            'inputs': dict(inputs, **extra), 'options': options, 'execution': execution}


if args.stage in ('all', 'associate'):
    run_job('associate', workflow('associate', {'candidate': 0}, {'segmentationJobId': '9bfc6916-eeed-4e0f-bdee-5b71800d29d3', 'objectJobIds': []}))
if args.stage in ('all', 'export'):
    prepare()
    snapshot = json.loads((folder/'snapshot.json').read_text())
    run_job('export', workflow('export', {'project': snapshot, 'numFrames': 5, 'fps': 4, 'width': 384, 'height': 256,
             'pointsPerObject': 500, 'seed': 42, 'radius': .005, 'pointsPerPixel': 8}, {'objectJobIds': [item['jobId'] for item in snapshot['objects']]}))
if args.stage in ('all', 'generation'):
    prepare(True)
    run_job('generation', json.loads((folder/'generation-request.json').read_text()))
print('Completed '+args.stage+'; evidence '+str(folder), flush=True)
