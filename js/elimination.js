// Pure elimination logic, shared between the browser admin panel (manual
// refresh) and the GitHub Actions cron script (scripts/fetch-results.mjs).
// No Firebase or fetch calls in here — just data in, decisions out.

/** Number of losses this participant has taken so far this season. */
export function lossCountFor(participant) {
  return Object.keys(participant?.losses || {}).length;
}

/**
 * @param {object} week           /weeks/{n} record: { games: { [id]: Game }, lockTime, status }
 * @param {object} picksForWeek   /picks/{n} record: { [participantId]: { team, pickedAt } }
 * @param {object} participants   /participants record: { [id]: { name, eliminatedWeek, eliminatedReason, losses } }
 * @param {number} weekNumber
 * @param {"eliminate"|"skip"} noPickPolicy  what happens if someone never picked
 * @param {number} maxLosses      losses this participant may accumulate before being eliminated —
 *                                default 1 means the first loss eliminates them (same as before this
 *                                option existed); 2 means they can take one loss and are eliminated on
 *                                their second, etc.
 * @returns {{
 *   newlyEliminated: { [participantId]: { eliminatedWeek: number, eliminatedReason: string } },
 *   newLosses: { [participantId]: { week: number, reason: string } },
 * }}
 *          newlyEliminated is participants whose loss count just reached maxLosses (fully out).
 *          newLosses is participants who took a loss this week but are still under the cap — the
 *          caller should still record it (participants/{pid}/losses/{weekNumber}) even though
 *          they're not eliminated, so the next call's loss count is correct.
 */
export function computeEliminations(week, picksForWeek, participants, weekNumber, noPickPolicy = 'eliminate', maxLosses = 1) {
  const games = Object.values(week?.games || {});
  const newlyEliminated = {};
  const newLosses = {};

  for (const [pid, participant] of Object.entries(participants || {})) {
    if (participant.eliminatedWeek != null) continue; // already out, don't re-process
    // This week's loss may already be on record from an earlier pass: the cron
    // re-runs every 3 hours over the same finished games, and admin can click
    // "Run eliminations" more than once. Without this guard the same single
    // loss gets counted again each pass, so at maxLosses=2 one real loss would
    // eliminate on the second run. (Invisible at the default maxLosses=1,
    // where the first loss eliminates outright and the check above then
    // short-circuits — which is why this never showed up in testing.)
    if (participant.losses?.[weekNumber] != null) continue;

    const pick = picksForWeek?.[pid];
    let reason = null;

    if (!pick) {
      const lockPassed = week?.lockTime && Date.now() > new Date(week.lockTime).getTime();
      if (lockPassed && noPickPolicy === 'eliminate') reason = 'No pick submitted';
    } else {
      const game = games.find(g => g.home.abbr === pick.team || g.away.abbr === pick.team);
      if (game?.completed && game.winnerAbbr !== pick.team) {
        const opponent = game.home.abbr === pick.team ? game.away.abbr : game.home.abbr;
        reason =
          game.winnerAbbr === 'TIE'
            ? `${pick.team} tied ${opponent}`
            : `${pick.team} lost to ${game.winnerAbbr} (${game.away.score}-${game.home.score})`;
      }
    }

    if (!reason) continue; // survived (or game not final yet, or no-pick under a non-eliminate policy)

    const totalLosses = lossCountFor(participant) + 1;
    if (totalLosses >= maxLosses) {
      newlyEliminated[pid] = { eliminatedWeek: weekNumber, eliminatedReason: reason };
    } else {
      newLosses[pid] = { week: weekNumber, reason };
    }
  }

  return { newlyEliminated, newLosses };
}
