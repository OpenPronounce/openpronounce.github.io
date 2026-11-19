// Small numeric helpers that mirror numpy's defaults (population std, linear quantiles)
// and Python's float rounding (round half to even on the exact binary value).

export function mean(xs) {
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Population standard deviation, like ``np.std``. */
export function std(xs) {
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / xs.length);
}

/** ``np.quantile(xs, q)`` with the default linear interpolation. */
export function quantile(xs, q) {
  return npQuantile(xs, q);
}

export function max(xs) {
  let m = -Infinity;
  for (const x of xs) if (x > m) m = x;
  return m;
}

export function min(xs) {
  let m = Infinity;
  for (const x of xs) if (x < m) m = x;
  return m;
}

/** Slope of the least-squares line through ``(i, ys[i])``, like ``np.polyfit(arange(n), ys, 1)[0]``. */
export function slope(ys) {
  const n = ys.length;
  const mx = (n - 1) / 2;
  const my = mean(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - mx) * (ys[i] - my);
    den += (i - mx) * (i - mx);
  }
  return num / den;
}

/**
 * Python's ``round(x, digits)``: rounds the exact binary value of ``x`` to the nearest
 * decimal, ties to even. ``toFixed(100)`` gives the exact expansion of every double above
 * about 1e-15 in magnitude, which is all the scores and probabilities rounded here.
 */
export function pyRound(x, digits = 0) {
  if (!Number.isFinite(x) || x === 0) return x;
  const exact = Math.abs(x).toFixed(100);
  const point = exact.indexOf(".");
  const keep = exact.slice(0, point + 1 + digits).replace(/\.$/, "");
  const rest = exact.slice(point + 1 + digits);
  let up = false;
  if (rest[0] > "5") up = true;
  else if (rest[0] === "5") {
    if (/[1-9]/.test(rest.slice(1))) up = true;
    else up = Number(keep[keep.length - 1]) % 2 === 1; // tie: to even
  }
  let value = Number(keep);
  if (up) value = Number((value + 10 ** -digits).toFixed(digits));
  value = x < 0 ? -value : value;
  return Object.is(value, -0) ? 0 : value;
}

export function sigmoid(z) {
  return 1 / (1 + Math.exp(-z));
}

// numpy's pairwise summation (``np.add.reduce`` on a contiguous float64 array): blocks of
// eight accumulators up to 128 items, halves above. Bit-exact sums matter here: the trees
// of the scorers split on durations that are multiples of 20 ms.
function pairwise(a, lo, n, round) {
  if (n < 8) {
    let r = 0;
    for (let i = lo; i < lo + n; i++) r = round(r + a[i]);
    return r;
  }
  if (n <= 128) {
    const r = [a[lo], a[lo + 1], a[lo + 2], a[lo + 3], a[lo + 4], a[lo + 5], a[lo + 6], a[lo + 7]];
    let i = 8;
    for (; i < n - (n % 8); i += 8) for (let j = 0; j < 8; j++) r[j] = round(r[j] + a[lo + i + j]);
    let res = round(round(round(r[0] + r[1]) + round(r[2] + r[3])) + round(round(r[4] + r[5]) + round(r[6] + r[7])));
    for (; i < n; i++) res = round(res + a[lo + i]);
    return res;
  }
  let n2 = Math.floor(n / 2);
  n2 -= n2 % 8;
  return round(pairwise(a, lo, n2, round) + pairwise(a, lo + n2, n - n2, round));
}

const identity = (x) => x;

/** ``np.sum`` of a float64 array. */
export const npSum = (xs) => pairwise(xs, 0, xs.length, identity);
/** ``np.sum`` of a float32 array (float32 accumulators). */
export const npSum32 = (xs) => pairwise(xs, 0, xs.length, Math.fround);
export const npMean = (xs) => npSum(xs) / xs.length;
export const npMean32 = (xs) => Math.fround(npSum32(xs) / xs.length);

/** ``np.std`` (population) of a float64 array, computed like numpy's ``_var``. */
export function npStd(xs) {
  const m = npMean(xs);
  const sq = Array.from(xs, (x) => (x - m) * (x - m));
  return Math.sqrt(npSum(sq) / xs.length);
}

export function npStd32(xs) {
  const m = npMean32(xs);
  const sq = Array.from(xs, (x) => Math.fround(Math.fround(x - m) * Math.fround(x - m)));
  return Math.fround(Math.sqrt(Math.fround(npSum32(sq) / xs.length)));
}

/** ``np.quantile(xs, q)`` (method "linear"), including numpy's two-sided interpolation formula. */
export function npQuantile(xs, q, round = identity) {
  const sorted = Float64Array.from(xs).sort();
  const n = sorted.length;
  const virtual = (n - 1) * q;
  let prev = Math.floor(virtual);
  let next = prev + 1;
  if (virtual >= n - 1) {
    prev = n - 1;
    next = n - 1;
  }
  const gamma = virtual - (virtual >= n - 1 ? -1 : prev);
  const a = sorted[prev];
  const b = sorted[next];
  const diff = round(b - a);
  return gamma >= 0.5 ? round(b - round(diff * round(1 - gamma))) : round(a + round(diff * gamma));
}
