import { fetchGames } from '../data-source/provider.js';
import { computeEliminations } from './elimination.js';
import { ALL_CONFERENCES } from '../data-source/power4-teams.js';

const RULE_DEFAULTS = {
  maxTeamUses: 1,
  maxSecOpponentPicks: 2,
  eligibleConferences: Object.fromEntries(ALL_CONFERENCES.map(c => [c, true])),
};

firebase.initializeApp(firebaseConfig);
const db = firebase.database();

const S = { participants: {}, weeks: {}, picks: {}, config: {}, loaded: false };
const me = { identity: null, admin: false };

const $ = id => document.getElementById(id);

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
firebase.auth().signInAnonymously().catch(() => {});
firebase.auth().onAuthStateChanged(async u => {
  if (!u) return;
  me.identity = u.uid;

  // admin/authorized/{uid} only ever holds a value if the rules accepted our write
  // (i.e. it matched admin/passHash) — its mere presence is proof of authorization.
  // Rules grant .read only on this exact per-uid leaf, not its parent, so we must
  // listen here rather than at admin/authorized.
  db.ref('admin/authorized/' + u.uid).on('value', snap => {
    me.admin = !!snap.val();
    render();
  });

  const saved = localStorage.getItem('ssp_admin_pass');
  if (saved) {
    await db.ref('admin/authorized/' + u.uid).set(await sha256Hex(saved)).catch(() => {});
  }
  render();
});

for (const node of ['participants', 'weeks', 'picks', 'config']) {
  db.ref(node).on('value', snap => {
    S[node] = snap.val() || {};
    S.loaded = true;
    render();
  });
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
  await db.ref('participants/' + id).set({ name, claimedBy: null, eliminatedWeek: null, eliminatedReason: null });
  $('newParticipantName').value = '';
}

async function unclaimParticipant(pid) {
  if (!confirm('Unclaim this seat? Whoever claimed it will need to re-claim.')) return;
  await db.ref(`participants/${pid}/claimedBy`).set(null);
}

async function setEliminatedManually(pid) {
  const week = Number(prompt('Eliminate as of which week number?'));
  if (!week) return;
  const reason = prompt('Reason (shown to the group):', 'Commissioner override') || 'Commissioner override';
  await db.ref(`participants/${pid}`).update({ eliminatedWeek: week, eliminatedReason: reason });
}

async function reinstateParticipant(pid) {
  if (!confirm('Reinstate this participant (undo elimination)?')) return;
  await db.ref(`participants/${pid}`).update({ eliminatedWeek: null, eliminatedReason: null });
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
      const earliest = Math.min(...games.map(g => new Date(g.kickoff).getTime()));
      updates[`weeks/${n}/lockTime`] = earliest;
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

async function forceRecomputeLockTime(n) {
  const games = Object.values(S.weeks[n]?.games || {});
  if (!games.length) return;
  const earliest = Math.min(...games.map(g => new Date(g.kickoff).getTime()));
  if (!confirm(`Reset lock time to ${new Date(earliest).toLocaleString()}?`)) return;
  await db.ref(`weeks/${n}/lockTime`).set(earliest);
}

// ---- eliminations ----
function previewEliminations(n) {
  const week = S.weeks[n];
  const picksForWeek = S.picks[n] || {};
  const result = computeEliminations(week, picksForWeek, S.participants, n, S.config.noPickPolicy || 'eliminate');
  return result;
}

async function runEliminations(n) {
  const preview = previewEliminations(n);
  const names = Object.keys(preview).map(pid => `${S.participants[pid]?.name}: ${preview[pid].eliminatedReason}`);
  if (!names.length) { alert('No new eliminations for week ' + n + '.'); return; }
  if (!confirm(`Eliminate:\n\n${names.join('\n')}\n\nApply?`)) return;
  const updates = {};
  for (const [pid, info] of Object.entries(preview)) {
    updates[`participants/${pid}/eliminatedWeek`] = info.eliminatedWeek;
    updates[`participants/${pid}/eliminatedReason`] = info.eliminatedReason;
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
    eligibleConferences,
  });
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
    return;
  }

  $('app').innerHTML = `
    <header class="app-header"><h1>Admin — ${S.config.poolName || 'SEC Survivor Pool'}</h1></header>
    ${renderConfigSection()}
    ${renderParticipantsSection()}
    ${renderWeeksSection()}
  `;
  wireAdminEvents();
}

function renderConfigSection() {
  const maxTeamUses = S.config.maxTeamUses ?? RULE_DEFAULTS.maxTeamUses;
  const maxSecOpponentPicks = S.config.maxSecOpponentPicks ?? RULE_DEFAULTS.maxSecOpponentPicks;
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
          <option value="eliminate" ${S.config.noPickPolicy !== 'skip' ? 'selected' : ''}>Eliminate</option>
          <option value="skip" ${S.config.noPickPolicy === 'skip' ? 'selected' : ''}>Skip (no penalty)</option>
        </select>
      </label>
    </div>
    <div class="admin-row">
      <label>Each team may be picked up to
        <input id="maxTeamUses" type="number" min="1" style="width:3.5rem" value="${maxTeamUses}">
      times per season</label>
    </div>
    <div class="admin-row">
      <label>Picks against an SEC opponent allowed up to
        <input id="maxSecOpponentPicks" type="number" min="0" style="width:3.5rem" value="${maxSecOpponentPicks}">
      times per season</label>
    </div>
    <div class="admin-row">
      <span>Eligible opponent conferences:</span>
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
  return `<div class="admin-section">
    <h2>Participants</h2>
    <div class="admin-row">
      <input id="newParticipantName" placeholder="Full name">
      <button class="btn" id="addParticipantBtn">Add</button>
    </div>
    ${rows.map(([pid, p]) => `
      <div class="admin-row" style="justify-content:space-between;">
        <span>${p.name} ${p.claimedBy ? '' : '<span class="muted">(unclaimed)</span>'} ${p.eliminatedWeek != null ? `<span class="badge-out">OUT W${p.eliminatedWeek}</span>` : ''}</span>
        <span>
          ${p.claimedBy ? `<button class="btn secondary" data-unclaim="${pid}">Unclaim</button>` : ''}
          ${p.eliminatedWeek != null
            ? `<button class="btn secondary" data-reinstate="${pid}">Reinstate</button>`
            : `<button class="btn secondary" data-eliminate="${pid}">Eliminate</button>`}
          <button class="btn danger" data-delete="${pid}">Remove</button>
        </span>
      </div>`).join('')}
  </div>`;
}

function renderWeeksSection() {
  const currentWeek = S.config.currentWeek || 1;
  const weeksToShow = [...new Set([currentWeek, ...Object.keys(S.weeks).map(Number)])].sort((a, b) => a - b);

  return weeksToShow.map(n => {
    const week = S.weeks[n] || {};
    const games = Object.entries(week.games || {});
    return `<div class="admin-section">
      <h2>Week ${n} ${n === currentWeek ? '(current)' : ''}</h2>
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
}
