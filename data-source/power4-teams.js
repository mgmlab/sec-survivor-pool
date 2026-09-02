// Conference membership for every team an SEC opponent could belong to, used
// to judge whether a pick's opponent is eligible. Covers the Power-4 plus two
// optional Group-of-5 conferences (Mountain West, Pac-12) admins can opt into
// via config.eligibleConferences — see RULE_DEFAULTS in js/eligibility.js,
// which defaults only the Power-4 to true. Harvested live from ESPN's
// season-scoped conference-group rosters (sports.core.api.espn.com groups:
// 8=SEC, 1=ACC, 4=Big 12, 5=Big Ten, 9=Pac-12, 17=Mountain West) — not
// hand-typed, so it reflects actual current realignment (e.g.
// Oregon/Washington/UCLA/USC in the Big Ten, SMU/Stanford/Cal in the ACC,
// Arizona/Utah/Colorado/Arizona State in the Big 12, the rebuilt 8-team
// Pac-12, and Mountain West's 2026 additions UTEP/Northern Illinois).
// Power-4 rosters confirmed 2026-08-31; Mountain West/Pac-12 added 2026-09-01.
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

  // Pac-12 (8) — rebuilt 2024 membership after the old Pac-12 broke apart
  { abbr: 'SDSU', name: 'San Diego State Aztecs', conference: 'Pac-12' },
  { abbr: 'CSU', name: 'Colorado State Rams', conference: 'Pac-12' },
  { abbr: 'BOIS', name: 'Boise State Broncos', conference: 'Pac-12' },
  { abbr: 'ORST', name: 'Oregon State Beavers', conference: 'Pac-12' },
  { abbr: 'WSU', name: 'Washington State Cougars', conference: 'Pac-12' },
  { abbr: 'FRES', name: 'Fresno State Bulldogs', conference: 'Pac-12' },
  { abbr: 'TXST', name: 'Texas State Bobcats', conference: 'Pac-12' },
  { abbr: 'USU', name: 'Utah State Aggies', conference: 'Pac-12' },

  // Mountain West (10)
  { abbr: 'SJSU', name: "San José State Spartans", conference: 'Mountain West' },
  { abbr: 'HAW', name: "Hawai'i Rainbow Warriors", conference: 'Mountain West' },
  { abbr: 'UNM', name: 'New Mexico Lobos', conference: 'Mountain West' },
  { abbr: 'AFA', name: 'Air Force Falcons', conference: 'Mountain West' },
  { abbr: 'UNLV', name: 'UNLV Rebels', conference: 'Mountain West' },
  { abbr: 'NEV', name: 'Nevada Wolf Pack', conference: 'Mountain West' },
  { abbr: 'NDSU', name: 'North Dakota State Bison', conference: 'Mountain West' },
  { abbr: 'NIU', name: 'Northern Illinois Huskies', conference: 'Mountain West' },
  { abbr: 'UTEP', name: 'UTEP Miners', conference: 'Mountain West' },
  { abbr: 'WYO', name: 'Wyoming Cowboys', conference: 'Mountain West' },
];

export const CONFERENCE_BY_ABBR = Object.fromEntries(POWER4_TEAMS.map(t => [t.abbr, t.conference]));

export const ALL_CONFERENCES = ['SEC', 'ACC', 'Big 12', 'Big Ten', 'Pac-12', 'Mountain West'];

// Conferences eligible by default when a pool has no config.eligibleConferences
// yet — the Power-4 only. Pac-12 and Mountain West are opt-in (admin toggles
// them on in Pool settings), not on by default.
export const DEFAULT_ELIGIBLE_CONFERENCES = ['SEC', 'ACC', 'Big 12', 'Big Ten'];

/** Returns the opponent's conference name, or null if they're not a Power-4 team. */
export function conferenceOf(abbr) {
  return CONFERENCE_BY_ABBR[abbr] || null;
}
