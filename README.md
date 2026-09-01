# SEC Survivor Pool

Static HTML/JS + Firebase Realtime Database, hosted on GitHub Pages. Same pattern
as the Open Championship golf pool: no build step, no accounts beyond an anonymous
Firebase auth session per browser, a shared passphrase gates the commissioner view.

## One-time setup

### 1. Firebase project
1. Create a project at https://console.firebase.google.com.
2. **Build > Realtime Database > Create Database** — start in *locked* mode (rules
   below replace the defaults).
3. **Build > Authentication > Sign-in method > Anonymous** — enable it.
4. **Realtime Database > Rules** — paste in the contents of [`firebase-rules.json`](firebase-rules.json) and publish.
5. **Project settings > General > Your apps > Add app (Web)** — copy the resulting
   config object into [`js/firebase-config.js`](js/firebase-config.js).

### 2. Bootstrap the admin passphrase
`admin/passHash` can only be *changed* by someone already authorized, so the very
first value has to be written by hand in the Firebase console (Realtime Database
data viewer, add a child `admin` → `passHash`). Compute the hash by pasting this
into any browser's JS console:

```js
crypto.subtle.digest('SHA-256', new TextEncoder().encode('your-passphrase-here'))
  .then(buf => console.log([...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')));
```

Paste the printed hex string in as the value of `admin/passHash`.

### 3. Deploy the site
Push this repo to GitHub, then **Settings > Pages** → deploy from `main` / `/root`.
Every push auto-redeploys in under a minute. Bump the `?v=N` query strings on the
`<link>`/`<script>` tags in `index.html`/`admin.html` on each deploy — phones cache
aggressively otherwise.

### 4. Wire up the automated score-check (GitHub Actions)
1. **Firebase console > Project settings > Service accounts > Generate new private key.**
   This downloads a JSON file — treat it like a password.
2. In the GitHub repo: **Settings > Secrets and variables > Actions**, add:
   - `FIREBASE_SERVICE_ACCOUNT` — the full contents of that JSON file
   - `FIREBASE_DATABASE_URL` — e.g. `https://your-project-default-rtdb.firebaseio.com`
3. The workflow at `.github/workflows/weekly-score-check.yml` runs every 3 hours,
   Thursday–Monday, during the season, plus on-demand via the Actions tab's
   "Run workflow" button.

## Pick rules

All three are enforced client-side in the pick screen and adjustable anytime
from admin's **Pool settings** (defaults shown):

- **Each team usable up to `maxTeamUses` times per season** (default **1** —
  the standard "can't reuse a team" survivor rule).
- **Picks against an SEC opponent capped at `maxSecOpponentPicks` per season**
  (default **2**) — an SEC-vs-SEC matchup only counts against this cap once
  its week locks, so switching an in-progress pick before lock never burns it.
- **Opponent must belong to an eligible conference** (default: **SEC, ACC,
  Big 12, Big Ten** — i.e. Power 4 only). A team whose only game that week is
  against a Group-of-5/FCS opponent shows as ineligible, not pickable, even
  though it's not technically a bye. Toggle conferences individually in admin
  if the group wants to loosen or tighten this later.

Conference membership for all 67 Power-4 teams lives in
[`data-source/power4-teams.js`](data-source/power4-teams.js), harvested live
from ESPN rather than hand-typed — regenerate it the same way (fetch each
conference's `groups=` scoreboard across a full season, keep only
`conferenceCompetition: true` games) if realignment happens again.

The rule engine itself (which teams are pickable, why not) lives in one shared,
pure module — [`js/eligibility.js`](js/eligibility.js) — imported by the pick
screen's grey-out UI, the admin panel's auto-pick step, and the cron script.
All three read the same logic, so they can never disagree about what's legal.

### If no pick is submitted by lock

Three options in admin's **Pool settings**:
- **Eliminate** — the standard survivor rule.
- **Skip** — no penalty, no team used that week.
- **Auto-pick** — a team is randomly assigned from whatever that person could
  still legally pick (not used up, opponent in an eligible conference, under
  the SEC-vs-SEC cap). If literally nothing is eligible, they're eliminated
  instead with that reason shown. Auto-picked weeks are flagged "(auto)" in
  the History tab. This runs both from admin's **Run eliminations** button and
  automatically from the scheduled GitHub Action — [`js/autopick.js`](js/autopick.js)
  uses a seeded random per participant+week, so re-running it (the cron fires
  repeatedly) never reassigns a different team once one's been written.

## Rules & how to play (player-facing)

`index.html` shows a collapsible "Rules & how to play" section right under the
header, built dynamically from the *actual current* admin settings — not
static copy — so it can never go stale if the commissioner changes a rule
mid-season. If you want to change the wording, edit `renderRulesSection()` in
[`js/app.js`](js/app.js).

## Full schedule / pick queue

A fourth tab ("Schedule") shows every SEC team's full-season schedule at once
— school names only, no mascots, to fit more on screen — color-coded by
opponent conference (SEC / other Power 4 / not Power 4). Tapping any team name
(there, or the "Full schedule →" link on each pick-screen card, which works
even on a team that's not currently pickable) opens that team's full
week-by-week schedule with results as they come in. This is fetched directly
from ESPN by the browser (read-only, no Firebase involved) and cached for the
session — nothing to set up, and it works for weeks the commissioner hasn't
synced yet too (`weekDataFor()` in `js/app.js` falls back to the live schedule
when a week isn't in `/weeks` yet).

**It doubles as a pick queue.** For any week that hasn't locked, tap a cell to
set your pick for that week — not just the current one. Queue picks for the
whole season at once if you want; change your mind anytime before that week's
lock, from either the queue or the Pick tab (they read/write the exact same
data, so whichever you touch last wins). The same rules engine that greys out
the Pick tab governs the queue, so a team already used — or queued — anywhere
else in the season is disabled everywhere else too, with a tooltip explaining
why. When a queued week becomes the current week, it just shows up pre-selected
on the Pick tab, same as if you'd picked it that day. Locked/past weeks and
eliminated participants get a read-only grid.

This required generalizing `usageStatsFor()` in `js/eligibility.js`: it used to
exclude "the current week and everything after" from the used-teams count
(the only case that could ever happen, before queuing existed); it now
excludes only the *one* week being edited, so a team queued for week 9 counts
as used while you're deciding week 3, and vice versa.

## Running the pool week to week

1. Open `admin.html`, unlock with the passphrase.
2. Add each participant's name (they'll claim it themselves from `index.html`).
   Each row shows whether they've picked yet for the current week, whether
   they're online right now, and how long ago they were last seen (mirrors
   the golf pool's `views`/`presence` pattern — one visit-log write per page
   load, plus a live `presence/{uid}` entry that auto-removes on disconnect
   via `onDisconnect()`).
3. Set that week's start/end date range, click **Sync scores** to pull the
   schedule (lock time is auto-set to the earliest kickoff among that week's
   games — override it under "Reset lock time" if needed).
4. Share `index.html`'s link with the group. Everyone taps their name once to
   claim it, then picks a team each week until it's used or they're eliminated.
5. After games finish, either wait for the scheduled Action or hit **Sync scores**
   manually in admin, then **Run eliminations** (shows a preview before applying).
6. If ESPN has a game wrong, postponed, or missing, use **Edit** next to that game
   in admin to override the result by hand — flagged as an override in the UI.
7. When ready for the next week, **Advance to next week** in Pool settings.

## Swapping the score source later

`data-source/provider.js` is the only file that names the active source. To move
to [CollegeFootballData.com](https://collegefootballdata.com), write a `cfbd.js`
in `data-source/` exporting the same `fetchGames(startDate, endDate)` signature
and change the one import line in `provider.js`. Nothing in `app.js`, `admin.js`,
or `scripts/fetch-results.mjs` needs to change.
