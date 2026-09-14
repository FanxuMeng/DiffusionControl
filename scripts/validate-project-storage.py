#!/usr/bin/env python3
"""Verify migrated outputs over HTTP and restore old/new packages in isolation."""
import hashlib
import json
import shutil
import sys
from http.cookiejar import CookieJar
from pathlib import Path
from urllib.request import HTTPCookieProcessor, ProxyHandler, Request, build_opener

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend.diffusioncontrol.config import Settings
from backend.diffusioncontrol.store import Store
from backend.diffusioncontrol.workflow import Workflow, validate_outputs
from backend.diffusioncontrol.projects import Projects

folder = ROOT/'var/validation/20260910-project-storage'
folder.mkdir(parents=True, exist_ok=True)
base = 'http://127.0.0.1:5192'
client = build_opener(ProxyHandler({}), HTTPCookieProcessor(CookieJar()))
token = (ROOT/'var/access-token').read_text().strip()
with client.open(Request(base+'/api/session', data=json.dumps({'token': token}).encode(), headers={'Content-Type': 'application/json'})) as response:
    assert response.status == 200
del token
before = json.loads((ROOT/'var/migrations/20260910-project-storage/jobs-before.json').read_text())
checks = []
for old in before:
    with client.open(base+'/api/inference/jobs/'+old['id']) as response: job = json.load(response)
    assert job['status'] == old['status']
    assert job['outputDirectory'].startswith(str(ROOT/'projects')+'/')
    assert job['actualArgv'] == old.get('submitArgv', [])
    for output in job['outputs']:
        result = hashlib.sha256()
        with client.open(base+'/api/'+output['url']) as response:
            expected_hash = response.headers['ETag'].strip('"')
            while True:
                data = response.read(1024**2)
                if not data: break
                result.update(data)
        assert result.hexdigest() == expected_hash
    checks.append({'id': job['id'], 'outputDirectory': job['outputDirectory'], 'downloadsValid': len(job['outputs'])})
    print('HTTP artifacts verified:', job['id'], len(job['outputs']), flush=True)

config = json.loads((ROOT/'backend/config.local.json').read_text())
config['stateRoot'] = str((folder/'isolated-state').relative_to(ROOT))
config['projectsRoot'] = str((folder/'isolated-projects').relative_to(ROOT))
settings = Settings(config)
store = Store(settings.state, settings.projects)
manager = Projects(settings, store, Workflow(settings, store))
try:
    name = 'before-migration.dcproject.zip'
    shutil.copyfile(ROOT/'var/validation/20260910-project-management/real-project.dcproject.zip', manager.root/'packages'/name)
    restored = manager.restore(name, 0)
    jobs = manager.project_jobs(restored['project'])
    for job in jobs:
        validate_outputs(Path(job['plan']['outputDirectory']), job['plan'])
        assert Path(job['plan']['outputDirectory']).is_dir()
    package = manager.export(restored['project'])
    assert manager.restore(package['name'], 1)['revision'] == 2
    result = {'succeeded': True, 'migrationHttpChecks': checks, 'publishedDownloadsVerified': sum(item['downloadsValid'] for item in checks),
              'oldPackageRestoredToProjects': True, 'newPackageReimported': True, 'workflowKinds': sorted(job['request']['kind'] for job in jobs),
              'gpuJobsSubmitted': 0}
    (folder/'restored-project.json').write_text(json.dumps(restored['project'], ensure_ascii=False, indent=2))
    (folder/'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps(result, ensure_ascii=False, indent=2))
finally:
    manager.close(); store.close()
