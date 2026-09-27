/* Test only: tests/serve-test.py adds this to the page in both test modes; the real site never loads it.
   Once signed in, if users/{uid}/projects-test is empty, it fills it with the made-up projects in
   tests/seed-fake.json, so tests never need real data. It writes only under projects-test, only when
   that list is empty, and only once per page load: deleting one test project doesn't bring it back. */
import '../firebase.js';   // the app's Firebase setup (already pointed at the emulators in --emulator mode)
import { getApp } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js';
import { getFirestore, collection, doc, getDocs, writeBatch } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js';

const db = getFirestore(getApp());
let done = false;
onAuthStateChanged(getAuth(getApp()), async user => {
  if (!user || done) return;
  done = true;
  try {
    const list = collection(db, 'users', user.uid, 'projects-test');
    if (!(await getDocs(list)).empty) return;
    const seed = await (await fetch('tests/seed-fake.json', { cache: 'no-store' })).json();
    const batch = writeBatch(db);
    Object.entries(seed.projects).forEach(([id, state]) => batch.set(doc(list, id), state));
    await batch.commit();
    console.info('projects-app test: filled projects-test with ' + Object.keys(seed.projects).length + ' made-up projects');
    // Reload so the app starts from the server's copy. Its project listeners opened while these writes
    // were still pending in this tab, skip pending snapshots, and the server's confirmation changes only
    // metadata, which doesn't fire a new snapshot: without the reload they'd never show the data.
    location.reload();
  } catch (err) {
    console.error('projects-app test: could not fill projects-test', err);
  }
});
