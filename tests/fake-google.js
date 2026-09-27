/* Test stand-in for Google Identity Services and the Calendar API. Only tests/serve-test.py
   --emulator adds this to the page; the real site never loads it.

   From the browser console:
     __fakeGoogle.scenario = 'ok'              the default: events come back in pages of 4
                             'expired'         every calendar request gets 401
                             'denied'          403 insufficientPermissions
                             'not_configured'  403 accessNotConfigured (Calendar API not enabled)
                             'rate_limited'    403 rateLimitExceeded (temporary, not a permission problem)
                             'network'         fetch rejects, as when offline
                             'popup_closed'    the user closes Google's popup
                             'popup_blocked'   the browser blocks the popup
                             'access_denied'   the user presses Cancel on the consent screen
                             'no_scope'        a token comes back without calendar access
     __fakeGoogle.tokenSeconds = 70            lifetime of the next token (the app stops using it 60s early)
     __fakeGoogle.delayMs = 300                simulated latency; 0 (the default) answers without timers, which
                                               keeps tests fast even when Chrome throttles a hidden tab's timers
     __fakeGoogle.requests                     every calendar request so far: {method, url}
     __fakeGoogle.prompts                      the prompt value of every token request
     __fakeGoogle.shift('e-next', 30)          move an event by N minutes, like editing it in Calendar */
(function () {
  const F = window.__fakeGoogle = { scenario: 'ok', tokenSeconds: 3599, pageSize: 4, delayMs: 0, requests: [], prompts: [] };
  const later = () => F.delayMs ? new Promise(resolve => setTimeout(resolve, F.delayMs)) : Promise.resolve();
  const now = Date.now();
  const at = (days, h, m) => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + days);
    d.setHours(h, m || 0, 0, 0);
    return d;
  };
  const timed = (id, summary, start, minutes, extra) => Object.assign({
    id, status: 'confirmed', summary,
    htmlLink: 'https://calendar.google.com/calendar/event?eid=' + id,
    start: { dateTime: start.toISOString() },
    end: { dateTime: new Date(start.getTime() + minutes * 60000).toISOString() }
  }, extra || {});
  const ymd = d => d.toISOString().slice(0, 10);

  const events = [
    timed('e-past-1', 'מדריד — סאבלט: לצלם את הדירה והמחסן', at(-2, 10), 60),
    timed('e-past-2', 'מדריד — Workaway: לפתוח חשבון', at(-1, 18), 45),
    timed('e-live', 'מדריד — ספרדית: 20 דקות דיבור בקול', new Date(now - 10 * 60000), 30,
      { description: '<b>הגדרת סיום:</b> לדבר 20 דקות על <i>היכרות וקפה</i>' }),
    timed('e-next', 'מדריד — סאבלט + Workaway: תיאום שבועי', new Date(now + 2 * 3600000), 50),
    timed('e-dentist', 'רופא שיניים', at(1, 9), 30),
    { id: 'e-allday', status: 'confirmed', summary: 'מדריד — יום חופש',
      start: { date: ymd(at(1, 12)) }, end: { date: ymd(at(2, 12)) } },
    timed('e-cancelled', 'מדריד — סאבלט: בוטל', at(1, 12), 30, { status: 'cancelled' }),
    timed('e-trip', 'מדריד — טיול: תוכנית השבועיים', at(1, 20), 60),
    timed('e-spanish-2', 'מדריד — ספרדית', at(2, 8, 30), 20),
    timed('e-work', 'מדריד — עבודה: לבדוק זכויות', at(3, 11), 40),
    timed('e-colon', 'מדריד: באפר — לסגור קצוות', at(4, 16), 30),
    timed('e-nostream', 'מדריד — משהו כללי', at(5, 10), 30),
    timed('e-later', 'מדריד — Workaway: 5 פניות', at(12, 10), 60),
    timed('e-out-of-window', 'מדריד — אחרי נקודת ההחלטה', new Date('2026-12-01T10:00:00+02:00'), 60),
    // The other made-up projects in tests/seed-fake.json (calendarKey קפה, כושר, and the paused גינה)
    timed('c-past', 'קפה — ספקים: לבקש 3 הצעות', at(-1, 12), 30),
    timed('c-today', 'קפה — קלייה: פרופיל בהיר', at(0, 7), 45),
    timed('c-next', 'קפה — מיתוג: סקיצה ללוגו', at(2, 19), 60),
    timed('k-today', 'כושר — ריצה 5 ק״מ', at(0, 21), 40),
    timed('k-tomorrow', 'כושר — כוח: פלג גוף עליון', at(1, 7), 45),
    timed('g-today', 'גינה — שתילה: בזיליקום', at(0, 17), 30)
  ];
  const startOf = e => new Date(e.start.dateTime || e.start.date);
  const endOf = e => new Date(e.end.dateTime || e.end.date);

  F.shift = (id, minutes) => {
    const e = events.find(x => x.id === id);
    for (const k of ['start', 'end']) e[k].dateTime = new Date(new Date(e[k].dateTime).getTime() + minutes * 60000).toISOString();
    return e;
  };

  window.google = { accounts: { oauth2: {
    initTokenClient(config) {
      return {
        requestAccessToken(options) {
          F.prompts.push(options && options.prompt);
          later().then(() => {
            if (F.scenario === 'popup_closed') return config.error_callback({ type: 'popup_closed' });
            if (F.scenario === 'popup_blocked') return config.error_callback({ type: 'popup_failed_to_open' });
            if (F.scenario === 'access_denied') return config.callback({ error: 'access_denied' });
            config.callback({
              access_token: 'fake-token-' + Math.random().toString(36).slice(2),
              expires_in: F.tokenSeconds, token_type: 'Bearer',
              scope: F.scenario === 'no_scope' ? 'email' : config.scope
            });
          });
        }
      };
    },
    hasGrantedAllScopes(response, ...scopes) {
      const granted = (response.scope || '').split(' ');
      return scopes.every(s => granted.includes(s));
    }
  } } };

  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const apiError = (code, reason) => ({ error: { code, message: reason, errors: [{ reason }] } });
  const realFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith('https://www.googleapis.com/calendar/')) return realFetch(input, init);
    const method = ((init && init.method) || 'GET').toUpperCase();
    F.requests.push({ method, url });
    await later();
    const auth = (init && init.headers && init.headers.Authorization) || '';
    if (F.scenario === 'network') throw new TypeError('Failed to fetch');
    if (F.scenario === 'expired' || !auth.startsWith('Bearer fake-token-')) return reply(401, apiError(401, 'authError'));
    if (F.scenario === 'denied') return reply(403, apiError(403, 'insufficientPermissions'));
    if (F.scenario === 'not_configured') return reply(403, apiError(403, 'accessNotConfigured'));
    if (F.scenario === 'rate_limited') return reply(403, apiError(403, 'rateLimitExceeded'));
    if (method !== 'GET') return reply(405, apiError(405, 'methodNotAllowed'));
    const q = new URL(url).searchParams;
    const min = new Date(q.get('timeMin')), max = new Date(q.get('timeMax'));
    const inWindow = events.filter(e => endOf(e) > min && startOf(e) < max).sort((a, b) => startOf(a) - startOf(b));
    const from = Number(q.get('pageToken') || 0);
    const body = { kind: 'calendar#events', timeZone: q.get('timeZone'), items: inWindow.slice(from, from + F.pageSize) };
    if (from + F.pageSize < inWindow.length) body.nextPageToken = String(from + F.pageSize);
    return reply(200, body);
  };
})();
