// The language registry of openpronounce/languages.py, reduced to what the scoring reads.

export const LANGUAGES = {
  en: { code: "en", espeak: "en-us", name: "English", variants: {}, wordThreshold: null },
  fr: { code: "fr", espeak: "fr-fr", name: "French", variants: {}, wordThreshold: 0.09 },
  es: { code: "es", espeak: "es", name: "Spanish", variants: {}, wordThreshold: 0.07 },
  de: { code: "de", espeak: "de", name: "German", variants: {}, wordThreshold: 0.06 },
  it: { code: "it", espeak: "it", name: "Italian", variants: { "ɪ": ["i"], "ʊ": ["u"] }, wordThreshold: 0.22 },
  pt: { code: "pt", espeak: "pt-br", name: "Portuguese",
    variants: { "æ": ["ɐ"], y: ["ɨ", "i"], r: ["ʁ"], x: ["ʁ"] }, wordThreshold: 0.15 },
  nl: { code: "nl", espeak: "nl", name: "Dutch",
    variants: { "ʋ": ["v"], "ɣ": ["x"], "ɛɪ": ["aɪ"], "œy": ["aʊ"], "ʌʊ": ["aʊ"], "ɑ": ["ɔ", "a"], "ɪː": ["eː"],
      "ɔː": ["oː"], "ɵ": ["ə", "y", "ʊ"] }, wordThreshold: 0.08 },
};

export function getLanguage(code) {
  const lang = LANGUAGES[code];
  if (!lang) throw new Error(`unsupported language ${JSON.stringify(code)}, expected one of: ${Object.keys(LANGUAGES).join(", ")}`);
  return lang;
}

export function accepted(lang, phone) {
  return Object.prototype.hasOwnProperty.call(lang.variants, phone) ? lang.variants[phone] : [];
}
