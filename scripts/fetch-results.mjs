// Runs unattended via GitHub Actions (.github/workflows/weekly-score-check.yml).
// Pulls the current week's games from the same data-source module the admin panel
// uses, writes results to Firebase, and applies eliminations. Requires Node 18+
// (global fetch) and two env vars: FIREBASE_SERVICE_ACCOUNT (JSON) and
// FIREBASE_DATABASE_URL.

import admin from 'firebase-admin';
import { fetchGames } from '../data-source/provider.js';
import { computeEliminations } from '../js/elimination.js';

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

  const week = (await db.ref(`weeks/${currentWeek}`).get()).val() || {};
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
  const participants = (await db.ref('participants').get()).val() || {};
  const picksForWeek = (await db.ref(`picks/${currentWeek}`).get()).val() || {};

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
