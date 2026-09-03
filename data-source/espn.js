// ESPN scoreboard data source. Works unmodified in the browser (admin's manual
// refresh button) and in Node (the GitHub Actions cron script) since both
// environments have a global fetch and this file has no other dependencies.
//
// Field shapes below were confirmed against live responses on 2026-08-31:
//   https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?groups=8&dates=20241130
//
// The `year`/`week`/`seasontype` query params were observed to be unreliable
// (silently ignored in some combinations), so this module always queries by
// explicit `dates=YYYYMMDD-YYYYMMDD` range instead of ESPN's own week numbers.

import { isSecTeam } from './teams.js?v=34';

const SCOREBOARD_URL =
  'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard';

function toYyyymmdd(date) {
  const d = typeof date === 'string' ? new Date(date) : date;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
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
 * Fetch SEC-involving games in a date range (inclusive).
 * @param {string|Date} startDate
 * @param {string|Date} endDate
 * @returns {Promise<ReturnType<typeof normalizeEvent>[]>}
 */
export async function fetchGames(startDate, endDate) {
  const dates = `${toYyyymmdd(startDate)}-${toYyyymmdd(endDate)}`;
  const url = `${SCOREBOARD_URL}?groups=8&dates=${dates}&limit=200`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`ESPN scoreboard request failed: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  const events = Array.isArray(data.events) ? data.events : [];

  return events
    .map(normalizeEvent)
    .filter(g => isSecTeam(g.home.abbr) || isSecTeam(g.away.abbr));
}
