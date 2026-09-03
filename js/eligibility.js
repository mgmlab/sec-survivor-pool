// Pure pick-eligibility logic — no Firebase, no DOM. Shared by the pick
// screen's grey-out UI (js/app.js), the admin auto-pick step (js/admin.js),
// and the cron script's auto-pick step (scripts/fetch-results.mjs), so all
// three can never disagree about which teams are legal to pick.
import { SEC_TEAMS, isSecTeam } from '../data-source/teams.js?v=31';
import { conferenceOf, ALL_CONFERENCES, DEFAULT_ELIGIBLE_CONFERENCES } from '../data-source/power4-teams.js?v=31';

export const RULE_DEFAULTS = {
  maxTeamUses: 1,
  maxSecOpponentPicks: 2,
  maxLosses: 1,
  eligibleConferences: Object.fromEntries(ALL_CONFERENCES.map(c => [c, DEFAULT_ELIGIBLE_CONFERENCES.includes(c)])),
};

export function isLocked(week) {
  return !!(week?.lockTime && Date.now() > week.lockTime);
}

/** True if anyone could legally pick a team in this game (opponent is in an eligible conference). */
export function isGameEligible(game, config) {
  const eligibleConferences = config?.eligibleConferences || RULE_DEFAULTS.eligibleConferences;
  for (const [side, other] of [[game.home, game.away], [game.away, game.home]]) {
    if (!isSecTeam(side.abbr)) continue;
    const conf = conferenceOf(other.abbr);
    if (conf && eligibleConferences[conf]) return true;
  }
  return false;
}

// Lock at the first kickoff among games someone could actually PICK, not the
// first SEC game of any kind. A week opening with, say, Missouri vs an FCS
// team would otherwise lock everyone out Thursday night over a game nobody
// was allowed to pick — the real deadline is the first eligible matchup.
// Deliberately global: only the conference rule is applied here, not the
// per-person ones (team already used, SEC-opponent cap), so everyone in the
// pool shares one deadline instead of each having a personal one.
// Falls back to all games if a week somehow has no eligible matchup at all.
export function computeLockTime(games, config) {
  const list = Object.values(games || {});
  if (!list.length) return null;
  const eligible = list.filter(g => isGameEligible(g, config));
  const pool = eligible.length ? eligible : list;
  return Math.min(...pool.map(g => new Date(g.kickoff).getTime()));
}

export function gameForTeam(week, abbr) {
  const games = Object.values(week?.games || {});
  return games.find(g => g.home.abbr === abbr || g.away.abbr === abbr) || null;
}

export function opponentAbbrFor(week, teamAbbr) {
  const game = gameForTeam(week, teamAbbr);
  if (!game) return null;
  return game.home.abbr === teamAbbr ? game.away.abbr : game.home.abbr;
}

// Counts every OTHER week's pick (any week except `excludeWeek`) — not just
// past/locked ones. Picks can now be queued ahead for future weeks (the
// Schedule tab doubles as a pick queue), so a team queued for week 7 must
// still count as "used" while you're deciding week 3, otherwise the same
// team could be double-booked across weeks. Excluding only the one week
// being edited (rather than "everything from here on") means an in-progress
// selection for THAT week never counts against itself, while every other
// week — past, current, or future-queued — does.
// `picks` and `weeks` are the FULL /picks and /weeks objects (all weeks).
// maxSecOpponentPicks caps how many times you can play against any ONE SEC
// opponent (e.g. you can't just always pick whoever's playing this year's
// worst SEC team) — it is NOT a shared pool across all SEC opponents. Playing
// against Auburn twice and Georgia twice both max out independently; there's
// no season-wide ceiling on how many different SEC opponents you face.
export function usageStatsFor(picks, weeks, excludeWeek, pid) {
  const teamUseCounts = {};
  const secOpponentCounts = {}; // opponent abbr -> times you've played against them

  for (const [weekStr, weekPicks] of Object.entries(picks || {})) {
    const weekNum = Number(weekStr);
    if (weekNum === excludeWeek) continue;
    const pick = weekPicks?.[pid];
    if (!pick?.team) continue;

    teamUseCounts[pick.team] = (teamUseCounts[pick.team] || 0) + 1;

    const opponentAbbr = opponentAbbrFor(weeks?.[weekNum], pick.team);
    if (opponentAbbr && conferenceOf(opponentAbbr) === 'SEC') {
      secOpponentCounts[opponentAbbr] = (secOpponentCounts[opponentAbbr] || 0) + 1;
    }
  }

  return { teamUseCounts, secOpponentCounts };
}

/**
 * Evaluates every SEC team's pickability for one participant in one week
 * (`weekNumber` — the week being edited/viewed, not necessarily the pool's
 * current week; the Schedule/queue view calls this once per future week too).
 * Returns one row per team: { abbr, name, game, opponentConf, flag, disabled, selected }.
 */
export function evaluateTeamsForWeek({ week, picks, weeks, weekNumber, pid, config, myPick = null }) {
  const maxTeamUses = config?.maxTeamUses ?? RULE_DEFAULTS.maxTeamUses;
  const maxSecOpponentPicks = config?.maxSecOpponentPicks ?? RULE_DEFAULTS.maxSecOpponentPicks;
  const eligibleConferences = config?.eligibleConferences || RULE_DEFAULTS.eligibleConferences;
  const { teamUseCounts, secOpponentCounts } = usageStatsFor(picks, weeks, weekNumber, pid);

  return SEC_TEAMS.map(team => {
    const game = gameForTeam(week, team.abbr);
    const selected = myPick === team.abbr;
    const usesLeft = maxTeamUses - (teamUseCounts[team.abbr] || 0);
    const teamExhausted = usesLeft <= 0;

    let opponentConf = null;
    let opponentAbbr = null;
    if (game) {
      const isHome = game.home.abbr === team.abbr;
      const opp = isHome ? game.away : game.home;
      opponentConf = conferenceOf(opp.abbr);
      opponentAbbr = opp.abbr;
    }

    const notPower4 = !!game && !opponentConf;
    const confDisabled = !!game && !!opponentConf && !eligibleConferences[opponentConf];
    const secOpponentUsed = opponentAbbr ? (secOpponentCounts[opponentAbbr] || 0) : 0;
    const secCapHit = !!game && opponentConf === 'SEC' && secOpponentUsed >= maxSecOpponentPicks;

    let flag = teamExhausted ? `used ${teamUseCounts[team.abbr]}/${maxTeamUses} times` : '';
    if (!selected) {
      if (notPower4 || confDisabled) flag = 'opponent not eligible (not Power 4)';
      else if (secCapHit) flag = `already played vs ${opponentAbbr} ${secOpponentUsed}/${maxSecOpponentPicks} times`;
    }

    const disabled = !selected && (teamExhausted || !game || notPower4 || confDisabled || secCapHit);

    return { abbr: team.abbr, name: team.name, game, opponentConf, flag, disabled, selected, teamExhausted };
  });
}

/** Just the abbreviations of teams this participant could legally pick for weekNumber. */
export function eligibleTeamsFor({ week, picks, weeks, weekNumber, pid, config }) {
  return evaluateTeamsForWeek({ week, picks, weeks, weekNumber, pid, config })
    .filter(t => !t.disabled)
    .map(t => t.abbr);
}
