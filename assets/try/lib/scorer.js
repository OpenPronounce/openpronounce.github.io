// Utterance scores learned from human ratings (openpronounce/scorer.py), read path only.

import { UTTERANCE_FEATURES, utteranceFeatures } from "./gop.js";
import { LogisticModel, MODEL_TYPES } from "./models.js";
import { PROSODY_FEATURES, prosodyFeatures } from "./prosody.js";
import { npMean, pyRound } from "./numeric.js";

export const TARGETS = ["total", "accuracy", "fluency", "prosodic"];
export const MODEL_FEATURES = ["p_phone_mean", "p_phone_max", "frac_phone_bad", "p_word_mean", "p_word_max", "frac_word_bad",
  "n_word_bad"];
export const FEATURES = [...UTTERANCE_FEATURES, ...MODEL_FEATURES, ...PROSODY_FEATURES];

export function modelFeatures(phoneProbabilities, wordProbabilities, threshold) {
  const p = phoneProbabilities;
  const w = [...wordProbabilities.values()];
  const nBad = w.filter((q) => q >= threshold).length;
  return {
    p_phone_mean: npMean(p), p_phone_max: Math.max(...p), frac_phone_bad: p.filter((q) => q >= 0.5).length / p.length,
    p_word_mean: npMean(w), p_word_max: Math.max(...w), frac_word_bad: nBad / w.length, n_word_bad: nBad,
  };
}

/** Every scorer feature of an utterance, keyed like FEATURES. */
export function features(analysis, phoneProbabilities, wordProbabilities, threshold, waveform, sr = 16000) {
  return { ...utteranceFeatures(analysis), ...modelFeatures(phoneProbabilities, wordProbabilities, threshold),
    ...prosodyFeatures(waveform, sr) };
}

class EmbeddingHead {
  constructor(data) {
    this.layer = data.layer;
    this.share = Number(data.share);
    this.center = data.center;
    this.scale = data.scale;
    this.weights = data.weights;
    this.intercept = data.intercept;
    this.calibration = data.calibration ?? {};
  }

  predict(embedding, target) {
    let s = this.intercept[target];
    const w = this.weights[target];
    for (let i = 0; i < embedding.length; i++) s += ((embedding[i] - this.center[i]) / this.scale[i]) * w[i];
    return s;
  }
}

/** One regression model per target (``scorer_<lang>.json``), optional embedding head and sentence match model. */
export class Scorer {
  constructor(data) {
    this.data = data;
    this.features = data.features;
    this.models = Object.fromEntries(Object.entries(data.models).map(([t, m]) => [t, new MODEL_TYPES[m.type](m)]));
    this.calibration = data.calibration ?? {};
    this.embedding = data.embedding ? new EmbeddingHead(data.embedding) : null;
    this.sentenceMatch = data.sentence_match ? new LogisticModel(data.sentence_match) : null;
    this.shift = {};
  }

  /** Scores on the raters' 0-10 scale. ``embedding`` (pooled hidden states) is blended in when the scorer has a head for it. */
  predict(featureDict, embedding = null) {
    const row = this.features.map((name) => {
      if (!(name in featureDict)) throw new Error(`missing scorer feature ${name}`);
      return featureDict[name];
    });
    const head = embedding && this.embedding ? this.embedding : null;
    const out = {};
    for (const [target, model] of Object.entries(this.models)) {
      let raw = model.predict([row])[0];
      let [a, b] = this.calibration[target] ?? [1.0, 0.0];
      if (head) {
        raw = (1.0 - head.share) * raw + head.share * head.predict(embedding, target);
        [a, b] = head.calibration[target] ?? [1.0, 0.0];
      }
      out[target] = Math.min(10, Math.max(0, a * raw + b));
    }
    return out;
  }

  matchProbability(featureDict) {
    if (!this.sentenceMatch) return null;
    const row = this.sentenceMatch.features.map((name) => featureDict[name]);
    return this.sentenceMatch.predict([row])[0];
  }

  /** ``scorer.score``: 0-100 scores and ``sentence_probability`` (rounded as in Python). */
  score(featureDict) {
    if (this.data.lang === "generic" && Object.keys(this.shift).length) {
      featureDict = { ...featureDict };
      for (const [name, delta] of Object.entries(this.shift)) if (name in featureDict) featureDict[name] += delta;
    }
    const scores = Object.fromEntries(Object.entries(this.predict(featureDict)).map(([t, v]) => [t, pyRound(10.0 * v, 1)]));
    if (this.sentenceMatch) scores.sentence_probability = pyRound(this.matchProbability(featureDict), 3);
    return scores;
  }
}
