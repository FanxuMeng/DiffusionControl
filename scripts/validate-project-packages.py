"""Exercise live project APIs and restore real artifacts into an isolated state."""
import argparse
import base64
import json
import shutil
import sys
import time
from http.cookiejar import CookieJar
from pathlib import Path
from urllib.request import HTTPCookieProcessor, ProxyHandler, Request, build_opener

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--project', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--port', type=int, default=8000)
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    client = build_opener(ProxyHandler({}), HTTPCookieProcessor(CookieJar()))
    base = 'http://127.0.0.1:%d' % args.port

    def call(path, data=None):
        request = Request(base+path, data=json.dumps(data).encode() if data is not None else None,
                          headers={'Content-Type': 'application/json', 'Origin': base})
        with client.open(request, timeout=60) as response: return json.loads(response.read())

    def wait(op):
        for _ in range(1800):
            status = call('/api/projects/operations/'+op['id'])
            if status['status'] == 'failed': raise RuntimeError(status['message'])
            if status['status'] == 'succeeded': return status['result']
            time.sleep(1)
        raise RuntimeError('File operation timeout')

    call('/api/session', {'token': (ROOT/'var/access-token').read_text().strip()})
    project = json.loads(args.project.read_text())
    listing = call('/api/projects')
    if any(row['projectId'] == project['id'] for row in listing['projects']):
        raise RuntimeError('Validation project already saved; refusing to overwrite it')
    snapshot = call('/api/projects/save', {'project': project, 'revision': 0})
    print('Saved validation snapshot', snapshot['key'], flush=True)
    exported = wait(call('/api/projects/export', {'project': project}))
    with client.open(base+exported['url'], timeout=60) as response:
        with (output/'real-project.dcproject.zip').open('wb') as stream: shutil.copyfileobj(response, stream, 2*1024**2)
    print('Downloaded package', exported['size'], 'bytes', flush=True)
    # Exercise actual browser-style chunk upload of this real package.
    offset, upload_id, uploaded = 0, None, None
    path = output/'real-project.dcproject.zip'
    with path.open('rb') as source:
        while True:
            block = source.read(2*1024**2)
            if not block: break
            uploaded = call('/api/projects/uploads', {'id': upload_id, 'offset': offset,
                'data': base64.b64encode(block).decode(), 'final': offset+len(block) == path.stat().st_size})
            offset, upload_id = uploaded['offset'], uploaded['id']
    deleted = call('/api/projects/snapshots/'+snapshot['key']+'/delete', {'revision': 1})
    assert deleted['deleted']
    restored = wait(call('/api/projects/import', {'name': uploaded['name'], 'revision': 2}))
    assert restored['revision'] == 3 and not restored['deleted']
    # Return the test snapshot to the recoverable list so the user's project list stays clean.
    call('/api/projects/snapshots/'+snapshot['key']+'/delete', {'revision': 3})
    from backend.diffusioncontrol.config import Settings
    from backend.diffusioncontrol.store import Store
    from backend.diffusioncontrol.workflow import Workflow, validate_outputs
    from backend.diffusioncontrol.projects import Projects
    config = json.loads((ROOT/'backend/config.local.json').read_text())
    config['stateRoot'] = str((output/'isolated-state').relative_to(ROOT))
    config['projectsRoot'] = str((output/'isolated-projects').relative_to(ROOT))
    settings = Settings(config)
    store = Store(settings.state, settings.projects)
    workflow = Workflow(settings, store)
    manager = Projects(settings, store, workflow)
    try:
        name = 'real-project.dcproject.zip'
        shutil.copyfile(path, manager.root/'packages'/name)
        copied = manager.restore(name, 0)
        checks = []
        for job in manager.project_jobs(copied['project']):
            assert job['phase'] == 'terminal'
            if job['plan']['adapter'] == 'workflow' and job['status'] == 'succeeded':
                validate_outputs(Path(job['plan']['outputDirectory']), job['plan'])
                checks.append({'id': job['id'], 'kind': job['request']['kind'], 'valid': True})
        assert {row['kind'] for row in checks} >= {'depth', 'sam2', 'associate', 'export'}
        assert store.active() == []
        again = manager.export(copied['project'])
        (output/'restored-project.json').write_text(json.dumps(copied['project'], ensure_ascii=False, indent=2))
        result = {'succeeded': True, 'projectId': project['id'], 'packageBytes': path.stat().st_size, 'chunkUploadBytes': offset,
                  'snapshotRevisionAfterRestore': 3, 'testSnapshotLeftInTrash': True, 'sameServiceRestore': True,
                  'crossStateRootRestore': True, 'resavedPackageBytes': again['size'], 'workflowArtifacts': checks,
                  'gpuJobsSubmitted': 0, 'scope': 'real_artifacts_live_http_and_isolated_import_no_browser'}
        (output/'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n')
        print(json.dumps(result, ensure_ascii=False), flush=True)
    finally:
        manager.close(); store.close()


if __name__ == '__main__':
    main()
