"""Real Firefox checks; isolated localStorage, no GPU submission or user edits."""
import copy
import json
import time
from pathlib import Path
from browser_marionette import Browser

ROOT = Path(__file__).resolve().parents[1]
folder = ROOT/'var/validation/20260911-motion/browser-check'
folder.mkdir(parents=True, exist_ok=True)
project = json.loads((folder.parent/'project.json').read_text())
project['generation']['submissions'] = []
for draft in project['generation']['projectProfiles']: draft['execution']['envName'] = 'base'
second = copy.deepcopy(project)
second.update(id='motion-browser-empty', name='切换检查空项目', reference=None, workflow=None, objects=[], geometryReady=False,
              fourD='missing', camera=None, cameraClip=None, cameraIntrinsics=None, referenceCamera=None, cameraHistory=[])
second.pop('workflow')
browser = Browser(folder/'browser')
base = 'http://127.0.0.1:8000'
result = {'succeeded': False, 'gpuJobsSubmitted': 0}


def wait(script, label, timeout=50):
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        value=browser.evaluate(script)
        if value: return value
        time.sleep(.3)
    raise RuntimeError('Timeout: '+label)


try:
    browser.command('WebDriver:Navigate', {'url': base+'/login'})
    status=browser.asynchronous("const done=arguments[arguments.length-1]; fetch('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:arguments[0]})}).then(r=>done(r.status));",[(ROOT/'var/access-token').read_text().strip()])
    assert status==200
    browser.evaluate("localStorage.setItem('diffusioncontrol.prototype.v2',JSON.stringify(arguments[0]));",[[project,second]])
    browser.command('WebDriver:Navigate',{'url':base+'/'})
    wait("return document.querySelector('[aria-label=\"物体控制\"]')?.checked && document.querySelector('[aria-label=\"相机控制\"]')?.checked;",'automatic controls')
    browser.click('.generation-connect')
    wait("return Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='执行推理' && !b.disabled);",'ready generation')
    env=browser.evaluate("return document.querySelector('input[id$=\"-slurm-env\"]').value;")
    assert env=='symphomotion',env
    result['legacyEnvironmentRepaired']=True
    assert browser.evaluate("return !!document.querySelector('[id$=\"field-obj_injector_path\"]') && !!document.querySelector('[aria-label=\"相机控制参数\"]');")
    browser.click('[aria-label="物体控制"]')
    wait("return !document.querySelector('[id$=\"field-obj_injector_path\"]');",'hide object fields')
    assert browser.evaluate("return document.body.innerText.includes('重新导出 Rendered Frames');")
    browser.click('[aria-label="相机控制"]')
    wait("return !document.querySelector('[aria-label=\"相机控制参数\"]');",'hide camera fields')
    saved=browser.evaluate("return JSON.parse(localStorage.getItem('diffusioncontrol.prototype.v2'))[0];")
    assert saved['camera'] and saved['objects'][0]['trajectory']
    assert saved['motionControls']['object']['enabled'] is False and saved['motionControls']['camera']['enabled'] is False
    result.update(switchesHideParameters=True, disabledTracksRetained=True, staleExportBlocked=True)
    browser.screenshot('01-controls-disabled.png')
    browser.command('WebDriver:Refresh')
    wait("return document.querySelector('[aria-label=\"物体控制\"]') && !document.querySelector('[aria-label=\"物体控制\"]').checked && !document.querySelector('[aria-label=\"相机控制\"]').checked;",'persisted switches')
    result['switchesPersistAfterReload']=True
    browser.click('[aria-label="物体控制"]'); browser.click('[aria-label="相机控制"]')
    wait("return document.querySelector('[id$=\"field-obj_injector_path\"]') && document.querySelector('[aria-label=\"相机控制参数\"]');",'restored fields')
    browser.click('.generation-connect')
    wait("return Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='执行推理' && !b.disabled);",'restored valid binding')
    result['restoredConditionsExecutable']=True
    browser.screenshot('02-controls-enabled.png')
    browser.evaluate("const el=document.querySelector('[aria-label=\"切换项目\"]');el.value='motion-browser-empty';el.dispatchEvent(new Event('change',{bubbles:true}));")
    wait("return document.querySelector('[aria-label=\"物体控制\"]')?.disabled && !document.querySelector('[aria-label=\"物体控制\"]').checked;",'no trajectory controls')
    browser.evaluate("const el=document.querySelector('[aria-label=\"切换项目\"]');el.value=arguments[0];el.dispatchEvent(new Event('change',{bubbles:true}));",[project['id']])
    wait("return document.querySelector('[aria-label=\"物体控制\"]')?.checked;",'back to moving project')
    browser.click('[aria-label="物体控制"]')
    wait("return !document.querySelector('[aria-label=\"物体控制\"]').checked;",'live handlers after switching')
    result['switchAfterProjectRoundTrip']=True
    result['webgl2Available']=browser.evaluate("return !!document.createElement('canvas').getContext('webgl2');")
    result['succeeded']=True
except Exception as error:
    result['error']=str(error)
    try:
        browser.screenshot('failure.png')
        (folder/'failure-page.txt').write_text(browser.evaluate('return document.body.innerText;'))
        (folder/'failure-workspace.json').write_text(browser.evaluate("return localStorage.getItem('diffusioncontrol.prototype.v2');"))
    except Exception: pass
finally:
    browser.close()
    (folder/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(result,ensure_ascii=False),flush=True)
if not result['succeeded']: raise SystemExit(1)
