// Pure elimination logic, shared between the browser admin panel (manual
// refresh) and the GitHub Actions cron script (scripts/fetch-results.mjs).
// No Firebase or fetch calls in here — just data in, decisions out.

/**
 * @param {object} week           /weeks/{n} record: { games: { [id]: Game }, lockTime, status }
 * @param {object} picksForWeek   /picks/{n} record: { [participantId]: { team, pickedAt } }
 * @param {object} participants   /participants record: { [id]: { name, eliminatedWeek, eliminatedReason } }
 * @param {number} weekNumber
 * @param {"eliminate"|"skip"} noPickPolicy  what happens if someone never picked
 * @returns {{ [participantId]: { eliminatedWeek: number, eliminatedReason: string } }}
 *          only entries for participants newly eliminated this call
 */
export function computeEliminations(week, picksForWeek, participants, weekNumber, noPickPolicy = 'eliminate') {
  const games = Object.values(week?.games || {});
  const newlyEliminated = {};

  for (const [pid, participant] of Object.entries(participants || {})) {
    if (participant.eliminatedWeek != null) continue; // already out, don't re-process

    const pick = picksForWeek?.[pid];

    if (!pick) {
      const lockPassed = week?.lockTime && Date.now() > new Date(week.lockTime).getTime();
      if (lockPassed && noPickPolicy === 'eliminate') {
        newlyEliminated[pid] = { eliminatedWeek: weekNumber, eliminatedReason: 'No pick submitted' };
      }
      continue;
    }

    const game = games.find(g => g.home.abbr === pick.team || g.away.abbr === pick.team);
    if (!game || !game.completed) continue; // game hasn't finished yet, nothing to decide

    if (game.winnerAbbr === pick.team) continue; // survived

    const opponent = game.home.abbr === pick.team ? game.away.abbr : game.home.abbr;
    const reason =
      game.winnerAbbr === 'TIE'
        ? `${pick.team} tied ${opponent}`
        : `${pick.team} lost to ${game.winnerAbbr} (${game.away.score}-${game.home.score})`;

    newlyEliminated[pid] = { eliminatedWeek: weekNumber, eliminatedReason: reason };
  }

  return newlyEliminated;
}
