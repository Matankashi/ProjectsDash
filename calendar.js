/* Google Calendar, read-only.

   - Separate from the app's Firebase sign-in: a Google Identity Services (GIS) token client asks for
     one scope, calendar.readonly. The token lives only in this module's memory. It's never put in
     localStorage or Firestore and never logged, so after a reload "חבר יומן" asks for a new one.
   - Every request goes through get(), which only ever sends GET. The app never creates, edits or
     deletes events, and a read-only token couldn't anyway.
   - Browsers block a popup that doesn't come straight from a click, so connect() must be called
     synchronously inside the click handler. For the same reason there's no silent renewal: when
     the token expires (after about an hour) the app shows "חבר מחדש". */

// OAuth client ID (type "Web application") from Google Cloud Console. Public, not a secret: Google
// only accepts it from the Authorized JavaScript origins configured on it there.
const CLIENT_ID = '662770088037-gojt38843lsio0o12bi8glidmo20vvof.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const GIS_SRC = 'https://accounts.google.com/gsi/client';
const EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const MAX_PAGES = 20;              // 20 × 250 events, far more than any project window holds
const EXPIRY_MARGIN_MS = 60000;    // stop using a token a minute before Google does
const RATE_LIMITED = ['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'dailyLimitExceeded'];

let gis = 'idle';                  // idle | loading | ready | failed
let gisLoad = null;
let client = null;
let pending = null;                // {resolve, reject} of the connect() in progress
let token = null;                  // {value, expiresAt}
let expireTimer = null;
let expireHandler = null;

// kind: the state the app shows (disconnected | expired | denied | network), or null to keep the
// current one. detail: a finer reason the app words differently (popup_closed, not_configured, ...).
export class CalendarError extends Error {
  constructor(kind, detail, extra) {
    super(detail || kind || 'calendar error');
    this.name = 'CalendarError';
    this.kind = kind;
    this.detail = detail || '';
    Object.assign(this, extra);
  }
}

export function init() {
  if (!gisLoad) {
    gis = 'loading';
    gisLoad = loadScript().then(() => {
      client = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPE,
        callback: onToken,
        error_callback: onPopupError
      });
      gis = 'ready';
    }, err => {
      gis = 'failed';
      gisLoad = null;              // the next init() tries again
      throw err;
    });
  }
  return gisLoad;
}

function loadScript() {
  return new Promise((resolve, reject) => {
    if (window.google && google.accounts && google.accounts.oauth2) return resolve();
    const s = document.createElement('script');
    s.src = GIS_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      s.remove();
      reject(new Error('Google Identity Services did not load'));
    };
    document.head.appendChild(s);
  });
}

// Opens Google's popup and resolves once a token with the calendar scope is in hand.
// consent: true shows the consent screen again (after the user declined calendar access).
export function connect({ consent = false } = {}) {
  if (gis !== 'ready') {
    if (gis === 'failed') {
      init().catch(err => console.error('projects-app: Google Identity Services did not load', err));
    }
    return Promise.reject(new CalendarError(null, gis === 'failed' ? 'gis_failed' : 'gis_loading'));
  }
  if (pending) pending.reject(new CalendarError(null, 'popup_closed'));
  return new Promise((resolve, reject) => {
    pending = { resolve, reject };
    client.requestAccessToken({ prompt: consent ? 'consent' : '' });
  });
}

function onToken(resp) {
  const p = pending;
  pending = null;
  if (!p) return;
  if (resp.error) return p.reject(new CalendarError('denied', resp.error === 'access_denied' ? '' : resp.error));
  if (!google.accounts.oauth2.hasGrantedAllScopes(resp, SCOPE)) return p.reject(new CalendarError('denied'));
  token = { value: resp.access_token, expiresAt: Date.now() + Number(resp.expires_in || 3600) * 1000 };
  clearTimeout(expireTimer);
  expireTimer = setTimeout(() => { if (expireHandler) expireHandler(); },
    Math.max(0, token.expiresAt - EXPIRY_MARGIN_MS - Date.now()));
  p.resolve();
}

function onPopupError(err) {
  const p = pending;
  pending = null;
  if (p) p.reject(new CalendarError(null, err && err.type === 'popup_failed_to_open' ? 'popup_blocked' : 'popup_closed'));
}

export function tokenState() {
  if (!token) return 'none';
  return Date.now() < token.expiresAt - EXPIRY_MARGIN_MS ? 'valid' : 'expired';
}

export function onExpire(handler) {
  expireHandler = handler;
}

// Every event in the window, following nextPageToken to the last page.
export async function listEvents({ timeMin, timeMax }) {
  const items = [];
  let pageToken = '';
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      timeMin, timeMax,
      singleEvents: 'true', orderBy: 'startTime', maxResults: '250', timeZone: 'Asia/Jerusalem'
    });
    if (pageToken) params.set('pageToken', pageToken);
    const data = await get(EVENTS_URL + '?' + params);
    items.push(...(data.items || []));
    pageToken = data.nextPageToken;
    if (!pageToken) return items;
  }
  throw new CalendarError('network', 'too_many_pages');
}

// The only function that talks to the Calendar API, and it only ever sends GET.
async function get(url) {
  if (tokenState() !== 'valid') throw new CalendarError(token ? 'expired' : 'disconnected');
  let res;
  try {
    res = await fetch(url, { method: 'GET', cache: 'no-store', headers: { Authorization: 'Bearer ' + token.value } });
  } catch (err) {
    throw new CalendarError('network', 'fetch_failed', { cause: err });
  }
  if (res.ok) {
    try {
      return await res.json();
    } catch (err) {
      throw new CalendarError('network', 'bad_response', { cause: err });
    }
  }
  let reason = '';
  try {
    reason = (await res.json())?.error?.errors?.[0]?.reason || '';
  } catch (err) {
    console.error('projects-app: calendar error response was not JSON', res.status, err);
  }
  const extra = { status: res.status, reason };
  if (res.status === 401) {
    token.expiresAt = 0;
    throw new CalendarError('expired', '', extra);
  }
  if (res.status === 403 && !RATE_LIMITED.includes(reason)) {
    throw new CalendarError('denied', reason === 'accessNotConfigured' ? 'not_configured' : '', extra);
  }
  throw new CalendarError('network', 'http_' + res.status, extra);
}
