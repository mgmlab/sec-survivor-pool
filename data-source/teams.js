// Static SEC team roster (16 teams, post Oklahoma/Texas realignment).
// espnId/abbr verified live against the ESPN scoreboard API on 2026-08-31 (groups=8).
export const SEC_TEAMS = [
  { abbr: 'ALA',  espnId: 333,  name: 'Alabama Crimson Tide' },
  { abbr: 'ARK',  espnId: 8,    name: 'Arkansas Razorbacks' },
  { abbr: 'AUB',  espnId: 2,    name: 'Auburn Tigers' },
  { abbr: 'FLA',  espnId: 57,   name: 'Florida Gators' },
  { abbr: 'UGA',  espnId: 61,   name: 'Georgia Bulldogs' },
  { abbr: 'UK',   espnId: 96,   name: 'Kentucky Wildcats' },
  { abbr: 'LSU',  espnId: 99,   name: 'LSU Tigers' },
  { abbr: 'MISS', espnId: 145,  name: 'Ole Miss Rebels' },
  { abbr: 'MSST', espnId: 344,  name: 'Mississippi State Bulldogs' },
  { abbr: 'MIZ',  espnId: 142,  name: 'Missouri Tigers' },
  { abbr: 'OU',   espnId: 201,  name: 'Oklahoma Sooners' },
  { abbr: 'SC',   espnId: 2579, name: 'South Carolina Gamecocks' },
  { abbr: 'TENN', espnId: 2633, name: 'Tennessee Volunteers' },
  { abbr: 'TEX',  espnId: 251,  name: 'Texas Longhorns' },
  { abbr: 'TA&M', espnId: 245,  name: 'Texas A&M Aggies' },
  { abbr: 'VAN',  espnId: 238,  name: 'Vanderbilt Commodores' },
];

export const SEC_ABBRS = new Set(SEC_TEAMS.map(t => t.abbr));

export function isSecTeam(abbr) {
  return SEC_ABBRS.has(abbr);
}
