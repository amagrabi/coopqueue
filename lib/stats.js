import { completionEvidence } from './completion.js';

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

const parseUnlocked = (value) => {
  try { return Array.isArray(value) ? value : JSON.parse(value || '[]'); }
  catch { return []; }
};

const median = (values) => {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** Personal-only summaries shared by production and the local UI harness. */
export function buildPersonalStats(games, achievementRows = [], now = Date.now()) {
  const outcomes = games.filter((game) => PLAYED_OUTCOMES.has(game.status));
  const finishedHours = games.filter((game) => game.status === 'finished' && Number(game.effectiveHours) > 0)
    .map((game) => Number(game.effectiveHours));

  const ratingMap = new Map();
  for (const game of games) {
    if (!(game.n > 0) || !Number.isFinite(Number(game.raw))) continue;
    const score = Number(game.raw);
    ratingMap.set(score, (ratingMap.get(score) || 0) + 1);
  }

  const hourBands = [
    { label: 'Under 5h', min: 0, max: 5 },
    { label: '5–20h', min: 5, max: 20 },
    { label: '20–50h', min: 20, max: 50 },
    { label: '50–100h', min: 50, max: 100 },
    { label: '100h+', min: 100, max: Infinity },
  ].map((band) => ({
    label: band.label,
    count: games.filter((game) => Number(game.effectiveHours) > 0
      && Number(game.effectiveHours) >= band.min && Number(game.effectiveHours) < band.max).length,
  }));

  const byApp = new Map(games.filter((game) => game.steam_appid)
    .map((game) => [Number(game.steam_appid), game]));
  const achievementGames = achievementRows.map((row) => {
    const game = byApp.get(Number(row.appid));
    const unlocked = parseUnlocked(row.unlocked);
    return game ? {
      id: game.id, name: game.name, appid: Number(row.appid), unlocked,
      achieved: Math.max(0, Number(row.achieved) || 0), total: Math.max(0, Number(row.total) || 0),
    } : null;
  }).filter(Boolean);

  const recentUnlocks = achievementGames.flatMap((game) => game.unlocked.map((achievement) => ({
    gameId: game.id, game: game.name, name: achievement.name || achievement.key || 'Achievement',
    unlocktime: Number(achievement.unlocktime) || 0,
  }))).filter((achievement) => achievement.unlocktime > 0)
    .sort((a, b) => b.unlocktime - a.unlocktime).slice(0, 5);

  const completionSuggestions = achievementGames.map((progress) => {
    const game = byApp.get(progress.appid);
    if (!game || game.status !== 'sampled') return null;
    const evidence = completionEvidence(progress.appid, progress.unlocked);
    return evidence ? { id: game.id, name: game.name, evidence: evidence.label } : null;
  }).filter(Boolean);

  const hoursGames = games.filter((game) => Number(game.effectiveHours) > 0);
  const ratedHoursGames = hoursGames.filter((game) => game.n > 0);
  const staleBefore = Math.floor((now - 180 * 86400 * 1000) / 1000);
  const biggestTimeSink = hoursGames.slice().sort((a, b) => b.effectiveHours - a.effectiveHours)[0];
  const favoriteShort = ratedHoursGames.filter((game) => game.effectiveHours <= 12)
    .sort((a, b) => b.raw - a.raw || a.effectiveHours - b.effectiveHours)[0];

  return {
    completion: {
      outcomes: outcomes.length,
      finished: games.filter((game) => game.status === 'finished').length,
      rate: outcomes.length ? Math.round((games.filter((game) => game.status === 'finished').length / outcomes.length) * 100) : null,
      medianFinishedHours: finishedHours.length ? r2(median(finishedHours)) : null,
      sampled: games.filter((game) => game.status === 'sampled').length,
    },
    ratingDistribution: [...ratingMap.entries()].sort((a, b) => a[0] - b[0])
      .map(([score, count]) => ({ score, count })),
    hourBands,
    backlog: {
      unplayed: games.filter((game) => game.status === 'backlog' && !(Number(game.effectiveHours) > 0)).length,
      unratedPlayed: games.filter((game) => (PLAYED_OUTCOMES.has(game.status) || game.status === 'playing') && !(game.n > 0)).length,
      stalePlaying: games.filter((game) => game.status === 'playing'
        && (!game.personal_last_played || Number(game.personal_last_played) < staleBefore)).length,
    },
    records: {
      biggestTimeSink: biggestTimeSink ? {
        id: biggestTimeSink.id, name: biggestTimeSink.name, hours: r2(biggestTimeSink.effectiveHours),
      } : null,
      favoriteShort: favoriteShort ? {
        id: favoriteShort.id, name: favoriteShort.name,
        hours: r2(favoriteShort.effectiveHours), rating: r2(favoriteShort.raw),
      } : null,
    },
    achievements: {
      syncedGames: achievementGames.length,
      unlocked: achievementGames.reduce((sum, game) => sum + game.achieved, 0),
      total: achievementGames.reduce((sum, game) => sum + game.total, 0),
      perfectGames: achievementGames.filter((game) => game.total > 0 && game.achieved === game.total).length,
      nearComplete: achievementGames.filter((game) => game.total > 0 && game.achieved < game.total
        && game.achieved / game.total >= 0.6)
        .sort((a, b) => (b.achieved / b.total) - (a.achieved / a.total)).slice(0, 5)
        .map((game) => ({ id: game.id, name: game.name, achieved: game.achieved, total: game.total })),
      recentUnlocks,
    },
    completionSuggestions,
  };
}
