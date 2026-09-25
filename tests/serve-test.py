#!/usr/bin/env python3
"""Local test server. It never touches the real project document.

From the repo root:
  python3 tests/serve-test.py [--emulator] [port]        default port 8010, open http://localhost:8010

Always:
- Sends Cache-Control: no-store on everything. Otherwise Chrome keeps running an old app.js after an
  edit, and a test silently checks old code (this happened on madrid-trip).
- Rewrites app.js as it's served, so the page reads and writes
  users/{uid}/projects/madrid-field-trial-test instead of madrid-field-trial, with its own timer key,
  and adds a red TEST bar to the page. Files on disk are never modified.
- Listens on 127.0.0.1 only: the folder holds source-artifact.html, which is real data.

--emulator: fully offline, no real project and no Google account involved.
- Serves a demo firebase-config.js and points firebase.js at the local Auth and Firestore emulators.
  Start them first:
    firebase emulators:start --only auth,firestore --project demo-projects-app
- Creates the test login test@example.com / test-password in the Auth emulator, with the UID that
  firestore.rules allows, so the real rules apply unchanged. (Changed the UID in the rules? Restart
  the emulators, which start empty, and this server.)
- Adds tests/fake-google.js, a stand-in for Google sign-in and the Calendar API. See the top of that
  file for how to switch its behavior from the browser console.
"""
import http.server
import json
import os
import re
import sys
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEMO_PROJECT = 'demo-projects-app'
TEST_EMAIL, TEST_PASSWORD = 'test@example.com', 'test-password'

EMULATOR = '--emulator' in sys.argv
ports = [a for a in sys.argv[1:] if not a.startswith('--')]
PORT = int(ports[0]) if ports else 8010

REWRITES = {
    '/app.js': [
        ("const PROJECT_ID='madrid-field-trial';", "const PROJECT_ID='madrid-field-trial-test';"),
        ("const LS_TIMER='madrid-dash-timer';", "const LS_TIMER='madrid-dash-timer-test';"),
    ],
    '/index.html': [
        ('<body>', '<body>\n<div style="position:sticky;top:0;z-index:9;background:#B8352C;color:#fff;'
                   'text-align:center;font:700 13px/1.8 system-ui,sans-serif">TEST: madrid-field-trial-test'
                   + (' (emulator)' if EMULATOR else '') + '</div>'),
    ],
}
if EMULATOR:
    REWRITES['/firebase.js'] = [
        ('import { getAuth, ', 'import { getAuth, connectAuthEmulator, '),
        ('import { getFirestore, ', 'import { getFirestore, connectFirestoreEmulator, '),
        ('const db = getFirestore(app);',
         "const db = getFirestore(app);\n"
         "connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });\n"
         "connectFirestoreEmulator(db, '127.0.0.1', 8080);"),
    ]
    REWRITES['/index.html'].append(('</head>', '<script src="tests/fake-google.js"></script>\n</head>'))

DEMO_CONFIG = ('export const firebaseConfig = { apiKey: "demo-key", authDomain: "%s.firebaseapp.com", '
               'projectId: "%s", appId: "demo-app" };\n' % (DEMO_PROJECT, DEMO_PROJECT))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, max-age=0')
        super().end_headers()

    def do_GET(self):
        path = self.path.split('?')[0]
        if path == '/':
            path = '/index.html'
        if EMULATOR and path == '/firebase-config.js':
            return self.send_text(DEMO_CONFIG, 'text/javascript')
        if path in REWRITES:
            with open(os.path.join(ROOT, path.lstrip('/')), encoding='utf-8') as f:
                src = f.read()
            for old, new in REWRITES[path]:
                if old not in src:
                    return self.send_error(500, 'serve-test.py: %s no longer contains %r' % (path, old))
                src = src.replace(old, new, 1)
            return self.send_text(src, 'text/html' if path.endswith('.html') else 'text/javascript')
        super().do_GET()

    def send_text(self, text, ctype):
        body = text.encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', ctype + '; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


def ensure_test_user():
    with open(os.path.join(ROOT, 'firestore.rules'), encoding='utf-8') as f:
        uid = re.search(r"request\.auth\.uid == '([^']+)'", f.read()).group(1)
    req = urllib.request.Request(
        'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/projects/%s/accounts' % DEMO_PROJECT,
        data=json.dumps({'localId': uid, 'email': TEST_EMAIL, 'password': TEST_PASSWORD}).encode(),
        method='POST', headers={'Content-Type': 'application/json', 'Authorization': 'Bearer owner'})
    try:
        urllib.request.urlopen(req).read()
        print('Test login created: %s / %s (uid %s)' % (TEST_EMAIL, TEST_PASSWORD, uid))
    except urllib.error.HTTPError as err:
        msg = err.read().decode(errors='replace')
        if 'DUPLICATE' in msg or 'EXISTS' in msg:
            print('Test login already exists: %s / %s (uid %s)' % (TEST_EMAIL, TEST_PASSWORD, uid))
        else:
            print('Could not create the test login (HTTP %d): %s' % (err.code, msg))
    except urllib.error.URLError as err:
        print('The Auth emulator is not reachable (%s). Start it first:\n'
              '  firebase emulators:start --only auth,firestore --project %s' % (err.reason, DEMO_PROJECT))


if __name__ == '__main__':
    if EMULATOR:
        ensure_test_user()
    http.server.ThreadingHTTPServer.allow_reuse_address = True
    with http.server.ThreadingHTTPServer(('127.0.0.1', PORT), Handler) as srv:
        print('Serving %s at http://localhost:%d%s' % (ROOT, PORT, ' (emulator mode)' if EMULATOR else ''))
        srv.serve_forever()
