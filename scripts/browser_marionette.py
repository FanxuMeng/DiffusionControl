"""Small stdlib client for the installed Firefox's local Marionette interface.

Protocol: https://firefox-source-docs.mozilla.org/remote/marionette/Protocol.html
All profile, cache and diagnostic output is confined to the supplied project folder.
"""
import base64
import json
import os
import socket
import subprocess
import time


class Browser:
    def __init__(self, folder, port=28283):
        self.folder, self.sequence = folder, 0
        folder.mkdir(parents=True, exist_ok=True)
        profile = folder/'profile'
        profile.mkdir(exist_ok=True)
        prefs = {'marionette.port': port, 'marionette.enabled': True, 'browser.shell.checkDefaultBrowser': False,
                 'browser.startup.homepage': 'about:blank', 'browser.startup.page': 0, 'browser.aboutwelcome.enabled': False,
                 'browser.newtabpage.enabled': False, 'browser.newtabpage.activity-stream.feeds.telemetry': False,
                 'datareporting.healthreport.uploadEnabled': False, 'toolkit.telemetry.enabled': False,
                 'app.update.enabled': False, 'extensions.update.enabled': False,
                 'browser.tabs.warnOnClose': False, 'webgl.force-enabled': True,
                 'gfx.webrender.software': True, 'network.proxy.type': 0}
        (profile/'user.js').write_text('\n'.join('user_pref(%s, %s);' % (json.dumps(k), json.dumps(v)) for k, v in prefs.items()))
        environment = dict(os.environ, MOZ_HEADLESS='1', MOZ_HEADLESS_WIDTH='1440', MOZ_HEADLESS_HEIGHT='1080',
                           LIBGL_ALWAYS_SOFTWARE='1', XDG_CACHE_HOME=str(folder/'cache'), XDG_CONFIG_HOME=str(folder/'config'), TMPDIR=str(folder/'tmp'))
        for name in ('cache', 'config', 'tmp'): (folder/name).mkdir(exist_ok=True)
        self.log = (folder/'firefox.log').open('ab')
        self.process = subprocess.Popen(['firefox', '--headless', '--no-remote', '--marionette', '--profile', str(profile), 'about:blank'],
            stdin=subprocess.DEVNULL, stdout=self.log, stderr=subprocess.STDOUT, env=environment)
        self.socket = None
        try:
            for _ in range(60):
                if self.process.poll() is not None: raise RuntimeError('Firefox exited; inspect browser/firefox.log')
                try:
                    self.socket = socket.create_connection(('127.0.0.1', port), timeout=1)
                    break
                except OSError: time.sleep(.5)
            if self.socket is None: raise RuntimeError('Marionette did not start')
            self.socket.settimeout(45)
            self.receive()
            self.command('WebDriver:NewSession', {'capabilities': {'alwaysMatch': {'acceptInsecureCerts': True}}})
            self.command('WebDriver:SetWindowRect', {'width': 1440, 'height': 1080})
        except Exception:
            self.close(); raise

    def receive(self):
        length = b''
        while not length.endswith(b':'):
            block = self.socket.recv(1)
            if not block: raise RuntimeError('Firefox disconnected')
            length += block
        remaining = int(length[:-1]); parts = []
        while remaining:
            part = self.socket.recv(remaining)
            if not part: raise RuntimeError('Firefox disconnected during response')
            parts.append(part); remaining -= len(part)
        return json.loads(b''.join(parts))

    def command(self, name, parameters=None):
        self.sequence += 1
        data = json.dumps([0, self.sequence, name, parameters or {}]).encode()
        self.socket.sendall(str(len(data)).encode()+b':'+data)
        response = self.receive()
        if response[2]: raise RuntimeError(response[2]['error']+': '+response[2]['message'])
        result = response[3]
        return result.get('value', result) if isinstance(result, dict) else result

    def evaluate(self, script, args=None):
        return self.command('WebDriver:ExecuteScript', {'script': script, 'args': args or [], 'newSandbox': False, 'sandbox': None})

    def asynchronous(self, script, args=None):
        return self.command('WebDriver:ExecuteAsyncScript', {'script': script, 'args': args or [], 'newSandbox': False, 'sandbox': None, 'scriptTimeout': 40000})

    def find(self, selector, using='css selector'):
        result = self.command('WebDriver:FindElement', {'using': using, 'value': selector})
        return result.get('element-6066-11e4-a52e-4f735466cecf', result.get('ELEMENT'))

    def click(self, selector, using='css selector'):
        element = self.find(selector, using)
        self.scroll_to(element)
        self.command('WebDriver:ElementClick', {'id': element})

    def scroll_to(self, element):
        # Scroll nested panels and settle layout before sending a native click.
        self.evaluate("arguments[0].scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});", [{'element-6066-11e4-a52e-4f735466cecf': element}])
        time.sleep(.4)

    def fill(self, selector, text, using='css selector'):
        element = self.find(selector, using)
        self.scroll_to(element)
        self.command('WebDriver:ElementClear', {'id': element})
        time.sleep(.2)  # Allow controlled React inputs to commit the clear event.
        self.command('WebDriver:ElementSendKeys', {'id': element, 'text': text, 'value': list(text)})
        time.sleep(.2)

    def screenshot(self, name):
        data = self.command('WebDriver:TakeScreenshot', {'id': None, 'highlights': [], 'full': False})
        (self.folder.parent/name).write_bytes(base64.b64decode(data))

    def close(self):
        if self.socket:
            try: self.command('WebDriver:DeleteSession')
            except Exception: pass
            self.socket.close()
        if self.process.poll() is None:
            self.process.terminate()
            try: self.process.wait(timeout=15)
            except subprocess.TimeoutExpired: self.process.kill(); self.process.wait()
        self.log.close()
