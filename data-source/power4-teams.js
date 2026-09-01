// Conference membership for every Power-4 team, used only to judge whether a
// pick's opponent is eligible (rule: SEC team must play a Power-4 opponent).
// Harvested live on 2026-08-31 from ESPN's conference-flagged games across the
// full 2025 season (sports.core.api.espn.com groups: 8=SEC, 1=ACC, 4=Big 12,
// 5=Big Ten) — not hand-typed, so it reflects actual current realignment
// (e.g. Oregon/Washington/UCLA/USC in the Big Ten, SMU/Stanford/Cal in the ACC,
// Arizona/Utah/Colorado/Arizona State in the Big 12).
export const POWER4_TEAMS = [
  // SEC (16) — same set as data-source/teams.js
  { abbr: 'ALA', name: 'Alabama Crimson Tide', conference: 'SEC' },
  { abbr: 'ARK', name: 'Arkansas Razorbacks', conference: 'SEC' },
  { abbr: 'AUB', name: 'Auburn Tigers', conference: 'SEC' },
  { abbr: 'FLA', name: 'Florida Gators', conference: 'SEC' },
  { abbr: 'UGA', name: 'Georgia Bulldogs', conference: 'SEC' },
  { abbr: 'UK', name: 'Kentucky Wildcats', conference: 'SEC' },
  { abbr: 'LSU', name: 'LSU Tigers', conference: 'SEC' },
  { abbr: 'MISS', name: 'Ole Miss Rebels', conference: 'SEC' },
  { abbr: 'MSST', name: 'Mississippi State Bulldogs', conference: 'SEC' },
  { abbr: 'MIZ', name: 'Missouri Tigers', conference: 'SEC' },
  { abbr: 'OU', name: 'Oklahoma Sooners', conference: 'SEC' },
  { abbr: 'SC', name: 'South Carolina Gamecocks', conference: 'SEC' },
  { abbr: 'TENN', name: 'Tennessee Volunteers', conference: 'SEC' },
  { abbr: 'TEX', name: 'Texas Longhorns', conference: 'SEC' },
  { abbr: 'TA&M', name: 'Texas A&M Aggies', conference: 'SEC' },
  { abbr: 'VAN', name: 'Vanderbilt Commodores', conference: 'SEC' },

  // ACC (17)
  { abbr: 'BC', name: 'Boston College Eagles', conference: 'ACC' },
  { abbr: 'DUKE', name: 'Duke Blue Devils', conference: 'ACC' },
  { abbr: 'NCSU', name: 'NC State Wolfpack', conference: 'ACC' },
  { abbr: 'UNC', name: 'North Carolina Tar Heels', conference: 'ACC' },
  { abbr: 'WAKE', name: 'Wake Forest Demon Deacons', conference: 'ACC' },
  { abbr: 'SYR', name: 'Syracuse Orange', conference: 'ACC' },
  { abbr: 'PITT', name: 'Pittsburgh Panthers', conference: 'ACC' },
  { abbr: 'CLEM', name: 'Clemson Tigers', conference: 'ACC' },
  { abbr: 'MIA', name: 'Miami Hurricanes', conference: 'ACC' },
  { abbr: 'STAN', name: 'Stanford Cardinal', conference: 'ACC' },
  { abbr: 'CAL', name: 'California Golden Bears', conference: 'ACC' },
  { abbr: 'SMU', name: 'SMU Mustangs', conference: 'ACC' },
  { abbr: 'UVA', name: 'Virginia Cavaliers', conference: 'ACC' },
  { abbr: 'VT', name: 'Virginia Tech Hokies', conference: 'ACC' },
  { abbr: 'FSU', name: 'Florida State Seminoles', conference: 'ACC' },
  { abbr: 'GT', name: 'Georgia Tech Yellow Jackets', conference: 'ACC' },
  { abbr: 'LOU', name: 'Louisville Cardinals', conference: 'ACC' },

  // Big 12 (16)
  { abbr: 'ARIZ', name: 'Arizona Wildcats', conference: 'Big 12' },
  { abbr: 'OKST', name: 'Oklahoma State Cowboys', conference: 'Big 12' },
  { abbr: 'UCF', name: 'UCF Knights', conference: 'Big 12' },
  { abbr: 'CIN', name: 'Cincinnati Bearcats', conference: 'Big 12' },
  { abbr: 'KU', name: 'Kansas Jayhawks', conference: 'Big 12' },
  { abbr: 'KSU', name: 'Kansas State Wildcats', conference: 'Big 12' },
  { abbr: 'BAY', name: 'Baylor Bears', conference: 'Big 12' },
  { abbr: 'HOU', name: 'Houston Cougars', conference: 'Big 12' },
  { abbr: 'BYU', name: 'BYU Cougars', conference: 'Big 12' },
  { abbr: 'UTAH', name: 'Utah Utes', conference: 'Big 12' },
  { abbr: 'TCU', name: 'TCU Horned Frogs', conference: 'Big 12' },
  { abbr: 'TTU', name: 'Texas Tech Red Raiders', conference: 'Big 12' },
  { abbr: 'WVU', name: 'West Virginia Mountaineers', conference: 'Big 12' },
  { abbr: 'COLO', name: 'Colorado Buffaloes', conference: 'Big 12' },
  { abbr: 'ISU', name: 'Iowa State Cyclones', conference: 'Big 12' },
  { abbr: 'ASU', name: 'Arizona State Sun Devils', conference: 'Big 12' },

  // Big Ten (18)
  { abbr: 'MD', name: 'Maryland Terrapins', conference: 'Big Ten' },
  { abbr: 'MSU', name: 'Michigan State Spartans', conference: 'Big Ten' },
  { abbr: 'MICH', name: 'Michigan Wolverines', conference: 'Big Ten' },
  { abbr: 'MINN', name: 'Minnesota Golden Gophers', conference: 'Big Ten' },
  { abbr: 'NEB', name: 'Nebraska Cornhuskers', conference: 'Big Ten' },
  { abbr: 'RUTG', name: 'Rutgers Scarlet Knights', conference: 'Big Ten' },
  { abbr: 'OSU', name: 'Ohio State Buckeyes', conference: 'Big Ten' },
  { abbr: 'PSU', name: 'Penn State Nittany Lions', conference: 'Big Ten' },
  { abbr: 'IOWA', name: 'Iowa Hawkeyes', conference: 'Big Ten' },
  { abbr: 'ORE', name: 'Oregon Ducks', conference: 'Big Ten' },
  { abbr: 'PUR', name: 'Purdue Boilermakers', conference: 'Big Ten' },
  { abbr: 'UCLA', name: 'UCLA Bruins', conference: 'Big Ten' },
  { abbr: 'WASH', name: 'Washington Huskies', conference: 'Big Ten' },
  { abbr: 'WIS', name: 'Wisconsin Badgers', conference: 'Big Ten' },
  { abbr: 'USC', name: 'USC Trojans', conference: 'Big Ten' },
  { abbr: 'ILL', name: 'Illinois Fighting Illini', conference: 'Big Ten' },
  { abbr: 'NU', name: 'Northwestern Wildcats', conference: 'Big Ten' },
  { abbr: 'IU', name: 'Indiana Hoosiers', conference: 'Big Ten' },
];

export const CONFERENCE_BY_ABBR = Object.fromEntries(POWER4_TEAMS.map(t => [t.abbr, t.conference]));

export const ALL_CONFERENCES = ['SEC', 'ACC', 'Big 12', 'Big Ten'];

/** Returns the opponent's conference name, or null if they're not a Power-4 team. */
export function conferenceOf(abbr) {
  return CONFERENCE_BY_ABBR[abbr] || null;
}
