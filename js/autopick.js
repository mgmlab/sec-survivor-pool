import { eligibleTeamsFor } from './eligibility.js?v=28';

// Seeded so re-running the sync (the cron job fires repeatedly, or admin
// clicks the button twice) doesn't reassign a different random team before
// the first assignment is actually written — same participant + same week
// always resolves to the same pick.
function seededRandom(seedStr) {
  let h = 0;
  for (let i = 0; i < seedStr.length; i++) h = (h * 31 + seedStr.charCodeAt(i)) >>> 0;
  return () => {
    h = (h * 1664525 + 1013904223) >>> 0;
    return h / 4294967296;
  };
}

/**
 * For every non-eliminated participant with no pick yet in weekNumber,
 * assigns a random rule-eligible team. A participant with zero eligible
 * teams left gets `null` — the caller should eliminate them directly rather
 * than write a pick.
 * @returns {{ [participantId]: string|null }}
 */
export function autoPicksForWeek({ week, weekNumber, picks, weeks, participants, config }) {
  const assignments = {};
  const picksForWeek = picks?.[weekNumber] || {};

  for (const [pid, participant] of Object.entries(participants || {})) {
    if (participant.eliminatedWeek != null) continue;
    if (picksForWeek[pid]?.team) continue;

    const eligible = eligibleTeamsFor({ week, picks, weeks, weekNumber, pid, config });
    if (!eligible.length) {
      assignments[pid] = null;
      continue;
    }

    const rand = seededRandom(`${pid}-week${weekNumber}`);
    assignments[pid] = eligible[Math.floor(rand() * eligible.length)];
  }

  return assignments;
}
