import { SEC_TEAMS } from '../data-source/teams.js?v=36';
import { conferenceOf } from '../data-source/power4-teams.js?v=36';
import { fetchGames } from '../data-source/provider.js?v=36';
import { RULE_DEFAULTS, gameForTeam, evaluateTeamsForWeek, isLocked, computeLockTime } from './eligibility.js?v=36';
import { lossCountFor } from './elimination.js?v=36';

// ---- on-device diagnostics ----
// Three fix attempts guessed at plausible browser mechanisms (scroll
// restoration, rAF-in-background-tabs, bfcache, scroll anchoring) and none
// of them were confirmed against the real device — plus a report of the
// whole page hanging on "Loading…" once, which is a different and more
// concerning symptom. Rather than guess a fifth mechanism blind, this logs
// a real timeline (script start, auth, each Firebase listener's first
// response, every render(), every scroll event, pageshow/visibilitychange)
// to an on-screen panel, visible by adding ?debug=1 to the URL — so the
// next report can be "here's the actual log" instead of another guess.
const DEBUG = location.search.includes('debug');
const debugLog = [];
function dlog(msg) {
  if (!DEBUG) return;
  const t = (performance.now() / 1000).toFixed(2);
  // NEWEST FIRST — with oldest-first, every screenshot so far captured only
  // the first ~0.5s and cut off the post-render entries that actually
  // matter. That was a flaw in the tooling, not the data.
  debugLog.unshift(`${t}s  ${msg}`);
  if (debugLog.length > 120) debugLog.pop();
  renderDebugPanel();
}
function renderDebugPanel() {
  if (!DEBUG) return;
  let el = document.getElementById('debugPanel');
  if (!el) {
    el = document.createElement('div');
    el.id = 'debugPanel';
    el.style.cssText = 'position:fixed;bottom:0;left:0;right:0;max-height:55vh;overflow:auto;background:rgba(0,0,0,0.95);color:#0f0;font-size:10px;font-family:monospace;padding:6px;z-index:999999;white-space:pre-wrap;border-top:2px solid #0f0;';
    document.documentElement.appendChild(el);
  }
  el.textContent = debugLog.join('\n');
}
if (DEBUG) {
  dlog(`script start — visibilityState=${document.visibilityState} scrollY=${window.scrollY} readyState=${document.readyState}`);
  window.addEventListener('pageshow', e => dlog(`pageshow — persisted=${e.persisted} scrollY=${window.scrollY}`));
  window.addEventListener('visibilitychange', () => dlog(`visibilitychange — visibilityState=${document.visibilityState} scrollY=${window.scrollY}`));
  window.addEventListener('scroll', () => dlog(`scroll event — scrollY=${window.scrollY}`));
  window.addEventListener('error', e => dlog(`ERROR — ${e.message} @ ${e.filename}:${e.lineno}`));
  window.addEventListener('unhandledrejection', e => dlog(`UNHANDLED REJECTION — ${e.reason?.message || e.reason}`));

  // window.scrollY is the DOCUMENT's own scroll position. iOS's visual
  // viewport (what's actually on screen while the address bar animates
  // in/out) is a SEPARATE coordinate system that can shift on its own —
  // it wouldn't show up as a `scroll` event on window at all, which would
  // explain scrollY reading 0 the whole time even if the bug is real.
  if (window.visualViewport) {
    const vv = window.visualViewport;
    dlog(`visualViewport initial — w=${vv.width} h=${vv.height} offsetTop=${vv.offsetTop} pageTop=${vv.pageTop} scale=${vv.scale}`);
    vv.addEventListener('resize', () => dlog(`visualViewport RESIZE — w=${vv.width} h=${vv.height} offsetTop=${vv.offsetTop} pageTop=${vv.pageTop} scale=${vv.scale}`));
    vv.addEventListener('scroll', () => dlog(`visualViewport SCROLL — offsetTop=${vv.offsetTop} pageTop=${vv.pageTop}`));
  } else {
    dlog('window.visualViewport not supported on this browser');
  }

  // Continuous geometry sampling. Every previous one-shot check happened to
  // fire BEFORE the Firebase data arrived and the real content rendered
  // (~1.5s), so it always reported header top=undefined / a placeholder-only
  // page. This samples well past that point to capture the state the user
  // actually sees, and is the measurement that distinguishes the remaining
  // possibilities:
  //   headerTop NEGATIVE  -> document really is scrolled (scrollY should agree)
  //   headerTop 0, hidden -> painted behind browser chrome (a paint/viewport
  //                          issue no scroll API can fix)
  //   header MISSING      -> it's not in the DOM at all; not a scroll bug
  [1500, 2500, 4000, 6000].forEach(ms => setTimeout(() => {
    const h = document.querySelector('.app-header');
    const r = h?.getBoundingClientRect();
    const vv = window.visualViewport;
    dlog(`GEO@${ms}ms headerInDom=${!!h} headerTop=${r ? Math.round(r.top) : 'n/a'} headerH=${r ? Math.round(r.height) : 'n/a'} scrollY=${window.scrollY} docScrollTop=${document.documentElement.scrollTop} innerH=${window.innerHeight} vvH=${vv?.height} vvOffTop=${vv?.offsetTop} vvPageTop=${vv?.pageTop}`);
  }, ms));
}

// Mobile browsers sometimes restore a previous scroll position (or drift
// from one) when reopening a tab, or when the page's content height jumps
// (e.g. the short claim screen -> the much taller Pick screen right after
// claiming). Disable the browser's own restoration and force scroll-to-top
// on every genuine screen change — tracked by "which screen" (claim vs a
// specific participant), not just once on first paint, since the first fix
// only caught the very first render and missed the claim -> Pick transition.
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
let lastScreenKey = undefined;

// ROOT CAUSE, finally proven by on-device geometry logging + a screenshot:
//
//   GEO@6000ms headerInDom=true headerTop=0 headerH=55 scrollY=0 innerH=956
//
// innerHeight reports 956 — the FULL physical screen height of the device,
// including the status bar, address bar and bottom toolbar. But the actually
// visible page area is only ~779px tall and begins ~111px down the screen.
// So the layout viewport spans the entire screen *behind* the browser
// chrome, and the header (at top:0, height 55) plus the rules section
// (~50px) — about 105px, almost exactly the ~111px hidden region — are
// rendered underneath the address bar.
//
// This is NOT a scroll problem, which is why six scroll-based fixes all
// failed: the document is genuinely at scroll position 0, and scroll cannot
// go negative, so no scroll API could ever pull that content out from behind
// the chrome. The only fix is to add top padding so content starts below it.
//
// Detection: on a phone the layout viewport should be SHORTER than the
// screen (the chrome takes space). When innerHeight >= screen.height, the
// chrome must be overlaying the page instead. The viewport APIs themselves
// can't be trusted here — visualViewport reported height=956/offsetTop=0 at
// the same moment content was demonstrably hidden — so screen.height is the
// only reliable signal.
const TOUCH_DEVICE = matchMedia('(pointer: coarse)').matches;

function chromeOverlayInset() {
  const screenH = window.screen?.height || 0;
  if (!TOUCH_DEVICE || !screenH) return 0;
  if (window.innerHeight < screenH - 2) return 0; // chrome properly accounted for
  // Top chrome (status bar + address bar) measured at ~111px of a 956px
  // screen. Scale that ratio so it adapts across devices, with sane bounds.
  return Math.min(160, Math.max(80, Math.round(screenH * 0.118)));
}

function applyChromeOverlayFix() {
  const inset = chromeOverlayInset();
  const current = parseInt(document.body.style.paddingTop || '0', 10);
  if (inset === current) return;
  // Padding exactly fills the region hidden behind the chrome, so there's no
  // visible gap — the header just lands immediately below the address bar.
  document.body.style.paddingTop = inset ? `${inset}px` : '';
  dlog(`chromeOverlayFix — paddingTop=${inset} innerH=${window.innerHeight} screenH=${window.screen?.height}`);
}

function jiggleScrollTop() {
  applyChromeOverlayFix();
  window.scrollTo(0, 1);
  window.scrollTo(0, 0);
  if (document.documentElement) {
    document.documentElement.scrollTop = 1;
    document.documentElement.scrollTop = 0;
  }
}

function logGeometry(label) {
  if (!DEBUG) return;
  const rect = document.querySelector('.app-header')?.getBoundingClientRect();
  dlog(`  ${label} headerTop=${rect ? Math.round(rect.top) : 'n/a'} scrollY=${window.scrollY} vvH=${window.visualViewport?.height}`);
}

function forceScrollTop() {
  dlog(`forceScrollTop() — scrollY=${window.scrollY}`);
  jiggleScrollTop();
  setTimeout(() => { jiggleScrollTop(); logGeometry('+0ms'); }, 0);
  setTimeout(() => { jiggleScrollTop(); logGeometry('+100ms'); }, 100);
  setTimeout(() => { jiggleScrollTop(); logGeometry('+400ms'); }, 400);
  setTimeout(() => { jiggleScrollTop(); logGeometry('+900ms'); }, 900);
}

// The offset appears when the toolbar shows/hides AFTER layout, so also
// re-correct on visual-viewport resize — but only briefly after load, and
// only until the user scrolls on purpose, so this can never fight someone
// who has deliberately scrolled down (the toolbar collapses as you scroll,
// which fires this same event).
let userHasScrolled = false;
['touchstart', 'wheel', 'keydown'].forEach(evt =>
  window.addEventListener(evt, () => { userHasScrolled = true; }, { passive: true, once: true })
);
const pageLoadedAt = Date.now();
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => {
    if (userHasScrolled) return;
    if (Date.now() - pageLoadedAt > 4000) return;
    dlog(`visualViewport resize -> re-correcting (vvH=${window.visualViewport.height})`);
    jiggleScrollTop();
    setTimeout(jiggleScrollTop, 50);
  });
}

// "Close the tab, reopen the link" restoring an old scroll position is very
// likely mobile Safari's back-forward cache (bfcache): it repaints a frozen
// snapshot of the page exactly as it was when the tab closed — including
// scroll position — WITHOUT re-running any of this file's JS. That means
// nothing tied to render()/Firebase callbacks can ever catch it, no matter
// how the render-triggered scroll logic below is built. `pageshow` is the
// event made specifically for this: it fires on a bfcache restore (and on
// normal loads too), unlike load/DOMContentLoaded which don't fire again
// for a bfcache restore.
window.addEventListener('pageshow', forceScrollTop);

firebase.initializeApp(firebaseConfig);
const db = firebase.database();

const S = { participants: {}, weeks: {}, picks: {}, config: {}, loaded: false };
const me = { identity: null, participantId: null };

// UI-only state that must survive across render() calls (which happen on
// every Firebase update, so anything not stored here — like which tab is
// open — would otherwise snap back to the default each time someone else
// makes a pick).
const ui = { activeTab: 'pick', openScheduleTeam: null, rulesOpen: false, claimingPid: null };
let seatRestoreTried = false;

// The full-season schedule is fetched directly from ESPN (read-only, no
// Firebase involved) the first time anyone opens a schedule view, then
// cached in memory for the rest of the session.
let seasonSchedule = null;
let seasonScheduleLoading = false;
let seasonScheduleError = null;

const $ = id => document.getElementById(id);

function deviceId() {
  let id = localStorage.getItem('ssp_device');
  if (!id) {
    id = 'dev_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('ssp_device', id);
  }
  return id;
}

// Persistence forced to NONE (in-memory only) deliberately — this app never
// relies on Firebase's own session surviving a reload; participant identity
// is re-proven with a password on every fresh load regardless of which
// anonymous uid Firebase hands out that time (see restoreSeatSession()).
// The default LOCAL persistence needs IndexedDB, which some mobile Chrome
// configurations and in-app browsers (e.g. links opened inside Messages)
// block or restrict. NONE sidesteps that dependency at no real cost here.
//
// Every step here is time-boxed. setPersistence sits in front of sign-in, and
// on WebKit (all iOS browsers, Chrome included) a wedged storage layer can
// leave its promise pending forever rather than rejecting — which stalls the
// whole chain silently, with no error and no sign-in. Persistence is only a
// nice-to-have here anyway (seat identity is re-proven by password on every
// load), so it must never be able to block sign-in.
// `boot()` mirrors these stages into index.html's watchdog buffer, which is
// visible without devtools — dlog() alone is gated behind ?debug=1.
const boot = m => { try { window.__bootLog?.(m); } catch { /* never let logging break boot */ } };
boot('app.js module started');

function withTimeout(promise, ms, label) {
  return Promise.race([
    Promise.resolve(promise).then(() => `${label}: ok`, e => `${label}: failed (${e?.code || e?.message || e})`),
    new Promise(res => setTimeout(() => res(`${label}: TIMED OUT after ${ms}ms — continuing anyway`), ms)),
  ]);
}

(async () => {
  const persistResult = await withTimeout(
    firebase.auth().setPersistence(firebase.auth.Auth.Persistence.NONE), 1200, 'setPersistence(NONE)'
  );
  boot(persistResult);
  dlog(persistResult);
  try {
    boot('calling signInAnonymously()');
    dlog('calling signInAnonymously()');
    await firebase.auth().signInAnonymously();
    boot('signInAnonymously() resolved');
    dlog('signInAnonymously() resolved');
  } catch (e) {
    boot(`signInAnonymously() REJECTED — ${e.code}`);
    dlog(`signInAnonymously() REJECTED — ${e.code} ${e.message}`);
    showFatal(`Couldn't sign in: ${e.message}. Private/Incognito browsing can block the storage this needs — try a normal browser window.`);
  }
})();

// Auth wedged in Firebase's storage layer never errors — it just never
// settles — so the only way out is to notice the silence and act on it.
// Reload once with IndexedDB disabled (see the inline script in index.html),
// which takes the hanging storage path out of the picture entirely.
setTimeout(() => {
  if (firebase.auth().currentUser) return;
  boot('STALLED: no auth user after 7s');
  dlog('STALLED: no auth user after 7s');
  let alreadyRetried = false;
  try {
    alreadyRetried = sessionStorage.getItem('ssp_no_idb') === '1';
    sessionStorage.setItem('ssp_no_idb', '1');
  } catch (e) { /* no sessionStorage — fall through to the message below */ }
  if (!alreadyRetried) {
    boot('reloading once with IndexedDB disabled');
    location.reload();
    return;
  }
  showFatal('Signing in never completed, even with browser storage disabled. Close any other tabs of this site and reload — another tab can hold the storage lock this needs.');
}, 7000);

// Anything that stops the data from arriving used to leave the page showing
// "Loading…" forever with no explanation (reported in an incognito tab,
// where Firebase's anonymous auth can be blocked from using local storage).
// Show something actionable instead of hanging silently.
function showFatal(msg) {
  const el = $('app');
  if (!el || S.loaded) return;
  el.innerHTML = `<div style="padding:2rem;text-align:center;">
    <p style="color:var(--lose);font-weight:600;">Couldn't load the pool</p>
    <p class="muted" style="font-size:0.9rem;">${msg}</p>
  </div>`;
}
setTimeout(() => {
  if (!S.loaded) {
    dlog('WATCHDOG — still not loaded after 15s');
    showFatal('The connection to the pool data timed out. Check your connection and reload; if you\'re in a Private/Incognito window, try a normal one.');
  }
}, 15000);
firebase.auth().onAuthStateChanged(u => {
  boot(`onAuthStateChanged — uid=${u?.uid ? u.uid.slice(0, 8) : '(none)'}`);
  dlog(`onAuthStateChanged — uid=${u?.uid || '(none, using deviceId fallback)'}`);
  me.identity = u ? u.uid : deviceId();
  resolveMyParticipant();
  logVisit();
  setupPresence();
  // Every read below requires auth != null per firebase-rules.json — this is
  // the ONLY point where we know that's actually true. Subscribing at module
  // top-level instead (as this used to) raced the network round-trip
  // signInAnonymously() needs: the .on('value') calls fired synchronously
  // immediately, often before auth had actually completed, so Firebase's
  // rules saw auth == null and permanently denied that listener — it does
  // NOT silently retry once auth later succeeds. That race was near-invisible
  // before (LOCAL persistence usually had a warm, already-authenticated
  // session ready near-instantly on a reload) but got much easier to hit
  // once persistence was forced to NONE, since now every load needs a fresh
  // network round-trip first. Subscribing here, only once auth is confirmed,
  // removes the race entirely regardless of how fast that round-trip is.
  if (u) subscribeDataListeners();
  render();
});
if (!firebase.auth().currentUser) me.identity = deviceId();

// ---- usage stats (admin-only visibility): one view log per page load + live presence ----
let viewLogged = false;
function logVisit() {
  // Must wait for a real signed-in user, exactly like setupPresence below.
  // onAuthStateChanged fires once with no user before sign-in completes; on
  // that pass me.identity is the local deviceId fallback, so this wrote to
  // views/<deviceId> — which the rules reject ($uid must equal auth.uid) —
  // while still burning the one-shot flag, so the real visit was never
  // logged at all. Admin's "last seen" then sat at "—" forever for everyone
  // (presence was unaffected, which is why people showed as online with no
  // last-seen time). Only became reachable once auth persistence went
  // in-memory and that no-user pass started happening on every load.
  const user = firebase.auth().currentUser;
  if (viewLogged || !user) return;
  viewLogged = true;
  db.ref('views/' + user.uid).update({
    count: firebase.database.ServerValue.increment(1),
    last: firebase.database.ServerValue.TIMESTAMP,
  }).catch(() => {});
}

let presenceFor = null;
function setupPresence() {
  if (!me.identity || presenceFor === me.identity || !firebase.auth().currentUser) return;
  presenceFor = me.identity;
  const ref = db.ref('presence/' + me.identity);
  db.ref('.info/connected').on('value', s => {
    if (s.val()) {
      ref.onDisconnect().remove().catch(() => {});
      ref.set(firebase.database.ServerValue.TIMESTAMP).catch(() => {});
    }
  });
}

let dataListenersSubscribed = false;
function subscribeDataListeners() {
  if (dataListenersSubscribed) return;
  dataListenersSubscribed = true;
  boot('subscribing data listeners');
  for (const node of ['participants', 'weeks', 'picks', 'config']) {
    let firstFire = true;
    db.ref(node).on('value', snap => {
      if (firstFire) { boot(`${node} loaded`); dlog(`${node} listener fired (first time)`); firstFire = false; }
      S[node] = snap.val() || {};
      S.loaded = true;
      if (node === 'participants') {
        resolveMyParticipant();
        // Only worth attempting once participants exist and we know our uid.
        if (!me.participantId && !seatRestoreTried && me.identity) {
          seatRestoreTried = true;
          restoreSeatSession();
        }
      }
      render();
    }, err => {
      // No error callback here before meant a permission-denied (or any other
      // read error) failed completely silently — S.loaded would never become
      // true and the page would hang on "Loading…" forever with zero trace of
      // why. That matches a reported one-time hang closely enough to be worth
      // fixing regardless of whether it's the scroll issue's cause too.
      // dlog() alone isn't enough — it's only visible behind ?debug=1, which a
      // real user hitting this would never think to add. Surface it for real.
      boot(`${node} listener ERROR — ${err.code || err.message}`);
      dlog(`${node} listener ERROR — ${err.code || ''} ${err.message}`);
      showFatal(`Couldn't load ${node}: ${err.message}`);
    });
  }
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function resolveMyParticipant() {
  const cached = localStorage.getItem('ssp_participant');
  if (cached && S.participants[cached]?.claimedBy === me.identity) {
    me.participantId = cached;
    return;
  }
  const matched = Object.keys(S.participants).find(
    pid => S.participants[pid]?.claimedBy === me.identity
  ) || null;
  // Don't drop a seat we're already signed into just because claimedBy no
  // longer points at THIS session. claimedBy holds a single uid, but auth
  // persistence is in-memory now, so every page load (and every extra tab)
  // gets a fresh uid and re-claims the seat — which would otherwise kick the
  // other session back to the sign-in screen, and them kick this one, back
  // and forth. Staying put is also correct at the permission level: each
  // session's own seatAuth/{pid}/authorized/{uid} entry survives, so its
  // writes are still accepted by the rules.
  if (!matched && me.participantId && cached === me.participantId && S.participants[me.participantId]) {
    return;
  }
  me.participantId = matched;
  if (me.participantId) localStorage.setItem('ssp_participant', me.participantId);
}

// Re-authorize this device from the saved password on load, so returning
// users don't retype it. Mirrors the admin panel's cached-passphrase flow:
// the write is only accepted by the rules if the hash matches, so a stale
// or wrong saved password simply fails and drops back to the sign-in list.
async function restoreSeatSession() {
  const pid = localStorage.getItem('ssp_participant');
  const pass = localStorage.getItem('ssp_seatpass');
  if (!pid || !pass || !me.identity || !S.participants[pid]) return;
  try {
    await db.ref(`seatAuth/${pid}/authorized/${me.identity}`).set(await sha256Hex(pass));
    await db.ref(`participants/${pid}/claimedBy`).set(me.identity);
    me.participantId = pid;
    dlog(`restoreSeatSession OK — ${pid}`);
    render();
  } catch (e) {
    dlog(`restoreSeatSession failed — ${e.message}`);
    localStorage.removeItem('ssp_seatpass');
  }
}

// Seats are protected by a password chosen on first claim. The password is
// never stored or sent anywhere — only its SHA-256. The client proves it
// knows the password by writing that hash to seatAuth/{pid}/authorized/{uid},
// which the security rules accept ONLY if it equals seatAuth/{pid}/passHash.
// passHash lives outside /participants precisely because read permission
// cascades in Firebase: anything under the publicly-readable /participants
// node could be read and replayed by anyone, defeating the whole thing.
async function submitSeatPassword(pid, password, isNew) {
  if (!me.identity || !password) return;
  const err = $('claimErr');
  const hash = await sha256Hex(password);
  try {
    if (isNew) {
      // Rules only allow this while no password exists, so two people racing
      // to claim the same fresh seat can't overwrite each other — the loser's
      // write is rejected and they fall through to the wrong-password path.
      await db.ref(`seatAuth/${pid}/passHash`).set(hash);
    }
    await db.ref(`seatAuth/${pid}/authorized/${me.identity}`).set(hash);
    await db.ref(`participants/${pid}/claimedBy`).set(me.identity);
    localStorage.setItem('ssp_participant', pid);
    localStorage.setItem('ssp_seatpass', password);
    me.participantId = pid;
    ui.claimingPid = null;
    render();
  } catch (e) {
    if (err) {
      err.textContent = isNew
        ? 'Someone just claimed that name. Refresh and try signing in instead.'
        : "That password doesn't match. Try again, or ask the commissioner to reset it.";
      err.classList.remove('hidden');
    }
  }
}

function seasonYearGuess() {
  const d = S.weeks?.[1]?.startDate;
  return d ? Number(d.slice(0, 4)) : new Date().getFullYear();
}

async function ensureSeasonSchedule() {
  if (seasonSchedule || seasonScheduleLoading) return;
  seasonScheduleLoading = true;
  seasonScheduleError = null;
  try {
    const year = seasonYearGuess();
    seasonSchedule = await fetchGames(`${year}-08-20`, `${year}-12-15`);
  } catch (e) {
    seasonScheduleError = e.message;
  } finally {
    seasonScheduleLoading = false;
    render();
  }
}

// College football weeks run Tue-Mon; derive week 1's start as the Tuesday
// on/before the season's earliest kickoff, so week numbers need no hardcoded
// season dates and keep working in future seasons unchanged.
function mostRecentTuesday(ms) {
  const d = new Date(ms);
  const diff = (d.getUTCDay() - 2 + 7) % 7;
  d.setUTCDate(d.getUTCDate() - diff);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

function seasonStartMs() {
  const earliest = Math.min(...seasonSchedule.map(g => new Date(g.kickoff).getTime()));
  return mostRecentTuesday(earliest);
}

function weekNumberFor(kickoffIso, startMs) {
  return Math.floor((new Date(kickoffIso).getTime() - startMs) / (7 * 24 * 3600 * 1000)) + 1;
}

function teamScheduleRows(abbr) {
  if (!seasonSchedule?.length) return [];
  const startMs = seasonStartMs();
  return seasonSchedule
    .filter(g => g.home.abbr === abbr || g.away.abbr === abbr)
    .map(g => {
      const isHome = g.home.abbr === abbr;
      const opp = isHome ? g.away : g.home;
      return {
        weekNum: weekNumberFor(g.kickoff, startMs),
        date: new Date(g.kickoff),
        opponentAbbr: opp.abbr,
        opponentName: opp.name,
        opponentSchool: opp.school || opp.name || opp.abbr,
        homeAway: isHome ? 'vs' : '@',
        completed: g.completed,
        result: g.completed ? `${g.away.score}-${g.home.score}` : null,
        won: g.completed ? g.winnerAbbr === abbr : null,
        opponentConf: conferenceOf(opp.abbr),
      };
    })
    .sort((a, b) => a.date - b.date);
}

/** School name only (no mascot) for a team, from live schedule data — falls back to the abbreviation if the schedule hasn't loaded yet. */
function schoolNameFor(abbr) {
  if (!seasonSchedule?.length) return abbr;
  const g = seasonSchedule.find(g => g.home.abbr === abbr || g.away.abbr === abbr);
  if (!g) return abbr;
  const t = g.home.abbr === abbr ? g.home : g.away;
  return t.school || t.name || abbr;
}

// Returns { games, lockTime, status } for any week number, even ones the
// commissioner hasn't set up in admin yet — falls back to a lock time and
// game list derived straight from the live season schedule, so the queue
// (Schedule tab) works for future weeks without waiting on admin sync.
// Admin-synced weeks (S.weeks[n]) are always preferred when present, since
// they carry real-time results and any manual overrides.
function weekDataFor(n) {
  if (S.weeks[n]) return S.weeks[n];
  if (!seasonSchedule?.length) return null;
  const startMs = seasonStartMs();
  const games = seasonSchedule.filter(g => weekNumberFor(g.kickoff, startMs) === n);
  if (!games.length) return null;
  const gamesById = Object.fromEntries(games.map(g => [g.id, g]));
  const lockTime = computeLockTime(games, S.config);
  return { games: gamesById, lockTime, status: 'upcoming' };
}

// A merged /weeks-shaped map covering every week number that has a pick
// (including future queued ones) plus whichever weeks the caller also needs
// (e.g. the grid's visible columns) — so usageStatsFor's cross-week opponent
// lookups work even for weeks admin hasn't synced yet.
function mergedWeeksFor(extraWeekNumbers = []) {
  const weekNumbers = new Set([
    ...Object.keys(S.picks || {}).map(Number),
    ...extraWeekNumbers,
  ]);
  const merged = {};
  for (const n of weekNumbers) merged[n] = weekDataFor(n);
  return merged;
}

async function submitPick(team, weekNumber = S.config.currentWeek || 1) {
  const week = weekDataFor(weekNumber);
  if (isLocked(week)) { alert(`Picks are locked for week ${weekNumber}.`); return; }
  const current = S.picks?.[weekNumber]?.[me.participantId]?.team;
  // A rejected write (week locked server-side, or this device's seat
  // authorization no longer valid) used to reject silently, which looks
  // exactly like the tap never registered — the worst possible failure for
  // a pick. Say so instead.
  try {
    if (current === team) {
      // Tapping your own current pick again clears it, rather than being a
      // no-op — the only way to go from "picked" back to "no pick" otherwise
      // would be picking a different team first, which isn't obvious and
      // burns nothing but is still confusing.
      await db.ref(`picks/${weekNumber}/${me.participantId}`).remove();
    } else {
      await db.ref(`picks/${weekNumber}/${me.participantId}`).set({ team, pickedAt: Date.now() });
    }
  } catch (e) {
    dlog(`submitPick failed — ${e.code || ''} ${e.message}`);
    alert(`Couldn't save that pick: ${e.message}\n\nIf week ${weekNumber} just locked, picks are final. Otherwise try reloading and signing in again.`);
  }
}

const TABS = ['pick', 'schedule', 'standings', 'history'];

function render() {
  if (!S.loaded) { dlog('render() called but S.loaded=false, bailing'); return; }
  if (!me.participantId) return renderClaimScreen();
  dlog(`render() (Pick screen) — participantId=${me.participantId} scrollY-before=${window.scrollY}`);
  const participant = S.participants[me.participantId];

  // Tapping a cell in the Schedule tab's queue writes to Firebase, whose
  // picks listener fires straight back into this same render(), which
  // rebuilds #app's innerHTML from scratch — including the Schedule and
  // History grids' own horizontally-scrolling wrapper. Without restoring it,
  // that reset the grid to its Week 1 column on every tap, which looked like
  // your click had "jumped you back" instead of just registering the pick.
  const scrollLeftByTab = {};
  document.querySelectorAll('.tab-panel .history-scroll').forEach(el => {
    scrollLeftByTab[el.closest('.tab-panel').id] = el.scrollLeft;
  });

  $('app').innerHTML = `
    ${renderHeader(participant)}
    ${renderRulesSection()}
    <nav class="tabs">
      <button class="tab-btn ${ui.activeTab === 'pick' ? 'active' : ''}" data-tab="pick">Pick</button>
      <button class="tab-btn ${ui.activeTab === 'schedule' ? 'active' : ''}" data-tab="schedule">Schedule</button>
      <button class="tab-btn ${ui.activeTab === 'standings' ? 'active' : ''}" data-tab="standings">Standings</button>
      <button class="tab-btn ${ui.activeTab === 'history' ? 'active' : ''}" data-tab="history">History</button>
    </nav>
    <div id="tab-pick" class="tab-panel ${ui.activeTab === 'pick' ? '' : 'hidden'}">${renderPickScreen(participant)}</div>
    <div id="tab-standings" class="tab-panel ${ui.activeTab === 'standings' ? '' : 'hidden'}">${renderStandings()}</div>
    <div id="tab-history" class="tab-panel ${ui.activeTab === 'history' ? '' : 'hidden'}">${renderHistory()}</div>
    <div id="tab-schedule" class="tab-panel ${ui.activeTab === 'schedule' ? '' : 'hidden'}">${renderScheduleTab(participant)}</div>
    ${renderScheduleModal()}
  `;
  wireTabs();
  wirePickButtons();
  wireScheduleLinks();
  wireQueuePicks();
  wireClearPicksBtn();
  wireRulesSection();
  wireHeader();
  document.querySelectorAll('.tab-panel .history-scroll').forEach(el => {
    const saved = scrollLeftByTab[el.closest('.tab-panel').id];
    if (saved) el.scrollLeft = saved;
  });
  ensureScrolledToTop(me.participantId);
}

function ensureScrolledToTop(screenKey) {
  if (screenKey === lastScreenKey) return;
  lastScreenKey = screenKey;
  forceScrollTop();
}

function wireRulesSection() {
  document.querySelector('.rules-section')?.addEventListener('toggle', e => {
    ui.rulesOpen = e.target.open;
  });
}

function renderHeader(participant) {
  const maxLosses = S.config.maxLosses ?? RULE_DEFAULTS.maxLosses;
  const losses = participant ? lossCountFor(participant) : 0;
  const statusBadge = participant?.eliminatedWeek != null
    ? ' <span class="badge-out">ELIMINATED</span>'
    : losses > 0
      ? ` <span class="badge-warn">${losses}/${maxLosses} losses</span>`
      : '';
  return `<header class="app-header">
    <h1>${S.config.poolName || 'SEC Survivor Pool'}</h1>
    <div class="me-wrap">
      <button class="me-name" id="meNameBtn">${participant?.name || ''}${statusBadge}</button>
      <div class="me-menu hidden" id="meMenu">
        <button class="btn secondary" id="unclaimSelfBtn">Sign out</button>
      </div>
    </div>
  </header>`;
}

// Sign out only forgets this device — the seat and its password stay put, so
// you can sign back in here or anywhere else. (Unclaiming for real is an
// admin action now; a seat with a password shouldn't be grabbable by anyone
// who happens to open the link.)
async function unclaimSelf() {
  if (!me.participantId) return;
  if (!confirm("Sign out on this device? Your seat and picks stay exactly as they are — you'll just need your password to sign back in.")) return;
  await db.ref(`seatAuth/${me.participantId}/authorized/${me.identity}`).remove().catch(() => {});
  localStorage.removeItem('ssp_participant');
  localStorage.removeItem('ssp_seatpass');
  me.participantId = null;
  ui.claimingPid = null;
  render();
}

function wireHeader() {
  $('meNameBtn')?.addEventListener('click', () => $('meMenu')?.classList.toggle('hidden'));
  $('unclaimSelfBtn')?.addEventListener('click', unclaimSelf);
}

function renderRulesSection() {
  const maxTeamUses = S.config.maxTeamUses ?? RULE_DEFAULTS.maxTeamUses;
  const maxSecOpponentPicks = S.config.maxSecOpponentPicks ?? RULE_DEFAULTS.maxSecOpponentPicks;
  const maxLosses = S.config.maxLosses ?? RULE_DEFAULTS.maxLosses;
  const eligibleConferences = S.config.eligibleConferences || RULE_DEFAULTS.eligibleConferences;
  const enabledConfs = Object.entries(eligibleConferences).filter(([, v]) => v).map(([c]) => c);
  const noPickPolicy = S.config.noPickPolicy || 'eliminate';

  const noPickText = {
    eliminate: "If you don't submit a pick before lock, you're eliminated that week.",
    skip: "If you don't submit a pick before lock, you skip that week with no penalty — no team gets used up.",
    autopick: "If you don't submit a pick before lock, one is randomly assigned to you from whatever teams you can still legally pick. If none are left, you're eliminated.",
  }[noPickPolicy] || '';

  return `<details class="rules-section" ${ui.rulesOpen ? 'open' : ''}>
    <summary>Rules &amp; how to play</summary>
    <div class="rules-body">
      <ul>
        <li>Each week, pick one SEC team you think will win.</li>
        <li>${maxLosses === 1
          ? "If your team loses (or ties), you're eliminated."
          : `You're eliminated once your team has lost (or tied) <strong>${maxLosses}</strong> times this season — your first ${maxLosses - 1} loss${maxLosses - 1 === 1 ? '' : 'es'} won't knock you out.`}</li>
        <li>Last participant(s) still alive win the pool.</li>
        <li>Each team can be picked up to <strong>${maxTeamUses}</strong> time${maxTeamUses === 1 ? '' : 's'} all season.</li>
        <li>You can play against the same SEC opponent up to <strong>${maxSecOpponentPicks}</strong> time${maxSecOpponentPicks === 1 ? '' : 's'} all season — no cap on how many <em>different</em> SEC opponents you face, just on repeating the same one.</li>
        <li>Your team's opponent must belong to one of: <strong>${enabledConfs.join(', ') || 'none currently enabled'}</strong>.</li>
        <li>Picks lock at kickoff of the first <em>pickable</em> game each week — games against ineligible opponents don't start the clock. You can't change a pick after that.</li>
        <li>You can plan ahead: the <strong>Schedule</strong> tab doubles as a pick queue, so you can lock in picks for any future week anytime, not just the current one. Change your mind anytime before that week locks, from either the Schedule tab or the Pick tab.</li>
        <li>${noPickText}</li>
      </ul>
    </div>
  </details>`;
}

function renderClaimScreen() {
  dlog(`renderClaimScreen() — scrollY-before=${window.scrollY}`);
  // Every name is listed now, not just unclaimed ones — with a password, a
  // seat can be opened on a second device without unclaiming it first.
  // hasPassword is inferred from claimedBy because seatAuth/passHash is
  // deliberately unreadable by clients.
  const all = Object.entries(S.participants || {});
  const pid = ui.claimingPid;
  const p = pid ? S.participants[pid] : null;
  const isNew = p ? !p.claimedBy : false;

  $('app').innerHTML = `
    <header class="app-header"><h1>${S.config.poolName || 'SEC Survivor Pool'}</h1></header>
    ${renderRulesSection()}
    <div class="claim-screen">
      ${p ? `
        <p><strong>${p.name}</strong></p>
        <p class="muted" style="font-size:0.85rem;">
          ${isNew
            ? 'Pick a password for your seat. You\'ll use it to get back in on any other device — phone, laptop, whatever.'
            : 'Enter your seat password to sign in on this device.'}
        </p>
        <div class="admin-row" style="margin-top:0.6rem;">
          <input id="seatPass" type="password" placeholder="${isNew ? 'Choose a password' : 'Password'}" autocomplete="current-password">
          <button class="btn" id="seatPassBtn">${isNew ? 'Claim seat' : 'Sign in'}</button>
          <button class="btn secondary" id="seatCancelBtn">Back</button>
        </div>
        <div id="claimErr" class="err hidden"></div>
      ` : `
        <p>Tap your name to join. If you don't see it, ask the commissioner to add you.</p>
        <div class="claim-list">
          ${all.length
            ? all.map(([id, q]) => `<button class="claim-btn" data-pid="${id}">${q.name}${q.claimedBy ? '' : ' <span class="muted">· new</span>'}</button>`).join('')
            : '<p class="muted">No names set up yet.</p>'}
        </div>
      `}
    </div>
  `;

  document.querySelectorAll('.claim-btn').forEach(btn => {
    btn.addEventListener('click', () => { ui.claimingPid = btn.dataset.pid; render(); });
  });
  $('seatCancelBtn')?.addEventListener('click', () => { ui.claimingPid = null; render(); });
  const submit = () => submitSeatPassword(pid, $('seatPass').value, isNew);
  $('seatPassBtn')?.addEventListener('click', submit);
  $('seatPass')?.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  $('seatPass')?.focus();

  wireRulesSection();
  ensureScrolledToTop('claim-screen');
}

function renderPickScreen(participant) {
  if (participant?.eliminatedWeek != null) {
    const maxLosses = S.config.maxLosses ?? RULE_DEFAULTS.maxLosses;
    return `<div class="eliminated-panel">
      <p>You were eliminated in Week ${participant.eliminatedWeek}.</p>
      <p class="muted">${participant.eliminatedReason || ''}${maxLosses > 1 ? ` (${maxLosses}/${maxLosses} losses)` : ''}</p>
    </div>`;
  }

  const currentWeek = S.config.currentWeek || 1;
  const week = weekDataFor(currentWeek);
  const myPick = S.picks?.[currentWeek]?.[me.participantId]?.team;
  const locked = isLocked(week);

  if (!week) {
    return `<p class="muted">Week ${currentWeek} hasn't been set up yet. Check back soon.</p>`;
  }

  const lockLabel = week.lockTime
    ? new Date(week.lockTime).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : 'TBD';

  const evaluated = evaluateTeamsForWeek({
    week, picks: S.picks, weeks: mergedWeeksFor(), weekNumber: currentWeek, pid: me.participantId, config: S.config, myPick,
  });

  function renderCard(t, disabled) {
    let opponentLine = 'BYE';
    let meta = '';
    if (t.game) {
      const isHome = t.game.home.abbr === t.abbr;
      const opp = isHome ? t.game.away : t.game.home;
      opponentLine = `${isHome ? 'vs' : '@'} ${opp.school || opp.name || opp.abbr}`;
      if (t.game.completed) {
        opponentLine += ` — Final ${t.game.away.score}-${t.game.home.score}`;
      } else {
        const kickoffLabel = new Date(t.game.kickoff).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
        meta = [kickoffLabel, t.game.network].filter(Boolean).join(' · ');
      }
    }

    // The pick action and the schedule link are separate controls (not
    // schedule-link nested inside the pick <button>) because a disabled
    // <button> also blocks clicks on its children — and viewing a team's
    // schedule needs to work even for teams that aren't pickable right now.
    return `<div class="team-card-wrap">
      <button class="team-card ${t.selected ? 'selected' : ''} ${disabled ? 'disabled' : ''}"
              data-team="${t.abbr}" ${disabled ? 'disabled' : ''} ${t.selected ? 'title="Tap to remove this pick"' : ''}>
        <div class="team-name">${t.name}${t.selected ? ' <span class="queue-remove-hint">✕</span>' : ''}</div>
        <div class="team-opp">${opponentLine}</div>
        ${meta ? `<div class="team-meta">${meta}</div>` : ''}
        ${t.flag ? `<div class="team-flag">${t.flag}</div>` : ''}
      </button>
      <div class="schedule-link" data-schedule-team="${t.abbr}">Full schedule →</div>
    </div>`;
  }

  // Pickable teams first so you don't have to scan past everything you can't
  // choose; a locked week has nothing left pickable, so everything falls into
  // the second group and the divider just quietly doesn't show.
  const pickable = [];
  const unpickable = [];
  for (const t of evaluated) {
    const disabled = t.disabled || (!t.selected && locked);
    (disabled ? unpickable : pickable).push(renderCard(t, disabled));
  }

  const cards = pickable.join('')
    + (pickable.length && unpickable.length ? '<div class="team-grid-divider">Not eligible this week</div>' : '')
    + unpickable.join('');

  return `
    <div class="week-meta">
      <span>Week ${currentWeek}</span>
      <span class="${locked ? 'locked' : ''}">${locked ? 'Locked' : `Locks ${lockLabel}`}</span>
    </div>
    <div class="team-grid">${cards}</div>
  `;
}

function renderStandings() {
  const maxLosses = S.config.maxLosses ?? RULE_DEFAULTS.maxLosses;
  const rows = Object.entries(S.participants || {})
    .filter(([, p]) => p.claimedBy)
    .sort(([, a], [, b]) => {
      const aOut = a.eliminatedWeek ?? Infinity;
      const bOut = b.eliminatedWeek ?? Infinity;
      return bOut - aOut || a.name.localeCompare(b.name);
    });

  return `<table class="standings-table">
    <thead><tr><th>Name</th><th>Status</th></tr></thead>
    <tbody>
      ${rows.map(([, p]) => {
        const losses = lossCountFor(p);
        const status = p.eliminatedWeek != null
          ? `Out — Week ${p.eliminatedWeek}`
          : maxLosses > 1 && losses > 0
            ? `Alive (${losses}/${maxLosses} losses)`
            : 'Alive';
        return `<tr class="${p.eliminatedWeek != null ? 'row-out' : 'row-alive'}">
        <td>${p.name}</td>
        <td>${status}</td>
      </tr>`;
      }).join('')}
    </tbody>
  </table>`;
}

function renderHistory() {
  const weekNumbers = Object.keys(S.weeks || {}).map(Number).sort((a, b) => a - b);
  const participants = Object.entries(S.participants || {}).filter(([, p]) => p.claimedBy);

  return `<div class="history-scroll"><table class="history-table">
    <thead><tr><th>Name</th>${weekNumbers.map(w => `<th>Wk ${w}</th>`).join('')}</tr></thead>
    <tbody>
      ${participants.map(([pid, p]) => `<tr>
        <td>${p.name}</td>
        ${weekNumbers.map(w => {
          // Other players' picks stay hidden until that week locks, so nobody
          // can see (and counter) someone else's pick before it's final. Your
          // own picks are always visible to you.
          if (pid !== me.participantId && !isLocked(S.weeks[w])) {
            return '<td class="muted">Hidden</td>';
          }
          const pick = S.picks?.[w]?.[pid];
          if (!pick) return '<td class="muted">—</td>';
          const game = gameForTeam(S.weeks[w], pick.team);
          let cls = 'pending';
          if (game?.completed) cls = game.winnerAbbr === pick.team ? 'won' : 'lost';
          return `<td class="pick-${cls}">${pick.team}${pick.autoPicked ? '<span class="muted"> (auto)</span>' : ''}</td>`;
        }).join('')}
      </tr>`).join('')}
    </tbody>
  </table></div>`;
}

function renderScheduleTab(participant) {
  if (!seasonSchedule && !seasonScheduleLoading && !seasonScheduleError) ensureSeasonSchedule();
  if (seasonScheduleLoading) return '<p class="muted">Loading full season schedule…</p>';
  if (seasonScheduleError) return `<p class="err">Couldn't load schedule: ${seasonScheduleError}</p>`;
  if (!seasonSchedule?.length) return '<p class="muted">No schedule data available.</p>';

  const canQueue = participant?.eliminatedWeek == null;
  const startMs = seasonStartMs();
  const weekDateLabel = {};
  for (const g of seasonSchedule) {
    const wn = weekNumberFor(g.kickoff, startMs);
    const d = new Date(g.kickoff);
    if (!weekDateLabel[wn] || d < weekDateLabel[wn]) weekDateLabel[wn] = d;
  }
  const weekNums = Object.keys(weekDateLabel).map(Number).sort((a, b) => a - b);
  const allWeeks = mergedWeeksFor(weekNums);

  // Evaluate eligibility once per week (not per cell) — same rules engine the
  // Pick tab uses, so the queue can never disagree with what's actually pickable.
  const evalByWeek = {};
  for (const wn of weekNums) {
    const week = allWeeks[wn];
    const myPick = S.picks?.[wn]?.[me.participantId]?.team;
    evalByWeek[wn] = {
      locked: isLocked(week),
      byAbbr: Object.fromEntries(
        evaluateTeamsForWeek({ week, picks: S.picks, weeks: allWeeks, weekNumber: wn, pid: me.participantId, config: S.config, myPick })
          .map(t => [t.abbr, t])
      ),
    };
  }

  const rows = SEC_TEAMS.map(team => {
    return `<tr>
      <td class="schedule-team-name" data-schedule-team="${team.abbr}">${schoolNameFor(team.abbr)}</td>
      ${weekNums.map(wn => {
        const t = evalByWeek[wn].byAbbr[team.abbr];
        if (!t.game) return '<td class="muted">BYE</td>';

        const isHome = t.game.home.abbr === team.abbr;
        const opp = isHome ? t.game.away : t.game.home;
        const confClass = t.opponentConf === 'SEC' ? 'conf-sec' : (t.opponentConf ? 'conf-power4' : 'conf-none');
        const resultMark = t.game.completed ? (t.game.winnerAbbr === team.abbr ? ' W' : ' L') : '';
        const label = `${isHome ? 'vs' : '@'} ${opp.school || opp.name || opp.abbr}${resultMark}`;

        if (!canQueue || evalByWeek[wn].locked) {
          return `<td class="${confClass}">${label}</td>`;
        }
        // Disabled cells must NOT carry data-queue-pick — a greyed-out cell
        // that's still clickable would let someone queue an ineligible team
        // (this exact bug shipped once already: CSS made it look blocked,
        // but nothing actually stopped the click).
        if (t.disabled) {
          return `<td class="queue-disabled" title="${t.flag}">${label}</td>`;
        }
        if (t.selected) {
          return `<td class="${confClass} queue-selected" data-queue-pick="${wn}:${team.abbr}" title="Your pick — tap to remove">${label} <span class="queue-remove-hint">✕</span></td>`;
        }
        return `<td class="${confClass} queue-pickable" data-queue-pick="${wn}:${team.abbr}" title="Tap to pick ${schoolNameFor(team.abbr)} for week ${wn}">${label}</td>`;
      }).join('')}
    </tr>`;
  }).join('');

  // Only weeks after the current one — clearing your already-made current-week
  // pick is a different, riskier action (there's already a dedicated way to do
  // that: tap your own pick again). This is just for undoing ones queued ahead.
  const currentWeek = S.config.currentWeek || 1;
  const futureQueuedWeeks = weekNums.filter(wn =>
    wn > currentWeek && !evalByWeek[wn].locked && S.picks?.[wn]?.[me.participantId]?.team
  );

  return `
    <p class="muted schedule-legend">
      <span class="conf-sec">SEC opponent</span> &nbsp;
      <span class="conf-power4">Power 4</span> &nbsp;
      <span class="conf-none">not Power 4</span><br>
      Tap a team name for their full schedule.
      ${canQueue ? ' Tap a cell in an unlocked week to queue your pick for that week — change your mind anytime before it locks, here or on the Pick tab.' : ''}
    </p>
    <div class="history-scroll"><table class="schedule-grid-table">
      <thead><tr><th>Team</th>${weekNums.map(wn => `<th>Wk ${wn}<br><span class="muted">${weekDateLabel[wn].toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })}</span></th>`).join('')}</tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    ${futureQueuedWeeks.length
      ? `<p class="schedule-link" id="clearPicksBtn" data-clear-weeks="${futureQueuedWeeks.join(',')}">Clear queued pick${futureQueuedWeeks.length > 1 ? 's' : ''} (Week${futureQueuedWeeks.length > 1 ? 's' : ''} ${futureQueuedWeeks.join(', ')})</p>`
      : ''}
  `;
}

function renderScheduleModal() {
  const abbr = ui.openScheduleTeam;
  if (!abbr) return '<div id="scheduleModal" class="modal-overlay hidden"></div>';

  const teamLabel = schoolNameFor(abbr);
  let body;
  if (seasonScheduleLoading) {
    body = '<p class="muted">Loading…</p>';
  } else if (seasonScheduleError) {
    body = `<p class="err">Couldn't load schedule: ${seasonScheduleError}</p>`;
  } else {
    const rows = teamScheduleRows(abbr);
    body = rows.length
      ? `<table class="modal-schedule-table">
          <thead><tr><th>Wk</th><th>Date</th><th>Opponent</th><th>Result</th></tr></thead>
          <tbody>${rows.map(r => `<tr>
            <td>${r.weekNum}</td>
            <td>${r.date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</td>
            <td>${r.homeAway} ${r.opponentSchool}${!r.opponentConf ? ' <span class="muted">(not P4)</span>' : (r.opponentConf === 'SEC' ? ' <span class="muted">(SEC)</span>' : '')}</td>
            <td>${r.completed ? `${r.won ? 'W' : 'L'} ${r.result}` : '—'}</td>
          </tr>`).join('')}</tbody>
        </table>`
      : '<p class="muted">No games found.</p>';
  }

  return `<div id="scheduleModal" class="modal-overlay">
    <div class="modal-box">
      <div class="modal-header">
        <h3>${teamLabel}</h3>
        <button class="modal-close" id="modalCloseBtn">&times;</button>
      </div>
      ${body}
    </div>
  </div>`;
}

function wireTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      ui.activeTab = btn.dataset.tab;
      render();
    });
  });
}

function wirePickButtons() {
  document.querySelectorAll('.team-card:not(.disabled)').forEach(btn => {
    btn.addEventListener('click', () => submitPick(btn.dataset.team));
  });
}

function wireScheduleLinks() {
  document.querySelectorAll('[data-schedule-team]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      ui.openScheduleTeam = el.dataset.scheduleTeam;
      ensureSeasonSchedule();
      render();
    });
  });
  $('modalCloseBtn')?.addEventListener('click', () => { ui.openScheduleTeam = null; render(); });
  const overlay = $('scheduleModal');
  if (overlay && !overlay.classList.contains('hidden')) {
    overlay.addEventListener('click', e => {
      if (e.target === overlay) { ui.openScheduleTeam = null; render(); }
    });
  }
}

function wireQueuePicks() {
  document.querySelectorAll('[data-queue-pick]').forEach(cell => {
    cell.addEventListener('click', () => {
      const [wn, abbr] = cell.dataset.queuePick.split(':');
      submitPick(abbr, Number(wn));
    });
  });
}

async function clearQueuedPicks(weeks) {
  const label = weeks.length > 1 ? `weeks ${weeks.join(', ')}` : `week ${weeks[0]}`;
  if (!confirm(`Clear your queued pick${weeks.length > 1 ? 's' : ''} for ${label}? You can re-pick anytime before each one locks.`)) return;
  const updates = {};
  for (const wn of weeks) updates[`picks/${wn}/${me.participantId}`] = null;
  try {
    await db.ref().update(updates);
  } catch (e) {
    dlog(`clearQueuedPicks failed — ${e.code || ''} ${e.message}`);
    alert(`Couldn't clear those picks: ${e.message}`);
  }
}

function wireClearPicksBtn() {
  const btn = $('clearPicksBtn');
  if (!btn) return;
  btn.addEventListener('click', () => clearQueuedPicks(btn.dataset.clearWeeks.split(',').map(Number)));
}
