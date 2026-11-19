// CTC forced alignment (Viterbi) and sequence likelihood (forward pass) on frame log
// posteriors, a port of openpronounce/alignment.py. A posterior matrix is
// ``{data: Float32Array, frames, classes}`` in row-major order.

export const NEG = -1e30;

function extend(labels, blank) {
  const ext = new Int32Array(2 * labels.length + 1).fill(blank);
  for (let i = 0; i < labels.length; i++) ext[2 * i + 1] = labels[i];
  return ext;
}

function skips(ext, blank) {
  const skip = new Uint8Array(ext.length);
  for (let s = 2; s < ext.length; s++) skip[s] = ext[s] !== blank && ext[s] !== ext[s - 2] ? 1 : 0;
  return skip;
}

/**
 * Viterbi alignment of ``labels`` on ``lp`` (frames x classes). Returns ``{spans, logProb}``:
 * one ``[start, end)`` frame range per label (``[0, 0]`` when a label got no frame).
 */
export function forcedAlign(lp, labels, blank = 0) {
  const { data, frames, classes } = lp;
  const ext = extend(labels, blank);
  const n = ext.length;
  const skip = skips(ext, blank);
  let dp = new Float64Array(n).fill(NEG);
  let next = new Float64Array(n);
  dp[0] = data[ext[0]];
  if (n > 1) dp[1] = data[ext[1]];
  const back = new Int8Array(frames * n);
  for (let t = 1; t < frames; t++) {
    const row = t * classes;
    const bp = t * n;
    for (let s = 0; s < n; s++) {
      const stay = dp[s];
      const from1 = s >= 1 ? dp[s - 1] : NEG;
      const from2 = skip[s] && s >= 2 ? dp[s - 2] : NEG;
      const best = Math.max(stay, from1, from2);
      // same tie-breaking as numpy: from2 first, then from1, else stay
      back[bp + s] = best === from2 ? 2 : best === from1 ? 1 : 0;
      next[s] = best + data[row + ext[s]];
    }
    [dp, next] = [next, dp];
  }
  let state = n === 1 || dp[n - 1] >= dp[n - 2] ? n - 1 : n - 2;
  const logProb = dp[state];
  const path = new Int32Array(frames);
  for (let t = frames - 1; t >= 0; t--) {
    path[t] = state;
    state -= back[t * n + state];
  }
  const spans = labels.map(() => [-1, -1]);
  for (let t = 0; t < frames; t++) {
    const s = path[t];
    if (s % 2 === 1) {
      const span = spans[(s - 1) / 2];
      if (span[0] < 0) span[0] = t;
      span[1] = t + 1;
    }
  }
  return { spans: spans.map((s) => (s[0] < 0 ? [0, 0] : s)), logProb };
}

/** Whether ``labels`` can be aligned on ``frames`` frames (a repeated label needs a blank in between). */
export function fits(frames, labels) {
  let needed = labels.length;
  for (let i = 1; i < labels.length; i++) if (labels[i] === labels[i - 1]) needed++;
  return frames >= needed;
}

/** CTC forward pass: ``log P(labels | lp)`` summed over every alignment. ``lp`` may be a frame window. */
export function logLikelihood(lp, labels, blank = 0) {
  const { data, frames, classes } = lp;
  const offset = lp.offset ?? 0;
  if (labels.length === 0) {
    let s = 0;
    for (let t = 0; t < frames; t++) s += data[offset + t * classes + blank];
    return s;
  }
  const ext = extend(labels, blank);
  const n = ext.length;
  const skip = skips(ext, blank);
  let alpha = new Float64Array(n).fill(NEG);
  let next = new Float64Array(n);
  alpha[0] = data[offset + ext[0]];
  if (n > 1) alpha[1] = data[offset + ext[1]];
  for (let t = 1; t < frames; t++) {
    const row = offset + t * classes;
    for (let s = 0; s < n; s++) {
      const a0 = alpha[s];
      const a1 = s >= 1 ? alpha[s - 1] : NEG;
      const a2 = skip[s] && s >= 2 ? alpha[s - 2] : NEG;
      const m = Math.max(a0, a1, a2);
      next[s] = m + Math.log(Math.exp(a0 - m) + Math.exp(a1 - m) + Math.exp(a2 - m)) + data[row + ext[s]];
    }
    [alpha, next] = [next, alpha];
  }
  if (n === 1) return alpha[0];
  const m = Math.max(alpha[n - 1], alpha[n - 2]);
  return m + Math.log(Math.exp(alpha[n - 1] - m) + Math.exp(alpha[n - 2] - m));
}
