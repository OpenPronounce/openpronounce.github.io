// Grapheme to phoneme for English with CMUdict, a port of the lexicon backend of
// openpronounce/g2p.py: first pronunciation of each entry, ARPAbet mapped to the phone
// recognizer's espeak-style symbols, derived forms (plural, past tense, -ing, -ly,
// compounds), and letter-to-sound rules as a last resort (flagged as guessed).

const VOWELS = { AA: "ɑː", AE: "æ", AO: "ɔː", AW: "aʊ", AY: "aɪ", EH: "ɛ", EY: "eɪ", IH: "ɪ",
  IY: "iː", OW: "oʊ", OY: "ɔɪ", UH: "ʊ", UW: "uː" };
const CONSONANTS = { B: "b", CH: "tʃ", D: "d", DH: "ð", F: "f", G: "ɡ", HH: "h", JH: "dʒ", K: "k",
  L: "l", M: "m", N: "n", NG: "ŋ", P: "p", R: "ɹ", S: "s", SH: "ʃ", T: "t",
  TH: "θ", V: "v", W: "w", Y: "j", Z: "z", ZH: "ʒ" };
const R_COLOURED = { AA: "ɑːɹ", AO: "ɔːɹ", EH: "ɛɹ", IH: "ɪɹ", IY: "ɪɹ", UH: "ʊɹ" };
const VOICELESS = new Set(["P", "T", "K", "F", "TH"]);
const SIBILANTS = new Set(["S", "Z", "SH", "ZH", "CH", "JH"]);

const isDigit = (c) => c >= "0" && c <= "9";
const isVowel = (symbol) => symbol != null && isDigit(symbol[symbol.length - 1]);
const stripStress = (symbol) => symbol.replace(/[012]+$/, "");

/** Parse the lexicon text (``word SYM SYM ...`` per line, ``#`` comments, ``word(2)`` alternates skipped). */
export function parseLexicon(text) {
  const entries = new Map();
  for (let line of text.split("\n")) {
    line = line.split("#")[0].trim();
    if (!line) continue;
    const [word, ...symbols] = line.split(/\s+/);
    if (!word.includes("(")) entries.set(word, symbols);
  }
  return entries;
}

/** ARPAbet symbols (with stress digits) as the recognizer's phones. */
export function arpabetToPhones(symbols) {
  const out = [];
  let i = 0;
  while (i < symbols.length) {
    const symbol = symbols[i];
    const last = symbol[symbol.length - 1];
    const [base, stress] = isDigit(last) ? [symbol.slice(0, -1), last] : [symbol, null];
    const following = i + 1 < symbols.length ? symbols[i + 1] : null;
    const after = i + 2 < symbols.length ? symbols[i + 2] : null;
    if (base in R_COLOURED && following === "R" && !isVowel(after)) {
      out.push(R_COLOURED[base]);
      i += 2;
      continue;
    }
    if (base === "AH" && stress === "0" && following === "L" && !isVowel(after)) {
      out.push("əl");
      i += 2;
      continue;
    }
    if (base === "ER") out.push(stress === "1" ? "ɜː" : "ɚ");
    else if (base === "AH") out.push(stress === "0" ? "ə" : "ʌ");
    else if (base === "IY" && stress === "0" && following === null) out.push("i");
    else if (base in VOWELS) out.push(VOWELS[base]);
    else if (base === "T" && i && isVowel(symbols[i - 1]) && following !== null && following[following.length - 1] === "0") out.push("ɾ");
    else {
      if (!(base in CONSONANTS)) throw new Error(`unknown ARPAbet symbol ${symbol}`);
      out.push(CONSONANTS[base]);
    }
    i += 1;
  }
  return out;
}

function suffixed(word, lexicon, depth = 0) {
  if (lexicon.has(word)) return lexicon.get(word);
  if (depth >= 2) return null;
  const baseOf = (stem) => {
    const candidates = [stem, stem + "e"];
    if (stem.length > 2 && stem[stem.length - 1] === stem[stem.length - 2]) candidates.push(stem.slice(0, -1));
    if (stem.endsWith("i")) candidates.push(stem.slice(0, -1) + "y");
    for (const candidate of candidates) {
      const found = suffixed(candidate, lexicon, depth + 1);
      if (found && found.length) return found;
    }
    return null;
  };
  for (const ending of ["'s", "s'", "es", "s"]) {
    if (word.endsWith(ending) && word.length > ending.length + 1) {
      const base = baseOf(word.slice(0, -ending.length));
      if (base) {
        const last = stripStress(base[base.length - 1]);
        return [...base, ...(SIBILANTS.has(last) ? ["IH0", "Z"] : VOICELESS.has(last) ? ["S"] : ["Z"])];
      }
    }
  }
  for (const ending of ["ed", "d"]) {
    if (word.endsWith(ending) && word.length > ending.length + 2) {
      const base = baseOf(word.slice(0, -ending.length));
      if (base) {
        const last = stripStress(base[base.length - 1]);
        const tail = last === "T" || last === "D" ? ["IH0", "D"]
          : VOICELESS.has(last) || last === "S" || last === "SH" || last === "CH" ? ["T"] : ["D"];
        return [...base, ...tail];
      }
    }
  }
  for (const [ending, symbols] of [["ing", ["IH0", "NG"]], ["ly", ["L", "IY0"]]]) {
    if (word.endsWith(ending) && word.length > ending.length + 2) {
      const base = baseOf(word.slice(0, -ending.length));
      if (base) return [...base, ...symbols];
    }
  }
  return null;
}

function compound(word, lexicon) {
  let best = null;
  for (let cut = 3; cut < word.length - 2; cut++) {
    const head = word.slice(0, cut);
    const tail = word.slice(cut);
    const score = Math.min(cut, word.length - cut);
    if (lexicon.has(head) && lexicon.has(tail) && (best === null || score > best[0])) {
      best = [score, [...lexicon.get(head), ...lexicon.get(tail)]];
    }
  }
  return best ? best[1] : null;
}

const GRAPHEMES = [
  ["tch", ["CH"]], ["igh", ["AY1"]], ["sch", ["SH"]],
  ["ch", ["CH"]], ["sh", ["SH"]], ["th", ["TH"]], ["ph", ["F"]], ["ck", ["K"]], ["ng", ["NG"]],
  ["qu", ["K", "W"]], ["wh", ["W"]], ["ee", ["IY1"]], ["ea", ["IY1"]], ["oo", ["UW1"]], ["ou", ["AW1"]],
  ["ow", ["OW1"]], ["ai", ["EY1"]], ["ay", ["EY1"]], ["oa", ["OW1"]], ["oi", ["OY1"]], ["oy", ["OY1"]],
  ["au", ["AO1"]], ["aw", ["AO1"]], ["ie", ["IY1"]], ["ar", ["AA1", "R"]], ["er", ["ER1"]],
  ["ir", ["ER1"]], ["ur", ["ER1"]], ["or", ["AO1", "R"]],
  ["a", ["AE1"]], ["b", ["B"]], ["d", ["D"]], ["e", ["EH1"]], ["f", ["F"]], ["g", ["G"]], ["h", ["HH"]],
  ["i", ["IH1"]], ["j", ["JH"]], ["k", ["K"]], ["l", ["L"]], ["m", ["M"]], ["n", ["N"]], ["o", ["AA1"]],
  ["p", ["P"]], ["q", ["K"]], ["r", ["R"]], ["s", ["S"]], ["t", ["T"]], ["u", ["AH1"]], ["v", ["V"]],
  ["w", ["W"]], ["x", ["K", "S"]], ["z", ["Z"]],
];

/** Rough letter-to-sound rules, for words no dictionary entry explains. Always a guess. */
export function spelled(word) {
  let letters = word.replace(/[^a-z]/g, "");
  letters = letters.replace(/([b-df-hj-np-tv-z])\1/g, "$1");
  if (letters.length > 3 && letters.endsWith("e") && !"aeiou".includes(letters[letters.length - 2])) {
    letters = letters.slice(0, -1);
  }
  const out = [];
  let i = 0;
  while (i < letters.length) {
    if (letters[i] === "c") {
      out.push(["e", "i", "y"].includes(letters.slice(i + 1, i + 2)) ? "S" : "K");
      i += 1;
      continue;
    }
    if (letters[i] === "y") {
      out.push(i === 0 ? "Y" : i === letters.length - 1 ? "IY0" : "IH1");
      i += 1;
      continue;
    }
    if (letters[i] === "i" && i === letters.length - 1 && i) {
      out.push("IY0");
      i += 1;
      continue;
    }
    const match = GRAPHEMES.find(([grapheme]) => letters.startsWith(grapheme, i));
    if (match) {
      out.push(...match[1]);
      i += match[0].length;
    } else {
      i += 1;
    }
  }
  return out;
}

const ONES = ("zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen "
  + "seventeen eighteen nineteen").split(" ");
const TENS = "twenty thirty forty fifty sixty seventy eighty ninety".split(" ");

/** English words of a non-negative integer below one billion. */
export function numberWords(n) {
  if (n < 20) return [ONES[n]];
  if (n < 100) return [TENS[Math.floor(n / 10) - 2], ...(n % 10 ? [ONES[n % 10]] : [])];
  if (n < 1000) return [ONES[Math.floor(n / 100)], "hundred", ...(n % 100 ? numberWords(n % 100) : [])];
  for (const [size, name] of [[1e6, "million"], [1e3, "thousand"]]) {
    if (n >= size) return [...numberWords(Math.floor(n / size)), name, ...(n % size ? numberWords(n % size) : [])];
  }
  throw new Error(`number too large: ${n}`);
}

// Python's ``\b[\w']+\b``: runs of letters, digits, underscores and apostrophes, without
// apostrophes at either end.
const RUN_RE = /[\p{L}\p{N}_']+/gu;

/** Lower-case words of ``text``, punctuation dropped (``g2p.words_of``). */
export function wordsOf(text) {
  const words = [];
  for (const [run] of text.matchAll(RUN_RE)) {
    const word = run.replace(/^'+|'+$/g, "");
    if (word) words.push(word.toLowerCase());
  }
  return words;
}

/** The English lexicon backend: ``phonesByWord(text)`` and ``isGuessed(word)``. */
export class LexiconG2P {
  constructor(lexicon) {
    this.lexicon = lexicon;
    this.cache = new Map();
  }

  /** ``{phones, guessed}`` of one lower-case word. */
  word(word) {
    let hit = this.cache.get(word);
    if (hit) return hit;
    const lexicon = this.lexicon;
    if (/^[0-9]+$/.test(word)) {
      const spoken = word.length <= 9 && !(word.length > 1 && word[0] === "0")
        ? numberWords(Number(word)) : Array.from(word, (d) => ONES[Number(d)]);
      hit = { phones: spoken.flatMap((w) => arpabetToPhones(lexicon.get(w))), guessed: false };
    } else {
      const symbols = suffixed(word, lexicon) || suffixed(word.replaceAll("'", ""), lexicon) || compound(word, lexicon);
      hit = symbols && symbols.length
        ? { phones: arpabetToPhones(symbols), guessed: false }
        : { phones: arpabetToPhones(spelled(word)), guessed: true };
    }
    this.cache.set(word, hit);
    return hit;
  }

  /** ``{words, groups}``: lower-case words of ``text`` and their phones, as the backend writes them. */
  phonesByWord(text) {
    const words = wordsOf(text);
    return { words, groups: words.map((w) => this.word(w).phones) };
  }

  isGuessed(word) {
    return this.word(word.toLowerCase()).guessed;
  }
}
