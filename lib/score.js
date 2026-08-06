
/** Per-person mean and population standard deviation. */
export function calibrate(ratings) {
  const by = new Map();
  for (const r of ratings) {
    if (!by.has(r.steam_id)) by.set(r.steam_id, []);
    by.get(r.steam_id).push(r.score);
  }
  const out = new Map();
  for (const [id, xs] of by) {
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const varc = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
    // Guard: someone who has rated everything 8 has zero spread; fall back to
    // the global spread rather than dividing by zero.
    out.set(id, { mean, sd: Math.sqrt(varc) || 1, n: xs.length });
  }
  return out;
}

export function globalStats(ratings) {
  if (!ratings.length) return { mean: 7, sd: 1.3 };
  const xs = ratings.map((r) => r.score);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length) || 1;
  return { mean, sd };
}

/**
 * Score one game.
 * @param votes  [{steam_id, score}]
 * @returns {raw, n, spread} — raw is null when nobody has voted.
 */
/**
 * The group's score for one game: the plain mean of the scores given, and how
 * many gave one.
 *
 * There used to be a second, calibrated-and-shrunk number here, and the owner
 * removed it deliberately. The argument that killed it: a rating is a judgement,
 * not a measurement to be corrected. Somebody who has only ever given 8-10 may
 * simply have only played good games, and may well hand the next one a 4 — so
 * rescaling their scores against their own history assumes a rater bias that may
 * not exist, and produces a number nobody can reconstruct from the column next
 * to it. `n` is still returned so thin evidence stays visible; the UI shows it
 * rather than silently discounting it.
 *
 * `calibrate()` above is still used, but only to *describe* people on the Stats
 * page. It no longer decides any ranking.
 */
export function scoreGame(votes) {
  if (!votes.length) return { raw: null, n: 0, spread: null };
  const scores = votes.map((v) => v.score);
  const n = votes.length;
  return {
    raw: round(scores.reduce((a, b) => a + b, 0) / n),
    n,
    spread: n >= 2 ? round(Math.max(...scores) - Math.min(...scores)) : null,
  };
}

const round = (x) => Math.round(x * 100) / 100;

/**
 * Can the whole group actually play this together?
 * @param need how many people have to fit — the group's own headcount, not a
 *             hardcoded 4, so a trio or a group of six gets the right answer.
 */
export function viability(game, need = 4) {
  const mp = game.max_players;
  if (mp == null) return { ok: null, label: 'unknown', reason: 'Player count not set yet' };
  if (mp >= need) return { ok: true, label: `${mp}p`, reason: null };
  // Couch-only and one-copy games still work for a group with the right setup.
  if (game.coop_note && /remote play|only the host|manual/i.test(game.coop_note))
    return { ok: 'workaround', label: `${mp}p`, reason: game.coop_note };
  return {
    ok: false,
    label: `${mp}p`,
    reason: game.coop_note || `Caps out at ${mp} player${mp === 1 ? '' : 's'}, and there are ${need} of you`,
  };
}
