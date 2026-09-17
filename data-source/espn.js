// ESPN scoreboard data source. Works unmodified in the browser (admin's manual
// refresh button) and in Node (the GitHub Actions cron script) since both
// environments have a global fetch and this file has no other dependencies.
//
// Field shapes below were confirmed against live responses on 2026-08-31:
//   https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?groups=8&dates=20241130
//
// The `year`/`week`/`seasontype` query params were observed to be unreliable
// (silently ignored in some combinations), so this module queries by date and
// filters to the requested window itself, rather than trusting ESPN's weeks.
//
// 2026-09-17: ESPN stopped accepting date RANGES. Every `dates=YYYYMMDD-YYYYMMDD`
// request — even a 2-day one, and even ranges that synced fine the week before —
// now returns 400 `{"message":"Failed to get events endpoint."}`, which took
// down the cron, admin's Sync button, and the players' Schedule tab (it loads
// the whole season as one range) all at once. Single days and whole months
// (`dates=YYYYMM`) still work, so this fetches the months a window touches and
// filters down. Verified against stored data before switching: Weeks 1-3
// reproduced with identical game IDs, nothing missing, nothing extra.

import { isSecTeam } from './teams.js?v=40';

const SCOREBOARD_URL =
  'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard';

/** "YYYY-MM-DD" for a Date or date string, read in UTC (how the admin date inputs are stored). */
function toIsoDate(date) {
  const d = typeof date === 'string' ? new Date(date) : date;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ESPN assigns games to US Eastern calendar days, not UTC ones, and the window
// has to be applied the same way. A late kickoff lands on the next day in UTC —
// Week 1's Thursday opener, UAPB @ MIZ, is 2026-09-04T00:00Z but a Sep 3 game —
// so filtering on the raw UTC timestamp would drop late games from the end of a
// window and pull them into the following one.
const ET_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
});
const easternDay = iso => ET_DAY.format(new Date(iso));

/** Every YYYYMM that [start, end] touches, padded a day either side for ET/UTC edges. */
function monthsBetween(startIso, endIso) {
  const DAY = 24 * 3600 * 1000;
  const cursor = new Date(new Date(startIso).getTime() - DAY);
  cursor.setUTCDate(1);
  const last = new Date(new Date(endIso).getTime() + DAY);
  const months = [];
  while (cursor <= last) {
    months.push(`${cursor.getUTCFullYear()}${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

const MONTH_LIMIT = 300; // busiest observed month is ~51 SEC games

async function fetchMonth(yyyymm) {
  const url = `${SCOREBOARD_URL}?groups=8&dates=${yyyymm}&limit=${MONTH_LIMIT}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`ESPN scoreboard request failed: ${res.status} ${res.statusText} (${yyyymm})`);
  }
  const data = await res.json();
  const events = Array.isArray(data.events) ? data.events : [];
  if (events.length >= MONTH_LIMIT) {
    // Would mean the month was silently truncated — surface it rather than
    // quietly syncing a partial schedule.
    console.warn(`ESPN returned ${events.length} events for ${yyyymm}, at the limit — results may be truncated.`);
  }
  return events;
}

function normalizeCompetitor(c) {
  return {
    abbr: c.team.abbreviation,
    name: c.team.displayName,
    school: c.team.location, // e.g. "Ole Miss" vs displayName's "Ole Miss Rebels" — no mascot
    score: c.score === undefined || c.score === '' ? null : Number(c.score),
    winner: c.winner === true,
  };
}

function normalizeEvent(event) {
  const comp = event.competitions[0];
  const home = comp.competitors.find(c => c.homeAway === 'home');
  const away = comp.competitors.find(c => c.homeAway === 'away');
  const statusType = comp.status.type;

  const homeN = normalizeCompetitor(home);
  const awayN = normalizeCompetitor(away);

  let winnerAbbr = null;
  if (statusType.completed) {
    if (homeN.winner && !awayN.winner) winnerAbbr = homeN.abbr;
    else if (awayN.winner && !homeN.winner) winnerAbbr = awayN.abbr;
    else winnerAbbr = 'TIE'; // no modern-era CFB ties, but guard anyway
  }

  const network = Array.isArray(comp.broadcasts) && comp.broadcasts.length
    ? [...new Set(comp.broadcasts.flatMap(b => b.names || []))].join('/')
    : null;

  return {
    id: event.id,
    kickoff: event.date,
    name: event.name,
    shortName: event.shortName,
    statusName: statusType.name, // STATUS_SCHEDULED | STATUS_IN_PROGRESS | STATUS_FINAL | STATUS_POSTPONED | STATUS_CANCELED
    completed: statusType.completed === true,
    network, // e.g. "ESPN", "ABC/Disney+" — null if ESPN hasn't published one yet
    home: homeN,
    away: awayN,
    winnerAbbr,
  };
}

/**
 * Fetch SEC-involving games in a date range (inclusive, US Eastern game days).
 * Same signature and results as the old single range request — see the note at
 * the top of the file for why it now fetches by month.
 * @param {string|Date} startDate
 * @param {string|Date} endDate
 * @returns {Promise<ReturnType<typeof normalizeEvent>[]>}
 */
export async function fetchGames(startDate, endDate) {
  const start = toIsoDate(startDate);
  const end = toIsoDate(endDate);

  const monthly = await Promise.all(monthsBetween(start, end).map(fetchMonth));

  // A padded window can touch the same event from two months' requests.
  const byId = new Map();
  for (const event of monthly.flat()) byId.set(event.id, event);

  return [...byId.values()]
    .filter(e => { const day = easternDay(e.date); return day >= start && day <= end; })
    .map(normalizeEvent)
    .filter(g => isSecTeam(g.home.abbr) || isSecTeam(g.away.abbr));
}
