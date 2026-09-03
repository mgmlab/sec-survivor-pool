import { fetchGames } from '../data-source/provider.js?v=30';
import { computeEliminations, lossCountFor } from './elimination.js?v=30';
import { ALL_CONFERENCES } from '../data-source/power4-teams.js?v=30';
import { RULE_DEFAULTS, isLocked, computeLockTime } from './eligibility.js?v=30';
import { autoPicksForWeek } from './autopick.js?v=30';

if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
let lastScreenKey = undefined;

// See js/app.js for the full diagnosis: on iOS the page can be painted
// ~120px offset (hidden behind the address bar) while the document still
// reports scrollY === 0, which makes a plain scrollTo(0,0) a no-op that
// can never fix it. Scrolling to 1 and back forces a real scroll op.
function jiggleScrollTop() {
  window.scrollTo(0, 1);
  window.scrollTo(0, 0);
  if (document.documentElement) {
    document.documentElement.scrollTop = 1;
    document.documentElement.scrollTop = 0;
  }
}

function forceScrollTop() {
  jiggleScrollTop();
  setTimeout(jiggleScrollTop, 0);
  setTimeout(jiggleScrollTop, 100);
  setTimeout(jiggleScrollTop, 400);
  setTimeout(jiggleScrollTop, 900);
}

window.addEventListener('pageshow', forceScrollTop);

let userHasScrolled = false;
['touchstart', 'wheel', 'keydown'].forEach(evt =>
  window.addEventListener(evt, () => { userHasScrolled = true; }, { passive: true, once: true })
);
const pageLoadedAt = Date.now();
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => {
    if (userHasScrolled || Date.now() - pageLoadedAt > 4000) return;
    jiggleScrollTop();
    setTimeout(jiggleScrollTop, 50);
  });
}

function ensureScrolledToTop(screenKey) {
  if (screenKey === lastScreenKey) return;
  lastScreenKey = screenKey;
  forceScrollTop();
}

firebase.initializeApp(firebaseConfig);
const db = firebase.database();

const S = { participants: {}, weeks: {}, picks: {}, config: {}, views: {}, presence: {}, loaded: false };
const me = { identity: null, admin: false };
// Week sections shown that don't have Firebase data (or config.currentWeek)
// backing them yet — lets admin open a blank section for a week number to
// set its dates before ever syncing it. Without this there was no way to
// configure a week other than whichever one happened to be current, and
// "Save dates" for a week you meant to add would silently overwrite
// whatever week WAS showing instead.
const ui = { extraWeeks: new Set() };

const $ = id => document.getElementById(id);

// Lives outside #app (whose innerHTML gets fully replaced on every Firebase
// listener re-render, including the one triggered by the very save this
// confirms) so it survives that re-render instead of being wiped out by it.
let toastTimer = null;
function showToast(msg) {
  let el = document.getElementById('adminToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'adminToast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visible'), 2200);
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function slugify(name) {
  let base = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  let id = base;
  let i = 2;
  while (S.participants[id]) id = `${base}-${i++}`;
  return id;
}

// ---- auth ----
// Unlike app.js, there's no fallback identity here if real Firebase Auth
// never comes through — every node admin needs (including config/weeks/picks,
// not just admin-only ones) requires auth != null per firebase-rules.json, so
// a failure here is fatal, not degradable. This used to be a silently
// swallowed .catch(() => {}), which is exactly why reports of this page
// hanging on "Loading…" forever came back with zero captured errors: Firebase
// Auth failures (blocked IndexedDB/storage — seen in some mobile Chrome
// configurations and in-app browsers) don't throw an uncaught JS exception,
// they just reject this promise, which we were throwing away.
function showFatal(msg) {
  const el = $('app');
  if (!el || S.loaded) return;
  el.innerHTML = `<div style="padding:2rem;text-align:center;">
    <p style="color:var(--lose);font-weight:600;">Couldn't load</p>
    <p class="muted" style="font-size:0.9rem;">${msg}</p>
  </div>`;
}
// Persistence forced to NONE (in-memory only) — see js/app.js for the full
// reasoning; admin identity is re-proven with the passphrase on every fresh
// load too (below), so it never needed Firebase's own session to survive a
// reload in the first place. This sidesteps LOCAL persistence's IndexedDB
// dependency, which is what silently hung signInAnonymously() forever on
// some mobile Chrome configurations and in-app browsers with no catchable
// error at all.
firebase.auth().setPersistence(firebase.auth.Auth.Persistence.NONE)
  .catch(() => {}) // non-fatal — still attempt sign-in below either way
  .then(() => firebase.auth().signInAnonymously())
  .catch(e => {
    showFatal(`Couldn't sign in: ${e.message}. Private/Incognito browsing (or some Chrome configurations) can block the storage this needs — try a normal browser window, or Safari.`);
  });
setTimeout(() => {
  if (!S.loaded) showFatal('The connection to the pool data timed out. Check your connection and reload; if you\'re in a Private/Incognito window, try a normal one.');
}, 15000);
firebase.auth().onAuthStateChanged(async u => {
  if (!u) return;
  me.identity = u.uid;

  // admin/authorized/{uid} only ever holds a value if the rules accepted our write
  // (i.e. it matched admin/passHash) — its mere presence is proof of authorization.
  // Rules grant .read only on this exact per-uid leaf, not its parent, so we must
  // listen here rather than at admin/authorized.
  db.ref('admin/authorized/' + u.uid).on('value', snap => {
    me.admin = !!snap.val();
    subscribeAdminStats();
    render();
  }, e => showFatal(`Couldn't check admin status: ${e.message}`));

  const saved = localStorage.getItem('ssp_admin_pass');
  if (saved) {
    await db.ref('admin/authorized/' + u.uid).set(await sha256Hex(saved)).catch(() => {});
  }
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
  subscribeDataListeners();
  render();
});

let dataListenersSubscribed = false;
function subscribeDataListeners() {
  if (dataListenersSubscribed) return;
  dataListenersSubscribed = true;
  for (const node of ['participants', 'weeks', 'picks', 'config']) {
    db.ref(node).on('value', snap => {
      S[node] = snap.val() || {};
      S.loaded = true;
      render();
    }, e => showFatal(`Couldn't load ${node}: ${e.message}`));
  }
}

// views/presence are admin-only readable, so only subscribe once unlocked.
let statsSubscribed = false;
function subscribeAdminStats() {
  if (statsSubscribed || !me.admin) return;
  statsSubscribed = true;
  db.ref('views').on('value', s => { S.views = s.val() || {}; render(); }, () => {});
  db.ref('presence').on('value', s => { S.presence = s.val() || {}; render(); }, () => {});
}

function ago(ts) {
  if (!ts) return '—';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

async function unlock() {
  const pass = $('passInput').value;
  if (!pass) return;
  try {
    await db.ref('admin/authorized/' + me.identity).set(await sha256Hex(pass));
    localStorage.setItem('ssp_admin_pass', pass);
    me.admin = true;
    render();
  } catch (e) {
    $('unlockErr').textContent = 'Wrong passphrase.';
    $('unlockErr').classList.remove('hidden');
  }
}

// ---- participants ----
async function addParticipant() {
  const name = $('newParticipantName').value.trim();
  if (!name) return;
  const id = slugify(name);
  await db.ref('participants/' + id).set({ name, claimedBy: null, eliminatedWeek: null, eliminatedReason: null, losses: null });
  $('newParticipantName').value = '';
}

// Clears the seat AND its password, so the next person to tap that name sets
// a fresh one. This is the only recovery path when someone forgets theirs —
// there's no email on file to reset against.
async function unclaimParticipant(pid) {
  if (!confirm(`Reset ${S.participants[pid]?.name || 'this seat'}? Their password is cleared and the seat is freed, so they can claim it again and set a new password. Their picks are NOT affected.`)) return;
  await db.ref(`seatAuth/${pid}/passHash`).remove().catch(() => {});
  await db.ref(`participants/${pid}/claimedBy`).set(null);
}

async function setEliminatedManually(pid) {
  const week = Number(prompt('Eliminate as of which week number?'));
  if (!week) return;
  const reason = prompt('Reason (shown to the group):', 'Commissioner override') || 'Commissioner override';
  await db.ref(`participants/${pid}`).update({ eliminatedWeek: week, eliminatedReason: reason });
  await db.ref(`participants/${pid}/losses/${week}`).set(reason);
}

// Clears loss history along with the elimination flag — a reinstated
// participant starts this rule back at zero rather than one loss away
// from being eliminated again.
async function reinstateParticipant(pid) {
  if (!confirm('Reinstate this participant (undo elimination and clear their loss count)?')) return;
  await db.ref(`participants/${pid}`).update({ eliminatedWeek: null, eliminatedReason: null, losses: null });
}

async function deleteParticipant(pid) {
  if (!confirm('Remove this participant entirely? This does not delete their past picks.')) return;
  await db.ref(`participants/${pid}`).remove();
}

// ---- weeks / sync ----
async function saveWeekDates(n) {
  const start = $(`weekStart-${n}`).value;
  const end = $(`weekEnd-${n}`).value;
  if (!start || !end) return;
  await db.ref(`weeks/${n}/startDate`).set(start);
  await db.ref(`weeks/${n}/endDate`).set(end);
  showToast(`Week ${n} dates saved.`);
}

async function syncWeek(n) {
  const week = S.weeks[n];
  if (!week?.startDate || !week?.endDate) {
    alert('Set a start and end date for this week first.');
    return;
  }
  const btn = $(`syncBtn-${n}`);
  btn.disabled = true;
  btn.textContent = 'Syncing…';
  try {
    const games = await fetchGames(week.startDate, week.endDate);
    const gamesById = {};
    for (const g of games) gamesById[g.id] = g;

    const updates = { [`weeks/${n}/games`]: gamesById };
    if (!week.lockTime && games.length) {
      updates[`weeks/${n}/lockTime`] = computeLockTime(games, S.config);
    }
    const allDone = games.length > 0 && games.every(g => g.completed);
    updates[`weeks/${n}/status`] = allDone ? 'final' : (week.lockTime ? 'locked' : 'upcoming');

    await db.ref().update(updates);
  } catch (e) {
    alert('Sync failed: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sync scores';
  }
}

async function overrideGame(n, gameId) {
  const game = S.weeks[n]?.games?.[gameId];
  if (!game) return;
  const winner = prompt(
    `Manual override for ${game.away.abbr} @ ${game.home.abbr}.\nEnter winning team abbreviation, "TIE", or leave blank to mark not-yet-final:`,
    game.winnerAbbr || ''
  );
  if (winner === null) return;
  const patch = winner.trim()
    ? { completed: true, winnerAbbr: winner.trim().toUpperCase(), isOverride: true }
    : { completed: false, winnerAbbr: null, isOverride: true };
  await db.ref(`weeks/${n}/games/${gameId}`).update(patch);
}

async function removeWeekSection(n) {
  const hasData = !!S.weeks[n];
  const msg = hasData
    ? `Remove Week ${n}'s dates/schedule/lock time? Anyone's picks for that week are NOT affected — this only clears admin's own record, and you can re-add it anytime.`
    : `Remove this Week ${n} section?`;
  if (!confirm(msg)) return;
  ui.extraWeeks.delete(n);
  if (hasData) await db.ref(`weeks/${n}`).remove();
  render();
}

async function forceRecomputeLockTime(n) {
  const games = Object.values(S.weeks[n]?.games || {});
  if (!games.length) return;
  const earliest = computeLockTime(games, S.config);
  if (!confirm(`Reset lock time to ${new Date(earliest).toLocaleString()}?\n\nThat's the first kickoff among games that are actually pickable this week — games against ineligible opponents are ignored.`)) return;
  await db.ref(`weeks/${n}/lockTime`).set(earliest);
}

// ---- eliminations ----
// If the policy is auto-pick and the week is locked, assigns a random
// rule-eligible team to everyone who hasn't picked yet (eliminating anyone
// with zero eligible teams left instead). Writes go straight to Firebase;
// the return value is a locally-merged view of this week's picks so the
// caller doesn't have to wait on the listener round-trip to see them.
async function runAutoPickIfNeeded(n) {
  const week = S.weeks[n];
  const noPickPolicy = S.config.noPickPolicy || 'eliminate';
  if (noPickPolicy !== 'autopick' || !isLocked(week)) return S.picks[n] || {};

  const assignments = autoPicksForWeek({
    week, weekNumber: n, picks: S.picks, weeks: S.weeks, participants: S.participants, config: S.config,
  });

  const pickUpdates = {};
  const elimUpdates = {};
  const merged = { ...(S.picks[n] || {}) };
  for (const [pid, team] of Object.entries(assignments)) {
    if (team) {
      const pick = { team, pickedAt: Date.now(), autoPicked: true };
      pickUpdates[`picks/${n}/${pid}`] = pick;
      merged[pid] = pick;
    } else {
      // Running out of legal teams is structural, not a game loss — it
      // eliminates outright regardless of how many losses config.maxLosses
      // allows, since there's no team left to even attempt a pick with.
      const reason = 'No eligible teams remained for auto-pick';
      elimUpdates[`participants/${pid}/eliminatedWeek`] = n;
      elimUpdates[`participants/${pid}/eliminatedReason`] = reason;
      elimUpdates[`participants/${pid}/losses/${n}`] = reason;
    }
  }
  if (Object.keys(pickUpdates).length) await db.ref().update(pickUpdates);
  if (Object.keys(elimUpdates).length) await db.ref().update(elimUpdates);

  return merged;
}

async function runEliminations(n) {
  const picksForWeek = await runAutoPickIfNeeded(n);
  const week = S.weeks[n];
  const maxLosses = S.config.maxLosses ?? RULE_DEFAULTS.maxLosses;
  const { newlyEliminated, newLosses } = computeEliminations(
    week, picksForWeek, S.participants, n, S.config.noPickPolicy || 'eliminate', maxLosses
  );
  const elimLines = Object.keys(newlyEliminated).map(
    pid => `${S.participants[pid]?.name}: ELIMINATED — ${newlyEliminated[pid].eliminatedReason}`
  );
  const lossLines = Object.keys(newLosses).map(
    pid => `${S.participants[pid]?.name}: loss recorded (${lossCountFor(S.participants[pid]) + 1}/${maxLosses}) — ${newLosses[pid].reason}`
  );
  const lines = [...elimLines, ...lossLines];
  if (!lines.length) { alert('No changes for week ' + n + '.'); return; }
  if (!confirm(`${lines.join('\n')}\n\nApply?`)) return;
  const updates = {};
  for (const [pid, info] of Object.entries(newlyEliminated)) {
    updates[`participants/${pid}/eliminatedWeek`] = info.eliminatedWeek;
    updates[`participants/${pid}/eliminatedReason`] = info.eliminatedReason;
    updates[`participants/${pid}/losses/${n}`] = info.eliminatedReason;
  }
  for (const [pid, info] of Object.entries(newLosses)) {
    updates[`participants/${pid}/losses/${n}`] = info.reason;
  }
  await db.ref().update(updates);
}

async function advanceWeek() {
  const next = (S.config.currentWeek || 1) + 1;
  if (!confirm(`Advance pool to Week ${next}?`)) return;
  await db.ref('config/currentWeek').set(next);
}

const confSlug = c => c.replace(/\s+/g, '-');

async function saveConfig() {
  const eligibleConferences = Object.fromEntries(
    ALL_CONFERENCES.map(c => [c, $(`conf-${confSlug(c)}`).checked])
  );
  await db.ref('config').update({
    poolName: $('poolName').value,
    currentWeek: Number($('currentWeek').value) || 1,
    noPickPolicy: $('noPickPolicy').value,
    maxTeamUses: Number($('maxTeamUses').value) || 1,
    maxSecOpponentPicks: Number($('maxSecOpponentPicks').value) || 0,
    maxLosses: Number($('maxLosses').value) || 1,
    eligibleConferences,
  });
  showToast('Settings saved.');
}

// ---- render ----
function render() {
  if (!S.loaded) return;
  if (!me.admin) {
    $('app').innerHTML = `
      <header class="app-header"><h1>Admin — ${S.config.poolName || 'SEC Survivor Pool'}</h1></header>
      <div class="admin-section">
        <h2>Enter commissioner passphrase</h2>
        <div class="admin-row">
          <input id="passInput" type="password" placeholder="Passphrase">
          <button class="btn" id="unlockBtn">Unlock</button>
        </div>
        <div id="unlockErr" class="err hidden"></div>
      </div>`;
    $('unlockBtn').addEventListener('click', unlock);
    $('passInput').addEventListener('keydown', e => { if (e.key === 'Enter') unlock(); });
    ensureScrolledToTop('locked');
    return;
  }

  $('app').innerHTML = `
    <header class="app-header">
      <h1>Admin — ${S.config.poolName || 'SEC Survivor Pool'}</h1>
      <div class="me-wrap">
        <button class="me-name" id="meNameBtn">Admin</button>
        <div class="me-menu hidden" id="meMenu">
          <button class="btn secondary" id="logoutBtn">Log out</button>
        </div>
      </div>
    </header>
    ${renderConfigSection()}
    ${renderParticipantsSection()}
    ${renderWeeksSection()}
  `;
  wireAdminEvents();
  $('meNameBtn')?.addEventListener('click', () => $('meMenu')?.classList.toggle('hidden'));
  $('logoutBtn')?.addEventListener('click', logout);
  ensureScrolledToTop('unlocked');
}

async function logout() {
  if (!confirm("Log out of admin? You'll need the passphrase again next time.")) return;
  localStorage.removeItem('ssp_admin_pass');
  me.admin = false;
  render(); // immediate feedback — the fresh sign-in below can take a moment
  // Deliberately not a page reload: signOut() immediately followed by
  // location.reload() hit a real race with Firebase's auth reinitializing
  // on the fresh page load (reproduced live — it hung on "Loading…"
  // indefinitely, even though every underlying read/auth call succeeded
  // when tried manually seconds later). Signing back in within the same
  // already-running page sidesteps it entirely and gets the same result:
  // a fresh anonymous identity that was never granted admin.
  await firebase.auth().signOut();
  await firebase.auth().signInAnonymously();
}

function renderConfigSection() {
  const maxTeamUses = S.config.maxTeamUses ?? RULE_DEFAULTS.maxTeamUses;
  const maxSecOpponentPicks = S.config.maxSecOpponentPicks ?? RULE_DEFAULTS.maxSecOpponentPicks;
  const maxLosses = S.config.maxLosses ?? RULE_DEFAULTS.maxLosses;
  const eligibleConferences = S.config.eligibleConferences || RULE_DEFAULTS.eligibleConferences;

  return `<div class="admin-section">
    <h2>Pool settings</h2>
    <div class="admin-row">
      <input id="poolName" placeholder="Pool name" value="${S.config.poolName || ''}">
    </div>
    <div class="admin-row">
      <label>Current week: <input id="currentWeek" type="number" min="1" style="width:4rem" value="${S.config.currentWeek || 1}"></label>
      <button class="btn secondary" id="advanceWeekBtn">Advance to next week</button>
    </div>
    <div class="admin-row">
      <label>If no pick submitted by lock:
        <select id="noPickPolicy">
          <option value="eliminate" ${(S.config.noPickPolicy || 'eliminate') === 'eliminate' ? 'selected' : ''}>Eliminate</option>
          <option value="skip" ${S.config.noPickPolicy === 'skip' ? 'selected' : ''}>Skip (no penalty)</option>
          <option value="autopick" ${S.config.noPickPolicy === 'autopick' ? 'selected' : ''}>Auto-pick (random eligible team)</option>
        </select>
      </label>
    </div>
    <div class="admin-row">
      <label>Each team may be picked up to
        <input id="maxTeamUses" type="number" min="1" style="width:3.5rem" value="${maxTeamUses}">
      times per season</label>
    </div>
    <div class="admin-row">
      <label>Same SEC opponent may be played against up to
        <input id="maxSecOpponentPicks" type="number" min="0" style="width:3.5rem" value="${maxSecOpponentPicks}">
      times per season (no cap on different opponents)</label>
    </div>
    <div class="admin-row">
      <label>Eliminated after
        <input id="maxLosses" type="number" min="1" style="width:3.5rem" value="${maxLosses}">
      loss${maxLosses === 1 ? '' : 'es'} this season (1 = out on the first loss, same as before this was configurable)</label>
    </div>
    <div class="admin-row">
      <span style="width:100%;">Eligible opponent conferences:</span>
      ${ALL_CONFERENCES.map(c => `
        <label style="display:inline-flex;align-items:center;gap:0.25rem;">
          <input type="checkbox" id="conf-${confSlug(c)}" ${eligibleConferences[c] ? 'checked' : ''}> ${c}
        </label>`).join('')}
    </div>
    <div class="admin-row">
      <button class="btn" id="saveConfigBtn">Save settings</button>
    </div>
  </div>`;
}

function renderParticipantsSection() {
  const rows = Object.entries(S.participants || {});
  const currentWeek = S.config.currentWeek || 1;
  const maxLosses = S.config.maxLosses ?? RULE_DEFAULTS.maxLosses;

  return `<div class="admin-section">
    <h2>Participants</h2>
    <div class="admin-row">
      <input id="newParticipantName" placeholder="Full name">
      <button class="btn" id="addParticipantBtn">Add</button>
    </div>
    ${rows.map(([pid, p]) => {
      const pick = S.picks?.[currentWeek]?.[pid];
      const pickStatus = p.eliminatedWeek != null
        ? ''
        : pick
          ? `<span class="pick-status-yes">✓ ${pick.team}${pick.autoPicked ? ' (auto)' : ''}</span>`
          : `<span class="pick-status-no">no pick yet — Wk ${currentWeek}</span>`;

      const uid = p.claimedBy;
      const online = uid && S.presence?.[uid];
      const lastSeen = uid ? S.views?.[uid]?.last : null;
      const presenceLabel = !uid
        ? ''
        : online
          ? '<span class="presence-online">● online</span>'
          : `<span class="muted">last seen ${ago(lastSeen)}</span>`;

      const losses = lossCountFor(p);
      const lossBadge = p.eliminatedWeek == null && losses > 0
        ? `<span class="badge-warn">${losses}/${maxLosses} losses</span>`
        : '';

      return `
      <div class="admin-row" style="justify-content:space-between; flex-wrap:wrap;">
        <span>${p.name} ${p.claimedBy ? '' : '<span class="muted">(unclaimed)</span>'} ${p.eliminatedWeek != null ? `<span class="badge-out">OUT W${p.eliminatedWeek}</span>` : lossBadge}
          ${pickStatus} ${presenceLabel}
        </span>
        <span>
          ${p.claimedBy ? `<button class="btn secondary" data-unclaim="${pid}">Reset password</button>` : ''}
          ${p.eliminatedWeek != null
            ? `<button class="btn secondary" data-reinstate="${pid}">Reinstate</button>`
            : `<button class="btn secondary" data-eliminate="${pid}">Eliminate</button>`}
          <button class="btn danger" data-delete="${pid}">Remove</button>
        </span>
      </div>`;
    }).join('')}
  </div>`;
}

function renderWeeksSection() {
  const currentWeek = S.config.currentWeek || 1;
  const weeksToShow = [...new Set([currentWeek, ...Object.keys(S.weeks).map(Number), ...ui.extraWeeks])].sort((a, b) => a - b);
  const nextSuggested = Math.max(currentWeek, ...weeksToShow) + 1;

  const sections = weeksToShow.map(n => {
    const week = S.weeks[n] || {};
    const games = Object.entries(week.games || {});
    return `<div class="admin-section">
      <div class="admin-row" style="justify-content:space-between;">
        <h2 style="margin:0;">Week ${n} ${n === currentWeek ? '(current)' : ''}</h2>
        ${n !== currentWeek ? `<button class="btn danger" data-removeweek="${n}">Remove</button>` : ''}
      </div>
      <div class="admin-row">
        <label>Start <input type="date" id="weekStart-${n}" value="${week.startDate || ''}"></label>
        <label>End <input type="date" id="weekEnd-${n}" value="${week.endDate || ''}"></label>
        <button class="btn secondary" data-savedates="${n}">Save dates</button>
      </div>
      <div class="admin-row">
        <button class="btn" id="syncBtn-${n}" data-sync="${n}">Sync scores</button>
        <button class="btn secondary" data-runelim="${n}">Run eliminations</button>
        ${week.lockTime ? `<button class="btn secondary" data-relock="${n}">Reset lock time</button>` : ''}
        <span class="muted">${week.lockTime ? 'Locks ' + new Date(week.lockTime).toLocaleString() : 'Lock time not set yet'}</span>
      </div>
      ${games.length ? games.map(([gid, g]) => `
        <div class="game-row">
          <span>${g.away.abbr} @ ${g.home.abbr} — ${g.completed ? `Final ${g.away.score}-${g.home.score}` : g.statusName} ${g.isOverride ? '(override)' : ''}</span>
          <button class="btn secondary" data-override="${n}:${gid}">Edit</button>
        </div>`).join('') : '<p class="muted">No games synced yet.</p>'}
    </div>`;
  }).join('');

  return sections + `<div class="admin-section">
    <div class="admin-row">
      <label>Set up week <input type="number" id="newWeekNum" min="1" style="width:4rem" value="${nextSuggested}"></label>
      <button class="btn secondary" id="addWeekBtn">Add week section</button>
    </div>
  </div>`;
}

function wireAdminEvents() {
  $('saveConfigBtn')?.addEventListener('click', saveConfig);
  $('advanceWeekBtn')?.addEventListener('click', advanceWeek);
  $('addParticipantBtn')?.addEventListener('click', addParticipant);

  document.querySelectorAll('[data-unclaim]').forEach(b => b.addEventListener('click', () => unclaimParticipant(b.dataset.unclaim)));
  document.querySelectorAll('[data-eliminate]').forEach(b => b.addEventListener('click', () => setEliminatedManually(b.dataset.eliminate)));
  document.querySelectorAll('[data-reinstate]').forEach(b => b.addEventListener('click', () => reinstateParticipant(b.dataset.reinstate)));
  document.querySelectorAll('[data-delete]').forEach(b => b.addEventListener('click', () => deleteParticipant(b.dataset.delete)));

  document.querySelectorAll('[data-savedates]').forEach(b => b.addEventListener('click', () => saveWeekDates(Number(b.dataset.savedates))));
  document.querySelectorAll('[data-sync]').forEach(b => b.addEventListener('click', () => syncWeek(Number(b.dataset.sync))));
  document.querySelectorAll('[data-runelim]').forEach(b => b.addEventListener('click', () => runEliminations(Number(b.dataset.runelim))));
  document.querySelectorAll('[data-relock]').forEach(b => b.addEventListener('click', () => forceRecomputeLockTime(Number(b.dataset.relock))));
  document.querySelectorAll('[data-override]').forEach(b => b.addEventListener('click', () => {
    const [n, gid] = b.dataset.override.split(':');
    overrideGame(Number(n), gid);
  }));

  $('addWeekBtn')?.addEventListener('click', () => {
    const n = Number($('newWeekNum').value);
    if (!n || n < 1) return;
    ui.extraWeeks.add(n);
    render();
  });
  document.querySelectorAll('[data-removeweek]').forEach(b => b.addEventListener('click', () => removeWeekSection(Number(b.dataset.removeweek))));
}
