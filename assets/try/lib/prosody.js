// Pitch and energy: librosa.yin and librosa.feature.rms (librosa 1.0 semantics, centered
// frames, zero padding) and the prosody descriptors of openpronounce/scorer.py.

import { npMean as mean, npMean32, npQuantile as quantile, npStd as std, npStd32, npSum32, slope } from "./numeric.js";

export const HOP = 320;
export const FRAME = 1024;

function padCenter(y, frameLength) {
  const pad = Math.floor(frameLength / 2);
  const out = new Float32Array(y.length + 2 * pad);
  out.set(y, pad);
  return out;
}

const frameCount = (n, frameLength, hop) => 1 + Math.floor((n - frameLength) / hop);

/** ``librosa.feature.rms(y=y, frame_length, hop_length, center=True)[0]``. */
export function rms(y, frameLength = FRAME, hop = HOP) {
  const padded = padCenter(y, frameLength);
  const n = frameCount(padded.length, frameLength, hop);
  const out = new Float32Array(n);
  const sq = new Float32Array(frameLength);
  for (let f = 0; f < n; f++) {
    const off = f * hop;
    for (let i = 0; i < frameLength; i++) sq[i] = padded[off + i] * padded[off + i];
    out[f] = Math.sqrt(Math.fround(npSum32(sq) / frameLength));
  }
  return out;
}

// Radix-2 complex FFT with precomputed tables, sized once per transform length.
const fftTables = new Map();

function tables(n) {
  let t = fftTables.get(n);
  if (t) return t;
  const rev = new Uint32Array(n);
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k++) {
    cos[k] = Math.cos((2 * Math.PI * k) / n);
    sin[k] = Math.sin((2 * Math.PI * k) / n);
  }
  t = { rev, cos, sin };
  fftTables.set(n, t);
  return t;
}

/** In-place FFT of ``re + i im`` (``sign`` -1 forward, +1 inverse without the 1/n). */
function fft(re, im, sign) {
  const n = re.length;
  const { rev, cos, sin } = tables(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (i < j) {
      let x = re[i];
      re[i] = re[j];
      re[j] = x;
      x = im[i];
      im[i] = im[j];
      im[j] = x;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step];
        const wi = sign * sin[k * step];
        const a = i + k;
        const b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

/**
 * ``librosa.autocorrelate`` of two real frames at once (one in the real part, one in the
 * imaginary part of the same transform), up to lag ``maxLag``.
 */
function autocorrelatePair(frameA, frameB, maxLag, re, im, outA, outB) {
  const n = re.length;
  re.fill(0);
  im.fill(0);
  re.set(frameA);
  if (frameB) im.set(frameB);
  fft(re, im, -1);
  // |A_k|^2 and |B_k|^2 from Z_k = A_k + i B_k, then Z'_k = |A_k|^2 + i |B_k|^2
  const pr = new Float64Array(n);
  const pi = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const m = (n - k) % n;
    const ar = (re[k] + re[m]) / 2;
    const ai = (im[k] - im[m]) / 2;
    const br = (im[k] + im[m]) / 2;
    const bi = -(re[k] - re[m]) / 2;
    pr[k] = ar * ar + ai * ai;
    pi[k] = br * br + bi * bi;
  }
  re.set(pr);
  im.set(pi);
  fft(re, im, 1);
  for (let k = 0; k <= maxLag; k++) {
    outA[k] = re[k] / n;
    if (outB) outB[k] = im[k] / n;
  }
}

/**
 * ``librosa.yin(y, fmin, fmax, sr, frame_length, hop_length)``, librosa 1.0 semantics: the
 * difference function is derived from the autocorrelation of the whole frame, the first
 * trough under ``troughThreshold`` is refined by parabolic interpolation (float64 here,
 * float32 in librosa).
 */
export function yinFrames(y, { fmin, fmax, sr = 16000, frameLength = FRAME, hop = HOP }) {
  const padded = padCenter(y, frameLength);
  const n = frameCount(padded.length, frameLength, hop);
  const minPeriod = Math.floor(sr / fmax);
  const maxPeriod = Math.min(Math.ceil(sr / fmin), frameLength - 1);
  const rows = maxPeriod - minPeriod + 1;
  let size = 1;
  while (size < 2 * frameLength - 1) size <<= 1;
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const acfA = new Float64Array(maxPeriod + 1);
  const acfB = new Float64Array(maxPeriod + 1);
  const cumMean = new Float64Array(maxPeriod + 1);
  const d = new Float64Array(maxPeriod + 1);
  const tiny = 1.1754943508222875e-38;
  const out = [];
  const frameAt = (f) => padded.subarray(f * hop, f * hop + frameLength);
  const finish = (frame, acf) => {
    let c = 0;
    let cum = 0;
    for (let k = 1; k <= maxPeriod; k++) {
      c += frame[k - 1] * frame[k - 1];
      d[k] = 2 * (acf[0] - acf[k]) - c;
      cum += d[k];
      cumMean[k] = cum / k;
    }
    const cmnd = new Float64Array(rows);
    for (let r = 0; r < rows; r++) cmnd[r] = d[minPeriod + r] / (cumMean[minPeriod + r] + tiny);
    out.push(cmnd);
  };
  for (let f = 0; f < n; f += 2) {
    const a = frameAt(f);
    const b = f + 1 < n ? frameAt(f + 1) : null;
    autocorrelatePair(a, b, maxPeriod, re, im, acfA, b ? acfB : null);
    finish(a, acfA);
    if (b) finish(b, acfB);
  }
  return { frames: out, minPeriod, rows };
}

/** Parabolic shift at ``r`` (``librosa.core.pitch._parabolic_interpolation``, 0 at the edges). */
export function parabolicShift(x, r) {
  if (r <= 0 || r >= x.length - 1) return 0;
  const a = x[r + 1] + x[r - 1] - 2 * x[r];
  const b = (x[r + 1] - x[r - 1]) / 2;
  return Math.abs(b) >= Math.abs(a) ? 0 : -b / a;
}

export function yin(y, { fmin, fmax, sr = 16000, frameLength = FRAME, hop = HOP, troughThreshold = 0.1 }) {
  const { frames, minPeriod, rows } = yinFrames(y, { fmin, fmax, sr, frameLength, hop });
  const f0 = new Float64Array(frames.length);
  frames.forEach((cmnd, f) => {
    // local minima: x[i] < x[i-1] and x[i] <= x[i+1]; the first row against the second, the last against the one before
    let period = -1;
    for (let r = 0; r < rows; r++) {
      let trough;
      if (r === 0) trough = cmnd[0] < cmnd[1];
      else if (r === rows - 1) trough = cmnd[r] < cmnd[r - 1];
      else trough = cmnd[r] < cmnd[r - 1] && cmnd[r] <= cmnd[r + 1];
      if (trough && cmnd[r] < troughThreshold) {
        period = r;
        break;
      }
    }
    if (period < 0) {
      period = 0;
      for (let r = 1; r < rows; r++) if (cmnd[r] < cmnd[period]) period = r;
    }
    f0[f] = sr / (minPeriod + period + parabolicShift(cmnd, period));
  });
  return f0;
}

export const PROSODY_FEATURES = ["f0_mean", "f0_std_semitones", "f0_range_semitones", "f0_slope", "f0_delta_mean", "rms_mean",
  "rms_std_norm", "rms_dyn_db", "voiced_ratio", "n_energy_dips", "duration"];

/** ``scorer.prosody_features``: YIN pitch (60-400 Hz) and RMS energy descriptors. */
export function prosodyFeatures(waveform, sr = 16000) {
  let y = waveform;
  if (y.length < FRAME) {
    y = new Float32Array(FRAME);
    y.set(waveform);
  }
  const f0 = yin(y, { fmin: 60, fmax: 400, sr, frameLength: FRAME, hop: HOP });
  const energy = rms(y, FRAME, HOP);
  let peak = 0;
  for (const v of energy) peak = Math.max(peak, v);
  // numpy compares the float32 RMS with float32 thresholds
  const floor = Math.max(Math.fround(peak * 0.1), Math.fround(1e-4));
  const voiced = Array.from(energy, (v) => v > floor);
  const nVoiced = voiced.filter(Boolean).length;
  const f0v = nVoiced > 3 ? Array.from(f0).filter((_, i) => voiced[i]) : Array.from(f0);
  const lf = f0v.map((v) => Math.log(Math.max(v, 1e-3)));
  const semitone = 12 / Math.log(2);
  let dips = 0;
  for (let i = 1; i < voiced.length; i++) if (voiced[i] !== voiced[i - 1]) dips++;
  const deltas = [];
  for (let i = 1; i < lf.length; i++) deltas.push(Math.abs(lf[i] - lf[i - 1]));
  const rmsArr = Array.from(energy);
  const rmsMean = npMean32(rmsArr);
  return {
    f0_mean: mean(f0v),
    f0_std_semitones: std(lf) * semitone,
    f0_range_semitones: (quantile(lf, 0.95) - quantile(lf, 0.05)) * semitone,
    f0_slope: lf.length > 2 ? slope(lf) * 100 : 0.0,
    f0_delta_mean: lf.length > 1 ? mean(deltas) : 0.0,
    rms_mean: rmsMean,
    rms_std_norm: Math.fround(npStd32(rmsArr) / Math.fround(rmsMean + 1e-9)),
    rms_dyn_db: 20 * Math.log10((quantile(rmsArr, 0.95) + 1e-9) / (quantile(rmsArr, 0.2) + 1e-9)),
    voiced_ratio: nVoiced / voiced.length,
    n_energy_dips: Math.floor(dips / 2),
    duration: y.length / sr,
  };
}

// ---------------------------------------------------------------------------
// pYIN (librosa.pyin with its defaults), for the display contour of the ``prosody`` key
// ---------------------------------------------------------------------------

function betaCdfInteger(x, a, b) {
  // regularized incomplete beta for integer a, b: P(Binomial(a + b - 1, x) >= a)
  const n = a + b - 1;
  let s = 0;
  let c = 1; // C(n, j)
  for (let j = 0; j <= n; j++) {
    if (j >= a) s += c * x ** j * (1 - x) ** (n - j);
    c = (c * (n - j)) / (j + 1);
  }
  return s;
}

function triangle(m) {
  // scipy.signal.windows.triang(m), symmetric
  const w = new Float64Array(m);
  const half = Math.floor((m + 1) / 2);
  for (let i = 1; i <= half; i++) {
    const v = m % 2 === 0 ? (2 * i - 1) / m : (2 * i) / (m + 1);
    w[i - 1] = v;
    w[m - i] = v;
  }
  return w;
}

function transitionLocal(n, width) {
  const t = Array.from({ length: n }, () => new Float64Array(n));
  const win = triangle(width);
  const lpad = Math.floor((n - width) / 2);
  const padded = new Float64Array(n);
  padded.set(win, lpad);
  for (let i = 0; i < n; i++) {
    const shift = Math.floor(n / 2) + i + 1;
    const row = t[i];
    for (let k = 0; k < n; k++) row[(k + shift) % n] = padded[k];
    for (let k = Math.min(n, i + Math.floor(width / 2) + 1); k < n; k++) row[k] = 0;
    for (let k = 0; k < Math.max(0, i - Math.floor(width / 2)); k++) row[k] = 0;
    let sum = 0;
    for (let k = 0; k < n; k++) sum += row[k];
    for (let k = 0; k < n; k++) row[k] /= sum;
  }
  return t;
}

const pyinCache = new Map();

function pyinSetup(n, nBinsPerSemitone, hop, sr) {
  const key = `${n}/${hop}/${sr}`;
  if (pyinCache.has(key)) return pyinCache.get(key);
  const maxSemitonesPerFrame = Math.round((35.92 * 12 * hop) / sr);
  const width = maxSemitonesPerFrame * nBinsPerSemitone + 1;
  const local = transitionLocal(n, width);
  const switchProb = 0.01;
  const eps = 2.2250738585072014e-308;
  const threshold = Math.log(1e-4 + eps);
  // kron([[1 - p, p], [p, 1 - p]], local): predecessors of every state with their log transition
  const preds = [];
  for (let j = 0; j < 2 * n; j++) {
    const list = [];
    for (let k = 0; k < 2 * n; k++) {
      const block = (k < n) === (j < n) ? 1 - switchProb : switchProb;
      const lt = Math.log(block * local[k % n][j % n] + eps);
      if (lt >= threshold) list.push(k, lt);
    }
    preds.push(Float64Array.from(list));
  }
  const thresholds = Array.from({ length: 101 }, (_, i) => i / 100);
  const cdf = thresholds.map((x) => betaCdfInteger(x, 2, 18));
  const betaProbs = cdf.slice(1).map((c, i) => c - cdf[i]);
  const setup = { preds, thresholds, betaProbs };
  pyinCache.set(key, setup);
  return setup;
}

const roundHalfEven = (x) => {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
};

/** ``librosa.pyin(y, fmin, fmax, sr)`` with librosa's defaults: ``{f0 (0 when unvoiced), voiced}``. */
export function pyin(y, { fmin, fmax, sr = 16000, frameLength = 2048, hop = 512 }) {
  const { frames, minPeriod, rows } = yinFrames(y, { fmin, fmax, sr, frameLength, hop });
  const nBinsPerSemitone = 10;
  const n = Math.floor(12 * nBinsPerSemitone * Math.log2(fmax / fmin)) + 1;
  const { preds, thresholds, betaProbs } = pyinSetup(n, nBinsPerSemitone, hop, sr);
  const lambda = 2;
  const boltzmann = (k, N) => ((1 - Math.exp(-lambda)) * Math.exp(-lambda * k)) / (1 - Math.exp(-lambda * N));
  const T = frames.length;
  const S = 2 * n;
  const eps = 2.2250738585072014e-308;
  const logObs = [];
  for (const cmnd of frames) {
    const troughs = [];
    for (let r = 0; r < rows; r++) {
      let trough;
      if (r === 0) trough = cmnd[0] < cmnd[1];
      else if (r === rows - 1) trough = cmnd[r] < cmnd[r - 1];
      else trough = cmnd[r] < cmnd[r - 1] && cmnd[r] <= cmnd[r + 1];
      if (trough) troughs.push(r);
    }
    const obs = new Float64Array(S);
    if (troughs.length) {
      const heights = troughs.map((r) => cmnd[r]);
      const probs = new Float64Array(troughs.length);
      for (let m = 0; m < 100; m++) {
        const thr = thresholds[m + 1];
        let N = 0;
        for (const h of heights) if (h < thr) N++;
        let position = -1;
        heights.forEach((h, k) => {
          if (h < thr) {
            position++;
            probs[k] += boltzmann(position, N) * betaProbs[m];
          }
        });
      }
      let gmin = 0;
      for (let k = 1; k < heights.length; k++) if (heights[k] < heights[gmin]) gmin = k;
      let below = 0;
      for (let m = 0; m < 100; m++) if (!(heights[gmin] < thresholds[m + 1])) below++;
      let extra = 0;
      for (let m = 0; m < below; m++) extra += betaProbs[m];
      probs[gmin] += 0.01 * extra;
      troughs.forEach((r, k) => {
        if (probs[k] === 0) return;
        const f0 = sr / (minPeriod + r + parabolicShift(cmnd, r));
        const bin = Math.min(n, Math.max(0, roundHalfEven(12 * nBinsPerSemitone * Math.log2(f0 / fmin))));
        obs[bin] = probs[k];
      });
    }
    let voiced = 0;
    for (let b = 0; b < n; b++) voiced += obs[b];
    voiced = Math.min(1, Math.max(0, voiced));
    for (let b = n; b < S; b++) obs[b] = (1 - voiced) / n;
    logObs.push(obs.map((v) => Math.log(v + eps)));
  }
  // Viterbi over the 2n states (voiced pitch bins, then unvoiced), uniform initial distribution
  const logInit = Math.log(1 / S + eps);
  let value = logObs[0].map((v) => v + logInit);
  const ptr = [new Uint16Array(S)];
  for (let t = 1; t < T; t++) {
    const next = new Float64Array(S);
    const back = new Uint16Array(S);
    for (let j = 0; j < S; j++) {
      const list = preds[j];
      let best = -Infinity;
      let arg = 0;
      for (let q = 0; q < list.length; q += 2) {
        const cost = value[list[q]] + list[q + 1];
        if (cost > best) {
          best = cost;
          arg = list[q];
        }
      }
      next[j] = logObs[t][j] + best;
      back[j] = arg;
    }
    value = next;
    ptr.push(back);
  }
  const states = new Int32Array(T);
  let arg = 0;
  for (let j = 1; j < S; j++) if (value[j] > value[arg]) arg = j;
  states[T - 1] = arg;
  for (let t = T - 2; t >= 0; t--) states[t] = ptr[t + 1][states[t + 1]];
  const f0 = new Float64Array(T);
  const voicedFlags = new Array(T);
  for (let t = 0; t < T; t++) {
    voicedFlags[t] = states[t] < n;
    f0[t] = voicedFlags[t] ? fmin * 2 ** ((states[t] % n) / (12 * nBinsPerSemitone)) : 0;
  }
  return { f0, voiced: voicedFlags };
}

/**
 * Display contours of the ``prosody`` key, as ``speech.extract_f0`` / ``extract_energy``:
 * pYIN F0 (50-300 Hz, unvoiced frames interpolated) and RMS energy scaled to 0-250.
 * No score reads them.
 */
export function prosodyContours(waveform, sr = 16000) {
  const { f0 } = pyin(waveform, { fmin: 50, fmax: 300, sr });
  const energy = rms(waveform, 2048, 512);
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of energy) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  const scaled = Array.from(energy, (v) => (hi > lo ? ((v - lo) / (hi - lo)) * 250 : 0));
  return { f0: interpolateF0(Array.from(f0)), energy: scaled };
}

/** Linearly interpolate unvoiced (0) frames, like ``speech.interpolate_f0`` (``np.interp`` holds the ends). */
export function interpolateF0(f0) {
  const idx = [];
  f0.forEach((v, i) => {
    if (v > 0) idx.push(i);
  });
  if (!idx.length) return f0.slice();
  return f0.map((v, i) => {
    if (i <= idx[0]) return f0[idx[0]];
    if (i >= idx[idx.length - 1]) return f0[idx[idx.length - 1]];
    let k = 0;
    while (idx[k + 1] < i) k++;
    const a = idx[k];
    const b = idx[k + 1];
    return f0[a] + ((f0[b] - f0[a]) * (i - a)) / (b - a);
  });
}
