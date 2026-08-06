// Which 4 of the 8 validated --series-* colours are most separable, for normal
// vision AND for the two common colour-vision deficiencies?
// CIELAB ΔE76 + Viénot(1999) dichromat simulation in linear RGB.

const SERIES = {
  1: '#3987e5', 2: '#d95926', 3: '#199e70', 4: '#c98500',
  5: '#d55181', 6: '#008300', 7: '#9085e9', 8: '#e66767',
};
const NAME = { 1: 'blue', 2: 'orange', 3: 'aqua', 4: 'yellow',
               5: 'magenta', 6: 'green', 7: 'violet', 8: 'red' };

const hex2rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function linToLab([r, g, b]) {
  const X = 0.4124 * r + 0.3576 * g + 0.1805 * b;
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const Z = 0.0193 * r + 0.1192 * g + 0.9505 * b;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(X / 0.95047), fy = f(Y), fz = f(Z / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
const dE = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// Viénot LMS transform
const rgb2lms = ([r, g, b]) => [
  17.8824 * r + 43.5161 * g + 4.11935 * b,
  3.45565 * r + 27.1554 * g + 3.86714 * b,
  0.0299566 * r + 0.184309 * g + 1.46709 * b,
];
const lms2rgb = ([L, M, S]) => [
  0.080944 * L - 0.130504 * M + 0.116721 * S,
  -0.0102485 * L + 0.0540194 * M - 0.113615 * S,
  -0.000365294 * L - 0.00412163 * M + 0.693513 * S,
];
const clamp = (x) => Math.min(1, Math.max(0, x));

function simulate(linRgb, kind) {
  const [L, M, S] = rgb2lms(linRgb);
  const sim = kind === 'deuteranopia'
    ? [L, 0.494207 * L + 1.24827 * S, S]
    : [2.02344 * M - 2.52581 * S, M, S];      // protanopia
  return lms2rgb(sim).map(clamp);
}

const lin = {}, lab = { normal: {}, deuteranopia: {}, protanopia: {} };
for (const [k, hex] of Object.entries(SERIES)) {
  lin[k] = hex2rgb(hex).map(toLinear);
  lab.normal[k] = linToLab(lin[k]);
  for (const kind of ['deuteranopia', 'protanopia']) {
    lab[kind][k] = linToLab(simulate(lin[k], kind));
  }
}

const worstPair = (set) => {
  let worst = Infinity, pair = null;
  for (let i = 0; i < set.length; i++) {
    for (let j = i + 1; j < set.length; j++) {
      for (const kind of ['normal', 'deuteranopia', 'protanopia']) {
        const d = dE(lab[kind][set[i]], lab[kind][set[j]]);
        if (d < worst) { worst = d; pair = [set[i], set[j], kind]; }
      }
    }
  }
  return { worst, pair };
};

console.log('CURRENT first-four assignment (members sort alphabetically):');
const current = ['1', '2', '3', '4'];
const cw = worstPair(current);
console.log('  ', current.map((k) => NAME[k]).join(', '));
console.log(`   worst pair: ${NAME[cw.pair[0]]} vs ${NAME[cw.pair[1]]} = ΔE ${cw.worst.toFixed(1)} (${cw.pair[2]})`);
console.log('   Dave=orange vs Pat=yellow specifically:');
for (const kind of ['normal', 'deuteranopia', 'protanopia']) {
  console.log(`     ${kind.padEnd(13)} ΔE ${dE(lab[kind]['2'], lab[kind]['4']).toFixed(1)}`);
}

// Exhaustive search over 4-subsets, maximising the worst pairwise ΔE.
const keys = Object.keys(SERIES);
let best = null;
for (let a = 0; a < keys.length; a++)
 for (let b = a + 1; b < keys.length; b++)
  for (let c = b + 1; c < keys.length; c++)
   for (let d = c + 1; d < keys.length; d++) {
     const set = [keys[a], keys[b], keys[c], keys[d]];
     const w = worstPair(set);
     if (!best || w.worst > best.w.worst) best = { set, w };
   }
console.log('\nBEST 4-subset of the existing validated palette:');
console.log('  ', best.set.map((k) => `series-${k} (${NAME[k]})`).join(', '));
console.log(`   worst pair: ${NAME[best.w.pair[0]]} vs ${NAME[best.w.pair[1]]} = ΔE ${best.w.worst.toFixed(1)} (${best.w.pair[2]})`);
console.log(`   improvement over current: ΔE ${cw.worst.toFixed(1)} -> ${best.w.worst.toFixed(1)}`);

// Also report a robust order for up to 8, greedily maximising min distance.
const order = ['1'];
while (order.length < 8) {
  let pick = null, pickScore = -1;
  for (const k of keys) {
    if (order.includes(k)) continue;
    const s = worstPair([...order, k]).worst;
    if (s > pickScore) { pickScore = s; pick = k; }
  }
  order.push(pick);
}
console.log('\nGreedy order for 1..8 members (each prefix is the best it can be):');
console.log('  ', order.map((k) => `${k}:${NAME[k]}`).join('  '));
for (let n = 2; n <= 8; n++) {
  console.log(`   first ${n}: worst ΔE ${worstPair(order.slice(0, n)).worst.toFixed(1)}`);
}
