// All game/lock times are shown in Central Time regardless of the viewer's
// own device timezone — the league runs on Central, and letting each phone's
// local timezone leak into the display caused real confusion (and, for a
// late-night kickoff, could even show the wrong calendar date to someone in
// a different zone).
const CENTRAL = 'America/Chicago';

export function formatCentral(date, opts) {
  return new Date(date).toLocaleString('en-US', { ...opts, timeZone: CENTRAL });
}

export function formatCentralDate(date, opts) {
  return new Date(date).toLocaleDateString('en-US', { ...opts, timeZone: CENTRAL });
}
