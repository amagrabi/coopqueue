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

/**
 * Below this, a tag preference is a coincidence rather than a taste.
 *
 * Raised 2 -> 3 when three Early Access games read as a taste, and 3 -> 4 once the
 * evidence base doubled: reading `steam_apps` as a second tag home (migration 031)
 * took group 1 from 58 tagged rated games to 93, and a cutoff that was right for 58
 * is loose for 93. At 3 the group's top preference came back as **Pirates, +0.70
 * off three games**, which put a pirate MMO at number one; at 4 it is gone and the
 * likes are Difficult (n=10), Puzzle (n=9), Co-op Campaign (n=4), Souls-like (n=8).
 *
 * It costs nothing measurable. Leave-one-out over the group's own ratings scores
 * 0.195 at 3 and 0.194 at 4 — and the bootstrap interval on either is about
 * [-0.02, 0.39], so anything in that range is noise, not an improvement. **Do not
 * read small differences in that number as evidence**; an earlier pass here quoted
 * a table of them as though they meant something. Judge changes to this constant on
 * whether the likes list is backed by real evidence, and only use the correlation
 * to catch a change that makes things clearly worse — which 6 and 8 do (0.185,
 * 0.131), as the tag set gets thin enough for single matches to swing a candidate.
 *
 * 5 was rejected on output, not arithmetic: it drops Co-op Campaign, which is a
 * real signal for a co-op group, and lets the far more generic Casual (n=12) back
 * into the top four.
 *
 * Safe for a group that has barely started. Simulated by sampling group 1's history
 * down: at 8 rated games this still ranks 327 of 362 catalogue rows (342 at a
 * threshold of 3), because tags are numerous and overlap heavily. A threshold that
 * scaled with history size was considered and dropped — a fixed 4 behaves well from
 * 8 rated games to 93, so the complexity buys nothing.
 */
export const TAG_MIN_GAMES = 4;

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
/**
 * Fewer rated games than this and the group has not demonstrated a taste yet.
 *
 * Was 5, which was far too generous and had never been measured. Train on k of
 * group 1's rated games and predict the rest, over 60 random splits, and the
 * ranking does not track taste at all until the history is large:
 *
 *   rated games   10      15      20      30      45      60
 *   correlation  -0.01   -0.03   -0.01    0.01    0.07    0.12
 *
 * At 5 rated games a group was shown a fit column and told it was "ranked against
 * what you like". It was noise wearing a label. 20 is the floor for claiming
 * anything at all; `SETTLED_HISTORY` is where it starts being worth trusting.
 *
 * Measured on one group, because group 1 is the only one with ratings — every
 * other workspace here has imported a library and rated nothing. So read this as
 * one taste profile at varying library sizes, not as a universal constant, and
 * re-measure once a second group has a history.
 */
export const MIN_HISTORY = 20;
/**
 * Above this the ranking is worth presenting without a caveat; between MIN_HISTORY
 * and here it is ordered by taste but still mostly noise, so the UI says so rather
 * than quietly implying the number means as much as it will later.
 */
export const SETTLED_HISTORY = 45;

/**
 * A prior on Steam's own verdict, subtracted from a candidate's rank.
 *
 * Deliberately one-sided: zero for everything Steam likes, growing only at the bad
 * end. It is a prior and not a fitted signal, and the distinction matters, because
 * the fitted version cannot be measured here. Group 1 has rated 37 Very Positive
 * games, 11 Overwhelmingly Positive, 8 Mostly Positive, 6 Mixed and **nothing
 * worse** — so "does Steam's verdict predict our score" came back as r = 0.019 on a
 * sample containing essentially no badly-reviewed games. That is range restriction,
 * not evidence of no effect; an earlier pass here read it as the latter.
 *
 * What is observable is that weak-verdict games do reach the top: hololive Dreams
 * (Mixed) ranked 5th and Lords of the Fallen (Mixed) 13th before this existed.
 * With these values they fall to 8th and 34th, and group 1's leave-one-out score is
 * unmoved (0.194 -> 0.200), which is exactly what should happen when a group has
 * never rated a game the prior applies to.
 *
 * Unlike POP_WEIGHT this is NOT held below the resolution of the displayed fit: it
 * is meant to reorder genuine ties, because "well reviewed" is a real reason to
 * prefer one of two equally good-looking matches. Fits cluster tightly in the
 * middle of the list, so 0.05 moves a game a few places at the top and ~20 in the
 * middle. Applied in taste mode only — see the popularity branch.
 */
export const REVIEW_PRIOR = {
  'Overwhelmingly Positive': 0,
  'Very Positive': 0,
  Positive: 0,
  'Mostly Positive': 0,
  Mixed: 0.05,
  'Mostly Negative': 0.15,
  Negative: 0.20,
  'Very Negative': 0.30,
  'Overwhelmingly Negative': 0.30,
};
const reviewPrior = (hint) => REVIEW_PRIOR[hint] ?? 0;
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
      /* No review prior here. This branch promises the popularity order and says so
         in the UI; quietly reordering it on quality would make that label untrue,
         and the card shows each game's verdict anyway. */
      games: candidates.slice().sort(
        (a, b) => (a.popularity_rank ?? 1e9) - (b.popularity_rank ?? 1e9)),
      likes: [], dislikes: [],
      ratedGames: history.length, needed: MIN_HISTORY, settled: false,
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
    /* The review prior is subtracted from the DISPLAYED number too, unlike the
       popularity tiebreak. It is big enough to reorder the list, so leaving it out
       of the column would print 0.22 above 0.26 and read as broken — the exact
       failure POP_WEIGHT is sized to avoid. So `fit` is the score that ranked the
       card, and the Steam verdict shown beside it is why it is lower than the tags
       alone would suggest. */
    const prior = reviewPrior(c.review_hint);
    const shown = fit == null ? null : fit - prior;
    return {
      ...c,
      fit: shown == null ? null : round(shown),
      // Reasons are ranked the same way the fit is, so the card explains the
      // ranking it actually got rather than naming the most generic match.
      why: hits.filter(([, v]) => v.value > 0)
        .sort((a, b) => b[1].value * b[2] - a[1].value * a[2]).slice(0, 2).map(([t]) => t),
      // Untasted candidates sort below every ranked one rather than among them.
      // The prior still applies there, so an unrecognised game Steam dislikes sinks
      // below an unrecognised game Steam likes.
      _rank: (shown == null ? -99 - prior : shown) - popular,
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
    ratedGames: history.length,
    needed: MIN_HISTORY,
    // Ordered by taste, but say whether that ordering has earned any confidence.
    settled: history.length >= SETTLED_HISTORY,
  };
}
