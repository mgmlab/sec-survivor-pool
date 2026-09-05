// Single swap point for the active score data source.
// To move to CollegeFootballData.com later: write cfbd.js exporting the same
// fetchGames(startDate, endDate) signature, then change this one import.
export { fetchGames } from './espn.js?v=37';
