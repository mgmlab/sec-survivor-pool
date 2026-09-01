import { SEC_TEAMS } from '../data-source/teams.js';
import { conferenceOf } from '../data-source/power4-teams.js';
import { fetchGames } from '../data-source/provider.js';
import { RULE_DEFAULTS, gameForTeam, evaluateTeamsForWeek, isLocked } from './eligibility.js';

// Mobile browsers sometimes restore a previous scroll position (or drift
// from one) when reopening a tab for a URL that's been visited before —
// reported as the page opening "slightly scrolled down" instead of at the
// top. Disable the browser's own restoration and force it explicitly once
// the first real content is on screen.
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
let scrolledToTop = false;

firebase.initializeApp(firebaseConfig);
const db = firebase.database();

const S = { participants: {}, weeks: {}, picks: {}, config: {}, loaded: false };
const me = { identity: null, participantId: null };

// UI-only state that must survive across render() calls (which happen on
// every Firebase update, so anything not stored here — like which tab is
// open — would otherwise snap back to the default each time someone else
// makes a pick).
const ui = { activeTab: 'pick', openScheduleTeam: null, rulesOpen: false };

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
  logVisit();
  setupPresence();
  render();
});
if (!firebase.auth().currentUser) me.identity = deviceId();

// ---- usage stats (admin-only visibility): one view log per page load + live presence ----
let viewLogged = false;
function logVisit() {
  if (viewLogged || !me.identity) return;
  viewLogged = true;
  db.ref('views/' + me.identity).update({
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
  const lockTime = Math.min(...games.map(g => new Date(g.kickoff).getTime()));
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
  if (current === team) {
    // Tapping your own current pick again clears it, rather than being a
    // no-op — the only way to go from "picked" back to "no pick" otherwise
    // would be picking a different team first, which isn't obvious and
    // burns nothing but is still confusing.
    await db.ref(`picks/${weekNumber}/${me.participantId}`).remove();
  } else {
    await db.ref(`picks/${weekNumber}/${me.participantId}`).set({ team, pickedAt: Date.now() });
  }
}

const TABS = ['pick', 'schedule', 'standings', 'history'];

function render() {
  if (!S.loaded) return;
  if (!me.participantId) return renderClaimScreen();
  const participant = S.participants[me.participantId];
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
  wireRulesSection();
  wireHeader();
  ensureScrolledToTop();
}

function ensureScrolledToTop() {
  if (scrolledToTop) return;
  scrolledToTop = true;
  // Runs after the DOM update so it wins against any browser-driven
  // restoration that happens around the same time as first paint.
  requestAnimationFrame(() => window.scrollTo(0, 0));
}

function wireRulesSection() {
  document.querySelector('.rules-section')?.addEventListener('toggle', e => {
    ui.rulesOpen = e.target.open;
  });
}

function renderHeader(participant) {
  return `<header class="app-header">
    <h1>${S.config.poolName || 'SEC Survivor Pool'}</h1>
    <div class="me-wrap">
      <button class="me-name" id="meNameBtn">${participant?.name || ''}${participant?.eliminatedWeek != null ? ' <span class="badge-out">ELIMINATED</span>' : ''}</button>
      <div class="me-menu hidden" id="meMenu">
        <button class="btn secondary" id="unclaimSelfBtn">Unclaim seat</button>
      </div>
    </div>
  </header>`;
}

async function unclaimSelf() {
  if (!me.participantId) return;
  if (!confirm("Unclaim your seat? You'll need to tap your name again to claim it — handy if you're switching devices, but anyone could claim it in the meantime.")) return;
  await db.ref(`participants/${me.participantId}/claimedBy`).set(null);
  localStorage.removeItem('ssp_participant');
  me.participantId = null;
  render();
}

function wireHeader() {
  $('meNameBtn')?.addEventListener('click', () => $('meMenu')?.classList.toggle('hidden'));
  $('unclaimSelfBtn')?.addEventListener('click', unclaimSelf);
}

function renderRulesSection() {
  const maxTeamUses = S.config.maxTeamUses ?? RULE_DEFAULTS.maxTeamUses;
  const maxSecOpponentPicks = S.config.maxSecOpponentPicks ?? RULE_DEFAULTS.maxSecOpponentPicks;
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
        <li>Each week, pick one SEC team you think will win. If they lose (or tie), you're eliminated.</li>
        <li>Last participant(s) still alive win the pool.</li>
        <li>Each team can be picked up to <strong>${maxTeamUses}</strong> time${maxTeamUses === 1 ? '' : 's'} all season.</li>
        <li>You can play against the same SEC opponent up to <strong>${maxSecOpponentPicks}</strong> time${maxSecOpponentPicks === 1 ? '' : 's'} all season — no cap on how many <em>different</em> SEC opponents you face, just on repeating the same one.</li>
        <li>Your team's opponent must belong to one of: <strong>${enabledConfs.join(', ') || 'none currently enabled'}</strong>.</li>
        <li>Picks lock at kickoff of the first SEC game each week — you can't change a pick after that.</li>
        <li>${noPickText}</li>
      </ul>
    </div>
  </details>`;
}

function renderClaimScreen() {
  const unclaimed = Object.entries(S.participants || {}).filter(([, p]) => !p.claimedBy);
  $('app').innerHTML = `
    <header class="app-header"><h1>${S.config.poolName || 'SEC Survivor Pool'}</h1></header>
    ${renderRulesSection()}
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
  wireRulesSection();
  ensureScrolledToTop();
}

function renderPickScreen(participant) {
  if (participant?.eliminatedWeek != null) {
    return `<div class="eliminated-panel">
      <p>You were eliminated in Week ${participant.eliminatedWeek}.</p>
      <p class="muted">${participant.eliminatedReason || ''}</p>
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
