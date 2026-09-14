"""Exercise object deletion against existing assets in an isolated Firefox workspace.

No submission, cancellation, snapshot save, or model environment changes.
"""
import copy
import json
import time
from pathlib import Path
from browser_marionette import Browser

ROOT = Path(__file__).resolve().parents[1]
folder = ROOT / 'var/validation/20260911-object-deletion'
folder.mkdir(parents=True, exist_ok=True)
project = json.loads((ROOT / 'var/validation/20260911-motion/project.json').read_text())
project['generation']['submissions'] = []
obj = project['objects'][0]
request = json.loads((ROOT / 'projects' / project['id'] / 'jobs' / obj['reconstruction']['jobId'] / 'request.json').read_text())
definition = dict(id=obj['id'], name=obj['name'], prompt=obj['prompt'], requestId=request['requestId'],
                  createdAt=request['createdAt'], sceneJobId=request['inputs']['sceneJobId'],
                  segmentationJobId=request['inputs']['segmentationJobId'], candidate=request['options']['candidate'])
project['workflow']['objectDefinitions'] = [definition]
second = copy.deepcopy(project)
second.update(id='object-deletion-browser-empty', name='删除验证另一项目', reference=None, objects=[], geometryReady=False,
              fourD='missing', camera=None, cameraClip=None, cameraIntrinsics=None, referenceCamera=None, cameraHistory=[])
second.pop('workflow')
browser = Browser(folder / 'browser', port=28284)
base = 'http://127.0.0.1:8000'
result = {'succeeded': False, 'gpuJobsSubmitted': 0, 'projectId': project['id']}
saved_js = "JSON.parse(localStorage.getItem('diffusioncontrol.prototype.v2'))[0]"


def wait(script, label, timeout=40):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = browser.evaluate(script)
        if value:
            return value
        time.sleep(.3)
    raise RuntimeError('Timeout: ' + label)


def job_state():
    return browser.asynchronous("""const done=arguments[arguments.length-1];
      fetch('/api/inference/jobs/'+arguments[0]).then(async r=>done({status:r.status,job:await r.json()}));
      """, [obj['reconstruction']['jobId']])


def assert_deleted():
    state = browser.evaluate('return ' + saved_js + ';')
    assert state['objects'] == [] and state['workflow']['objectDefinitions'] == []
    assert state['workflow'].get('exportJobId') is None and state['fourD'] == 'stale'
    assert state['workflow']['sceneJobId'] == project['workflow']['sceneJobId']
    assert state['camera']['id'] == project['camera']['id']
    assert state['geometryReady'] is True
    assert browser.evaluate("return document.querySelector('[aria-label=\"物体控制\"]').disabled && !document.querySelector('[aria-label=\"物体控制\"]').checked;")
    assert browser.evaluate("return document.querySelector('[aria-label=\"相机控制\"]').checked;")
    return state


try:
    browser.command('WebDriver:Navigate', {'url': base + '/login'})
    status = browser.asynchronous("""const done=arguments[arguments.length-1];
      fetch('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:arguments[0]})})
      .then(r=>done(r.status));""", [(ROOT / 'var/access-token').read_text().strip()])
    assert status == 200
    browser.evaluate("localStorage.setItem('diffusioncontrol.prototype.v2',JSON.stringify(arguments[0]));", [[project, second]])
    browser.command('WebDriver:Navigate', {'url': base + '/'})
    wait("return document.querySelectorAll('.dcp-object-delete').length===1 && document.querySelector('[aria-label=\"物体控制\"]')?.checked;", 'object and controls')
    before_job = job_state()
    assert before_job['status'] == 200 and before_job['job']['status'] == 'succeeded'
    browser.click('.generation-connect')
    wait("return Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='执行推理'&&!b.disabled);", 'valid original generation binding')
    browser.click('.dcp-object-heading')
    browser.click('.dcp-record-action')
    wait("return document.querySelector('.target-label').textContent.includes('验证卡车');", 'armed object target')
    browser.click('.dcp-object-heading')
    assert browser.evaluate("return document.querySelector('.dcp-object-heading').getAttribute('aria-expanded')==='false' && !document.querySelector('.dcp-object-delete').closest('.dcp-object-heading');")
    browser.scroll_to(browser.find('.dcp-object-delete'))
    browser.screenshot('01-object-delete-button.png')

    browser.click('.dcp-object-delete')
    dialog = browser.command('WebDriver:GetAlertText')
    assert obj['name'] in dialog and '运行任务继续执行' in dialog
    browser.command('WebDriver:DismissAlert')
    kept = browser.evaluate('return ' + saved_js + ';')
    assert kept['objects'][0]['id'] == obj['id'] and kept['workflow']['exportJobId'] == project['workflow']['exportJobId']
    assert kept['workflow']['objectDefinitions'] == [definition]
    result['cancelKeepsObjectAndExport'] = True

    browser.click('.dcp-object-delete')
    browser.command('WebDriver:AcceptAlert')
    wait("return !!document.querySelector('.dcp-empty-objects') && !document.querySelector('.dcp-object-delete');", 'deleted object')
    state = assert_deleted()
    assert browser.evaluate("return !document.querySelector('.target-label').textContent.includes('验证卡车');")
    assert not browser.evaluate("return !!document.querySelector('[id$=\"field-obj_injector_path\"]');")
    assert browser.evaluate("return Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='执行推理'&&b.disabled);")
    assert browser.evaluate("return document.body.innerText.includes('请先导出 Rendered Frames');")
    result.update(deleteFromCollapsedCard=True, armedTargetCleared=True, lastObjectDisablesOMM=True,
                  cameraPreserved=True, generationRequiresNewExport=True)
    browser.scroll_to(browser.find('.dcp-empty-objects'))
    browser.screenshot('02-object-deleted.png')

    browser.command('WebDriver:Refresh')
    wait("return !!document.querySelector('.dcp-empty-objects') && !!document.querySelector('[aria-label=\"物体控制\"]');", 'deleted state after reload')
    # Cross at least two normal workflow poll boundaries; successful old jobs remain visible.
    time.sleep(11)
    assert_deleted()
    result['noResurrectionAfterRefreshAndPolling'] = True
    browser.evaluate("const el=document.querySelector('[aria-label=\"切换项目\"]');el.value=arguments[0];el.dispatchEvent(new Event('change',{bubbles:true}));", [second['id']])
    wait("return document.querySelector('[aria-label=\"切换项目\"]').value==='object-deletion-browser-empty';", 'other project')
    browser.evaluate("const el=document.querySelector('[aria-label=\"切换项目\"]');el.value=arguments[0];el.dispatchEvent(new Event('change',{bubbles:true}));", [project['id']])
    wait("return document.querySelector('[aria-label=\"切换项目\"]').value!=='object-deletion-browser-empty' && !!document.querySelector('.dcp-empty-objects');", 'return to project')
    assert_deleted()
    result['deletionSurvivesProjectSwitch'] = True

    pending = dict(definition, id='pending-object-deletion', name='待关联物体删除验证', requestId='pending-delete-validation')
    # Seed on the login document so the mounted app cannot autosave over this fixture.
    browser.command('WebDriver:Navigate', {'url': 'about:blank'})
    browser.command('WebDriver:Navigate', {'url': base + '/login'})
    state['workflow']['objectDefinitions'] = [pending]
    browser.evaluate("localStorage.setItem('diffusioncontrol.prototype.v2',JSON.stringify(arguments[0]));", [[state, second]])
    browser.command('WebDriver:Navigate', {'url': base + '/'})
    wait("return !!document.querySelector('.dcp-object-pending .dcp-object-delete');", 'pending definition')
    browser.click('.dcp-object-pending .dcp-object-delete')
    assert pending['name'] in browser.command('WebDriver:GetAlertText')
    browser.command('WebDriver:AcceptAlert')
    wait("return !document.querySelector('.dcp-object-pending') && !!document.querySelector('.dcp-empty-objects');", 'removed pending definition')
    state = assert_deleted()
    result['pendingDefinitionDeletion'] = True
    after_job = job_state()
    assert before_job == after_job
    result['clusterAssociationJobAndOutputsRetained'] = True
    result['webgl2Available'] = browser.evaluate("return !!document.createElement('canvas').getContext('webgl2');")
    (folder / 'deleted-project.json').write_text(json.dumps(state, ensure_ascii=False, indent=2) + '\n')
    result['succeeded'] = True
except Exception as error:
    result['error'] = str(error)
    try:
        result['failureUrl'] = browser.command('WebDriver:GetCurrentURL')
    except Exception:
        pass
    try:
        browser.screenshot('failure.png')
        (folder / 'failure-page.txt').write_text(browser.evaluate('return document.body.innerText;'))
        (folder / 'failure-workspace.json').write_text(browser.evaluate("return localStorage.getItem('diffusioncontrol.prototype.v2');"))
    except Exception:
        pass
finally:
    browser.close()
    (folder / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(result, ensure_ascii=False), flush=True)
if not result['succeeded']:
    raise SystemExit(1)
