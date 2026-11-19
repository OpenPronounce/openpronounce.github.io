// OpenPronounce in the browser: read-speech assessment with a distilled wav2vec2 phone
// model run by onnxruntime-web, and the scoring pipeline of the Python library.
//
//   import * as ort from "onnxruntime-web";
//   import { createAssessor } from "openpronounce";
//   const assessor = await createAssessor({ ort, modelUrl: "models/student.int8.onnx", dataUrl: "models/" });
//   const result = await assessor.assess(samples16k, "The quick brown fox");

import { assessFromPosteriors, logSoftmax } from "./assess.js";
import { normalizeInput } from "./audio.js";
import { LexiconG2P, parseLexicon } from "./g2p.js";
import { MissingModel, WordModel } from "./gop.js";
import { Scorer } from "./scorer.js";

export { assessFromPosteriors, logSoftmax } from "./assess.js";
export { decodeToMono16k, mixDown, parseWav, quality } from "./audio.js";
export { LexiconG2P, parseLexicon, wordsOf } from "./g2p.js";
export { MissingModel, WordModel } from "./gop.js";
export { Scorer } from "./scorer.js";

/** Build the model bundle from parsed JSON objects. */
export function loadModels({ vocab, wordModel, missingModel = null, scorer = null }) {
  return {
    vocab,
    wordModel: new WordModel(wordModel),
    missingModel: missingModel ? new MissingModel(missingModel) : null,
    scorer: scorer ? new Scorer(scorer) : null,
  };
}

async function gunzipText(response) {
  const name = response.url ?? "";
  // A server may have decoded the file already (Content-Encoding: gzip): look at the magic bytes.
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).text();
  }
  if (name.endsWith(".gz")) console.warn("openpronounce: expected gzip data at", name);
  return new TextDecoder().decode(bytes);
}

/** Run the phone model: ``{logp, hidden}`` for a 16 kHz waveform. */
export async function runPhoneModel(ort, session, waveform) {
  const input = new ort.Tensor("float32", normalizeInput(waveform), [1, waveform.length]);
  const out = await session.run({ input_values: input }, ["logits", "hidden20"]);
  const [, frames, classes] = out.logits.dims;
  const dim = out.hidden20.dims[2];
  const logp = { data: logSoftmax(out.logits.data, frames, classes), frames, classes };
  const hidden = { data: out.hidden20.data, frames, dim };
  out.logits.dispose?.();
  input.dispose?.();
  return { logp, hidden };
}

/**
 * Load everything and return ``{assess(waveform, sentence, options), session, models, g2p}``.
 *
 * ``ort`` is the onnxruntime-web module. ``modelUrl`` the ONNX student (or ``modelBytes``).
 * ``dataUrl`` a base URL holding ``vocab.json``, ``word_mdd_en.json``, ``word_missing_generic.json``,
 * ``scorer_en.json`` and ``cmudict.txt.gz``; any of them can be overridden with ``files``.
 * ``executionProviders`` defaults to ``["wasm"]``; pass ``["webgpu", "wasm"]`` to try WebGPU first.
 */
export async function createAssessor({ ort, modelUrl, modelBytes, dataUrl = "./", files = {}, executionProviders = ["wasm"],
  fetchFn = globalThis.fetch, onProgress = null } = {}) {
  const url = (name) => files[name] ?? new URL(name, new URL(dataUrl, globalThis.location?.href ?? "file:///")).href;
  const json = async (name) => (await fetchFn(url(name))).json();
  const [vocab, wordModel, missingModel, scorer, lexiconText] = await Promise.all([
    json("vocab.json"), json("word_mdd_en.json"), json("word_missing_generic.json"), json("scorer_en.json"),
    fetchFn(url("cmudict.txt.gz")).then(gunzipText),
  ]);
  onProgress?.({ stage: "data" });
  const models = loadModels({ vocab, wordModel, missingModel, scorer });
  const g2p = new LexiconG2P(parseLexicon(lexiconText));
  let source = modelBytes;
  if (!source) {
    const response = await fetchFn(modelUrl);
    source = new Uint8Array(await response.arrayBuffer());
  }
  onProgress?.({ stage: "model-downloaded" });
  const session = await ort.InferenceSession.create(source, { executionProviders, graphOptimizationLevel: "all" });
  onProgress?.({ stage: "ready" });
  return {
    session,
    models,
    g2p,
    /** Same JSON shape as Python ``openpronounce.assess(waveform, sentence, acoustic=False, transcription=False)``. */
    async assess(waveform, sentence, options = {}) {
      if (!sentence || !sentence.trim()) throw new Error("free speech (no sentence) is not supported in the browser yet");
      const lang = options.lang ?? "en";
      if (lang !== "en") throw new Error("only English is supported in the browser so far (CMUdict G2P)");
      const t0 = performance.now();
      const outputs = await runPhoneModel(ort, session, waveform);
      const t1 = performance.now();
      const result = assessFromPosteriors(waveform, sentence, outputs, { models, g2p, lang, prosody: options.prosody ?? false,
        threshold: options.threshold ?? null });
      const t2 = performance.now();
      Object.defineProperty(result, "timings", { value: { model_ms: t1 - t0, scoring_ms: t2 - t1 }, enumerable: false });
      return result;
    },
  };
}
