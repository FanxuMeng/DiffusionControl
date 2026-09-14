"""Submit one retained condition sample through the real authenticated API."""
import argparse
import hashlib
import json
import re
import shlex
import sys
import time
import uuid
from datetime import datetime, timezone
from http.cookiejar import CookieJar
from pathlib import Path
from urllib.request import HTTPCookieProcessor, ProxyHandler, Request, build_opener

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend.diffusioncontrol.validation import parse_parameters, validate_request


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--validation-csv', type=Path, default=ROOT/'var/validation/20260909-gpu/generation-344399/validation.csv')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--max-area', type=int, default=36864)
    args = parser.parse_args()
    output = args.output or ROOT / 'var/validation/20260909-gpu' / ('http-generation-' + uuid.uuid4().hex[:12])
    output.mkdir(parents=True, exist_ok=False)
    client = build_opener(ProxyHandler({}), HTTPCookieProcessor(CookieJar()))
    base = 'http://127.0.0.1:8000'

    def call(path, data=None, key=None):
        headers = {'Content-Type': 'application/json', 'Origin': base}
        if key:
            headers['Idempotency-Key'] = key
        request = Request(base + path, data=json.dumps(data).encode() if data is not None else None, headers=headers)
        with client.open(request, timeout=30) as response:
            return json.loads(response.read())

    call('/api/session', {'token': (ROOT/'var/access-token').read_text().strip()})
    profile = json.loads((ROOT/'backend/profiles/symphomotion-multi-gpu.json').read_text())
    original = json.loads((ROOT/'var/frontend-contract-sharded-request.json').read_text())
    parameters = dict(original['parameters'], validation_csv_path=str(args.validation_csv.resolve()),
                      num_frames=5, fps=4, max_area=args.max_area, num_inference_steps=2, max_samples=1,
                      use_object_prompt=True, use_camera_embedding=True)
    argv = list(profile['commandPrefix'])
    for parameter in profile['parameters']:
        value = parameters.get(parameter['key'])
        if value is None or value == '':
            continue
        if parameter['type'] == 'boolean':
            if value:
                argv.append(parameter['flag'])
            elif parameter.get('falseFlag'):
                argv.append(parameter['falseFlag'])
        else:
            argv.extend([parameter['flag'], str(value)])
    script = call('/api/settings/execution')['scriptContent']
    # Clone the shared template for bounded validation; do not edit global settings.
    for pattern, replacement in [(r'^#SBATCH --cpus-per-task=.*$', '#SBATCH --cpus-per-task=8'),
                                 (r'^#SBATCH -t .*$', '#SBATCH -t 00:15:00'),
                                 (r'^#SBATCH -G .*$', '#SBATCH -G 2')]:
        script, count = re.subn(pattern, replacement, script, flags=re.MULTILINE)
        if count != 1:
            raise RuntimeError('Shared script differs from the expected template; no job submitted')
    request_id = 'http-validation-' + uuid.uuid4().hex
    wrapped = ['sbatch', 'job.gpu', 'ENVNAME=symphomotion'] + argv
    request = dict(original, requestId=request_id, createdAt=datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
                   projectId='gpu-validation-20260909', projectName='真实 GPU 接口验收',
                   parameters=parse_parameters(profile, argv), argv=argv, command=shlex.join(argv),
                   execution=dict(original['execution'], envName='symphomotion', scriptName='job.gpu', scriptContent=script,
                                  argv=wrapped, command=shlex.join(wrapped)))
    validate_request(request, request_id, profile)
    (output/'request.json').write_text(json.dumps(request, ensure_ascii=False, indent=2)+'\n')
    job = call('/api/inference/jobs', request, request_id)
    (output/'submission.json').write_text(json.dumps(job, ensure_ascii=False, indent=2)+'\n')
    print('Evidence:', output, 'job:', job['id'], flush=True)
    states = []
    deadline = time.monotonic() + 1000
    while True:
        job = call('/api/inference/jobs/' + job['id'])
        (output/'job.json').write_text(json.dumps(job, ensure_ascii=False, indent=2)+'\n')
        if not states or states[-1] != job['status']:
            states.append(job['status'])
            print('State:', job['status'], job.get('slurmId'), flush=True)
        if job['status'] in ('succeeded', 'failed', 'cancelled'):
            break
        if time.monotonic() > deadline:
            raise RuntimeError('Polling deadline reached; retained job.json identifies the bounded Slurm job')
        time.sleep(5)
    (output/'logs.json').write_text(json.dumps(call('/api/inference/jobs/' + job['id'] + '/logs'), ensure_ascii=False, indent=2)+'\n')
    if job['status'] != 'succeeded':
        raise RuntimeError('Generation failed; see retained job and logs')
    entry = next(item for item in job['outputs'] if item['name'].startswith('generated_videos/'))
    with client.open(base + '/api/' + entry['url'], timeout=30) as response:
        content = response.read()
        digest = hashlib.sha256(content).hexdigest()
        assert response.headers['ETag'] == '"' + digest + '"'
        assert content[4:8] == b'ftyp'
    (output/'generated.mp4').write_bytes(content)
    report = {'succeeded': True, 'jobId': job['id'], 'states': states, 'slurmId': job.get('slurmId'),
              'downloadBytes': len(content), 'sha256': digest, 'outputUrl': entry['url']}
    (output/'result.json').write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps(report), flush=True)


if __name__ == '__main__':
    main()
