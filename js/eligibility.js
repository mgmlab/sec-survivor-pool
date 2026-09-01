// Pure pick-eligibility logic — no Firebase, no DOM. Shared by the pick
// screen's grey-out UI (js/app.js), the admin auto-pick step (js/admin.js),
// and the cron script's auto-pick step (scripts/fetch-results.mjs), so all
// three can never disagree about which teams are legal to pick.
import { SEC_TEAMS } from '../data-source/teams.js';
import { conferenceOf, ALL_CONFERENCES } from '../data-source/power4-teams.js';

export const RULE_DEFAULTS = {
  maxTeamUses: 1,
  maxSecOpponentPicks: 2,
  eligibleConferences: Object.fromEntries(ALL_CONFERENCES.map(c => [c, true])),
};

export function isLocked(week) {
  return !!(week?.lockTime && Date.now() > week.lockTime);
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

// Counts only locked/past weeks (< currentWeek) — an in-progress pick for the
// current week doesn't burn a use until its week actually locks, so switching
// picks freely before lock never wastes anything.
// `picks` and `weeks` are the FULL /picks and /weeks objects (all weeks).
export function usageStatsFor(picks, weeks, currentWeek, pid) {
  const teamUseCounts = {};
  let secOpponentCount = 0;

  for (const [weekStr, weekPicks] of Object.entries(picks || {})) {
    const weekNum = Number(weekStr);
    if (weekNum >= currentWeek) continue;
    const pick = weekPicks?.[pid];
    if (!pick?.team) continue;

    teamUseCounts[pick.team] = (teamUseCounts[pick.team] || 0) + 1;

    const opponentAbbr = opponentAbbrFor(weeks?.[weekNum], pick.team);
    if (opponentAbbr && conferenceOf(opponentAbbr) === 'SEC') secOpponentCount++;
  }

  return { teamUseCounts, secOpponentCount };
}

/**
 * Evaluates every SEC team's pickability for one participant in one week.
 * Returns one row per team: { abbr, name, game, opponentConf, flag, disabled, selected }.
 */
export function evaluateTeamsForWeek({ week, picks, weeks, currentWeek, pid, config, myPick = null }) {
  const maxTeamUses = config?.maxTeamUses ?? RULE_DEFAULTS.maxTeamUses;
  const maxSecOpponentPicks = config?.maxSecOpponentPicks ?? RULE_DEFAULTS.maxSecOpponentPicks;
  const eligibleConferences = config?.eligibleConferences || RULE_DEFAULTS.eligibleConferences;
  const { teamUseCounts, secOpponentCount } = usageStatsFor(picks, weeks, currentWeek, pid);

  return SEC_TEAMS.map(team => {
    const game = gameForTeam(week, team.abbr);
    const selected = myPick === team.abbr;
    const usesLeft = maxTeamUses - (teamUseCounts[team.abbr] || 0);
    const teamExhausted = usesLeft <= 0;

    let opponentConf = null;
    if (game) {
      const isHome = game.home.abbr === team.abbr;
      const opp = isHome ? game.away : game.home;
      opponentConf = conferenceOf(opp.abbr);
    }

    const notPower4 = !!game && !opponentConf;
    const confDisabled = !!game && !!opponentConf && !eligibleConferences[opponentConf];
    const secCapHit = !!game && opponentConf === 'SEC' && secOpponentCount >= maxSecOpponentPicks;

    let flag = teamExhausted ? `used ${teamUseCounts[team.abbr]}/${maxTeamUses} times` : '';
    if (!selected) {
      if (notPower4 || confDisabled) flag = 'opponent not eligible (not Power 4)';
      else if (secCapHit) flag = `SEC-vs-SEC limit reached (${secOpponentCount}/${maxSecOpponentPicks})`;
    }

    const disabled = !selected && (teamExhausted || !game || notPower4 || confDisabled || secCapHit);

    return { abbr: team.abbr, name: team.name, game, opponentConf, flag, disabled, selected, teamExhausted };
  });
}

/** Just the abbreviations of teams this participant could legally pick right now. */
export function eligibleTeamsFor({ week, picks, weeks, currentWeek, pid, config }) {
  return evaluateTeamsForWeek({ week, picks, weeks, currentWeek, pid, config })
    .filter(t => !t.disabled)
    .map(t => t.abbr);
}
