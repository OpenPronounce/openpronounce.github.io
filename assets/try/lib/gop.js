// Goodness of pronunciation of every expected phone from forced alignment, the word
// model, missing words and extra speech, and utterance features: a port of
// openpronounce/gop.py.

import * as alignment from "./alignment.js";
import { getLanguage, accepted } from "./languages.js";
import { LogisticModel, stage } from "./models.js";
import { npMean as mean, npMean32, npQuantile as quantile, npStd as std, npSum } from "./numeric.js";
import { NEAR_PHONES, normalizePhone, tokenIdsByPhone } from "./phones.js";

export const FRAME_SECONDS = 0.02;
export const PLAUSIBLE_LOG_POSTERIOR = -1.0;
// numpy compares a float32 with a Python float in float32 (NEP 50)
export const HEARD_LOG_POSTERIOR = Math.fround(Math.log(0.1));
export const PERTURBATION_CONTEXT = 2;
export const PERTURBATION_MARGIN = 5;
export const EMBEDDING_MARGIN = 1;
const NEG_INF = Math.fround(-1e9);

export const PHONE_FEATURES = [
  "gop_margin", "gop_margin_min", "gop_dnn", "lp_target", "ctx_lp_target", "gop_del", "gop_af", "dur",
  "n_tokens", "pos_in_word", "is_first", "is_last", "n_phones", "function_word", "prev_gm", "next_gm",
  "utt_gm_mean", "utt_gm_std", "ll_full_per_phone", "heard_ratio", "greedy_ll_per_frame",
];
const AGGREGATED = ["p", "gm", "del", "af", "lp", "dur"];
export const WORD_FEATURES = [
  ...AGGREGATED.flatMap((name) => ["min", "max", "mean"].map((stat) => `${name}_${stat}`)).concat(["p_any"]).sort(),
  "n_phones", "function_word", "utt_gm_mean", "utt_gm_std", "heard_ratio", "ll_full_per_phone",
];

export const FUNCTION_WORDS = {
  en: new Set(["a", "an", "the", "of", "to", "in", "on", "at", "for", "and", "or", "is", "are", "was", "it", "i",
    "you", "he", "she", "we", "they", "that", "this", "my", "your", "his", "her", "its", "our", "their",
    "do", "does", "did", "have", "has", "had", "be", "am", "not", "no", "so", "if", "as", "by", "with",
    "from", "but", "me", "him", "us", "them"]),
};

const VOWEL_LETTERS = new Set(Array.from("aeiouyæɑɒɔəɛɜɪʊʌøœɐɨɵʉɯɤ"));
const isVowelToken = (token) => VOWEL_LETTERS.has(Array.from(token)[0]);

// ---------------------------------------------------------------------------
// Expected phones -> recognizer tokens
// ---------------------------------------------------------------------------

const labelCache = new Map();

/** Token ids standing for ``phone``: one array of ids per CTC label (``gop._label_ids``). */
export function labelIds(phone, vocab, lang) {
  const key = `${lang}\u0000${phone}`;
  let cached = labelCache.get(vocab)?.get(key);
  if (cached) return cached;
  cached = computeLabelIds(phone, vocab, lang);
  if (!labelCache.has(vocab)) labelCache.set(vocab, new Map());
  labelCache.get(vocab).set(key, cached);
  return cached;
}

const unique = (xs) => [...new Set(xs)];

function computeLabelIds(phone, vocab, lang) {
  const index = new Map(vocab.map((token, i) => [token, i]));
  const acc = accepted(getLanguage(lang), phone).filter((t) => index.has(t)).map((t) => index.get(t));
  const short = phone.replaceAll("ː", "");
  if (phone.endsWith("ː") && index.has(short) && !isVowelToken(short)) acc.push(index.get(short));
  for (const spelling of [phone, short]) {
    if (index.has(spelling) && !spelling.startsWith("<")) return [unique([index.get(spelling), ...acc])];
  }
  if (acc.length) return [unique(acc)];
  const groups = tokenIdsByPhone(vocab, lang);
  const normalized = normalizePhone(phone, lang);
  if (groups.has(normalized)) return [groups.get(normalized)];
  const longest = Math.max(...vocab.map((t) => Array.from(t).length));
  const chars = Array.from(phone);
  const labels = [];
  let i = 0;
  while (i < chars.length) {
    let found = false;
    for (let length = Math.min(longest, chars.length - i); length > 0; length--) {
      const piece = normalizePhone(chars.slice(i, i + length).join(""), lang);
      if (groups.has(piece)) {
        labels.push(groups.get(piece));
        i += length;
        found = true;
        break;
      }
    }
    if (!found) i += 1;
  }
  return labels;
}

/** Log posteriors of the label columns: blank first, then log-sum-exp over each group of token ids. */
function reduce(logp, columns) {
  const { data, frames, classes } = logp;
  const width = columns.length + 1;
  const out = new Float32Array(frames * width);
  for (let t = 0; t < frames; t++) {
    const row = t * classes;
    out[t * width] = data[row];
    for (let j = 0; j < columns.length; j++) {
      const ids = columns[j];
      if (ids.length === 1) {
        out[t * width + j + 1] = data[row + ids[0]];
      } else {
        let m = -Infinity;
        for (const id of ids) m = Math.max(m, data[row + id]);
        let s = 0;
        for (const id of ids) s += Math.exp(data[row + id] - m);
        out[t * width + j + 1] = m + Math.log(s);
      }
    }
  }
  return { data: out, frames, classes: width };
}

class Labels {
  constructor(logp, vocab, groups, lang) {
    this.lang = lang;
    this.vocab = vocab;
    this.phones = []; // [wordIndex, position, phone, labelIndices]
    const columns = new Map();
    const sequence = [];
    groups.forEach((group, wordIndex) => {
      group.forEach((phone, position) => {
        const indices = [];
        for (const ids of labelIds(phone, vocab, lang)) {
          const key = ids.join(",");
          if (!columns.has(key)) columns.set(key, { column: columns.size + 1, ids });
          indices.push(sequence.length);
          sequence.push(columns.get(key).column);
        }
        if (indices.length) this.phones.push([wordIndex, position, phone, indices]);
      });
    });
    this.columnKeys = [...columns.keys()];
    this.columns = [...columns.values()].map((c) => c.ids);
    this.sequence = sequence;
    this.reduced = reduce(logp, this.columns);
    this.tokenIds = this.columns.map((ids) => new Set(ids));
  }

  columnOf(phone) {
    return labelIds(phone, this.vocab, this.lang).map((ids) => {
      const at = this.columnKeys.indexOf(ids.join(","));
      return at >= 0 ? at + 1 : null;
    });
  }
}

function nearPhones(lang) {
  const near = new Map();
  for (const group of NEAR_PHONES[lang] ?? []) {
    for (const phone of group) {
      if (!near.has(phone)) near.set(phone, new Set());
      for (const other of group) if (other !== phone) near.get(phone).add(other);
    }
  }
  return near;
}

const f32 = Math.fround;

/**
 * Force-align the expected phones (``groups``: espeak phones per word) and score each of them.
 * ``hidden`` is ``{data, frames, dim}`` or null. Returns null when the recording is too short.
 */
export function analyze(logp, vocab, groups, words = null, lang = "en", hidden = null) {
  const labels = new Labels(logp, vocab, groups, lang);
  if (!labels.phones.length || !alignment.fits(logp.frames, labels.sequence)) return null;
  const { reduced, sequence } = labels;
  const R = reduced.data;
  const W = reduced.classes;
  const nFrames = logp.frames;
  const C = logp.classes;
  const L = logp.data;
  const { spans } = alignment.forcedAlign(reduced, sequence);
  const llFull = alignment.logLikelihood(reduced, sequence);
  const frameMax = new Float32Array(nFrames);
  const greedy = new Int32Array(nFrames);
  for (let t = 0; t < nFrames; t++) {
    let best = 0;
    let value = -Infinity;
    for (let c = 0; c < C; c++) {
      const v = L[t * C + c];
      if (v > value) {
        value = v;
        best = c;
      }
    }
    frameMax[t] = value;
    greedy[t] = best;
  }
  let nHeard = greedy[0] !== 0 ? 1 : 0;
  for (let t = 1; t < nFrames; t++) if (greedy[t] !== greedy[t - 1] && greedy[t] !== 0) nHeard++;
  const heardRatio = nHeard / labels.phones.length;
  const near = nearPhones(lang);
  const functionWords = FUNCTION_WORDS[lang] ?? new Set();
  const nPhones = groups.map((g) => g.length);

  const scored = [];
  labels.phones.forEach(([wordIndex, position, phone, indices], j) => {
    const ownSpans = indices.map((i) => spans[i]);
    let start = Math.min(...ownSpans.map((s) => s[0]));
    let end = Math.max(...ownSpans.map((s) => s[1]));
    if (end <= start) {
      start = Math.max(0, Math.min(start, nFrames - 1));
      end = start + 1;
    }
    const margins = [];
    const targets = [];
    const dnns = [];
    const contexts = [];
    indices.forEach((i, k) => {
      let [s, e] = ownSpans[k];
      if (e <= s) {
        s = Math.max(0, Math.min(s, nFrames - 1));
        e = s + 1;
      }
      const col = sequence[i];
      const n = e - s;
      const diff = new Float32Array(n);
      const column = new Float32Array(n);
      const expo = new Float32Array(n);
      for (let t = s; t < e; t++) {
        const v = R[t * W + col];
        column[t - s] = v;
        diff[t - s] = v - frameMax[t];
        expo[t - s] = Math.exp(v);
      }
      // float32 reductions, as numpy does on these float32 columns
      margins.push(npMean32(diff));
      targets.push(npMean32(column));
      dnns.push(-Math.fround(Math.log(Math.fround(npMean32(expo) + 1e-12))));
      let ctx = -Infinity;
      for (let t = Math.max(0, s - 2); t < Math.min(nFrames, e + 2); t++) ctx = Math.max(ctx, R[t * W + col]);
      contexts.push(ctx);
    });
    // Likelihood drop when the phone is deleted or replaced by a close one, on a window.
    const P = labels.phones.length;
    const first = labels.phones[Math.max(0, j - PERTURBATION_CONTEXT)][3][0];
    const lastIndices = labels.phones[Math.min(P - 1, j + PERTURBATION_CONTEXT)][3];
    const last = lastIndices[lastIndices.length - 1] + 1;
    const frameStart = Math.max(0, Math.min(spans[first][0], start) - PERTURBATION_MARGIN);
    const frameEnd = Math.min(nFrames, Math.max(spans[last - 1][1], end) + PERTURBATION_MARGIN);
    const window = { data: R, frames: frameEnd - frameStart, classes: W, offset: frameStart * W };
    const before = sequence.slice(first, indices[0]);
    const after = sequence.slice(indices[indices.length - 1] + 1, last);
    const candidates = [[...before, ...after]];
    for (const alternative of near.get(phone) ?? []) {
      const cols = labels.columnOf(alternative);
      if (cols.length && !cols.includes(null)) candidates.push([...before, ...cols, ...after]);
    }
    const reference = alignment.logLikelihood(window, sequence.slice(first, last));
    const likelihoods = candidates.map((c) => alignment.logLikelihood(window, c) - reference);
    const ownIds = new Set();
    for (const i of indices) for (const id of labels.tokenIds[sequence[i] - 1]) ownIds.add(id);
    let other = 0;
    let otherValue = -Infinity;
    for (let c = 0; c < C; c++) {
      let m = -Infinity;
      if (c === 0 || ownIds.has(c)) {
        m = NEG_INF;
      } else {
        for (let t = start; t < end; t++) m = Math.max(m, L[t * C + c]);
      }
      if (m > otherValue) {
        otherValue = m;
        other = c;
      }
    }
    const heard = otherValue >= HEARD_LOG_POSTERIOR ? other : null;
    const p = {
      word_index: wordIndex, position, phone, start, end, heard,
      gop_margin: mean(margins), gop_margin_min: Math.min(...margins),
      gop_dnn: mean(dnns), lp_target: mean(targets), ctx_lp_target: mean(contexts),
      gop_del: -likelihoods[0], gop_af: -Math.max(...likelihoods), dur: end - start, n_tokens: indices.length,
      pos_in_word: position, is_first: position === 0 ? 1 : 0, is_last: position === nPhones[wordIndex] - 1 ? 1 : 0,
      n_phones: nPhones[wordIndex], function_word: words !== null && functionWords.has(words[wordIndex]) ? 1 : 0,
    };
    if (hidden) {
      const a = Math.max(0, start - EMBEDDING_MARGIN);
      const b = Math.min(nFrames, end + EMBEDDING_MARGIN);
      const dim = hidden.dim;
      const emb = new Float64Array(dim);
      for (let t = a; t < b; t++) {
        const row = t * dim;
        for (let d = 0; d < dim; d++) emb[d] += hidden.data[row + d];
      }
      for (let d = 0; d < dim; d++) emb[d] = f32(emb[d] / (b - a));
      p.embedding = emb;
    }
    scored.push(p);
  });
  const margins = scored.map((p) => p.gop_margin);
  const utterance = {
    n_frames: nFrames,
    ll_full_per_phone: llFull / sequence.length,
    heard_ratio: heardRatio,
    greedy_ll_per_frame: npMean32(frameMax),
    plausible_phone_ratio: mean(scored.map((p) => (p.ctx_lp_target >= PLAUSIBLE_LOG_POSTERIOR ? 1 : 0))),
  };
  const gmMean = mean(margins);
  const gmStd = std(margins);
  scored.forEach((p, j) => {
    Object.assign(p, {
      prev_gm: j ? scored[j - 1].gop_margin : 0.0,
      next_gm: j + 1 < scored.length ? scored[j + 1].gop_margin : 0.0,
      utt_gm_mean: gmMean, utt_gm_std: gmStd,
      ll_full_per_phone: utterance.ll_full_per_phone, heard_ratio: heardRatio,
      greedy_ll_per_frame: utterance.greedy_ll_per_frame,
    });
  });
  return { phones: scored, utterance };
}

export const phoneMatrix = (scored) => scored.map((p) => PHONE_FEATURES.map((name) => p[name]));

/** ``{indices, rows}``: the phones of each word aggregated into WORD_FEATURES columns. */
export function wordMatrix(scored, probabilities) {
  const byWord = new Map();
  scored.forEach((p, i) => {
    if (!byWord.has(p.word_index)) byWord.set(p.word_index, []);
    byWord.get(p.word_index).push([p, probabilities[i]]);
  });
  const indices = [];
  const rows = [];
  for (const [wordIndex, items] of byWord) {
    const values = { p: items.map(([, q]) => q) };
    for (const [name, key] of [["gm", "gop_margin"], ["del", "gop_del"], ["af", "gop_af"], ["lp", "lp_target"], ["dur", "dur"]]) {
      values[name] = items.map(([p]) => p[key]);
    }
    const agg = {};
    for (const [name, series] of Object.entries(values)) {
      agg[`${name}_min`] = Math.min(...series);
      agg[`${name}_max`] = Math.max(...series);
      agg[`${name}_mean`] = series.reduce((a, b) => a + b, 0) / series.length;
    }
    agg.p_any = 1.0 - values.p.reduce((a, q) => a * (1.0 - q), 1.0);
    const first = items[0][0];
    for (const name of ["n_phones", "function_word", "utt_gm_mean", "utt_gm_std", "heard_ratio", "ll_full_per_phone"]) {
      agg[name] = first[name];
    }
    rows.push(WORD_FEATURES.map((name) => agg[name]));
    indices.push(wordIndex);
  }
  return { indices, rows };
}

/** Phone model + word model + threshold (``models/word_mdd_<lang>.json``). */
export class WordModel {
  constructor(data) {
    this.data = data;
    this.phone = stage(data.phone);
    this.word = stage(data.word);
    this.threshold = Number(data.threshold);
    this.generic = data.lang === "generic";
    this.hiddenLayer = this.phone.hiddenLayer ?? null;
    for (const [s, expected] of [[this.phone, PHONE_FEATURES], [this.word, WORD_FEATURES]]) {
      if (s.features && s.features.join() !== expected.join()) {
        console.warn("openpronounce: word model features differ from the expected column order");
      }
    }
  }

  /** ``{phoneProbabilities, wordProbabilities: Map(wordIndex -> p)}``. */
  predict(analysis) {
    const scored = analysis.phones;
    const phones = scored.map((p) => p.phone);
    const embeddings = this.hiddenLayer === null ? null : scored.map((p) => p.embedding);
    const phoneProbabilities = this.phone.predict(phoneMatrix(scored), phones, embeddings);
    const { indices, rows } = wordMatrix(scored, phoneProbabilities);
    const wordProbs = this.word.predict(rows);
    return { phoneProbabilities, wordProbabilities: new Map(indices.map((w, i) => [w, wordProbs[i]])) };
  }
}

// ---------------------------------------------------------------------------
// Words that were not said, speech that was not expected
// ---------------------------------------------------------------------------

export const HEARD_CONFIDENCE = 0.5;
export const EXTRA_SPEECH_SCORE = 2.0;
export const EXTRA_NEIGHBOUR_WEIGHT = 0.5;

function wordSpans(analysis) {
  const spans = new Map();
  for (const p of analysis.phones) {
    const [s, e] = spans.get(p.word_index) ?? [p.start, p.end];
    spans.set(p.word_index, [Math.min(s, p.start), Math.max(e, p.end)]);
  }
  return spans;
}

export function missingMatrix(analysis, spans, confidences) {
  const heard = spans.filter((_, i) => confidences[i] >= HEARD_CONFIDENCE);
  const byWord = new Map();
  for (const p of analysis.phones) {
    if (!byWord.has(p.word_index)) byWord.set(p.word_index, []);
    byWord.get(p.word_index).push(p);
  }
  const indices = [...byWord.keys()].sort((a, b) => a - b);
  const rows = indices.map((index) => {
    const phones = byWord.get(index);
    const start = Math.min(...phones.map((p) => p.start));
    const end = Math.max(...phones.map((p) => p.end));
    const deletions = phones.map((p) => p.gop_del);
    const contexts = phones.map((p) => p.ctx_lp_target);
    return [
      Math.max(...deletions), mean(deletions), Math.max(...contexts), mean(contexts),
      mean(phones.map((p) => p.lp_target)), mean(phones.map((p) => p.gop_margin)),
      (end - start) / phones.length, heard.filter(([s, e]) => s < end && e > start).length / phones.length, phones.length,
    ];
  });
  return { indices, rows };
}

export class MissingModel {
  constructor(data) {
    this.model = new LogisticModel(data.model);
    this.threshold = Number(data.threshold);
  }

  /** ``Map(wordIndex -> probability that the word was not said)``. */
  predict(analysis, spans, confidences) {
    const { indices, rows } = missingMatrix(analysis, spans, confidences);
    const probs = this.model.predict(rows);
    return new Map(indices.map((w, i) => [w, probs[i]]));
  }
}

/** Stretches where more was said than expected (``gop.extra_speech``). */
export function extraSpeech(analysis, spans, confidences) {
  const heard = [];
  spans.forEach((span, i) => {
    if (confidences[i] >= HEARD_CONFIDENCE) heard.push([i, span]);
  });
  const ws = wordSpans(analysis);
  const indices = [...ws.keys()].sort((a, b) => a - b);
  if (!indices.length) return [];
  const nPhones = new Map(indices.map((i) => [i, 0]));
  for (const p of analysis.phones) nPhones.set(p.word_index, nPhones.get(p.word_index) + 1);
  const surplus = new Map();
  for (const index of indices) {
    const [start, end] = ws.get(index);
    surplus.set(index, Math.max(0, heard.filter(([, [s, e]]) => s < end && e > start).length - nPhones.get(index)));
  }
  const sur = (i) => (i === null ? 0 : surplus.get(i) ?? 0);
  const nFrames = analysis.utterance.n_frames;
  const fired = [];
  for (let b = 0; b <= indices.length; b++) {
    const previous = b ? indices[b - 1] : null;
    const following = b < indices.length ? indices[b] : null;
    const gapStart = previous !== null ? ws.get(previous)[1] : 0;
    const gapEnd = following !== null ? ws.get(following)[0] : nFrames;
    const between = heard.filter(([, [s, e]]) => s >= gapStart && e <= gapEnd).map(([i]) => i);
    const score = between.length + EXTRA_NEIGHBOUR_WEIGHT * (sur(previous) + sur(following));
    if (score >= EXTRA_SPEECH_SCORE) fired.push([b, previous, following, between]);
  }
  const withPhones = new Set(fired.filter(([, , , between]) => between.length).map(([b]) => b));
  const events = [];
  for (const [b, previous, following, between] of fired) {
    if (!between.length) {
      if ((withPhones.has(b - 1) && sur(previous)) || (withPhones.has(b + 1) && sur(following))) continue;
      const lastEvent = events[events.length - 1];
      if (lastEvent && lastEvent._boundary === b - 1 && !lastEvent.heard.length && sur(previous)) {
        lastEvent.before = following;
        lastEvent._boundary = b;
        continue;
      }
    }
    events.push({ after: previous, before: following, heard: [...between], _boundary: b });
  }
  for (const event of events) {
    delete event._boundary;
    if (!event.heard.length) {
      const inside = [event.after, event.before].filter((i) => i !== null && surplus.get(i)).map((i) => ws.get(i));
      event.heard = heard.filter(([, [s, e]]) => inside.some(([start, end]) => s < end && e > start)).map(([i]) => i);
    }
    const frames = event.heard.map((i) => spans[i]);
    event.start = frames.length ? Math.min(...frames.map((f) => f[0])) : 0;
    event.end = frames.length ? Math.max(...frames.map((f) => f[1])) : 0;
  }
  return events;
}

// ---------------------------------------------------------------------------
// Utterance-level features
// ---------------------------------------------------------------------------

export const PAUSE_SECONDS = 0.25;
export const UTTERANCE_FEATURES = [
  "gm_mean", "gm_std", "gm_min", "gm_q10", "del_mean", "del_min", "del_q10", "af_mean", "af_min", "af_q10",
  "lp_mean", "lp_q10", "frac_gm_below_1", "frac_gm_below_3", "frac_heard_other", "ll_full_per_phone",
  "heard_ratio", "greedy_ll_per_frame", "plausible_phone_ratio",
  "n_phones", "n_words", "speech_seconds", "phones_per_second", "phone_dur_mean", "phone_dur_std", "phone_dur_cv",
  "gap_mean", "gap_max", "gap_std", "n_pauses", "pause_ratio", "leading_silence", "trailing_silence",
  "word_dur_cv", "articulation_rate",
];

export function utteranceFeatures(analysis) {
  const scored = analysis.phones;
  const utterance = analysis.utterance;
  const margins = scored.map((p) => p.gop_margin);
  const deletions = scored.map((p) => p.gop_del);
  const free = scored.map((p) => p.gop_af);
  const targets = scored.map((p) => p.lp_target);
  const durations = scored.map((p) => (p.end - p.start) * FRAME_SECONDS);
  const ws = wordSpans(analysis);
  const spans = [...ws.keys()].sort((a, b) => a - b).map((k) => ws.get(k));
  const gaps = [];
  for (let i = 0; i + 1 < spans.length; i++) gaps.push(Math.max(0, spans[i + 1][0] - spans[i][1]) * FRAME_SECONDS);
  const wordDurations = spans.map(([s, e]) => (e - s) * FRAME_SECONDS);
  const first = spans[0][0];
  const last = spans[spans.length - 1][1];
  const speech = Math.max(FRAME_SECONDS, (last - first) * FRAME_SECONDS);
  const pauses = gaps.filter((g) => g > PAUSE_SECONDS);
  const pauseTime = npSum(pauses);
  const frac = (xs, pred) => xs.filter(pred).length / xs.length;
  const durMean = mean(durations);
  const durStd = std(durations);
  const features = {
    gm_mean: mean(margins), gm_std: std(margins), gm_min: Math.min(...margins), gm_q10: quantile(margins, 0.1),
    del_mean: mean(deletions), del_min: Math.min(...deletions), del_q10: quantile(deletions, 0.1),
    af_mean: mean(free), af_min: Math.min(...free), af_q10: quantile(free, 0.1),
    lp_mean: mean(targets), lp_q10: quantile(targets, 0.1),
    frac_gm_below_1: frac(margins, (m) => m < -1.0), frac_gm_below_3: frac(margins, (m) => m < -3.0),
    frac_heard_other: frac(scored, (p) => p.heard !== null),
    ll_full_per_phone: utterance.ll_full_per_phone, heard_ratio: utterance.heard_ratio,
    greedy_ll_per_frame: utterance.greedy_ll_per_frame, plausible_phone_ratio: utterance.plausible_phone_ratio,
    n_phones: scored.length, n_words: spans.length, speech_seconds: speech,
    phones_per_second: scored.length / speech,
    phone_dur_mean: durMean, phone_dur_std: durStd, phone_dur_cv: durStd / Math.max(durMean, 1e-6),
    gap_mean: gaps.length ? mean(gaps) : 0.0, gap_max: gaps.length ? Math.max(...gaps) : 0.0,
    gap_std: gaps.length ? std(gaps) : 0.0,
    n_pauses: pauses.length, pause_ratio: pauseTime / speech,
    leading_silence: first * FRAME_SECONDS,
    trailing_silence: (utterance.n_frames - last) * FRAME_SECONDS,
    word_dur_cv: std(wordDurations) / Math.max(mean(wordDurations), 1e-6),
    articulation_rate: scored.length / Math.max(FRAME_SECONDS, speech - pauseTime),
  };
  return Object.fromEntries(UTTERANCE_FEATURES.map((name) => [name, Number(features[name])]));
}
