import { SEC_TEAMS } from '../data-source/teams.js';
import { conferenceOf, ALL_CONFERENCES } from '../data-source/power4-teams.js';
import { fetchGames } from '../data-source/provider.js';

const RULE_DEFAULTS = {
  maxTeamUses: 1,
  maxSecOpponentPicks: 2,
  eligibleConferences: Object.fromEntries(ALL_CONFERENCES.map(c => [c, true])),
};

firebase.initializeApp(firebaseConfig);
const db = firebase.database();

const S = { participants: {}, weeks: {}, picks: {}, config: {}, loaded: false };
const me = { identity: null, participantId: null };

// UI-only state that must survive across render() calls (which happen on
// every Firebase update, so anything not stored here — like which tab is
// open — would otherwise snap back to the default each time someone else
// makes a pick).
const ui = { activeTab: 'pick', openScheduleTeam: null };

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

firebase.auth().signInAnonymously().catch(() => {});
firebase.auth().onAuthStateChanged(u => {
  me.identity = u ? u.uid : deviceId();
  resolveMyParticipant();
  render();
});
if (!firebase.auth().currentUser) me.identity = deviceId();

for (const node of ['participants', 'weeks', 'picks', 'config']) {
  db.ref(node).on('value', snap => {
    S[node] = snap.val() || {};
    S.loaded = true;
    if (node === 'participants') resolveMyParticipant();
    render();
  });
}

function resolveMyParticipant() {
  const cached = localStorage.getItem('ssp_participant');
  if (cached && S.participants[cached]?.claimedBy === me.identity) {
    me.participantId = cached;
    return;
  }
  me.participantId = Object.keys(S.participants).find(
    pid => S.participants[pid]?.claimedBy === me.identity
  ) || null;
  if (me.participantId) localStorage.setItem('ssp_participant', me.participantId);
}

async function claimParticipant(pid) {
  if (!me.identity) return;
  const res = await db.ref(`participants/${pid}/claimedBy`).transaction(cur => (cur == null ? me.identity : undefined));
  if (res.committed) {
    localStorage.setItem('ssp_participant', pid);
    me.participantId = pid;
    render();
  } else {
    alert('Someone already claimed that name. Pick yours, or ask the commissioner to add it.');
  }
}

function gameForTeam(week, abbr) {
  const games = Object.values(week?.games || {});
  return games.find(g => g.home.abbr === abbr || g.away.abbr === abbr) || null;
}

function opponentAbbrFor(week, teamAbbr) {
  const game = gameForTeam(week, teamAbbr);
  if (!game) return null;
  return game.home.abbr === teamAbbr ? game.away.abbr : game.home.abbr;
}

// Counts only locked/past weeks (< currentWeek) — an in-progress pick for the
// current week doesn't burn a use until its week actually locks, so switching
// picks freely before lock never wastes anything.
function usageStatsFor(pid) {
  const currentWeek = S.config.currentWeek || 1;
  const teamUseCounts = {};
  let secOpponentCount = 0;

  for (const [weekStr, weekPicks] of Object.entries(S.picks || {})) {
    const weekNum = Number(weekStr);
    if (weekNum >= currentWeek) continue;
    const pick = weekPicks?.[pid];
    if (!pick?.team) continue;

    teamUseCounts[pick.team] = (teamUseCounts[pick.team] || 0) + 1;

    const opponentAbbr = opponentAbbrFor(S.weeks[weekNum], pick.team);
    if (opponentAbbr && conferenceOf(opponentAbbr) === 'SEC') secOpponentCount++;
  }

  return { teamUseCounts, secOpponentCount };
}

function isLocked(week) {
  return !!(week?.lockTime && Date.now() > week.lockTime);
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
        homeAway: isHome ? 'vs' : '@',
        completed: g.completed,
        result: g.completed ? `${g.away.score}-${g.home.score}` : null,
        won: g.completed ? g.winnerAbbr === abbr : null,
        opponentConf: conferenceOf(opp.abbr),
      };
    })
    .sort((a, b) => a.date - b.date);
}

async function submitPick(team) {
  const currentWeek = S.config.currentWeek || 1;
  const week = S.weeks[currentWeek];
  if (isLocked(week)) { alert('Picks are locked for this week.'); return; }
  await db.ref(`picks/${currentWeek}/${me.participantId}`).set({ team, pickedAt: Date.now() });
}

const TABS = ['pick', 'standings', 'history', 'schedule'];

function render() {
  if (!S.loaded) return;
  if (!me.participantId) return renderClaimScreen();
  const participant = S.participants[me.participantId];
  $('app').innerHTML = `
    ${renderHeader(participant)}
    <nav class="tabs">
      <button class="tab-btn ${ui.activeTab === 'pick' ? 'active' : ''}" data-tab="pick">Pick</button>
      <button class="tab-btn ${ui.activeTab === 'standings' ? 'active' : ''}" data-tab="standings">Standings</button>
      <button class="tab-btn ${ui.activeTab === 'history' ? 'active' : ''}" data-tab="history">History</button>
      <button class="tab-btn ${ui.activeTab === 'schedule' ? 'active' : ''}" data-tab="schedule">Schedule</button>
    </nav>
    <div id="tab-pick" class="tab-panel ${ui.activeTab === 'pick' ? '' : 'hidden'}">${renderPickScreen(participant)}</div>
    <div id="tab-standings" class="tab-panel ${ui.activeTab === 'standings' ? '' : 'hidden'}">${renderStandings()}</div>
    <div id="tab-history" class="tab-panel ${ui.activeTab === 'history' ? '' : 'hidden'}">${renderHistory()}</div>
    <div id="tab-schedule" class="tab-panel ${ui.activeTab === 'schedule' ? '' : 'hidden'}">${renderScheduleTab()}</div>
    ${renderScheduleModal()}
  `;
  wireTabs();
  wirePickButtons();
  wireScheduleLinks();
}

function renderHeader(participant) {
  return `<header class="app-header">
    <h1>${S.config.poolName || 'SEC Survivor Pool'}</h1>
    <div class="me">${participant?.name || ''}${participant?.eliminatedWeek != null ? ' <span class="badge-out">ELIMINATED</span>' : ''}</div>
  </header>`;
}

function renderClaimScreen() {
  const unclaimed = Object.entries(S.participants || {}).filter(([, p]) => !p.claimedBy);
  $('app').innerHTML = `
    <header class="app-header"><h1>${S.config.poolName || 'SEC Survivor Pool'}</h1></header>
    <div class="claim-screen">
      <p>Tap your name to join. If you don't see it, ask the commissioner to add you.</p>
      <div class="claim-list">
        ${unclaimed.length
          ? unclaimed.map(([pid, p]) => `<button class="claim-btn" data-pid="${pid}">${p.name}</button>`).join('')
          : '<p class="muted">No unclaimed names right now.</p>'}
      </div>
    </div>
  `;
  document.querySelectorAll('.claim-btn').forEach(btn => {
    btn.addEventListener('click', () => claimParticipant(btn.dataset.pid));
  });
}

function renderPickScreen(participant) {
  if (participant?.eliminatedWeek != null) {
    return `<div class="eliminated-panel">
      <p>You were eliminated in Week ${participant.eliminatedWeek}.</p>
      <p class="muted">${participant.eliminatedReason || ''}</p>
    </div>`;
  }

  const currentWeek = S.config.currentWeek || 1;
  const week = S.weeks[currentWeek];
  const maxTeamUses = S.config.maxTeamUses ?? RULE_DEFAULTS.maxTeamUses;
  const maxSecOpponentPicks = S.config.maxSecOpponentPicks ?? RULE_DEFAULTS.maxSecOpponentPicks;
  const eligibleConferences = S.config.eligibleConferences || RULE_DEFAULTS.eligibleConferences;
  const { teamUseCounts, secOpponentCount } = usageStatsFor(me.participantId);
  const myPick = S.picks?.[currentWeek]?.[me.participantId]?.team;
  const locked = isLocked(week);

  if (!week) {
    return `<p class="muted">Week ${currentWeek} hasn't been set up yet. Check back soon.</p>`;
  }

  const lockLabel = week.lockTime
    ? new Date(week.lockTime).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : 'TBD';

  const cards = SEC_TEAMS.map(team => {
    const game = gameForTeam(week, team.abbr);
    const selected = myPick === team.abbr;
    const usesLeft = maxTeamUses - (teamUseCounts[team.abbr] || 0);
    const teamExhausted = usesLeft <= 0;

    let opponentConf = null;
    let opponentLine = 'BYE';
    let flag = teamExhausted ? `used ${teamUseCounts[team.abbr]}/${maxTeamUses} times` : '';

    if (game) {
      const isHome = game.home.abbr === team.abbr;
      const opp = isHome ? game.away : game.home;
      opponentConf = conferenceOf(opp.abbr);
      opponentLine = `${isHome ? 'vs' : '@'} ${opp.name}`;
      if (game.completed) opponentLine += ` — Final ${game.away.score}-${game.home.score}`;
    }

    const notPower4 = game && !opponentConf;
    const confDisabled = game && opponentConf && !eligibleConferences[opponentConf];
    const secCapHit = game && opponentConf === 'SEC' && secOpponentCount >= maxSecOpponentPicks;

    if (!selected) {
      if (notPower4 || confDisabled) flag = 'opponent not eligible (not Power 4)';
      else if (secCapHit) flag = `SEC-vs-SEC limit reached (${secOpponentCount}/${maxSecOpponentPicks})`;
    }

    const disabled = !selected && (teamExhausted || !game || notPower4 || confDisabled || secCapHit || locked);

    // The pick action and the schedule link are separate controls (not
    // schedule-link nested inside the pick <button>) because a disabled
    // <button> also blocks clicks on its children — and viewing a team's
    // schedule needs to work even for teams that aren't pickable right now.
    return `<div class="team-card-wrap">
      <button class="team-card ${selected ? 'selected' : ''} ${disabled ? 'disabled' : ''}"
              data-team="${team.abbr}" ${disabled ? 'disabled' : ''}>
        <div class="team-name">${team.name}</div>
        <div class="team-opp">${opponentLine}</div>
        ${flag ? `<div class="team-flag">${flag}</div>` : ''}
      </button>
      <div class="schedule-link" data-schedule-team="${team.abbr}">Full schedule →</div>
    </div>`;
  }).join('');

  return `
    <div class="week-meta">
      <span>Week ${currentWeek}</span>
      <span class="${locked ? 'locked' : ''}">${locked ? 'Locked' : `Locks ${lockLabel}`}</span>
    </div>
    <div class="team-grid">${cards}</div>
  `;
}

function renderStandings() {
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
      ${rows.map(([, p]) => `<tr class="${p.eliminatedWeek != null ? 'row-out' : 'row-alive'}">
        <td>${p.name}</td>
        <td>${p.eliminatedWeek != null ? `Out — Week ${p.eliminatedWeek}` : 'Alive'}</td>
      </tr>`).join('')}
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
          const pick = S.picks?.[w]?.[pid];
          if (!pick) return '<td class="muted">—</td>';
          const game = gameForTeam(S.weeks[w], pick.team);
          let cls = 'pending';
          if (game?.completed) cls = game.winnerAbbr === pick.team ? 'won' : 'lost';
          return `<td class="pick-${cls}">${pick.team}</td>`;
        }).join('')}
      </tr>`).join('')}
    </tbody>
  </table></div>`;
}

function renderScheduleTab() {
  if (!seasonSchedule && !seasonScheduleLoading && !seasonScheduleError) ensureSeasonSchedule();
  if (seasonScheduleLoading) return '<p class="muted">Loading full season schedule…</p>';
  if (seasonScheduleError) return `<p class="err">Couldn't load schedule: ${seasonScheduleError}</p>`;
  if (!seasonSchedule?.length) return '<p class="muted">No schedule data available.</p>';

  const startMs = seasonStartMs();
  const weekDateLabel = {};
  for (const g of seasonSchedule) {
    const wn = weekNumberFor(g.kickoff, startMs);
    const d = new Date(g.kickoff);
    if (!weekDateLabel[wn] || d < weekDateLabel[wn]) weekDateLabel[wn] = d;
  }
  const weekNums = Object.keys(weekDateLabel).map(Number).sort((a, b) => a - b);

  const rows = SEC_TEAMS.map(team => {
    const byWeek = Object.fromEntries(teamScheduleRows(team.abbr).map(r => [r.weekNum, r]));
    return `<tr>
      <td class="schedule-team-name" data-schedule-team="${team.abbr}">${team.name}</td>
      ${weekNums.map(wn => {
        const r = byWeek[wn];
        if (!r) return '<td class="muted">BYE</td>';
        const confClass = r.opponentConf === 'SEC' ? 'conf-sec' : (r.opponentConf ? 'conf-power4' : 'conf-none');
        const resultMark = r.completed ? (r.won ? ' W' : ' L') : '';
        return `<td class="${confClass}">${r.homeAway}${r.opponentAbbr}${resultMark}</td>`;
      }).join('')}
    </tr>`;
  }).join('');

  return `
    <p class="muted schedule-legend">
      <span class="conf-sec">SEC opponent</span> &nbsp;
      <span class="conf-power4">Power 4</span> &nbsp;
      <span class="conf-none">not Power 4</span> — tap a team name for their full schedule.
    </p>
    <div class="history-scroll"><table class="schedule-grid-table">
      <thead><tr><th>Team</th>${weekNums.map(wn => `<th>Wk ${wn}<br><span class="muted">${weekDateLabel[wn].toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })}</span></th>`).join('')}</tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  `;
}

function renderScheduleModal() {
  const abbr = ui.openScheduleTeam;
  if (!abbr) return '<div id="scheduleModal" class="modal-overlay hidden"></div>';

  const team = SEC_TEAMS.find(t => t.abbr === abbr);
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
            <td>${r.homeAway} ${r.opponentName}${!r.opponentConf ? ' <span class="muted">(not P4)</span>' : (r.opponentConf === 'SEC' ? ' <span class="muted">(SEC)</span>' : '')}</td>
            <td>${r.completed ? `${r.won ? 'W' : 'L'} ${r.result}` : '—'}</td>
          </tr>`).join('')}</tbody>
        </table>`
      : '<p class="muted">No games found.</p>';
  }

  return `<div id="scheduleModal" class="modal-overlay">
    <div class="modal-box">
      <div class="modal-header">
        <h3>${team?.name || abbr}</h3>
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
