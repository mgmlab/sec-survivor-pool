// Runs unattended via GitHub Actions (.github/workflows/weekly-score-check.yml).
// Pulls the current week's games from the same data-source module the admin panel
// uses, writes results to Firebase, auto-picks for anyone who missed the lock (if
// that policy is on), and applies eliminations. Requires Node 18+ (global fetch)
// and two env vars: FIREBASE_SERVICE_ACCOUNT (JSON) and FIREBASE_DATABASE_URL.

import admin from 'firebase-admin';
import { fetchGames } from '../data-source/provider.js';
import { computeEliminations } from '../js/elimination.js';
import { isLocked } from '../js/eligibility.js';
import { autoPicksForWeek } from '../js/autopick.js';

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL,
});

const db = admin.database();

async function main() {
  const config = (await db.ref('config').get()).val() || {};
  const currentWeek = config.currentWeek || 1;
  console.log(`Checking week ${currentWeek}...`);

  const weeks = (await db.ref('weeks').get()).val() || {};
  const week = weeks[currentWeek] || {};
  if (!week.startDate || !week.endDate) {
    console.log(`Week ${currentWeek} has no startDate/endDate set in admin — nothing to sync.`);
    return;
  }

  const games = await fetchGames(week.startDate, week.endDate);
  console.log(`Fetched ${games.length} SEC games for ${week.startDate}..${week.endDate}.`);

  const gamesById = {};
  for (const g of games) gamesById[g.id] = g;

  const updates = { [`weeks/${currentWeek}/games`]: gamesById };
  if (!week.lockTime && games.length) {
    updates[`weeks/${currentWeek}/lockTime`] = Math.min(...games.map(g => new Date(g.kickoff).getTime()));
  }
  const allDone = games.length > 0 && games.every(g => g.completed);
  updates[`weeks/${currentWeek}/status`] = allDone ? 'final' : (week.lockTime ? 'locked' : 'upcoming');

  await db.ref().update(updates);

  const mergedWeek = { ...week, games: gamesById, lockTime: updates[`weeks/${currentWeek}/lockTime`] ?? week.lockTime };
  weeks[currentWeek] = mergedWeek;

  const participants = (await db.ref('participants').get()).val() || {};
  const picks = (await db.ref('picks').get()).val() || {};
  let picksForWeek = picks[currentWeek] || {};

  if ((config.noPickPolicy || 'eliminate') === 'autopick' && isLocked(mergedWeek)) {
    const assignments = autoPicksForWeek({ week: mergedWeek, weekNumber: currentWeek, picks, weeks, participants, config });
    const pickUpdates = {};
    const preElimUpdates = {};
    for (const [pid, team] of Object.entries(assignments)) {
      if (team) {
        const pick = { team, pickedAt: Date.now(), autoPicked: true };
        pickUpdates[`picks/${currentWeek}/${pid}`] = pick;
        picksForWeek = { ...picksForWeek, [pid]: pick };
        console.log(`Auto-picked ${team} for ${participants[pid]?.name || pid}.`);
      } else {
        preElimUpdates[`participants/${pid}/eliminatedWeek`] = currentWeek;
        preElimUpdates[`participants/${pid}/eliminatedReason`] = 'No eligible teams remained for auto-pick';
        console.log(`No eligible teams left for ${participants[pid]?.name || pid} — eliminated.`);
      }
    }
    if (Object.keys(pickUpdates).length) await db.ref().update(pickUpdates);
    if (Object.keys(preElimUpdates).length) await db.ref().update(preElimUpdates);
  }

  const eliminations = computeEliminations(mergedWeek, picksForWeek, participants, currentWeek, config.noPickPolicy || 'eliminate');
  const entries = Object.entries(eliminations);

  if (!entries.length) {
    console.log('No new eliminations.');
    return;
  }

  const elimUpdates = {};
  for (const [pid, info] of entries) {
    elimUpdates[`participants/${pid}/eliminatedWeek`] = info.eliminatedWeek;
    elimUpdates[`participants/${pid}/eliminatedReason`] = info.eliminatedReason;
    console.log(`Eliminated ${participants[pid]?.name || pid}: ${info.eliminatedReason}`);
  }
  await db.ref().update(elimUpdates);
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('fetch-results failed:', err);
    process.exit(1);
  });
