"""Check local box inputs and the canonical request in an isolated browser; no Slurm submission."""
import json
import math
import time
from pathlib import Path
from browser_marionette import Browser

ROOT = Path(__file__).resolve().parents[1]
folder = ROOT/'var/validation/20260911-box-local'
folder.mkdir(parents=True, exist_ok=True)
project = json.loads((ROOT/'var/validation/20260911-motion/project.json').read_text())
project['generation']['submissions'] = []
original = project['objects'][0]
result = {'succeeded': False, 'submittedToSlurm': False, 'projectId': project['id']}
browser = Browser(folder/'browser', port=28286)


def save(name, value):
    (folder/name).write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n')


def wait(script, label):
    end = time.monotonic()+40
    while time.monotonic()<end:
        value = browser.evaluate(script)
        if value: return value
        time.sleep(.2)
    raise AssertionError('Timeout: '+label)


def field(label):
    return '[aria-label="包围盒'+label+'"]'


def value(label):
    return browser.evaluate('return document.querySelector(arguments[0]).value;', [field(label)])


def keys(label, text):
    element = browser.find(field(label))
    browser.command('WebDriver:ElementSendKeys', {'id': element, 'text': text, 'value': list(text)})
    time.sleep(.2)


def commit(label):
    keys(label, '\ue007')  # Native Enter; relative value resets, preview is retained.
    assert value(label) == '0', (label, value(label))


def multiply(a, b):
    x, y, z, w = a
    X, Y, Z, W = b
    return [w*X+x*W+y*Z-z*Y, w*Y-x*Z+y*W+z*X, w*Z+x*Y-y*X+z*W, w*W-x*X-y*Y-z*Z]


def rotate(q, axis, degrees):
    delta = [0, 0, 0, math.cos(math.radians(degrees)/2)]
    delta[axis] = math.sin(math.radians(degrees)/2)
    return multiply(q, delta)


def translate(center, q, axis, amount):
    v = [0, 0, 0, 0]
    v[axis] = amount
    moved = multiply(multiply(q, v), [-q[0], -q[1], -q[2], q[3]])
    return [a+b for a, b in zip(center, moved)]


try:
    browser.command('WebDriver:Navigate', {'url': 'http://127.0.0.1:8000/login'})
    status = browser.asynchronous("const done=arguments[arguments.length-1];fetch('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:arguments[0]})}).then(r=>done(r.status));", [(ROOT/'var/access-token').read_text().strip()])
    assert status == 200
    browser.evaluate("localStorage.setItem('diffusioncontrol.prototype.v2',JSON.stringify([arguments[0]]));", [project])
    browser.command('WebDriver:Navigate', {'url': 'http://127.0.0.1:8000/'})
    wait("return !!document.querySelector('.dcp-object-card');", 'object panel')
    browser.click("//button[@role='tab' and contains(.,'3D View')]", using='xpath')
    # Install before any edits. Reject every mutating request at the browser boundary.
    browser.evaluate("""
      const originalFetch=window.fetch.bind(window);
      window.boxTestRequests=[]; window.boxTestBlocked=[];
      window.fetch=(resource, options={})=>{
        const method=(options.method || resource.method || 'GET').toUpperCase();
        const url=new URL(typeof resource==='string'?resource:resource.url,location.href);
        if (!['GET','HEAD'].includes(method)) {
          window.boxTestBlocked.push({method,path:url.pathname});
          if (url.pathname==='/api/workflow/jobs' && method==='POST') window.boxTestRequests.push(JSON.parse(options.body));
          return Promise.resolve(new Response(JSON.stringify({message:'Browser validation: request captured, no job submitted.'}),{status:422,headers:{'Content-Type':'application/json'}}));
        }
        return originalFetch(resource, options);
      };
    """)
    browser.click('[aria-label="编辑物体包围盒"]')
    browser.fill(field('相对位移 X'), '.1')
    browser.click('[aria-label="取消包围盒编辑"]')
    assert browser.evaluate("return JSON.parse(localStorage.getItem('diffusioncontrol.prototype.v2'))[0].objects[0].center;") == original['center']
    result['cancelPreservesOriginal'] = True
    browser.click('[aria-label="编辑物体包围盒"]')
    browser.fill(field('相对旋转 X'), '33')
    browser.fill(field('边长 X'), '3.75')
    browser.click("//section[@aria-label='3D 包围盒编辑']//button[contains(.,'重置草稿')]", using='xpath')
    assert value('相对旋转 X') == '0'
    assert abs(float(value('边长 X'))-original['halfExtents'][0]*2) < 1e-6
    result['resetRestoresFields'] = True

    center, q = list(original['center']), list(original['boxQuaternion'])
    # Multi-digit rotation and native Enter: no 1+12 accumulation.
    browser.fill(field('相对旋转 Z'), '12')
    assert value('相对旋转 Z') == '12'
    commit('相对旋转 Z')
    q = rotate(q, 2, 12)

    browser.fill(field('相对位移 X'), '1')
    keys('相对位移 X', '2')
    assert value('相对位移 X') == '12'
    commit('相对位移 X')
    center = translate(center, q, 0, 12)
    # Re-enter the same input: reference must advance to the current draft.
    browser.fill(field('相对位移 X'), '-.5')
    commit('相对位移 X')
    center = translate(center, q, 0, -.5)
    browser.fill(field('相对旋转 Y'), '-30')
    # Focusing another input commits via blur rather than Enter.
    browser.fill(field('相对位移 Z'), '.25')
    assert value('相对旋转 Y') == '0'
    q = rotate(q, 1, -30)
    commit('相对位移 Z')
    center = translate(center, q, 2, .25)
    browser.fill(field('边长 X'), '3.75')
    browser.click('.bbox-editor-heading strong')

    # Clearing an untouched relative field disables submission until it loses focus.
    browser.click(field('相对位移 Y'))
    keys('相对位移 Y', '\ue009a\ue000\ue003')  # Ctrl+A, release modifiers, Backspace.
    assert value('相对位移 Y') == ''
    assert browser.evaluate("return document.querySelector('.bbox-editor-actions .primary-button').disabled;")
    browser.click('.bbox-editor-heading strong')
    assert value('相对位移 Y') == '0'
    assert not browser.evaluate("return document.querySelector('.bbox-editor-actions .primary-button').disabled;")
    browser.screenshot('local-inputs.png')
    browser.click('.bbox-editor-actions .primary-button')
    request = wait('return window.boxTestRequests[0];', 'intercepted selection box')
    save('captured-request.json', request)
    actual = request['options']['selectionBox']
    expected = {'center': center, 'halfExtents': [1.875, *original['halfExtents'][1:]], 'quaternion': q}
    save('expected-box.json', expected)
    for name in expected:
        assert all(abs(a-b)<1e-8 for a,b in zip(actual[name],expected[name])), (name, actual[name], expected[name])
    blocked = browser.evaluate('return window.boxTestBlocked;')
    assert blocked == [{'method': 'POST', 'path': '/api/workflow/jobs'}], blocked
    assert browser.evaluate("return JSON.parse(localStorage.getItem('diffusioncontrol.prototype.v2'))[0].objects[0].center;") == original['center']
    result.update(succeeded=True, localTranslationAfterRotation=True, localRotationComposition=True,
                  numericTypingDoesNotAccumulate=True, enterAndBlurResetDeltas=True, repeatedInputUsesCurrentFrame=True,
                  invalidRelativeInputRecovers=True, canonicalRequestMatches=True, blockedRequests=blocked,
                  webgl2Available=browser.evaluate("return !!document.createElement('canvas').getContext('webgl2');"))
except Exception as error:
    result['error'] = str(error)
    try:
        browser.screenshot('failure.png')
        (folder/'failure-page.txt').write_text(browser.evaluate('return document.body.innerText;'))
    except Exception:
        pass
finally:
    browser.close()
    save('result.json', result)
print(json.dumps(result, ensure_ascii=False), flush=True)
if not result['succeeded']: raise SystemExit(1)
