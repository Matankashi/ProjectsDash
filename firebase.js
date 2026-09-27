/* Firebase: sign-in, the list of projects, and each project document.

   Each project is one Firestore document, users/{uid}/projects/{projectId}, holding the same object
   the artifact kept inside its <script id="state"> tag, plus updatedAt set by the server.
   watchProjects() follows the list; openProject() follows and saves one document. Nothing here
   ever creates a project document: there's no import, so a deleted document stays deleted.

   How saving and syncing fit together (the echo risk madrid-trip's budget.js avoids with getDoc,
   handled here because the dashboard needs onSnapshot for cross-device sync):
   - Only what changed is written, DEBOUNCE_MS after the last change, as one batch. changesBetween()
     compares the state on screen with `base`, the last synced copy:
       doneEvents, stuck: one field path per changed key, deleteField() for a removed key;
       log: arrayUnion for new entries, arrayRemove for removed ones;
       any other top-level field (streams: milestones, status, heavy): the whole field.
     So two devices marking blocks never overwrite each other; two devices editing streams within
     the same second, the last one wins. Writes made offline wait in the SDK's queue.
   - While a change is waiting for its debounce or a write is in flight, the local copy is the newest
     and incoming snapshots are only recorded. The next snapshot after that reconciles: if the
     server has something newer than what's on screen (another device), it's applied.
   - The echo of my own write changes nothing on screen: its content equals what's already shown.
   - Fields this code doesn't know are never written, so newer data survives an older tab.

   tests/serve-test.py --emulator rewrites the two SDK import lines below and the getFirestore line
   to point at the local emulators, and in both test modes rewrites the PROJECTS line so tests only
   ever touch users/{uid}/projects-test. If you change those lines, update the rewrites there too. */

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import { getFirestore, collection, doc, onSnapshot, writeBatch, serverTimestamp, deleteField, arrayUnion, arrayRemove, FieldPath } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { firebaseConfig } from './firebase-config.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const DEBOUNCE_MS = 1000;

export const watchAuth = callback => onAuthStateChanged(auth, callback);
export const signIn = (email, password) => signInWithEmailAndPassword(auth, email, password);
export const signOutUser = () => signOut(auth);

const PROJECTS = 'projects';
const projectRef = (uid, projectId) => doc(db, 'users', uid, PROJECTS, projectId);

// The ids of the user's projects, live. onList gets the full list on every change. A first answer
// that comes from the cache with nothing in it means offline with nothing cached: no verdict yet.
export function watchProjects(uid, handlers) {
  return onSnapshot(collection(db, 'users', uid, PROJECTS), snap => {
    if (snap.metadata.fromCache && snap.empty) { handlers.onOffline(); return; }
    handlers.onList(snap.docs.map(d => d.id));
  }, err => {
    console.error('projects-app: project list listener failed', err);
    handlers.onError(err);
  });
}

// A plain JSON copy (which also drops undefined, which Firestore rejects), without updatedAt,
// which the server sets.
function toDoc(state) {
  const copy = JSON.parse(JSON.stringify(state));
  delete copy.updatedAt;
  return copy;
}

// The app keeps updatedAt as epoch milliseconds, like the artifact did.
function fromDoc(data) {
  if (data.updatedAt && typeof data.updatedAt.toMillis === 'function') data.updatedAt = data.updatedAt.toMillis();
  return data;
}

// A fingerprint of a state's content that ignores key order (Firestore doesn't keep map key order)
// and the top-level updatedAt.
function contentKey(value, top = true) {
  if (Array.isArray(value)) return '[' + value.map(v => contentKey(v, false)).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value)
      .filter(k => value[k] !== undefined && !(top && k === 'updatedAt'))
      .sort()
      .map(k => JSON.stringify(k) + ':' + contentKey(value[k], false))
      .join(',') + '}';
  }
  return JSON.stringify(value);
}

// The updates that turn `before` into `after` (both toDoc copies), for one batch. Each update is a
// flat [fieldPath, value, fieldPath, value, ...] list. `log` gets its own update for arrayRemove,
// because one update can't apply two array operations to the same field. FieldPath takes event ids
// literally, so a dot or other special character in an id can't be misread as a path.
function changesBetween(before, after) {
  const fields = [];
  const updates = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const was = before[key], now = after[key];
    if (key === 'doneEvents' || key === 'stuck') {
      const wasMap = was || {}, nowMap = now || {};
      for (const id of new Set([...Object.keys(wasMap), ...Object.keys(nowMap)])) {
        if (!(id in nowMap)) fields.push(new FieldPath(key, id), deleteField());
        else if (contentKey(nowMap[id], false) !== contentKey(wasMap[id], false)) fields.push(new FieldPath(key, id), nowMap[id]);
      }
    } else if (key === 'log') {
      // Entries have no id: Firestore matches them by value, and so does this comparison.
      const wasEntries = new Map((was || []).map(e => [contentKey(e, false), e]));
      const nowEntries = new Map((now || []).map(e => [contentKey(e, false), e]));
      const added = [...nowEntries].filter(([k]) => !wasEntries.has(k)).map(([, e]) => e);
      const removed = [...wasEntries].filter(([k]) => !nowEntries.has(k)).map(([, e]) => e);
      if (removed.length) updates.push([new FieldPath('log'), arrayRemove(...removed)]);
      if (added.length) fields.push(new FieldPath('log'), arrayUnion(...added));
    } else if (contentKey(now, false) !== contentKey(was, false)) {
      fields.push(new FieldPath(key), now === undefined ? deleteField() : now);
    }
  }
  if (fields.length) updates.push(fields);
  return updates;
}

// `server` with the changes from `was` to `now` applied, by the same rules as changesBetween(): per
// key for doneEvents/stuck, per entry for log, and a whole field only if the server's copy is still
// the one the change was made against (otherwise another device changed it since, and that wins).
function withChanges(server, was, now) {
  const out = JSON.parse(JSON.stringify(server));
  const keys = new Set([...Object.keys(was), ...Object.keys(now)]);
  for (const key of keys) {
    if (key === 'doneEvents' || key === 'stuck') {
      const wasMap = was[key] || {}, nowMap = now[key] || {};
      for (const id of new Set([...Object.keys(wasMap), ...Object.keys(nowMap)])) {
        if (!(id in nowMap)) { if (out[key]) delete out[key][id]; }
        else if (contentKey(nowMap[id], false) !== contentKey(wasMap[id], false)) (out[key] = out[key] || {})[id] = nowMap[id];
      }
    } else if (key === 'log') {
      const wasKeys = new Set((was.log || []).map(e => contentKey(e, false)));
      const nowKeys = new Set((now.log || []).map(e => contentKey(e, false)));
      const kept = (out.log || []).filter(e => nowKeys.has(contentKey(e, false)) || !wasKeys.has(contentKey(e, false)));
      const have = new Set(kept.map(e => contentKey(e, false)));
      out.log = kept.concat((now.log || []).filter(e => !wasKeys.has(contentKey(e, false)) && !have.has(contentKey(e, false))));
    } else if (contentKey(now[key], false) !== contentKey(was[key], false)) {
      if (contentKey(server[key], false) !== contentKey(was[key], false)) {
        console.warn('projects-app: not restoring an unsaved change to "' + key + '": another device changed it since');
      } else if (now[key] === undefined) delete out[key];
      else out[key] = now[key];
    }
  }
  return out;
}

const BACKUP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const backupKey = (uid, projectId) => 'projects-app:' + uid + ':' + projectId + ':pending';

// Backups left by another account on this browser are never replayed, and are removed.
function removeOtherUsersBackups(uid) {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      const m = key && key.match(/^projects-app:([^:]+):.+:pending$/);
      if (m && m[1] !== uid) localStorage.removeItem(key);
    }
  } catch (err) {
    console.error('projects-app: could not clean up old backups', err);
  }
}

// Listens to one project document and saves changes to it.
// handlers: onData(state), onMissing() (the document doesn't exist or was deleted; nothing recreates
// it), onOffline(), onError(err), onSaveState('saving'|'saved'|'error', err)
export function openProject(uid, projectId, handlers) {
  const ref = projectRef(uid, projectId);
  let latest = null;      // newest local state, waiting to be written
  let base = null;        // the server's content as this tab knows it: last applied snapshot plus
                          // this tab's own writes. Changes are computed against it.
  let timer = null;       // the debounce
  let inFlight = 0;
  let failure = null;
  let localKey = null;    // content of what's on screen
  let server = null;      // newest snapshot the server sent: {key, snap}
  const writes = new Set();

  /* Backup of unsaved changes. The browser cancels a save the page starts while it's being closed
     or reloaded, so every change is also written to localStorage right away (synchronously, which
     nothing can cancel), as `base` (the content the unsaved changes were made against) and `now`.
     It's removed once the save is confirmed. On the next load a backup of this user and project,
     at most 7 days old, is merged onto the server's current content and saved. */
  const pendingKey = backupKey(uid, projectId);
  let backupBase = null;  // the content the first unsaved change was made against
  let replayChecked = false;
  removeOtherUsersBackups(uid);

  function writeBackup(now) {
    if (!backupBase) backupBase = base;
    try {
      localStorage.setItem(pendingKey, JSON.stringify({ uid, projectId, savedAt: Date.now(), base: backupBase, now }));
    } catch (err) {
      console.error('projects-app: could not back up unsaved changes', err);
    }
  }

  function dropBackup() {
    backupBase = null;
    try {
      localStorage.removeItem(pendingKey);
    } catch (err) {
      console.error('projects-app: could not remove the backup', err);
    }
  }

  function readBackup() {
    let backup = null;
    try {
      backup = JSON.parse(localStorage.getItem(pendingKey) || 'null');
    } catch (err) {
      console.error('projects-app: unreadable backup, ignoring it', err);
    }
    if (!backup) return null;
    if (backup.uid !== uid || backup.projectId !== projectId || !backup.base || !backup.now ||
        !(Date.now() - backup.savedAt < BACKUP_MAX_AGE_MS)) {
      dropBackup();
      return null;
    }
    return backup;
  }

  function reconcile() {
    if (timer || inFlight || !server || server.key === localKey) return;
    localKey = server.key;
    base = toDoc(server.snap.data());
    const data = fromDoc(server.snap.data());
    if (!replayChecked) {
      replayChecked = true;
      const backup = readBackup();
      if (backup) {
        const merged = withChanges(base, backup.base, backup.now);
        if (contentKey(merged) !== server.key) {
          console.info('projects-app: saving changes left unsaved when the page was last closed');
          merged.updatedAt = data.updatedAt;
          handlers.onData(merged);
          save(merged);
          flush();
          return;
        }
        dropBackup();
      }
    }
    handlers.onData(data);
  }

  function settle() {
    if (timer || inFlight) return;
    const failed = failure;
    failure = null;
    // Saved, or refused by the server (which a retry wouldn't change): either way nothing to keep.
    dropBackup();
    handlers.onSaveState(failed ? 'error' : 'saved', failed);
    // The SDK resolves a write before it delivers the snapshot that carries it, so at this point
    // `server` can still be the snapshot from before the write. Reconciling now would briefly put
    // the old state back on screen (and wipe whatever is being typed). After a successful write,
    // its snapshot is on the way and reconciles when it lands. After a failed one, nothing is on
    // the way, so go back to what the server has.
    if (failed) reconcile();
  }

  function write() {
    timer = null;
    const now = toDoc(latest);
    localKey = contentKey(now);
    const updates = base ? changesBetween(base, now) : [];
    if (!updates.length) {
      // Nothing to send (a change and its undo, say). A snapshot that arrived while the change was
      // waiting was only recorded, and no write of mine is coming to trigger it, so apply it now.
      settle();
      reconcile();
      return;
    }
    base = now;
    inFlight++;
    const batch = writeBatch(db);
    updates.forEach((fields, i) => {
      const stamp = i === updates.length - 1 ? ['updatedAt', serverTimestamp()] : [];
      batch.update(ref, ...fields, ...stamp);
    });
    const pending = batch.commit()
      .catch(err => {
        console.error('projects-app: save failed', err);
        failure = err;
      })
      .finally(() => {
        inFlight--;
        writes.delete(pending);
        settle();
      });
    writes.add(pending);
  }

  function flush() {
    if (!timer) return;
    clearTimeout(timer);
    write();
  }

  const unsubscribe = onSnapshot(ref, snap => {
    if (snap.metadata.hasPendingWrites) return;   // my own write, before the server has it
    if (!snap.exists()) {
      server = null;
      // From cache means offline with nothing cached: no verdict yet, the listener keeps trying.
      if (snap.metadata.fromCache) handlers.onOffline();
      else handlers.onMissing();
      return;
    }
    server = { key: contentKey(snap.data()), snap };
    reconcile();
  }, err => {
    console.error('projects-app: project listener failed', err);
    handlers.onError(err);
  });

  function save(state) {
    latest = state;
    writeBackup(toDoc(state));
    clearTimeout(timer);
    timer = setTimeout(write, DEBOUNCE_MS);
    handlers.onSaveState('saving');
  }

  return {
    save,
    // Called when the page is hidden or closed, so a change doesn't wait out the debounce. Saves
    // for sure only when the page stays alive (hidden); on close or reload the backup covers it.
    flush,
    // On sign-out: nothing of this user's data stays behind in this browser.
    discardBackup: dropBackup,
    async flushAndWait(ms = 3000) {
      flush();
      await Promise.race([Promise.allSettled([...writes]), new Promise(resolve => setTimeout(resolve, ms))]);
    },
    close() {
      clearTimeout(timer);
      unsubscribe();
    }
  };
}
