// Public Firebase web config for the "Projects app" project. Not a secret: every visitor's browser
// gets it anyway. What protects the data is firestore.rules (owner's UID only) plus the API key's
// HTTP-referrer restriction in Google Cloud Console.
export const firebaseConfig = {
  apiKey: "AIzaSyACJbKUtWz-tf48Y_iguxrA7c50CW5Rb1w",
  authDomain: "projects-app-oqjc2.firebaseapp.com",
  projectId: "projects-app-oqjc2",
  storageBucket: "projects-app-oqjc2.firebasestorage.app",
  messagingSenderId: "662770088037",
  appId: "1:662770088037:web:32cb97f2e1f40a83b76e8c"
};
