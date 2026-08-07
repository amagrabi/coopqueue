const FIELDS = ['started', 'finished', 'hours'];
const FIELD_ORDER = new Map(FIELDS.map((field, index) => [field, index]));
const MONTHS = new Map([
  ['Jan', 1], ['Feb', 2], ['Mar', 3], ['Apr', 4], ['May', 5], ['Jun', 6],
  ['Jul', 7], ['Aug', 8], ['Sep', 9], ['Oct', 10], ['Nov', 11], ['Dec', 12],
]);

export const HISTORY_FIELDS = new Set(FIELDS);

/** Steam stores release dates as display text, so only accept the exact form we
 * have measured instead of letting Date.parse make locale-dependent guesses. */
export function releaseDateToIso(value) {
  const match = String(value || '').match(/^(\d{1,2}) ([A-Z][a-z]{2}), (\d{4})$/);
  if (!match) return null;
  const month = MONTHS.get(match[2]);
  if (!month) return null;
  const day = Number(match[1]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const isoFromEpoch = (epoch) => {
  const date = new Date(Number(epoch) * 1000);
  return Number.isNaN(+date) ? null : date.toISOString().slice(0, 10);
};

function achievementBounds(rows) {
  const byApp = new Map();
  for (const row of rows || []) {
    let unlocked;
    try { unlocked = JSON.parse(row.unlocked || '[]'); } catch { unlocked = []; }
    if (!Array.isArray(unlocked)) continue;
    for (const achievement of unlocked) {
      const time = Number(achievement?.unlocktime);
      if (!Number.isFinite(time) || time <= 0) continue;
      const entry = byApp.get(row.appid) || { earliest: time, latest: time };
      entry.earliest = Math.min(entry.earliest, time);
      entry.latest = Math.max(entry.latest, time);
      byApp.set(row.appid, entry);
    }
  }
  return byApp;
}

const later = (a, b) => !a ? b : !b ? a : (a.value >= b.value ? a : b);

/**
 * Build one shared-history cleanup queue for the current member.
 *
 * A rating or an hour of personal Steam time only affects ordering: it says who
 * is most likely to remember, never who is allowed to edit a shared fact. A
 * member who explicitly said "I didn't play this" is excluded altogether.
 */
export function buildHistoryItems(
  games, achievementRows = [], nudgeRows = [], now = Date.now(), options = {}
) {
  const personal = options.mode === 'personal';
  const achievements = achievementBounds(achievementRows);
  const nudges = new Map((nudgeRows || []).map((row) => [`${row.game_id}:${row.field}`, row]));
  const today = new Date(now).toISOString().slice(0, 10);
  const items = [];

  const add = (game, field, suggestion, prompt) => {
    const nudge = nudges.get(`${game.id}:${field}`);
    if (nudge?.state === 'dismissed') return;
    if (nudge?.state === 'snoozed' && Number(nudge.snoozed_until) * 1000 > now) return;
    items.push({
      gameId: game.id,
      game: game.name,
      image: game.header_image || null,
      status: game.status,
      field,
      prompt,
      likely: game.my_rating != null || Number(game.my_minutes || 0) >= 60 || !!game.i_added,
      suggestion,
    });
  };

  for (const game of games || []) {
    if (game.archived_at || game.status === 'backlog' || game.sat_out) continue;
    const bounds = achievements.get(game.steam_appid);
    const release = releaseDateToIso(game.release_date);
    const earliestAchievement = isoFromEpoch(bounds?.earliest);
    const latestAchievement = isoFromEpoch(bounds?.latest);
    const knownEnd = game.finished || game.finished_estimated || null;

    if (!game.started) {
      // An achievement is proof the group had played by this day, not proof that
      // this was day one. Reject evidence that contradicts a known end or release.
      const achievementUsable = earliestAchievement && earliestAchievement <= today
        && (!knownEnd || earliestAchievement <= knownEnd)
        && (!release || earliestAchievement >= release);
      const releaseUsable = release && release <= today && (!knownEnd || release <= knownEnd);
      const suggestion = achievementUsable ? {
        value: earliestAchievement,
        source: 'achievement',
        label: 'Earliest synced achievement',
        detail: personal
          ? 'You had played by this date; your real start may be earlier.'
          : 'Someone had played by this date; the real start may be earlier.',
      } : releaseUsable ? {
        value: release,
        source: 'release-date',
        label: 'Steam release date',
        detail: personal
          ? 'A low-confidence fallback, not necessarily the day you started.'
          : 'A low-confidence fallback, not the date your group necessarily started.',
      } : null;
      add(game, 'started', suggestion, personal
        ? 'When did you first play this?' : 'When did your group first play this?');
    }

    // A currently-playing game's total and last date are still moving. Prompting
    // for either would turn a correct answer stale as soon as the next session ends.
    if (game.status !== 'playing' && game.hours == null) {
      const hours = Number(game.hours_estimated);
      const personalHours = Number(game.my_minutes) / 60;
      const suggestion = personal && Number.isFinite(personalHours) && personalHours > 0 ? {
        value: Math.round(personalHours * 10) / 10,
        source: 'steam-hours',
        label: 'Your Steam playtime',
        detail: 'Lifetime playtime reported by your Steam account.',
      } : Number.isFinite(hours) && hours > 0 && Number(game.hours_participants) >= 2 ? {
        value: hours,
        source: 'steam-hours',
        label: `Steam estimate · ${game.hours_participants} players`,
        detail: 'The smallest lifetime playtime among participants: an upper bound on time together.',
      } : null;
      add(game, 'hours', suggestion, personal
        ? 'Roughly how many hours did you play?' : 'Roughly how many hours did you play together?');
    }

    if (game.status !== 'playing' && !game.finished) {
      let suggestion = game.finished_estimated ? {
        value: game.finished_estimated,
        source: 'steam-last-played',
        label: 'Latest Steam play',
        detail: personal
          ? 'The most recent play date Steam exposes for your account.'
          : 'The most recent play date Steam exposes for anyone in the group.',
      } : null;
      if (latestAchievement && latestAchievement <= today) {
        suggestion = later(suggestion, {
          value: latestAchievement,
          source: 'achievement',
          label: 'Latest synced achievement',
          detail: personal
            ? 'You were still playing by this date; your real last session may be later.'
            : 'Someone was still playing by this date; the real last session may be later.',
        });
      }
      if (suggestion && game.started && suggestion.value < game.started) suggestion = null;
      add(game, 'finished', suggestion, personal
        ? 'When did you last play this?' : 'When did you last play this together?');
    }
  }

  items.sort((a, b) => Number(b.likely) - Number(a.likely)
    || Number(!!b.suggestion) - Number(!!a.suggestion)
    || FIELD_ORDER.get(a.field) - FIELD_ORDER.get(b.field)
    || a.game.localeCompare(b.game));
  return items;
}
