// Phone comparison of a recognition with the expected sentence: the GOP word reports and
// the rule-based fallback of openpronounce/phones.py (compare_phones and helpers).

import * as gop from "./gop.js";
import { distance, opcodes } from "./levenshtein.js";
import { getLanguage } from "./languages.js";
import { pyRound } from "./numeric.js";
import { ALTERNATE_PRONUNCIATIONS, normalizePhone, normalizePhones, substitutionCost, tokenIdsByPhone } from "./phones.js";

export const PHONE_ERROR_THRESHOLD = 0.4;
export const PHONE_ERROR_MIN_EDITS = 2;
export const NEAR_PHONE_COST = 0.5;
export const FINAL_EXTRA_COST = 0.25;
export const FINAL_DELETION_COST = 0.5;
export const PHONE_PLAUSIBLE_POSTERIOR = 0.05;
export const UNRELIABLE_LOG_LIKELIHOOD = -4.0;
export const UNRELIABLE_PLAUSIBLE_RATIO = 0.3;

const r3 = (x) => pyRound(x, 3);

/** ``{words, groups}`` normalized for ``lang`` (or raw with ``normalize=false``). */
export function expectedPhones(g2p, text, lang, normalize = true) {
  const { words, groups } = g2p.phonesByWord(text);
  return { words, groups: normalize ? groups.map((g) => normalizePhones(g, lang)) : groups.map((g) => [...g]) };
}

function align(expected, heard) {
  const alignment = expected.map(() => new Set());
  for (const [tag, i1, i2, j1, j2] of opcodes(expected, heard)) {
    if (tag === "equal") {
      for (let k = i1, l = j1; k < i2 && l < j2; k++, l++) alignment[k].add(l);
    } else if (tag === "replace") {
      const lenI = i2 - i1;
      const lenJ = j2 - j1;
      for (let k = i1; k < i2; k++) {
        const start = j1 + Math.trunc(((k - i1) * lenJ) / lenI);
        const end = j1 + Math.trunc(((k - i1 + 1) * lenJ) / lenI);
        if (start === end) alignment[k].add(Math.min(start, j2 - 1));
        else for (let l = start; l < end; l++) alignment[k].add(l);
      }
    } else if (tag === "insert") {
      const k = i1 > 0 ? i1 - 1 : i1;
      if (k < alignment.length) for (let l = j1; l < j2; l++) alignment[k].add(l);
    }
  }
  return alignment;
}

function pronunciations(word, expectedSeg, previousLastPhone, lang) {
  const alternates = ALTERNATE_PRONUNCIATIONS[lang]?.[word] ?? [];
  const candidates = [[...expectedSeg], ...alternates.map((alt) => normalizePhones(alt, lang))];
  if (previousLastPhone !== null && expectedSeg.length > 1 && expectedSeg[0] === previousLastPhone) {
    candidates.push(expectedSeg.slice(1));
  }
  return candidates;
}

function plausibility(recognition, phone, start, end, lang) {
  if (!recognition || end <= start) return 0.0;
  const ids = tokenIdsByPhone(recognition.vocab, lang).get(phone);
  if (!ids) return 0.0;
  const { data, classes } = recognition.logp;
  let m = -Infinity;
  for (let t = start; t < end; t++) for (const id of ids) m = Math.max(m, data[t * classes + id]);
  return Math.exp(m);
}

function phoneReports(candidate, actual, matched, recognition, region, lang) {
  const local = align(candidate, actual);
  const spans = recognition ? recognition.spans : null;
  const frames = (j) => (spans ? spans[matched[j]] : [0, 0]);
  const reports = [];
  const last = candidate.length - 1;
  candidate.forEach((expected, k) => {
    const heardIndices = [...local[k]].sort((a, b) => a - b);
    const heard = heardIndices.map((j) => actual[j]);
    let confidence;
    if (heard.length === 1 && heard[0] === expected) {
      confidence = 0.0;
    } else if (heard.includes(expected)) {
      confidence = k === last ? FINAL_EXTRA_COST : 1.0;
    } else {
      let cost;
      let start;
      let end;
      if (heard.length) {
        cost = Math.max(...heard.map((h) => substitutionCost(expected, h, lang, NEAR_PHONE_COST)));
        start = Math.min(...heardIndices.map((j) => frames(j)[0]));
        end = Math.max(...heardIndices.map((j) => frames(j)[1]));
      } else {
        cost = k === last ? FINAL_DELETION_COST : 1.0;
        const previous = [];
        for (let kk = 0; kk < k; kk++) previous.push(...local[kk]);
        const following = [];
        for (let kk = k + 1; kk < candidate.length; kk++) following.push(...local[kk]);
        start = previous.length ? frames(Math.max(...previous))[0] : region[0];
        end = following.length ? frames(Math.min(...following))[1] : region[1];
      }
      const p = plausibility(recognition, expected, start, end, lang);
      confidence = cost * (1.0 - Math.min(1.0, p / PHONE_PLAUSIBLE_POSTERIOR));
    }
    reports.push({ expected, heard: heard.join(""), confidence });
  });
  return reports;
}

function wordReports(recognition, text, g2p, lang) {
  const heard = recognition.phones;
  const nFrames = recognition.logp.frames;
  const { words, groups } = expectedPhones(g2p, text, lang);
  const expected = groups.flat();
  const alignment = align(expected, heard);
  const reports = [];
  let offset = 0;
  let previousLastPhone = null;
  words.forEach((word, position) => {
    const group = groups[position];
    if (!group.length) return;
    const indices = [];
    for (let i = offset; i < offset + group.length; i++) indices.push(i);
    offset += group.length;
    const matchedSet = new Set();
    for (const i of indices) for (const j of alignment[i]) matchedSet.add(j);
    const matched = [...matchedSet].sort((a, b) => a - b);
    const actual = matched.map((j) => heard[j]);
    const candidates = pronunciations(word, group, previousLastPhone, lang);
    const distances = candidates.map((c) => distance(c, actual));
    const dist = Math.min(...distances);
    const candidate = candidates[distances.indexOf(dist)];
    previousLastPhone = group[group.length - 1];
    let region;
    if (matched.length) {
      region = [recognition.spans[matched[0]][0], recognition.spans[matched[matched.length - 1]][1]];
    } else {
      const before = [];
      for (let i = 0; i < indices[0]; i++) before.push(...alignment[i]);
      const after = [];
      for (let i = indices[indices.length - 1] + 1; i < expected.length; i++) after.push(...alignment[i]);
      region = [before.length ? recognition.spans[Math.max(...before)][0] : 0,
        after.length ? recognition.spans[Math.min(...after)][1] : nFrames];
    }
    const phones = dist ? phoneReports(candidate, actual, matched, recognition, region, lang) : [];
    reports.push({ position, word, expected: [...group], actual, distance: dist, phones,
      weighted_edits: phones.reduce((a, p) => a + p.confidence, 0) });
  });
  return reports;
}

function rescale(probability, source, target) {
  if (probability < source) return (probability * target) / source;
  return target + ((probability - source) * (1.0 - target)) / (1.0 - source);
}

function gopWordReports(recognition, words, groups, rawGroups, lang, threshold, models, g2p) {
  const model = models.wordModel;
  if (!model) return null;
  if (model.hiddenLayer !== null && !recognition.hidden) return null;
  const analysis = gop.analyze(recognition.logp, recognition.vocab, rawGroups, words, lang, recognition.hidden);
  if (!analysis) return null;
  const { phoneProbabilities, wordProbabilities } = model.predict(analysis);
  if (threshold === null || threshold === undefined) threshold = model.threshold;
  const bundle = { analysis, phoneProbabilities, wordProbabilities, threshold };
  let reportProbabilities = wordProbabilities;
  const languageThreshold = model.generic ? getLanguage(lang).wordThreshold : null;
  if (languageThreshold) {
    reportProbabilities = new Map([...wordProbabilities].map(([w, p]) => [w, rescale(p, languageThreshold, model.threshold)]));
  }
  const missingModel = models.missingModel;
  const missing = missingModel ? missingModel.predict(analysis, recognition.spans, recognition.confidences) : new Map();
  bundle.extra = gop.extraSpeech(analysis, recognition.spans, recognition.confidences).map((event) => ({
    after: event.after, before: event.before,
    start: r3(event.start * gop.FRAME_SECONDS), end: r3(event.end * gop.FRAME_SECONDS),
    heard: event.heard.map((i) => recognition.phones[i]),
  }));
  const byWord = new Map();
  analysis.phones.forEach((scored, i) => {
    if (!byWord.has(scored.word_index)) byWord.set(scored.word_index, []);
    byWord.get(scored.word_index).push([scored, phoneProbabilities[i]]);
  });
  const reports = [];
  for (const position of [...byWord.keys()].sort((a, b) => a - b)) {
    const items = byWord.get(position);
    const start = Math.min(...items.map(([s]) => s.start));
    const end = Math.max(...items.map(([s]) => s.end));
    const actual = recognition.phones.filter((_, i) => recognition.spans[i][0] < end && recognition.spans[i][1] > start);
    const phones = items.map(([scored, probability]) => {
      const expectedPhone = normalizePhone(scored.phone, lang);
      let heard;
      if (probability < 0.5) heard = expectedPhone;
      else if (scored.heard === null) heard = "";
      else heard = normalizePhone(recognition.vocab[scored.heard], lang);
      return { expected: expectedPhone, heard, confidence: r3(probability),
        start: r3(scored.start * gop.FRAME_SECONDS), end: r3(scored.end * gop.FRAME_SECONDS) };
    });
    const probability = reportProbabilities.get(position);
    const report = {
      position, word: words[position], expected: [...groups[position]], actual,
      start: r3(start * gop.FRAME_SECONDS), end: r3(end * gop.FRAME_SECONDS),
      confidence: r3(probability), mispronounced: probability >= threshold, phones,
    };
    if (missing.has(position)) {
      report.missing_confidence = r3(missing.get(position));
      if (missing.get(position) >= missingModel.threshold) Object.assign(report, { mispronounced: true, missing: true });
    }
    if (g2p.isGuessed(words[position])) {
      Object.assign(report, { mispronounced: false, guessed: true });
      delete report.missing;
    }
    reports.push(report);
  }
  const utterance = analysis.utterance;
  const reliability = {
    log_likelihood_per_phone: r3(utterance.ll_full_per_phone),
    plausible_phone_ratio: r3(utterance.plausible_phone_ratio),
  };
  reliability.reliable = reliability.log_likelihood_per_phone >= UNRELIABLE_LOG_LIKELIHOOD
    && reliability.plausible_phone_ratio >= UNRELIABLE_PLAUSIBLE_RATIO;
  return { reports, reliability, bundle };
}

/** ``phones.compare_phones(recognition, text, return_analysis=True)``: ``{result, bundle}``. */
export function comparePhones(recognition, text, { lang = "en", threshold = null, useModel = true, models, g2p }) {
  const heard = recognition.phones;
  const heardConfidences = recognition.confidences;
  const { words, groups } = expectedPhones(g2p, text, lang);
  const expected = groups.flat();
  const phoneErrorRate = expected.length ? distance(expected, heard) / expected.length : heard.length ? 1.0 : 0.0;
  let gopReports = null;
  if (useModel) {
    const raw = expectedPhones(g2p, text, lang, false).groups;
    gopReports = gopWordReports(recognition, words, groups, raw, lang, threshold, models, g2p);
  }
  if (gopReports) {
    const { reports, reliability, bundle } = gopReports;
    const errors = reports.filter((r) => r.mispronounced).map((r) => ({
      position: r.position, word: r.word, expected: r.expected.join(""), actual: r.actual.join(""), actual_word: "",
      phone_distance: distance(r.expected, r.actual), confidence: r.confidence, phones: r.phones,
      ...(r.missing ? { missing: true } : {}),
    }));
    const result = {
      expected_phones: groups.map((g) => [...g]), heard_phones: heard,
      heard_phones_confidence: heardConfidences.map(r3), phone_error_rate: pyRound(phoneErrorRate, 4),
      errors, words_with_errors: errors.map((e) => e.word), words: reports, extra: bundle.extra, alignment: reliability,
    };
    return { result, bundle };
  }
  const errors = [];
  const wordsWithErrors = [];
  for (const report of wordReports(recognition, text, g2p, lang)) {
    const edits = report.weighted_edits;
    const length = report.expected.length;
    if (g2p.isGuessed(report.word)) continue;
    if (report.distance && (edits / length >= PHONE_ERROR_THRESHOLD || edits >= PHONE_ERROR_MIN_EDITS)) {
      errors.push({
        position: report.position, word: report.word, expected: report.expected.join(""), actual: report.actual.join(""),
        actual_word: "", phone_distance: report.distance,
        confidence: r3(Math.min(1.0, Math.max(edits / length, edits / PHONE_ERROR_MIN_EDITS))),
        phones: report.phones.map((p) => ({ ...p, confidence: r3(p.confidence) })),
      });
      wordsWithErrors.push(report.word);
    }
  }
  const result = {
    expected_phones: groups.map((g) => [...g]), heard_phones: heard,
    heard_phones_confidence: heardConfidences.map(r3), phone_error_rate: pyRound(phoneErrorRate, 4),
    errors, words_with_errors: wordsWithErrors,
  };
  return { result, bundle: null };
}
