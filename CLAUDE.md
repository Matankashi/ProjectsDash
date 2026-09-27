# Projects app

**Version: v1.1**

A private project dashboard: static files on GitHub Pages (`https://matankashi.github.io/ProjectsDash/`,
repo `git@github.com:Matankashi/ProjectsDash.git`, served from `main`), Firestore for data,
Firebase email/password sign-in, and Google Calendar read-only. The first project is the Madrid field
trial, migrated from the claude.ai artifact "מדריד: ניסוי שטח". The migration brief is
`~/Projects app/BRIEF-FOR-CLAUDE-CODE.md`. See README.md for how to run, test, deploy.

## Working rules

Standing rules from the user, for every session:

1. **Stop and tell first.** If you find a problem, a risk, or anything the user should know, stop and
   tell them before acting. Don't work around it silently.
2. **Explicit approval per action.** Never write to real data, deploy, push, tag, change security
   rules, or change anything in Firebase or Google Cloud without the user's explicit approval for
   that specific action.
3. **Security first.** Least privilege, no secrets in the repo, read-only calendar, UID-locked rules.
   Flag anything that would weaken them, even if it's convenient.
4. **Show before anything irreversible.** Show the user exactly what will change first.

Repo conventions:

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

- One document per project, `users/{uid}/projects/{projectId}` (`PROJECTS` in `firebase.js`).
  `watchProjects()` follows the list; `app.js` opens one `openProject()` per listed project and drops
  a project whose document is deleted.
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
- There's no import (removed in v1.2): nothing in the app creates a project document, so a deleted
  one stays deleted. An empty list shows "אין עדיין פרויקטים". The live Madrid document was imported
  once, on 2026-09-25.
- A document listener opened while *this tab* has a pending write to that document never delivers
  it: `openProject()` skips pending snapshots, and the server's confirmation only changes metadata,
  which doesn't fire a snapshot. The app never writes a document it hasn't loaded, so this only bites
  test code that writes through the page's own Firestore instance (the seeder reloads for this reason).

## Projects and the home screen (v1.2)

- `app.js` keeps the artifact's views, which draw "the current project": `use(id)` points `state` and
  `cal.blocks` at one project first. Every handler calls `useFor(el)`, which uses the project of the
  nearest `[data-p]`. `commit()` saves the current project.
- Routes: `#/` home, `#/p/<id>` one project. In-page links (`#week`, `#st-<stream>`) are caught in the
  click handler and scroll instead of changing the hash.
- Home: the app bar, then "היום" (today's blocks from all active projects, each with its ✓), then:
  one active project → its overview panel and its full dashboard; two or more → an overview card per
  active project linking to `#/p/<id>`, ordered by nearest open deadline (none last, ties by name).
  Paused projects sit in a collapsed "מוקפאים" row with "הפעל".
  At most `MAX_ACTIVE` (3) active; activating a fourth shows a warning.
- The overview panel (`overview()`) replaced the artifact's header: name, goal, countdown, overall
  progress (milestones %) plus "השבוע: X מתוך Y בלוקים", next deadline, next block, missed-and-
  unmarked count, and a row per stream (calendar-based %, green on track, red behind, grey without
  blocks). The save status, "יומן Google" and sign-out moved to the app bar (`bar()`).
- New optional fields inside `project`: `calendarKey` (the word in the event title that marks this
  project's blocks, e.g. "מדריד" for "מדריד — סאבלט: ..."; no key means no blocks) and `status`
  (`active`/`paused`, missing = active). `flight`, `buffer` and `decision` are optional: the countdown,
  timeline and rules draw only what exists. Timeline ticks are computed (1st and 15th of each month
  plus the end date), which gives Madrid the artifact's 1.10, 15.10, 1.11, 14.11.
- Verified in stage 1: the Madrid dashboard sections (now, 7-day list, streams, deadlines, timeline,
  log, rules) render identical HTML to v1.1 with the same data, apart from clock times and the new
  `id="st-<stream>"` anchors.

## Editing (v1.2)

- "עריכה" in the overview panel opens `editPanel()`: project name (required), goal, success criteria
  (add/edit/delete), the calendar key, and pause/activate (the 3-active limit applies). "עריכה" in a stream's head (the same
  `ui.open` state as "כל אבני הדרך") shows milestone edit/delete, the add form, and `linksEditor()`.
- Everything edited lives in `project` or `streams`, so it's saved as a whole field, last write wins.
- Calendar key: the count of matching blocks updates while typing (`keyCount()`, over the loaded
  calendar window only). A key that matches nothing, or can't be checked because the calendar isn't
  loaded, needs a second tap ("שמור בכל זאת"). Errors and confirmations are written into the form in
  place, never by re-rendering, so nothing typed is lost; the same goes for link errors.
- Links: `isUrl()` is the same http(s)-only rule `streamLinks()` renders by, plus a 2000-character cap.
  Links that fail it are listed in the editor with "לא מוצג" so they can be fixed or deleted. Removing
  the last link deletes the `links` key. Inputs carry `maxlength` (`MAX_LEN`) and saves cut to it.
- Deleting a milestone, link or success criterion takes two taps on the same row (`delButton()`,
  `confirmDel()`): × becomes "למחוק? כן, למחוק / ביטול", with "ביטול" where × was, so a double tap
  cancels. Any other tap drops the question. No dialogs.
- All values are rendered through `esc()`: a label like `<img onerror=...>` shows as text (tested).

## Stream links (v1.1)

- `streams[].links = [{label, url}]`, optional. `streamLinks()` in `app.js` shows them under the
  stream's name. Only `http(s)` URLs are rendered (anything else gets one `console.warn` and is
  skipped), labels and URLs are escaped, and a missing label falls back to the URL.
- Nothing in `firebase.js` knows about `links`. Edits change the stream objects in place, so status,
  heavy and milestone edits keep the field. It's part of `streams`, so last-write-wins applies.
- Edited in the app since v1.2 (see "Editing").
- The header also has a general "יומן Google" link, and each block in the 7-day list has a
  "פתח ביומן" link (the event's `htmlLink`), placed outside the checkbox label.

## Calendar (calendar.js)

- GET only, through `get()`. Scope `calendar.readonly` only. The token lives only in module memory:
  never in storage, never logged.
- `connect()` must run synchronously inside a click handler, or the browser blocks Google's popup.
  So there's no silent renewal: after a reload or expiry the user taps "חבר יומן" / "חבר מחדש".
- Error states the app shows: disconnected, expired (401 or timer), denied (403, a declined consent,
  or a token without the scope; `accessNotConfigured` gets its own message), network (fetch
  failure, 5xx, 429, rate-limit 403s). Data on screen is kept for everything except a fresh start.
- After a denial, the next connect asks with `prompt: 'consent'`.
- The window comes from the active projects' dates (`calRange()` in `app.js`), one request for all
  of them: each project's earliest date − 10 days through its decision date (or latest date) + 2 days,
  and always reaching a week past today. Paused projects' blocks aren't fetched.

## Security

- Rules pin the owner's UID (as madrid-jobs does). `OWNER_UID_NOT_SET` is a fail-closed placeholder
  until the real UID is set. `tests/rules-test.py` reads the UID from the file.
- Unlike madrid-trip, rules are deployed with `firebase deploy --only firestore:rules`, so the file
  is what's live. `firebase.json` has no `hosting` key; keep it that way.

## Testing gotchas

- **Emulator only** (the user's decision, 2026-09-27): don't run `serve-test.py` without `--emulator`
  unless the user explicitly approves that run.
- Never test against the real `projects` collection. `tests/serve-test.py` rewrites `firebase.js` on
  the fly to use `users/{uid}/projects-test`, sends `no-store`, and binds to 127.0.0.1 only.
- It also adds `tests/seed-in-page.js`: once signed in, if `projects-test` is empty, it fills it with
  the made-up projects in `tests/seed-fake.json` (3 active, 1 paused, calendar keys מדריד/קפה/כושר/גינה
  matching `tests/fake-google.js`) and reloads. Without `--emulator` that's a write to the real Firebase
  project, under `projects-test` only, so it needs the user's OK like any other write.
- `serve-test.py` depends on exact strings: `const LS_TIMER=...` in `app.js`; `<body>`/`</head>` in
  `index.html`; `const PROJECTS = 'projects';` in `firebase.js`; and in `--emulator` mode the two SDK
  import lines and `const db = getFirestore(app);` in `firebase.js`. It returns HTTP 500 if one is
  missing.
- To change test data the way another device would, write from outside the page: the emulator's REST
  API with `Authorization: Bearer owner` (emulator only; it bypasses rules). Writes through the page's
  own Firestore instance don't reach the app's listeners (see "Data and sync").
- Emulator mode needs the emulators running first. It creates `test@example.com` / `test-password`
  with the UID from `firestore.rules`. After changing that UID, restart the emulators (they start
  empty) and the server.
- Chrome's automation window is usually behind other windows (`visibilityState: hidden`), so its
  timers are throttled. `tests/fake-google.js` answers without timers by default (`delayMs: 0`).
  Wait for states by polling with a MessageChannel yield, not fixed sleeps. Typing into the login
  form right after a reload was flaky; fill it through the DOM and call `requestSubmit()`.
- `source-artifact.html` lives in `~/Documents/projects-app-backup/` since 2026-09-27 and is no longer
  needed for anything: tests use `tests/seed-fake.json`.
- The fake's scenarios (`__fakeGoogle.scenario`) cover every calendar error path; see the top of
  `tests/fake-google.js`.

## Roadmap

**v1.1 (links only), released 2026-09-27:** a "פתח ביומן" link on every block in the 7-day list, a
general Google Calendar link in the header, and data-driven per-stream links (see "Stream links").
The madrid-trip budget app link was added to the real document's `trip` stream in a one-off write
the user approved, rehearsed on `madrid-field-trial-test` first (since deleted) and verified
field by field afterwards.

**v1.2: multiple projects and in-app editing (in progress).** Only the Madrid project for now; the
model and screens take more without code changes. Stage 1 (built 2026-09-27): home with "היום", the
overview panel and cards, the 3-active limit, `calendarKey`/`status`, the import removed, fake seed
data, tests on `projects-test`. Stage 2 (built 2026-09-27): editing (goal, success criteria, milestone titles and
dates, stream links, project status, calendar key with a count of matching blocks and a second tap
at zero), and cards ordered by nearest deadline.
Before deploying v1.2: back up the real document to `~/Documents/projects-app-backup/` (dated JSON),
then add `project.calendarKey: "מדריד"` to it, with a before/after preview and the user's OK.

**v1.3: week-grid task calendar inside the app.** A week grid showing only this project's calendar
blocks, colored per stream. Done blocks faded with a check, missed blocks in red. Tapping a block
shows its description, a "done" toggle and the Calendar link. Arrows move between weeks; RTL,
mobile-first. Still read-only against Google Calendar; the done state stays in Firestore.
