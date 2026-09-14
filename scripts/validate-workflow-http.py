"""Run a real bounded HTTP -> Slurm workflow, retaining requests and downloads."""
import argparse
import base64
import hashlib
import json
import re
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from http.cookiejar import CookieJar
from pathlib import Path
from urllib.request import HTTPCookieProcessor, ProxyHandler, Request, build_opener

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--generate', action='store_true')
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    base = 'http://127.0.0.1:8000'
    client = build_opener(ProxyHandler({}), HTTPCookieProcessor(CookieJar()))

    def save(path, data):
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2)+'\n')

    def call(path, data=None, key=None):
        headers = {'Content-Type': 'application/json', 'Origin': base}
        if key:
            headers['Idempotency-Key'] = key
        request = Request(base+path, data=json.dumps(data).encode() if data is not None else None, headers=headers)
        with client.open(request, timeout=30) as response:
            return json.loads(response.read())

    call('/api/session', {'token': (ROOT/'var/access-token').read_text().strip()})
    capabilities = call('/api/workflow/capabilities')
    save(output/'capabilities.json', capabilities)
    assert all(task['available'] for task in capabilities['tasks'])
    shared = call('/api/settings/execution')
    save(output/'execution-settings.json', shared)
    script = shared['scriptContent']
    for pattern, replacement in [(r'^#SBATCH --cpus-per-task=.*$', '#SBATCH --cpus-per-task=4'),
                                 (r'^#SBATCH -t .*$', '#SBATCH -t 00:10:00'),
                                 (r'^#SBATCH -G .*$', '#SBATCH -G 1')]:
        script, count = re.subn(pattern, replacement, script, flags=re.MULTILINE)
        if count != 1:
            raise RuntimeError('Shared Slurm template differs; inspect before submitting')
    photo = ROOT/'var/validation/20260910-workflow/truck.jpg'
    upload = {'image': 'data:image/jpeg;base64,'+base64.b64encode(photo.read_bytes()).decode()}
    asset = call('/api/workflow/assets', upload)
    assert call('/api/workflow/assets', upload) == asset
    save(output/'asset.json', asset)
    project_id = 'workflow-validation-'+uuid.uuid4().hex[:12]
    jobs, states, evidence = {}, {}, {}

    def submit(kind, options, inputs=None):
        request_id = 'workflow-http-'+uuid.uuid4().hex
        request = {'version': 1, 'requestId': request_id, 'createdAt': datetime.now(timezone.utc).isoformat(),
                   'projectId': project_id, 'projectName': '真实卡车工作流验收', 'kind': kind,
                   'inputs': dict({'referenceAssetId': asset['id']}, **(inputs or {})), 'options': options,
                   'execution': {'kind': 'slurm_sbatch', 'version': 1, 'envName': 'sam2' if kind == 'sam2' else 'depthpro',
                                 'scriptName': shared['scriptName'], 'scriptContent': script}}
        folder = output/kind
        folder.mkdir()
        save(folder/'request.json', request)
        job = call('/api/workflow/jobs', request, request_id)
        assert call('/api/workflow/jobs', request, request_id)['id'] == job['id']
        jobs[kind], states[kind] = job, []
        save(folder/'submission.json', job)
        print('Submitted', kind, job['id'], flush=True)

    def wait(kinds):
        deadline = time.monotonic()+1000
        pending = set(kinds)
        while pending:
            for kind in sorted(pending):
                job = call('/api/inference/jobs/'+jobs[kind]['id'])
                jobs[kind] = job
                save(output/kind/'job.json', job)
                if not states[kind] or states[kind][-1] != job['status']:
                    states[kind].append(job['status'])
                    print(kind, job['status'], job.get('slurmId'), flush=True)
                if job['status'] in ('succeeded', 'failed', 'cancelled'):
                    save(output/kind/'logs.json', call('/api/inference/jobs/'+job['id']+'/logs'))
                    if job['status'] != 'succeeded':
                        raise RuntimeError(kind+' failed; see retained logs')
                    pending.remove(kind)
            if pending:
                if time.monotonic() > deadline:
                    raise RuntimeError('Polling deadline reached; job records retain bounded Slurm IDs')
                time.sleep(3)

    def download(kind, name):
        entry = next(item for item in jobs[kind]['outputs'] if item['name'] == name)
        with client.open(base+'/api/'+entry['url'], timeout=30) as response:
            data = response.read()
            digest = hashlib.sha256(data).hexdigest()
            assert response.headers['ETag'] == '"'+digest+'"'
        path = output/kind/name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        evidence[kind+'/'+name] = {'sha256': digest, 'bytes': len(data), 'url': entry['url']}
        return data

    submit('depth', {'precision': 'float16', 'contract': 8, 'sobelThreshold': .35})
    submit('sam2', {'points': [[1050, 550, 1], [900, 1100, 0], [1700, 50, 0]], 'box': [75, 260, 1730, 870]})
    wait(['depth', 'sam2'])
    depth = json.loads(download('depth', 'result.json'))
    sam = json.loads(download('sam2', 'result.json'))
    candidate = sam['suggestedCandidate']
    for kind, names in [('depth', ['preview.bin', 'depth.png']), ('sam2', ['mask-%d.png' % candidate, 'overlay-%d.png' % candidate])]:
        for name in names:
            download(kind, name)
    submit('associate', {'candidate': candidate}, {'sceneJobId': jobs['depth']['id'], 'segmentationJobId': jobs['sam2']['id'], 'objectJobIds': []})
    wait(['associate'])
    obj = json.loads(download('associate', 'result.json'))
    for name in ('preview.bin', 'point-ids.bin', 'overlay.png'):
        download('associate', name)
    initial = {'position': obj['center'], 'quaternion': [0, 0, 0, 1]}
    final = {'position': [obj['center'][0]+.5, *obj['center'][1:]], 'quaternion': [0, 0, 0, 1]}
    item = {'id': 'truck', 'jobId': jobs['associate']['id'], 'prompt': 'A silver pickup truck moves slowly to the right.',
            'initialPose': initial, 'motion': 'trajectory', 'trajectory': {'duration': 1, 'samples': [{'t': 0, **initial}, {'t': 1, **final}]},
            'clip': {'start': 0, 'duration': 1}}
    project = {'prompt': 'A silver pickup truck moves slowly to the right in front of a red wall. The camera is stationary.',
               'duration': 1, 'calibration': {'intrinsic': depth['intrinsic'], 'imageWidth': asset['width'], 'imageHeight': asset['height'],
               'distortion': {'coefficients': [0]*5}}, 'camera': None, 'cameraClip': None, 'objects': [item]}
    submit('export', {'project': project, 'numFrames': 5, 'fps': 4, 'width': 384, 'height': 256, 'pointsPerObject': 500,
                     'radius': .005, 'pointsPerPixel': 8, 'seed': 42}, {'sceneJobId': jobs['depth']['id'], 'objectJobIds': [jobs['associate']['id']]})
    wait(['export'])
    exported = json.loads(download('export', 'result.json'))
    for name in ('manifest.json', 'conditions.zip', 'sample/first_image.png', 'sample/render_output/render_with_2d_bbox.mp4', 'sample/render_output/render_mask.mp4', 'sample/spatialtracker2.npz'):
        download('export', name)
    listed = call('/api/workflow/projects/'+project_id+'/jobs')['jobs']
    assert {job['id'] for job in listed} == {job['id'] for job in jobs.values()}
    assert call('/api/settings/execution') == shared
    report = {'succeeded': True, 'projectId': project_id, 'jobs': {kind: {'id': job['id'], 'slurmId': job['slurmId'], 'states': states[kind]} for kind, job in jobs.items()},
              'downloads': evidence, 'uploadIdempotent': True, 'jobSubmissionIdempotent': True, 'sharedSettingsUnchanged': True,
              'exportCsv': exported['validationCsv'], 'scope': 'real_http_slurm_workers_and_downloads_not_browser_interaction'}
    save(output/'result.json', report)
    print(json.dumps(report, ensure_ascii=False), flush=True)
    if args.generate:
        cmd = [sys.executable, str(ROOT/'scripts/validate-generation-http.py'), '--validation-csv', exported['validationCsv'],
               '--max-area', '98304', '--output', str(output/'generation')]
        save(output/'generation-command.json', cmd)
        subprocess.run(cmd, check=True, cwd=ROOT)


if __name__ == '__main__':
    main()
