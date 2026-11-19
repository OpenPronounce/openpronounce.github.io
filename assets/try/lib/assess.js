// Read-speech assessment: openpronounce.compare_audio_with_text with acoustic=False and
// transcription=False (the phone recognizer alone), on a recognition computed elsewhere.

import { quality } from "./audio.js";
import { comparePhones } from "./compare.js";
import { decodeCtc } from "./phones.js";
import { prosodyContours } from "./prosody.js";
import { features } from "./scorer.js";

export const EXTRA_SPEECH_MIN_PHONES = 5;
export const EXTRA_SPEECH_RATIO = 0.25;

export function feedback(wordsWithErrors) {
  let text = "🔊 Feedback on your pronunciation:\n";
  if (wordsWithErrors.length) text += "❌ You need to better pronounce these words: " + wordsWithErrors.join(", ") + "\n";
  else text += "✅ Your pronunciation is excellent! 🎉\n";
  return text;
}

/** log-softmax over the last axis of ``(frames, classes)`` logits, in place into a new Float32Array. */
export function logSoftmax(logits, frames, classes) {
  const out = new Float32Array(frames * classes);
  for (let t = 0; t < frames; t++) {
    const o = t * classes;
    let m = -Infinity;
    for (let c = 0; c < classes; c++) m = Math.max(m, logits[o + c]);
    let s = 0;
    for (let c = 0; c < classes; c++) s += Math.exp(logits[o + c] - m);
    const lse = Math.log(s);
    for (let c = 0; c < classes; c++) out[o + c] = logits[o + c] - m - lse;
  }
  return out;
}

/**
 * Assess ``waveform`` (Float32Array, 16 kHz mono) against ``text`` given the phone model's
 * outputs: ``logp`` ``{data, frames, classes}`` log posteriors and ``hidden`` ``{data, frames, dim}``.
 * ``models`` holds ``wordModel``, ``missingModel``, ``scorer``, ``vocab``; ``g2p`` the G2P backend.
 */
export function assessFromPosteriors(waveform, text, { logp, hidden }, { models, g2p, lang = "en", prosody = false,
  threshold = null, sampleRate = 16000 } = {}) {
  const vocab = models.vocab;
  const blank = Math.max(0, vocab.indexOf("<pad>"));
  const recognition = decodeCtc(logp, vocab, blank, lang, true, hidden);
  const differences = { transcribe: null, word_error_rate: null, phoneme_error_rate: null, errors: [],
    words_with_errors: [], feedback: "" };
  const { result: phoneResult, bundle } = comparePhones(recognition, text, { lang, threshold, models, g2p });
  Object.assign(differences, {
    errors: phoneResult.errors,
    words_with_errors: phoneResult.words_with_errors,
    phoneme_error_rate: phoneResult.phone_error_rate,
    expected_phones: phoneResult.expected_phones,
    heard_phones: phoneResult.heard_phones,
    heard_phones_confidence: phoneResult.heard_phones_confidence,
    feedback: feedback(phoneResult.words_with_errors),
  });
  for (const key of ["words", "extra", "alignment"]) if (key in phoneResult) differences[key] = phoneResult[key];
  let scores = null;
  let featureDict = null;
  if (bundle && models.scorer) {
    featureDict = features(bundle.analysis, bundle.phoneProbabilities, bundle.wordProbabilities, bundle.threshold,
      waveform, sampleRate);
    scores = models.scorer.score(featureDict);
    if ("sentence_probability" in scores) {
      const probability = scores.sentence_probability;
      delete scores.sentence_probability;
      differences.alignment.sentence_probability = probability;
      differences.alignment.reliable = probability >= 0.5;
    }
  }
  const audioQuality = quality(waveform, sampleRate);
  const reasons = audioQuality.issues.map((issue) => `recording ${issue.replaceAll("_", " ")}`);
  const reports = differences.words ?? [];
  const missing = reports.filter((w) => w.missing).map((w) => w.word);
  if (!(differences.alignment?.reliable ?? true)) {
    if (missing.length && 2 * missing.length <= reports.length) reasons.unshift("not said: " + missing.join(", "));
    else reasons.unshift("the recording does not match the sentence");
  }
  const unexpected = (differences.extra ?? []).reduce((a, e) => a + e.heard.length, 0);
  const expectedCount = reports.reduce((a, w) => a + w.expected.length, 0);
  if (unexpected >= Math.max(EXTRA_SPEECH_MIN_PHONES, EXTRA_SPEECH_RATIO * expectedCount)) {
    reasons.push("speech that is not in the sentence");
  }
  const result = {
    score: scores ? scores.total : null,
    scores,
    formula_score: null,
    distance: null,
    acoustic_distance: null,
    differences,
    feedback: differences.feedback,
    transcribe: null,
    language: lang,
    audio_quality: audioQuality,
    reliable: reasons.length === 0,
    reasons,
  };
  if (prosody) result.prosody = prosodyContours(waveform, sampleRate);
  Object.defineProperty(result, "_features", { value: featureDict, enumerable: false });
  return result;
}
