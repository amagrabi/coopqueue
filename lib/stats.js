export const PLAYED_OUTCOMES = new Set(['finished', 'unfinished', 'dropped', 'sampled']);

const STATUSES = ['backlog', 'playing', 'finished', 'unfinished', 'dropped', 'sampled'];
const r2 = (x) => Math.round(x * 100) / 100;

function yearOf(value) {
  const match = /^(\d{4})-\d{2}-\d{2}$/.exec(value || '');
  return match ? Number(match[1]) : null;
}

/* These are the history-shaped statistics shared by the production route and the
   local UI harness. Hours are present only when the route has chosen a trustworthy
   source for them; a missing value must never be silently turned into zero here. */
export function buildLibraryStats(games) {
  const statusCounts = Object.fromEntries(STATUSES.map((status) => [status, 0]));
  for (const game of games) {
    if (statusCounts[game.status] != null) statusCounts[game.status]++;
  }

  const outcomes = games.filter((game) => PLAYED_OUTCOMES.has(game.status));
  const genreMap = new Map();
  for (const game of outcomes) {
    if (!game.genre) continue;
    if (!genreMap.has(game.genre)) {
      genreMap.set(game.genre, {
        genre: game.genre, games: 0, hours: 0, hoursGames: 0,
        ratedGames: 0, scoreSum: 0,
      });
    }
    const genre = genreMap.get(game.genre);
    genre.games++;
    if (game.effectiveHours != null && Number.isFinite(Number(game.effectiveHours))) {
      genre.hours += Number(game.effectiveHours);
      genre.hoursGames++;
    }
    if (game.n > 0 && Number.isFinite(Number(game.raw))) {
      genre.ratedGames++;
      genre.scoreSum += Number(game.raw);
    }
  }
  const genres = [...genreMap.values()].map((genre) => ({
    genre: genre.genre,
    games: genre.games,
    hours: r2(genre.hours),
    hoursGames: genre.hoursGames,
    ratedGames: genre.ratedGames,
    avg: genre.ratedGames ? r2(genre.scoreSum / genre.ratedGames) : null,
  })).sort((a, b) => a.genre.localeCompare(b.genre));

  const timelineMap = new Map();
  const addYear = (year, field) => {
    if (year == null) return;
    if (!timelineMap.has(year)) timelineMap.set(year, { year, started: 0, finished: 0 });
    timelineMap.get(year)[field]++;
  };
  const startEligible = games.filter((game) => game.status !== 'backlog');
  const finishEligible = games.filter((game) => game.status === 'finished');
  for (const game of startEligible) addYear(yearOf(game.started), 'started');
  for (const game of finishEligible) addYear(yearOf(game.finished), 'finished');

  return {
    statusCounts,
    genres,
    genreCoverage: {
      games: genres.reduce((sum, genre) => sum + genre.games, 0),
      hoursGames: genres.reduce((sum, genre) => sum + genre.hoursGames, 0),
      ratedGames: genres.reduce((sum, genre) => sum + genre.ratedGames, 0),
    },
    timeline: [...timelineMap.values()].sort((a, b) => a.year - b.year),
    timelineCoverage: {
      started: startEligible.filter((game) => yearOf(game.started) != null).length,
      startEligible: startEligible.length,
      finished: finishEligible.filter((game) => yearOf(game.finished) != null).length,
      finishEligible: finishEligible.length,
    },
    timeVsRating: outcomes
      .filter((game) => game.n > 0 && Number(game.effectiveHours) > 0 && Number.isFinite(Number(game.raw)))
      .map((game) => ({
        id: game.id, name: game.name, status: game.status,
        hours: r2(Number(game.effectiveHours)), rating: r2(Number(game.raw)), n: game.n,
      }))
      .sort((a, b) => a.hours - b.hours),
  };
}
