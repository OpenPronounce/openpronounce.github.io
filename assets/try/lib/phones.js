// Phone normalization and greedy CTC decoding, a port of the parts of
// openpronounce/phones.py the read-speech path needs.

export const TOKEN_ALIASES = { th: "t", kh: "k", ph: "p", "tʰ": "t", "kʰ": "k", "pʰ": "p",
  ai: "aɪ", ei: "eɪ", au: "aʊ", ou: "oʊ" };

export const PHONE_MAP = {
  en: { "ᵻ": "ɪ", "ɐ": "ə", "ɔ": "ɑ", "ɔɹ": "oɹ", "ɜ": "ɚ", "ɾ": "t", "ɫ": "l" },
  fr: { "ɛ": "e", "œ": "ø", "ə": "ø", "ɔ": "o" },
};

const set = (...xs) => new Set(xs);
export const NEAR_PHONES = {
  fr: [set("e", "i"), set("ø", "y"), set("ø", "e"), set("o", "u"), set("ɑ̃", "ɔ̃"), set("ɛ̃", "ɑ̃"), set("ʁ", "r", "ɹ"),
    set("b", "p"), set("d", "t"), set("ɡ", "k"), set("z", "s"), set("v", "f"), set("ʒ", "ʃ")],
  en: [set("ɪ", "i"), set("ʊ", "u"), set("ɛ", "æ"), set("ʌ", "ɑ", "ə", "a"), set("æ", "a"), set("ɛ", "eɪ"),
    set("ð", "z", "d"), set("θ", "s", "t"), set("b", "p"), set("d", "t"), set("ɡ", "k"), set("z", "s"),
    set("v", "f"), set("ʒ", "ʃ"), set("dʒ", "tʃ"), set("n", "ŋ"), set("h", "x"), set("ɹ", "r"), set("v", "w")],
};

export const ALTERNATE_PRONUNCIATIONS = {
  en: {
    a: [["ə"], ["eɪ"]], an: [["ən"], ["æn"]], the: [["ð", "ə"], ["ð", "i"], ["ð", "ɪ"]], to: [["t", "ə"], ["t", "u"]],
    of: [["ʌ", "v"], ["ə", "v"]], and: [["æ", "n", "d"], ["ə", "n", "d"], ["ə", "n"]], for: [["f", "ɔ", "ɹ"], ["f", "ɚ"]],
    you: [["j", "u"], ["j", "ə"]], are: [["ɑ", "ɹ"], ["ɚ"]], was: [["w", "ʌ", "z"], ["w", "ə", "z"]],
    that: [["ð", "æ", "t"], ["ð", "ə", "t"]], can: [["k", "æ", "n"], ["k", "ə", "n"]], have: [["h", "æ", "v"], ["h", "ə", "v"]],
    or: [["ɔ", "ɹ"], ["ɚ"]],
  },
  fr: { je: [["ʒ"]], le: [["l"]], de: [["d"]], ne: [["n"]], ce: [["s"]], se: [["s"]], me: [["m"]], te: [["t"]], que: [["k"]] },
};

// Python's ``\d`` on str matches every Unicode decimal digit.
const TONE_RE = /\p{Nd}/gu;
const own = (obj, key) => (Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined);

/** Canonical form of a phone: no length mark, no tone digit, merged near-identical phones of ``lang``. */
export function normalizePhone(phone, lang = "en") {
  phone = phone.replaceAll("ː", "").replace(TONE_RE, "");
  phone = own(TOKEN_ALIASES, phone) ?? phone;
  return own(PHONE_MAP[lang] ?? {}, phone) ?? phone;
}

/** ``[phone, sourceIndices]`` per surviving phone after normalization and collapse of repetitions. */
export function normalizeIndexed(phones, lang = "en") {
  const out = [];
  phones.forEach((raw, index) => {
    const phone = normalizePhone(raw, lang);
    if (!phone) return;
    const last = out[out.length - 1];
    if (last && (last[0] === phone || (last[0] === "ɚ" && phone === "ɹ"))) {
      last[1].push(index);
      return;
    }
    out.push([phone, [index]]);
  });
  return out;
}

export function normalizePhones(phones, lang = "en") {
  return normalizeIndexed(phones, lang).map(([p]) => p);
}

export const isSpecial = (token) => token.startsWith("<") && token.endsWith(">");

/**
 * Greedy CTC decoding of ``logp`` (``{data, frames, classes}`` log posteriors). Returns a
 * recognition ``{phones, confidences, spans, logp, vocab, hidden}``.
 */
export function decodeCtc(logp, vocab, blankId = 0, lang = "en", normalize = true, hidden = null) {
  const { data, frames, classes } = logp;
  const ids = new Int32Array(frames);
  for (let t = 0; t < frames; t++) {
    let best = 0;
    let bestValue = -Infinity;
    for (let c = 0; c < classes; c++) {
      const v = data[t * classes + c];
      if (v > bestValue) {
        bestValue = v;
        best = c;
      }
    }
    ids[t] = best;
  }
  const tokens = [];
  const confidences = [];
  const spans = [];
  let start = 0;
  for (let end = 1; end <= frames; end++) {
    if (end < frames && ids[end] === ids[start]) continue;
    const id = ids[start];
    const token = vocab[id];
    if (id !== blankId && !isSpecial(token)) {
      let peak = -Infinity;
      for (let t = start; t < end; t++) peak = Math.max(peak, data[t * classes + id]);
      tokens.push(token);
      confidences.push(Math.exp(peak));
      spans.push([start, end]);
    }
    start = end;
  }
  if (!normalize) return { phones: tokens, confidences, spans, logp, vocab, hidden, greedy: ids };
  const phones = [];
  const merged = [];
  const mergedSpans = [];
  for (const [phone, sources] of normalizeIndexed(tokens, lang)) {
    phones.push(phone);
    merged.push(Math.max(...sources.map((i) => confidences[i])));
    mergedSpans.push([spans[sources[0]][0], spans[sources[sources.length - 1]][1]]);
  }
  return { phones, confidences: merged, spans: mergedSpans, logp, vocab, hidden, greedy: ids };
}

const tokenIdsCache = new Map();

/** Every normalized phone mapped to the ids of the vocabulary tokens that normalize to it. */
export function tokenIdsByPhone(vocab, lang = "en") {
  const key = lang;
  let ids = tokenIdsCache.get(vocab)?.get(key);
  if (ids) return ids;
  ids = new Map();
  vocab.forEach((token, index) => {
    if (isSpecial(token)) return;
    const phone = normalizePhone(token, lang);
    if (!ids.has(phone)) ids.set(phone, []);
    ids.get(phone).push(index);
  });
  if (!tokenIdsCache.has(vocab)) tokenIdsCache.set(vocab, new Map());
  tokenIdsCache.get(vocab).set(key, ids);
  return ids;
}

export function substitutionCost(expected, heard, lang, nearCost) {
  for (const group of NEAR_PHONES[lang] ?? []) {
    if (group.has(expected) && group.has(heard)) return nearCost;
  }
  return 1.0;
}
