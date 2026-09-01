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
 * Method: a candidate is scored by how much the group liked the games it most
 * resembles.
 *   1. Every game becomes a vector over its tags, each weighted by IDF, so a rare
 *      tag counts for more than one on half the catalogue.
 *   2. Similarity between two games is the cosine of those vectors.
 *   3. A candidate's fit is the similarity-weighted mean of `NEIGHBOURS` nearest
 *      rated games' scores, relative to the group's own average, shrunk toward
 *      zero when even the nearest ones are not very near.
 *   4. Popularity breaks ties, weighted small enough that it cannot reorder a
 *      visible difference in fit (POP_WEIGHT), and a weak Steam verdict is
 *      penalised (REVIEW_PRIOR).
 *
 * **This replaced a per-tag average**, which learned one number per tag and scored
 * a candidate by the mean of its tags' numbers. That model could not use a tag it
 * had seen fewer than TAG_MIN_GAMES times — which is exactly the rare, informative
 * ones IDF weights highest. Barotrauma was ranked on Strategy (−0.45) and Horror
 * (−0.15) and buried at #259 while its actual signal, Submarine (idf 5.98) and
 * Underwater (idf 5.29), carried no preference at all; the group had scored it 7.5.
 * Comparing whole games instead needs no threshold: one rated submarine game is
 * enough to recognise another. Barotrauma now ranks #80, "because you rated
 * Subnautica 2 and Sunkenland".
 *
 * Measured on group 1, holding each rated game out in turn:
 *
 *                        leave-one-out r      where held-out games land (median)
 *                                            loved   liked    ok    meh   1st page
 *   per-tag average    0.193 [-0.02, 0.39]    28%     50%    43%    49%    4 / 52
 *   nearest games      0.270 [ 0.04, 0.46]    15%     21%    40%    41%    8 / 52
 *
 * The correlations overlap, so that is not the argument. Two things are: this is
 * the first configuration measured here whose interval **excludes zero**, and the
 * retrieval order is finally monotonic — games the group loved place high, games it
 * disliked place low, where the old model put "liked" (50%) below "meh" (49%).
 *
 * It is a taste-matching heuristic, not a prediction, and it names the games that
 * drove each result so the UI can show its reasoning instead of asserting a rank
 * people have to take on faith. "Because you rated Subnautica 2" is also a better
 * explanation than "matches your taste for Survival" — it is checkable.
 *
 * Tag preferences are still computed, but only for the `likes` / `dislikes` summary
 * the UI shows. They no longer decide any ranking.
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
const idf = (df, n) => Math.max(IDF_FLOOR, Math.log(n / Math.max(1, df)));
/**
 * A tag on every candidate would otherwise weigh exactly nothing, which zeroes a
 * vector made only of common tags and makes its similarity undefined. A small floor
 * keeps such a game comparable — barely — rather than unrankable.
 */
const IDF_FLOOR = 0.1;

/**
 * How many of the most similar rated games decide a candidate's fit.
 *
 * Swept against the group's own ratings: 5 scored 0.206, **10 scored 0.270**, 20
 * scored 0.224, 40 scored 0.200. Too few and one coincidental neighbour swings the
 * result; too many and the group's whole library averages back out to its mean,
 * which is what the per-tag model effectively did.
 */
export const NEIGHBOURS = 10;

/**
 * Shrinkage on the neighbourhood's total similarity. A candidate whose ten nearest
 * games are all faint matches is a guess, and should sit near zero rather than
 * inheriting a strong opinion from a weak resemblance. Measured: 1 beat 3 at every
 * neighbourhood size tried.
 */
export const SIM_SHRINK = 1;

/**
 * How hard a candidate is penalised for repeating something already suggested.
 *
 * Without it the list clusters, because the neighbourhood model gives every game
 * near one beloved cluster a high fit. Measured on group 1: 7 of the top 20 had
 * Elden Ring as their nearest rated game and 5 had Big Walk, and mean pairwise
 * similarity inside the top 10 was 0.105 against 0.053 for twenty-four random
 * catalogue games — twice as same-y as chance.
 *
 * Standard greedy diversification: repeatedly take whichever remaining candidate
 * maximises `fit − DIVERSITY × (its closest resemblance to anything already
 * picked)`. At 0.15 top-10 pairwise similarity falls to 0.086 and mean top-10 fit
 * from 0.473 to 0.441. Raising it to 0.25 buys no further variety (still 0.086) and
 * costs more fit, so 0.15 is where the curve flattens.
 *
 * **The penalty is subtracted from the displayed `fit`, like REVIEW_PRIOR and
 * unlike POP_WEIGHT.** Diversification reorders by construction, so leaving it out
 * of the column would print a higher number below a lower one — the failure this
 * file has now avoided three times. The consequence is that `fit` means "how well
 * it suits you, less how much it repeats what is already above it", and a game's
 * number therefore depends on what outranked it. That is the honest reading of a
 * diversified list.
 */
export const DIVERSITY = 0.15;
/**
 * Diversification is O(window²) in cosines and only the first pages are ever read,
 * so it is applied to the head and the tail keeps plain fit order. 60 covers two
 * full pages at PAGE = 24 and costs at most ~3,600 comparisons.
 */
export const DIVERSITY_WINDOW = 60;
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
 * prefer one of two equally good-looking matches. Applied in taste mode only — see
 * the popularity branch.
 *
 * **These values are calibrated to the spread of `fit`, so they move when the model
 * does.** They were 0.05 / 0.15 / 0.20 / 0.30 against the per-tag average, whose
 * top-to-page-24 gap was 0.16. The nearest-games model works in rating points and
 * that gap is 0.38, so the same ladder would have been quietly neutered to a third
 * of its intended force; it is scaled by ~2.4 to keep the effect the owner chose —
 * a Mixed game slips a few places near the top, a genuinely disliked one is buried.
 * If the fit scale changes again, rescale these with it rather than leaving them.
 */
export const REVIEW_PRIOR = {
  'Overwhelmingly Positive': 0,
  'Very Positive': 0,
  Positive: 0,
  'Mostly Positive': 0,
  Mixed: 0.12,
  'Mostly Negative': 0.35,
  Negative: 0.45,
  'Very Negative': 0.70,
  'Overwhelmingly Negative': 0.70,
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
 * @param history    [{ appid, name, score }] — the group's mean score per rated game
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
        (a, b) => (b.review_count ?? -1) - (a.review_count ?? -1) || a.appid - b.appid),
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

  /* An IDF-weighted unit vector per game, built once. Similarity is the cosine of
     two of these, so tags shared by both count in proportion to how rare they are —
     two submarine games score far higher than two games that merely share
     "Multiplayer". NON_TASTE is dropped here too: how a game ships is not what it
     resembles. */
  const vectorOf = (tags) => {
    const m = new Map();
    for (const t of new Set(tags)) if (!NON_TASTE.has(t)) m.set(t, weightOf(t));
    let norm = 0;
    for (const w of m.values()) norm += w * w;
    return { m, norm: Math.sqrt(norm) || 1 };
  };
  const cosine = (a, b) => {
    // Walk the shorter vector; tag lists are ~12 long, but this runs
    // candidates × history times and that product is the whole cost of ranking.
    const [small, big] = a.m.size < b.m.size ? [a, b] : [b, a];
    let dot = 0;
    for (const [t, w] of small.m) {
      const other = big.m.get(t);
      if (other) dot += w * other;
    }
    return dot / (a.norm * b.norm);
  };

  // The group's rated games, vectorised once and reused for every candidate.
  const rated = history
    .map((g) => ({ ...g, vec: vectorOf(tagsFor.get(g.appid) || []) }))
    .filter((g) => g.vec.m.size);

  const round = (x) => Math.round(x * 100) / 100;
  const games = candidates.map((c) => {
    const cv = vectorOf(asTags(c.tags));
    /* Nearest rated games, most similar first. Only the top NEIGHBOURS count: a
       long tail of faint resemblances just drags every candidate back toward the
       group's average, which is the failure the per-tag model had. */
    const near = [];
    if (cv.m.size) {
      for (const g of rated) {
        const s = cosine(cv, g.vec);
        if (s > 0) near.push({ s, g });
      }
      near.sort((a, b) => b.s - a.s);
    }
    const top = near.slice(0, NEIGHBOURS);
    const wsum = top.reduce((a, x) => a + x.s, 0);
    const fit = wsum > 0
      ? (top.reduce((a, x) => a + x.s * (x.g.score - groupMean), 0) / wsum)
        * (wsum / (wsum + SIM_SHRINK))
      : null;
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
      /* The two games that drove it, named. This is the reason the ranking is
         actually built on, and unlike "matches your taste for Survival" it is
         checkable — you either liked Subnautica 2 or you did not. Only positive
         neighbours are worth naming: "similar to a game you disliked" explains a
         low rank nobody is looking at. */
      why: top.filter((x) => x.g.score > groupMean).slice(0, 2).map((x) => x.g.name),
      // Untasted candidates sort below every ranked one rather than among them.
      // The prior still applies there, so an unrecognised game Steam dislikes sinks
      // below an unrecognised game Steam likes.
      _rank: (shown == null ? -99 - prior : shown) - popular,
      _vec: cv,
    };
  }).sort((a, b) => b._rank - a._rank);

  /* Break up runs of near-identical suggestions. See DIVERSITY: the neighbourhood
     model gives everything near one beloved cluster a high fit, so without this the
     first page is the same game five times. */
  const head = games.slice(0, DIVERSITY_WINDOW);
  const spread = [];
  while (head.length) {
    let bestAt = 0;
    let bestValue = -Infinity;
    let bestPenalty = 0;
    for (let i = 0; i < head.length; i++) {
      let closest = 0;
      for (const chosen of spread) closest = Math.max(closest, cosine(head[i]._vec, chosen._vec));
      const penalty = DIVERSITY * closest;
      const value = (head[i].fit ?? -99) - penalty;
      if (value > bestValue) { bestValue = value; bestAt = i; bestPenalty = penalty; }
    }
    const picked = head.splice(bestAt, 1)[0];
    spread.push(picked.fit == null ? picked : { ...picked, fit: round(picked.fit - bestPenalty) });
  }
  const ordered = spread.concat(games.slice(DIVERSITY_WINDOW))
    .map(({ _rank, _vec, ...g }) => g);

  const summary = (list) => list.map(([tag, v]) => ({ tag, points: round(v.value), n: v.n }));
  const byValue = [...pref.entries()].sort((a, b) => b[1].value - a[1].value);

  return {
    basis: 'taste',
    games: ordered,
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
