"""Isolated browser acceptance: camera deletion and one real Slurm box replacement."""
import argparse
import json
import time
from pathlib import Path
from browser_marionette import Browser

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, default=ROOT/'var/validation/20260911-box-editor')
folder = parser.parse_args().output.resolve()
folder.relative_to(ROOT)
folder.mkdir(parents=True, exist_ok=True)
base = 'http://127.0.0.1:8000'
project = json.loads((ROOT/'var/validation/20260911-motion/project.json').read_text())
project['generation']['submissions'] = []
original_object = project['objects'][0]
result = {'succeeded': False, 'projectId': project['id']}
if (folder/'pending-project.json').exists():
    project = json.loads((folder/'pending-project.json').read_text())
    if (folder/'result.json').exists(): result.update(json.loads((folder/'result.json').read_text()))
    result.pop('error', None)
    resume = True
else:
    resume = False
browser = Browser(folder/'browser', port=28285)
saved_js = "JSON.parse(localStorage.getItem('diffusioncontrol.prototype.v2'))[0]"


def save(name, value):
    (folder/name).write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n')


def wait(script, label, timeout=45):
    end = time.monotonic()+timeout
    while time.monotonic()<end:
        value = browser.evaluate(script)
        if value: return value
        time.sleep(.3)
    raise RuntimeError('Timeout: '+label)


def saved():
    return browser.evaluate('return '+saved_js+';')


try:
    browser.command('WebDriver:Navigate', {'url': base+'/login'})
    status = browser.asynchronous("const done=arguments[arguments.length-1];fetch('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:arguments[0]})}).then(r=>done(r.status));", [(ROOT/'var/access-token').read_text().strip()])
    assert status == 200
    browser.evaluate("localStorage.setItem('diffusioncontrol.prototype.v2',JSON.stringify([arguments[0]]));", [project])
    browser.command('WebDriver:Navigate', {'url': base+'/'})
    wait("return !!document.querySelector('.dcp-object-card');", 'loaded object')
    if not resume:
        browser.click('[aria-label="删除相机轨迹"]')
        assert project['camera']['name'] in browser.command('WebDriver:GetAlertText')
        browser.command('WebDriver:DismissAlert')
        assert saved()['camera']['id'] == project['camera']['id']
        browser.click('.dcp-camera-panel .dcp-record-action')
        browser.click('[aria-label="删除相机轨迹"]')
        browser.command('WebDriver:AcceptAlert')
        wait('return '+saved_js+'.camera===null;', 'camera deleted')
        state = saved()
        assert state['cameraClip'] is None and state['cameraHistory'][0]['id'] == project['camera']['id']
        assert state['objects'][0]['trajectory']['id'] == original_object['trajectory']['id']
        assert state['fourD'] == 'ready' and state['workflow'].get('exportJobId') is None
        assert browser.evaluate("return !document.querySelector('[aria-label=\"相机控制\"]').checked && document.querySelector('[aria-label=\"相机控制\"]').disabled;")
        assert browser.evaluate("return !document.querySelector('.target-label').textContent.includes('相机轨迹');")
        browser.screenshot('01-camera-deleted.png')
        result['cameraDeleteCancelConfirmAndTargetCleanup'] = True
        browser.command('WebDriver:Refresh')
        wait("return !!document.querySelector('.dcp-camera-panel') && !document.querySelector('[aria-label=\"删除相机轨迹\"]');", 'camera deletion persisted')
        browser.click('.dcp-camera-actions button:first-child')
        browser.click('.history-list summary')
        browser.click('.history-list button')
        wait('return '+saved_js+'.camera!==null;', 'camera restored from history')
        assert saved()['camera']['id'] == project['camera']['id']
        result['cameraDeletionPersistsAndHistoryRestores'] = True
        browser.click('[aria-label="编辑物体包围盒"]')
        wait("return !!document.querySelector('.bbox-editor');", 'box editor')
        browser.fill('[aria-label="包围盒相对位移 X"]', '.1')
        browser.click('[aria-label="取消包围盒编辑"]')
        assert saved()['objects'][0]['center'] == original_object['center']
        result['boxCancelPreservesInstance'] = True
        browser.click('[aria-label="编辑物体包围盒"]')
        browser.click("//section[@aria-label='3D 包围盒编辑']//button[contains(.,'尺寸')]", using='xpath')
        assert browser.evaluate("return Array.from(document.querySelectorAll('.bbox-editor-modes button')).some(b=>b.textContent==='尺寸'&&b.getAttribute('aria-pressed')==='true');")
        browser.fill('[aria-label="包围盒相对位移 X"]', '.05')
        browser.fill('[aria-label="包围盒边长 X"]', str(round(original_object['halfExtents'][0]*2*.95, 5)))
        browser.fill('[aria-label="包围盒相对旋转 Z"]', '12')
        assert browser.evaluate("return Number(document.querySelector('[aria-label=\"包围盒相对旋转 Z\"]').value)===12;")
        assert saved()['objects'][0]['center'] == original_object['center']
        assert browser.evaluate("return document.querySelector('[aria-label=\"切换项目\"]').disabled && document.querySelector('[aria-label=\"删除相机轨迹\"]').disabled;")
        browser.screenshot('02-box-editor-draft.png')
        result['draftNumericEditsAndModeSelection'] = True
        result['numericCoordinateFrame'] = 'current-box-local'
        browser.click('.bbox-editor-actions .primary-button')
        wait('return '+saved_js+'.workflow.objectDefinitions?.some(d=>!!d.replaceObjectJobId);', 'persisted replacement definition')
        project = saved()
        assert project['objects'][0]['reconstruction']['jobId'] == original_object['reconstruction']['jobId']
        assert project['objects'][0]['trajectory']['id'] == original_object['trajectory']['id']
        save('pending-project.json', project); save('result.json', result)
        result['originalRetainedWhileQueued'] = True
        print('Replacement submitted; original instance retained', flush=True)
        browser.command('WebDriver:Refresh')
        wait("return !!document.querySelector('.dcp-object-card');", 'reload during replacement')
    definition = next(d for d in project['workflow']['objectDefinitions'] if d.get('replaceObjectJobId'))
    last = None
    for _ in range(180):
        jobs = browser.asynchronous("const done=arguments[arguments.length-1];fetch('/api/workflow/projects/'+arguments[0]+'/jobs').then(r=>r.json()).then(done);", [project['id']])['jobs']
        job = next((j for j in jobs if j['requestId'] == definition['requestId']), None)
        if job:
            save('association-job.json', job)
            if job['status'] != last:
                last = job['status']; print('Slurm box update:', last, job.get('slurmId'), flush=True)
            if job['status'] in ('failed', 'cancelled'): raise RuntimeError(job.get('message', job['status']))
            if job['status'] == 'succeeded': break
        time.sleep(5)
    else: raise RuntimeError('Slurm replacement is still pending; rerun this script to resume')
    wait('return '+saved_js+'.objects[0].reconstruction.jobId==='+json.dumps(job['id'])+';', 'automatic in-place replacement')
    state = saved(); updated = state['objects'][0]
    assert len(state['objects']) == 1 and updated['id'] == original_object['id']
    assert updated['trajectory'] is None and updated['clip'] is None and updated['motion'] == 'unassigned'
    assert updated['history'][0]['id'] == original_object['trajectory']['id']
    assert state['workflow']['objectDefinitions'] == [] and state['workflow'].get('exportJobId') is None
    assert state['camera']['id'] == project['camera']['id']
    expected = job['options']['selectionBox']
    assert all(abs(a-b)<1e-5 for a,b in zip(updated['center'],expected['center']))
    assert all(abs(a-b)<1e-5 for a,b in zip(updated['halfExtents'],expected['halfExtents']))
    assert browser.evaluate("return !document.querySelector('[aria-label=\"物体控制\"]').checked;")
    result.update(realSlurmAssociation=True, slurmId=job.get('slurmId'), jobId=job['id'], environment='depthpro',
                  automaticReplacementAfterReload=True, objectIdRetained=True, trajectoryClearedWithHistory=True,
                  cameraPreservedAfterBoxEdit=True, webgl2Available=browser.evaluate("return !!document.createElement('canvas').getContext('webgl2');"))
    browser.scroll_to(browser.find('.dcp-object-card')); browser.screenshot('03-box-applied.png')
    save('applied-project.json', saved())
    browser.command('WebDriver:Navigate', {'url': 'about:blank'})
    browser.command('WebDriver:Navigate', {'url': base+'/'})
    wait('return '+saved_js+'.objects[0].reconstruction.jobId==='+json.dumps(job['id'])+';', 'final reload')
    save('applied-project.json', saved())
    result['succeeded'] = True
except Exception as error:
    result['error'] = str(error)
    try:
        result['failureUrl'] = browser.command('WebDriver:GetCurrentURL')
        browser.screenshot('failure.png')
        (folder/'failure-page.txt').write_text(browser.evaluate('return document.body.innerText;'))
        save('failure-project.json', saved())
    except Exception:
        pass
finally:
    browser.close(); save('result.json', result)
print(json.dumps(result, ensure_ascii=False), flush=True)
if not result['succeeded']: raise SystemExit(1)
