# Projects app

**Version: v1.0** (tagged only after the live site is confirmed working)

A private dashboard for personal projects. The first project is the Madrid field trial
("מדריד: ניסוי שטח"), moved here from a claude.ai artifact. Static site on GitHub Pages, data in
Firestore, sign-in with Firebase email/password, and the schedule read from Google Calendar
(read-only).

Live: https://matankashi.github.io/projectsDash/

## Files

| File | What it does |
|---|---|
| `index.html` | The page shell |
| `styles.css` | The artifact's CSS unchanged, plus the sign-in screen at the end |
| `app.js` | The artifact's script: views, events, `toBlocks`, the timer. Data now comes from the two modules below |
| `firebase.js` | Sign-in, the project document (live sync and debounced saves), the one-time import |
| `calendar.js` | Google Calendar, read-only: Google sign-in popup (GIS token client) and GET requests |
| `firebase-config.js` | The public Firebase config |
| `firestore.rules` | Security rules, deployed with the CLI |
| `firebase.json`, `.firebaserc` | Firebase CLI settings: rules and emulators only, no Hosting |
| `tests/` | Rules test, local test server, stand-in for Google (see "Testing") |

## Data

One Firestore document per project at `users/{uid}/projects/{projectId}`. It holds the object the
artifact kept in its `<script id="state">` tag (`version, project, rules, maxHeavy, streams,
doneEvents, stuck, log`) plus `updatedAt`, set by the server. The Madrid project is
`madrid-field-trial`.

- Only what changed is saved, about a second after the last change (debounced). Marking a block
  done or undone writes just that block's entry and its log line, so two devices never overwrite
  each other's marks. Milestone, status and "מוקד כבד" edits rewrite the list of streams as a whole:
  if two devices make one within the same second, the last one wins.
- Changes made offline are saved when the connection comes back, as long as the page stays open.
- Closing or reloading right after a change is safe. The browser cancels a save that starts while
  the page is closing, so each change is also backed up in this browser's localStorage
  (`projects-app:<uid>:<projectId>:pending`) until the save is confirmed, and the next load
  finishes it. The backup is deleted on sign-out, ignored and deleted if it belongs to another
  account or is older than 7 days, and a stream edit in it is skipped if another device changed
  the streams since.
- Other open devices update live.
- The timer is per device, in localStorage.

## Security

- **Sign-in:** email and password only. The single user is created by hand in the Firebase console,
  and self sign-up is turned off.
- **Rules:** only the owner's UID, only under `/users/{uid}`; everything else is denied, including any
  other account. `tests/rules-test.py` checks this against the emulator before every deploy.
- **API key:** public by design (every browser gets it). It's restricted by HTTP referrer in Google
  Cloud Console, and the rules are what actually protect the data.
- **Calendar:** one read-only scope, `calendar.readonly`. The token is kept in memory only, never in
  localStorage or Firestore. The app only sends GET requests to the Calendar API.
- **No secrets in the repo.** `data-export.json` and `source-artifact.html` hold the real project
  data, so they're gitignored.
- All of the account's GitHub Pages sites share one origin (`https://matankashi.github.io`), so
  localStorage, IndexedDB and the Google OAuth origin are shared with the other apps there. That's
  fine as long as every site there is yours.

## Google Calendar

- After each page load, tap "חבר יומן" once. Google's sign-in popup opens and closes. The token
  lasts about an hour; after that the dashboard keeps the last schedule it loaded and shows
  "חבר מחדש".
- While connected, the schedule refreshes every 10 minutes, and whenever you press "רענן".
- The window is derived from the project: 10 days before its earliest date through 2 days after
  `decision.date` (`CAL_LEAD_DAYS` / `CAL_TRAIL_DAYS` in `app.js`). All result pages are fetched.
- In DevTools → Network you'll also see POST requests to `firestore.googleapis.com`,
  `identitytoolkit.googleapis.com` and `securetoken.googleapis.com` (that's Firebase), and
  OPTIONS preflights to `googleapis.com/calendar`. The calendar requests themselves are GET only.

## Testing

The Firebase CLI is the `firebase` command (see "Tools"). Run everything from the repo folder.

Fully offline, against local emulators, with a stand-in for Google:

```bash
firebase emulators:start --only auth,firestore --project demo-projects-app
python3 tests/serve-test.py --emulator        # in a second terminal
# open http://localhost:8010 and sign in as test@example.com / test-password
```

Against the real project, but only ever on the test document `madrid-field-trial-test`:

```bash
python3 tests/serve-test.py                   # http://localhost:8010, red TEST bar at the top
```

Rules:

```bash
firebase emulators:exec --only firestore --project demo-projects-app "python3 tests/rules-test.py"
firebase deploy --only firestore:rules         # only after the test passes
```

## One-time import

The first time the owner signs in and the project document doesn't exist yet, the app creates it
from `data-export.json` (the dashboard's "ייצוא נתונים" output) if that file is present, and
otherwise from the state inside `source-artifact.html`. It never overwrites an existing document.
Both files are gitignored, so the live site can't import: there, a missing document shows a message.
To import, put the file in this folder, run `python3 -m http.server 8010 --bind 127.0.0.1`, open
http://localhost:8010, and sign in once.

## Tools

Node 24 LTS, the Firebase CLI, and JDK 21 (needed only for the Firestore emulator) live in
`~/.local`, installed without sudo or Homebrew. `~/.local/bin/firebase` is a small wrapper that
puts that Node and JDK on PATH for the one command.
