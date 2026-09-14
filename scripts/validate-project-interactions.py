#!/usr/bin/env python3
"""Real Firefox UI test using the earlier dedicated truck validation project.

Submits ONE real associate job with --submit-association; never changes user
projects or cluster project snapshots. All browser state stays in this folder.
"""
import argparse
import copy
import json
import time
from pathlib import Path
from browser_marionette import Browser

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--port', type=int, default=5192)
parser.add_argument('--submit-association', action='store_true')
args = parser.parse_args()
folder = ROOT/'var/validation/20260910-project-interactions'
folder.mkdir(parents=True, exist_ok=True)
base = 'http://127.0.0.1:'+str(args.port)
project = json.loads((ROOT/'var/validation/20260910-workflow-resume/http-workflow-ready/frontend-project.json').read_text())
assert project['id'] == 'workflow-validation-7d765556596b'
project.update(name='浏览器交互验收', objects=[], geometryReady=False, referenceCamera=None, cameraIntrinsics=None,
               fourD='missing', camera=None, cameraClip=None, cameraHistory=[])
project['workflow'] = {key: value for key, value in project['workflow'].items() if key in ('version', 'referenceAssetId', 'width', 'height')}
project['workflow']['pending'] = []
second = copy.deepcopy(project)
second.update(id='browser-switch-verification', name='切换验证空项目', workflow=None, reference=None)
second.pop('workflow')
result = {'succeeded': False, 'gpuJobsSubmitted': 0, 'projectId': project['id']}
browser = Browser(folder/'browser')

def wait(script, description, timeout=40):
    deadline = time.monotonic()+timeout
    while time.monotonic() < deadline:
        value = browser.evaluate(script)
        if value: return value
        time.sleep(.4)
    raise RuntimeError('Timed out: '+description)

try:
    browser.command('WebDriver:Navigate', {'url': base+'/login'})
    status = browser.asynchronous("const done=arguments[arguments.length-1]; fetch('/api/session', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({token:arguments[0]})}).then(r=>done(r.status)).catch(e=>done(String(e)));", [(ROOT/'var/access-token').read_text().strip()])
    assert status == 200, status
    browser.evaluate("localStorage.setItem('diffusioncontrol.prototype.v2', JSON.stringify(arguments[0]));", [[project, second]])
    browser.command('WebDriver:Navigate', {'url': base+'/'})
    wait("return JSON.parse(localStorage.getItem('diffusioncontrol.prototype.v2'))[0].geometryReady;", 'automatic completed depth binding')
    result['automaticDepthBinding'] = True
    print('Completed Depth Pro result automatically bound after page load', flush=True)
    browser.click('.view-tabs button:nth-child(2)')
    wait("return document.querySelector('.view-tabs button:nth-child(2)').getAttribute('aria-selected')==='true';", '3D view activation')
    result['threeDViewSelectable'] = True
    result['webgl2Available'] = browser.evaluate("return !!document.createElement('canvas').getContext('webgl2');")
    browser.screenshot('01-depth-3d.png')
    browser.evaluate("const el=document.querySelector('[aria-label=\"切换项目\"]'); el.value=arguments[0]; el.dispatchEvent(new Event('change',{bubbles:true}));", [second['id']])
    wait("return document.querySelector('.scene-viewport').textContent.includes('导入你的首帧参考图');", 'switch to empty project')
    browser.evaluate("const el=document.querySelector('[aria-label=\"切换项目\"]'); el.value=arguments[0]; el.dispatchEvent(new Event('change',{bubbles:true}));", [project['id']])
    wait("return document.querySelector('.dcp-project-card[aria-pressed=\"true\"]')?.getAttribute('aria-label')==='打开项目 浏览器交互验收';", 'switch back')
    result['projectSwitching'] = True
    browser.click('[aria-label="重命名项目 浏览器交互验收"]')
    browser.fill('[aria-label="项目场景名称"]', '卡车正式交互验证')
    browser.click('[aria-label="保存项目名称"]')
    wait("return document.querySelector('[aria-label=\"切换项目\"] option:checked').textContent==='卡车正式交互验证';", 'renamed header option')
    result['renamePersisted'] = browser.evaluate("return JSON.parse(localStorage.getItem('diffusioncontrol.prototype.v2'))[0].name==='卡车正式交互验证';")
    wait("return document.querySelectorAll('.workflow-candidates button').length>0;", 'SAM2 candidates')
    time.sleep(.5)
    browser.evaluate("window.candidateEvents=[];document.addEventListener('click',e=>candidateEvents.push({tag:e.target.tagName,text:e.target.textContent.slice(0,80),src:e.target.getAttribute('src'),button:e.target.closest('button')?.textContent}),true);")
    result['candidateBeforeClick'] = browser.evaluate("const e=document.querySelector('.workflow-candidates button');return {disabled:e.disabled,rect:e.getBoundingClientRect().toJSON()};")
    browser.click('.workflow-candidates button')
    time.sleep(.5)
    result['candidateClickEvents'] = browser.evaluate("return window.candidateEvents;")
    print('Candidate click:', result['candidateBeforeClick'], result['candidateClickEvents'], flush=True)
    result['candidateSelected'] = wait("return document.querySelector('.workflow-candidates button').getAttribute('aria-pressed')==='true';", 'candidate click committed')
    browser.fill('//label[contains(., "物体名称")]/input', '交互验证卡车', 'xpath')
    browser.fill('//label[contains(., "物体描述与运动提示")]/textarea', 'A silver pickup truck.', 'xpath')
    browser.screenshot('02-candidate-definition.png')
    if args.submit_association:
        button = '//button[text()="添加物体"]'
        wait("return [...document.querySelectorAll('button')].some(b=>b.textContent==='添加物体' && !b.disabled);", 'association button ready')
        browser.click(button, 'xpath')
        result['gpuJobsSubmitted'] = 1
        wait("return document.querySelector('.dcp-object-pending')?.textContent.includes('交互验证卡车');", 'pending object card')
        result['pendingObjectVisible'] = True
        browser.screenshot('03-object-pending.png')
        # A page reload proves that the definition and request survive loss of panel state.
        browser.command('WebDriver:Refresh')
        print('Association submitted; waiting for Slurm and automatic application after reload', flush=True)
        deadline = time.monotonic()+600
        previous = None
        while time.monotonic() < deadline:
            stored = browser.evaluate("return JSON.parse(localStorage.getItem('diffusioncontrol.prototype.v2'))[0];")
            if any(obj['name'] == '交互验证卡车' for obj in stored['objects']): break
            status = browser.evaluate("return document.querySelector('.dcp-object-pending')?.textContent || ''; ")
            if status != previous:
                print('Object status:', status[:250], flush=True); previous = status
            if any(word in status for word in ('关联失败', '提交失败', '无法应用结果', '已取消')): raise RuntimeError(status)
            time.sleep(2)
        else: raise RuntimeError('Association did not complete in 600 seconds; job is retained')
        obj = next(obj for obj in stored['objects'] if obj['name'] == '交互验证卡车')
        result.update(automaticObjectApplication=True, objectId=obj['id'], associationJobId=obj['reconstruction']['jobId'])
        (folder/'restored-browser-project.json').write_text(json.dumps(stored, ensure_ascii=False, indent=2))
        browser.click('//button[contains(@class,"dcp-object-heading") and contains(.,"交互验证卡车")]', 'xpath')
        browser.screenshot('04-object-applied.png')
        browser.command('WebDriver:Refresh')
        wait("return !!document.querySelector('[aria-label=\"切换项目\"]');", 'second reload')
        time.sleep(6)
        result['noDuplicateAfterReload'] = browser.evaluate("return JSON.parse(localStorage.getItem('diffusioncontrol.prototype.v2'))[0].objects.filter(o=>o.name==='交互验证卡车').length===1;")
        assert result['noDuplicateAfterReload']
    result['succeeded'] = True
except Exception as error:
    result['error'] = str(error)
    try:
        browser.screenshot('failure.png')
        (folder/'failure-page.txt').write_text(browser.evaluate('return document.body.innerText;'))
    except Exception: pass
    raise
finally:
    (folder/'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
    browser.close()
    print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)
