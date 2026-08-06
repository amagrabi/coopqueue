/**
 * Rank catalogue games against what a group has actually liked.
 *
 * A pure function over data the caller has already fetched, for the same reason
 * `lib/score.js` is one: the Pages Function, the test harness and
 * `test/isolation.mjs` all need this ranking, and a second copy of it would drift
 * from the first. Nothing here touches D1 or knows about groups — the tenancy
 * check happens in the route that calls it.
 *
 * The signal is Steam **user tags**, not Steam's `genre` field. Genre cannot
 * distinguish anything useful: 235 of the 337 catalogue rows are simply "Action".
 * Tags are specific — "Survival", "Roguelike", "Farming Sim" — and close to the
 * vocabulary this group already used in its own spreadsheet.
 *
 * Method, kept simple enough that the UI can explain it in one sentence:
 *   1. For each tag, average the group's scores for library games carrying it and
 *      subtract the group's overall mean. That is a preference in points: "you rate
 *      Survival 0.6 above your own average".
 *   2. Shrink each preference toward zero by n/(n+SHRINK), so a tag seen twice
 *      cannot outweigh one seen ten times.
 *   3. A candidate scores the mean preference of its tags, with popularity as a
 *      tiebreak weighted small enough that it cannot reorder a visible difference
 *      in fit — see POP_WEIGHT, where the magnitude is the whole point.
 *
 * It is a taste-matching heuristic, not a prediction, and it returns the tags that
 * drove each result so the UI can show its reasoning instead of asserting a rank
 * people have to take on faith.
 */

/** Below this, a tag preference is a coincidence rather than a taste. */
export const TAG_MIN_GAMES = 3;

/**
 * Tags that describe how a game is sold, shipped or framed — not what it plays like.
 *
 * These are dropped before anything else, because they are the tags most likely to
 * correlate with a group's scores for reasons that have nothing to do with taste.
 * Both groups here were found by reading the output against real data:
 *
 *  - **Release state and price model.** "Early Access" came out as group 1's
 *    second-strongest preference at +0.51 and drove five of its top ten, filling the
 *    list with unreleased games nobody has heard of (Windrose, Species: Unknown,
 *    SpaceCraft). Three of their rated games carry it and happen to be good; that is
 *    the whole of the "signal".
 *  - **Camera perspective.** "Third Person" scored +0.29 off four games and pulled in
 *    Need for Speed Payback and SnowRunner for a group whose actual taste is
 *    Souls-likes. Where the camera sits is presentation, not genre.
 *  - **PvP genres**, because the catalogue is filtered to co-op. "Wingspan — matches
 *    your taste for Building and PvP" is incoherent as a reason for a co-op
 *    suggestion, whatever the arithmetic says.
 *
 * Still deliberately narrow: genre and mechanic tags stay. Merely *generic* tags do
 * not need listing here — IDF already handles them (see `idf`).
 */
const NON_TASTE = new Set([
  // shipping state / business model
  'Early Access', 'Free to Play', 'Demo', 'Software', 'Utilities',
  'Steam Machine', 'Steam Deck Verified', 'Remote Play Together',
  // camera and presentation
  'Third Person', 'First-Person', 'Top-Down', 'Isometric', '2D', '3D', 'VR',
  // PvP, which the co-op filter has already excluded from the catalogue
  'PvP', 'Battle Royale', 'Competitive', 'Arena Shooter', 'eSports', 'MOBA',
  'Hero Shooter',
]);

/**
 * How much one tag's preference counts, by how rare the tag is.
 *
 * Plain inverse document frequency over the candidate set. Without it every tag on a
 * candidate counts equally, and the generic ones win by sheer commonness: group 1's
 * suggestions were dominated by "Exploration" and "Open World", which sit on a large
 * share of the catalogue and so say almost nothing, while "Souls-like" — on a handful
 * of games and the group's single strongest signal — counted exactly the same.
 * Four driving simulators reached the top ten that way.
 *
 * log(N/df) is 0 for a tag on every game and grows as a tag gets rarer, so specific
 * tags decide the ranking and common ones only break ties. Clamped at 0 so a tag
 * appearing on more rows than the candidate set (possible when candidates are
 * filtered) cannot go negative and start subtracting.
 */
const idf = (df, n) => Math.max(0, Math.log(n / Math.max(1, df)));
/** Shrinkage constant: damps tags backed by thin evidence. */
export const SHRINK = 3;
/** Fewer rated games than this and the group has not demonstrated a taste yet. */
export const MIN_HISTORY = 5;
/**
 * How much popularity may nudge the order.
 *
 * The magnitude is load-bearing, not taste. The raw popularity term
 * `1 / log10(10 + reviews)` spans about 0.14 to 0.50 across the catalogue, while
 * fit values span roughly ±0.4 — so unweighted it does not break ties, it
 * reorders genuine ones. That produced a list whose own displayed fit ran
 * 0.23, 0.23, 0.25, 0.23, which reads as broken however defensible the ranking is.
 *
 * At 0.02 the term is at most 0.01, below the resolution of the fit shown in the
 * UI, so a visible difference in fit always wins and popularity only separates
 * games that look equally good.
 */
export const POP_WEIGHT = 0.02;

/**
 * @param candidates catalogue rows, each with `tags` as a JSON string or array
 * @param history    [{ appid, score }] — the group's mean score per rated game
 * @param tagsFor    Map<appid, string[]> covering the rated games
 * @returns { basis, games, likes, dislikes, ratedGames, needed }
 */
export function recommend(candidates, history, tagsFor) {
  const asTags = (t) => {
    if (Array.isArray(t)) return t;
    if (typeof t !== 'string') return [];
    try { const p = JSON.parse(t); return Array.isArray(p) ? p : []; } catch { return []; }
  };

  // Not enough history to claim a taste. Popularity order, said out loud, beats a
  // ranking derived from three ratings dressed up as a recommendation.
  if (history.length < MIN_HISTORY) {
    return {
      basis: 'popularity',
      games: candidates.slice().sort(
        (a, b) => (a.popularity_rank ?? 1e9) - (b.popularity_rank ?? 1e9)),
      likes: [], dislikes: [],
      ratedGames: history.length, needed: MIN_HISTORY,
    };
  }

  const groupMean = history.reduce((a, g) => a + g.score, 0) / history.length;

  const agg = new Map();
  for (const g of history) {
    for (const t of tagsFor.get(g.appid) || []) {
      if (NON_TASTE.has(t)) continue;
      if (!agg.has(t)) agg.set(t, { sum: 0, n: 0 });
      const a = agg.get(t);
      a.sum += g.score;
      a.n++;
    }
  }

  const pref = new Map();
  for (const [t, a] of agg) {
    if (a.n < TAG_MIN_GAMES) continue;
    const raw = a.sum / a.n - groupMean;
    pref.set(t, { value: raw * (a.n / (a.n + SHRINK)), n: a.n });
  }

  // How common each tag is across the candidates, for the IDF weight below.
  const df = new Map();
  for (const c of candidates) {
    for (const t of new Set(asTags(c.tags))) df.set(t, (df.get(t) || 0) + 1);
  }
  const N = Math.max(1, candidates.length);
  const weightOf = (t) => idf(df.get(t) || 0, N);

  const round = (x) => Math.round(x * 100) / 100;
  const games = candidates.map((c) => {
    const hits = asTags(c.tags)
      .map((t) => [t, pref.get(t), weightOf(t)])
      .filter(([, v]) => v);
    // Weighted mean, so a rare tag the group loves outweighs three common ones it
    // is mildly warm about. An unweighted mean let "Open World" and "Exploration"
    // outvote "Souls-like" and filled the list with driving simulators.
    const wsum = hits.reduce((a, [, , w]) => a + w, 0);
    const fit = wsum > 0 ? hits.reduce((a, [, v, w]) => a + v.value * w, 0) / wsum : null;
    // A tiebreak, held below the resolution of the fit we display — see POP_WEIGHT.
    const popular = POP_WEIGHT / Math.log10(10 + (c.review_count ?? 0));
    return {
      ...c,
      fit: fit == null ? null : round(fit),
      // Reasons are ranked the same way the fit is, so the card explains the
      // ranking it actually got rather than naming the most generic match.
      why: hits.filter(([, v]) => v.value > 0)
        .sort((a, b) => b[1].value * b[2] - a[1].value * a[2]).slice(0, 2).map(([t]) => t),
      // Untasted candidates sort below every ranked one rather than among them.
      _rank: (fit == null ? -99 : fit) - popular,
    };
  }).sort((a, b) => b._rank - a._rank).map(({ _rank, ...g }) => g);

  const summary = (list) => list.map(([tag, v]) => ({ tag, points: round(v.value), n: v.n }));
  const byValue = [...pref.entries()].sort((a, b) => b[1].value - a[1].value);

  return {
    basis: 'taste',
    games,
    // The strongest and weakest preferences, so the UI can say what it thinks this
    // group likes rather than only ranking silently.
    likes: summary(byValue.filter(([, v]) => v.value > 0).slice(0, 4)),
    dislikes: summary(byValue.filter(([, v]) => v.value < 0).slice(-3).reverse()),
    ratedGames: history.length, needed: MIN_HISTORY,
  };
}
