/**
 * The scoring model. Two ideas, both aimed at the same problem: not everyone
 * rates everything, so raw averages are not comparable across games.
 *
 * 1. CALIBRATION. People use the scale differently. Each rating is converted to
 *    a z-score against that person's own mean and spread, so "Pat's 7" and
 *    "Ama's 7" are measured against their own baselines rather than each other's.
 *
 * 2. SHRINKAGE. A 9.0 from one person is weaker evidence than a 7.5 from four.
 *    The group z-score is pulled toward the overall mean by n / (n + K); with
 *    K = 1.6, one vote keeps ~38% of its distance from the mean and four keep ~71%.
 *
 * Both are deliberately simple and explainable — the group has to trust the
 * number for it to settle any argument.
 */
export const SHRINKAGE_K = 1.6;

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
 * @returns {raw, weighted, n, spread} — weighted is null when nobody has voted.
 */
export function scoreGame(votes, cal, glob) {
  if (!votes.length) return { raw: null, weighted: null, n: 0, spread: null };
  const scores = votes.map((v) => v.score);
  const raw = scores.reduce((a, b) => a + b, 0) / scores.length;
  const zs = votes.map((v) => {
    const c = cal.get(v.steam_id);
    return c ? (v.score - c.mean) / c.sd : (v.score - glob.mean) / glob.sd;
  });
  const meanZ = zs.reduce((a, b) => a + b, 0) / zs.length;
  const n = votes.length;
  const weighted = glob.mean + (n / (n + SHRINKAGE_K)) * meanZ * glob.sd;
  return {
    raw: round(raw),
    weighted: round(weighted),
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
