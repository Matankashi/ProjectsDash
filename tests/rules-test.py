#!/usr/bin/env python3
"""Firestore rules test against the local emulator. No dependencies.

From the repo root:
  firebase emulators:exec --only firestore --project demo-projects-app "python3 tests/rules-test.py"

A demo- project exists only inside the emulator, so this never touches the real project. The owner
UID is read from firestore.rules, so the test always checks the rules exactly as written.
"""
import base64
import json
import os
import re
import sys
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOST = os.environ.get('FIRESTORE_EMULATOR_HOST', '127.0.0.1:8080')
PROJECT = os.environ.get('GCLOUD_PROJECT', 'demo-projects-app')
DOCS = 'http://%s/v1/projects/%s/databases/(default)/documents' % (HOST, PROJECT)

with open(os.path.join(ROOT, 'firestore.rules'), encoding='utf-8') as f:
    OWNER = re.search(r"request\.auth\.uid == '([^']+)'", f.read()).group(1)
OTHER = 'someone-else'
ADMIN = object()   # the emulator's "Bearer owner" token: bypasses rules, used only to seed data


def b64(obj):
    return base64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b'=').decode()


def id_token(uid):
    # Unsigned, built the way @firebase/rules-unit-testing builds it. The emulator doesn't check
    # signatures; production would reject this outright.
    payload = {
        'iss': 'https://securetoken.google.com/' + PROJECT, 'aud': PROJECT,
        'iat': 0, 'exp': 2 ** 31 - 1, 'auth_time': 0,
        'sub': uid, 'user_id': uid,
        'firebase': {'sign_in_provider': 'password', 'identities': {}},
    }
    return b64({'alg': 'none', 'type': 'JWT'}) + '.' + b64(payload) + '.'


def call(method, path, who=None):
    body = json.dumps({'fields': {'x': {'stringValue': 'y'}}}).encode() if method == 'PATCH' else None
    req = urllib.request.Request(DOCS + '/' + path, data=body, method=method)
    req.add_header('Content-Type', 'application/json')
    if who is ADMIN:
        req.add_header('Authorization', 'Bearer owner')
    elif who:
        req.add_header('Authorization', 'Bearer ' + id_token(who))
    try:
        with urllib.request.urlopen(req) as res:
            return res.status
    except urllib.error.HTTPError as err:
        return err.code


own = 'users/%s/projects/madrid-field-trial' % OWNER
own_list = 'users/%s/projects' % OWNER
theirs = 'users/%s/projects/p' % OTHER
outside = 'misc/doc'

for path in (own, theirs, outside):
    if call('PATCH', path, ADMIN) != 200:
        sys.exit('could not seed %s in the emulator' % path)

OK, DENIED = 200, 403
CASES = [
    ('signed out: read the owner doc', 'GET', own, None, DENIED),
    ('signed out: write the owner doc', 'PATCH', own, None, DENIED),
    ('signed out: list the owner projects', 'GET', own_list, None, DENIED),
    ('other account: read the owner doc', 'GET', own, OTHER, DENIED),
    ('other account: write the owner doc', 'PATCH', own, OTHER, DENIED),
    ('other account: read its own doc', 'GET', theirs, OTHER, DENIED),
    ('other account: write its own doc', 'PATCH', theirs, OTHER, DENIED),
    ('owner: read', 'GET', own, OWNER, OK),
    ('owner: write', 'PATCH', own, OWNER, OK),
    ('owner: list projects', 'GET', own_list, OWNER, OK),
    ('owner: create another project', 'PATCH', own_list + '/another', OWNER, OK),
    ('owner: delete it', 'DELETE', own_list + '/another', OWNER, OK),
    ('owner: read another user', 'GET', theirs, OWNER, DENIED),
    ('owner: write another user', 'PATCH', theirs, OWNER, DENIED),
    ('owner: read outside /users', 'GET', outside, OWNER, DENIED),
    ('owner: write outside /users', 'PATCH', outside, OWNER, DENIED),
]

print('Owner UID from firestore.rules: %s' % OWNER)
failed = 0
for name, method, path, who, expected in CASES:
    got = call(method, path, who)
    ok = got == expected
    failed += not ok
    print('%s  %-40s %-6s -> %d%s' % ('PASS' if ok else 'FAIL', name, method, got,
                                      '' if ok else '  (expected %d)' % expected))
print('\n%d of %d passed' % (len(CASES) - failed, len(CASES)))
sys.exit(1 if failed else 0)
