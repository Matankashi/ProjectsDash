# Projects app

**Version: v1.0**

A private project dashboard: static files on GitHub Pages (`https://matankashi.github.io/ProjectsDash/`,
repo `git@github.com:Matankashi/ProjectsDash.git`, served from `main`), Firestore for data,
Firebase email/password sign-in, and Google Calendar read-only. The first project is the Madrid field
trial, migrated from the claude.ai artifact "מדריד: ניסוי שטח". The migration brief is
`~/Projects app/BRIEF-FOR-CLAUDE-CODE.md`. See README.md for how to run, test, deploy.

## Working rules

- **Keep the artifact's behavior.** `app.js` is the artifact's script with only the claude.ai parts
  replaced; `styles.css` is its CSS with additions appended at the end. Don't restyle or rework
  views, `toBlocks`, the progress logic or the timer unless asked.
- **Stage files by name**, never `git add -A`/`.`. Show the diff before committing, and never commit,
  push or tag without an explicit go-ahead in that turn.
- **Tags:** `vX.Y`. Bump the version line in this file and in README.md when tagging.
- **Never commit** `data-export.json` or `source-artifact.html`. They hold the real data and the repo
  is public (both are gitignored).
- **No build step, no npm in the repo.** The Firebase SDK comes from the gstatic CDN, pinned to
  12.18.0; only `firebase.js` imports it.
- Every `catch` logs with `console.error('projects-app: ...', err)`, even when there's a fallback.

## Data and sync (firebase.js)

- One document per project, `users/{uid}/projects/{projectId}`. `PROJECT_ID` is in `app.js`.
- Saves write **only what changed** (`changesBetween()` against `base`, the last synced copy), as one
  batch, debounced 1 s: field paths per key for `doneEvents`/`stuck` (`deleteField()` on removal),
  `arrayUnion`/`arrayRemove` for `log`, the whole field for anything else (`streams`). Fields this
  code doesn't know are never written. Verified in two tabs: simultaneous block marks both survive;
  a block mark plus a streams edit both survive; an outside write to `rules` plus an unknown field
  survives a pending write; unmarking deletes the key and the log entry.
- Pending changes are flushed on `visibilitychange: hidden` (the page stays alive, so this saves)
  and on `pagehide`, which does **not** reliably save: the browser cancels requests (and IndexedDB
  writes) a page starts while unloading. Without the backup, 0 of 4 "mark, then reload 100 ms
  later" trials saved, and Firestore's persistent cache didn't help.
- **The backup** (localStorage `projects-app:<uid>:<projectId>:pending`, written synchronously on
  every `save()`): `{uid, projectId, savedAt, base, now}`, where `base` is the content the first
  unsaved change was made against. It's removed when a save settles, whether it succeeded or the
  server refused. On the first snapshot of a load, `withChanges()` merges a valid backup onto the
  server's content (same per-key/per-entry rules; a whole field only if the server's copy still
  equals `base`), shows it, and saves it. Invalid means another uid, another project, or older
  than 7 days, and it's deleted. Other uids' keys are deleted on open, and sign-out deletes this
  one. Tested: 5 of 5 reload trials saved; stale, foreign, and foreign-inside-own-key backups are
  dropped; a stream change is skipped when another device changed streams since; sign-out removes
  the key.
- `onSnapshot` keeps devices in sync. While a local change is waiting or being written, snapshots
  are only recorded; the local copy wins.
- **Don't reconcile right after a successful write.** The SDK resolves the write's promise *before*
  it delivers the snapshot carrying that write, so the recorded snapshot is still the old one.
  Reconciling there flashed the old state back and wiped a half-typed form (found in testing and
  fixed). Only a failed write reconciles immediately.
- The echo of one's own write is recognized by content (`contentKey`, which ignores key order and
  `updatedAt`), so it never redraws the page.
- **Still last-write-wins for `streams`** (milestones, status, heavy), per the user's decision: two
  devices editing streams within the same second lose one edit (seen in testing).
- Rare edge of value-matched `log` entries: if one device unmarks a block while another marks it
  again on a different day, a log line can outlive its mark.
- Import (`importIfMissing`) runs in a transaction and never overwrites. On the live site both seed
  files are 404, so a missing document shows "אין עדיין נתונים לפרויקט הזה" and nothing is created.

## Calendar (calendar.js)

- GET only, through `get()`. Scope `calendar.readonly` only. The token lives only in module memory:
  never in storage, never logged.
- `connect()` must run synchronously inside a click handler, or the browser blocks Google's popup.
  So there's no silent renewal: after a reload or expiry the user taps "חבר יומן" / "חבר מחדש".
- Error states the app shows: disconnected, expired (401 or timer), denied (403, a declined consent,
  or a token without the scope; `accessNotConfigured` gets its own message), network (fetch
  failure, 5xx, 429, rate-limit 403s). Data on screen is kept for everything except a fresh start.
- After a denial, the next connect asks with `prompt: 'consent'`.
- The window comes from the project dates (`calRange()` in `app.js`). Blocks before
  "earliest date − 10 days" aren't fetched.

## Security

- Rules pin the owner's UID (as madrid-jobs does). `OWNER_UID_NOT_SET` is a fail-closed placeholder
  until the real UID is set. `tests/rules-test.py` reads the UID from the file.
- Unlike madrid-trip, rules are deployed with `firebase deploy --only firestore:rules`, so the file
  is what's live. `firebase.json` has no `hosting` key; keep it that way.

## Testing gotchas

- Never test against `madrid-field-trial`. `tests/serve-test.py` rewrites `app.js` on the fly to use
  `madrid-field-trial-test`, sends `no-store`, and binds to 127.0.0.1 only.
- `serve-test.py` depends on exact strings: `const PROJECT_ID=...` and `const LS_TIMER=...` in
  `app.js`; `<body>`/`</head>` in `index.html`; and in `--emulator` mode the two SDK import lines
  and `const db = getFirestore(app);` in `firebase.js`. It returns HTTP 500 if one is missing.
- Emulator mode needs the emulators running first. It creates `test@example.com` / `test-password`
  with the UID from `firestore.rules`. After changing that UID, restart the emulators (they start
  empty) and the server.
- Chrome's automation window is usually behind other windows (`visibilityState: hidden`), so its
  timers are throttled. `tests/fake-google.js` answers without timers by default (`delayMs: 0`).
  Wait for states by polling with a MessageChannel yield, not fixed sleeps. Typing into the login
  form right after a reload was flaky; fill it through the DOM and call `requestSubmit()`.
- The fake's scenarios (`__fakeGoogle.scenario`) cover every calendar error path; see the top of
  `tests/fake-google.js`.

## v1.1 backlog (plan with the user after v1.0 is tagged; nothing built yet)

1. **Calendar links:** an "open in Calendar" link on every block in the 7-day list (today only the
   "now" card has one), plus a general link to Google Calendar in the header.
2. **Task calendar view inside the app:** a week grid showing only this project's calendar blocks,
   colored per stream. Done blocks faded with a check, missed blocks in red. Tapping a block shows
   its description, a "done" toggle and the Calendar link. Arrows move between weeks; RTL,
   mobile-first. Still read-only against Google Calendar; the done state stays in Firestore.
