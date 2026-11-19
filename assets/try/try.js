// The "Try it" page: OpenPronounce's read-speech pipeline in the browser.
// lib/ is the JavaScript port of the library (AGPL-3.0-or-later, copied by scripts/vendor-try.sh),
// data/ holds the word model, the scorer and the CMUdict lexicon it reads. The ONNX phone model
// comes from Hugging Face and is kept with the Cache API; onnxruntime-web comes from jsDelivr.
//
// Debug parameters, for testing without a microphone:
//   ?model=<url>                 another copy of the ONNX model (loads it right away)
//   ?clip=<url>&text=<sentence>  score that clip as if it had been uploaded, once the model is ready
import { createAssessor, decodeToMono16k, wordsOf } from "./lib/index.js";

const ORT_VERSION = "1.22.0";
const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
const MODEL_URL = "https://huggingface.co/OpenPronounce/wav2vec2-base-phones-en/resolve/main/onnx/model_int8.onnx";
const MODEL_CACHE = "openpronounce-model-v1";
const MAX_SECONDS = 20;
const EXAMPLES = [
  "The quick brown fox jumps over the lazy dog",
  "I would like a cup of coffee, please",
  "She sells seashells by the seashore",
  "We are going to the theatre on Thursday",
];

const params = new URLSearchParams(location.search);
const modelUrl = params.get("model") || MODEL_URL;
const $ = (sel, root = document) => root.querySelector(sel);
const sheet = $("#try");
const ui = {
  sentence: $("#try-sentence"), examples: $("#try-examples"), load: $("#try-load"), record: $("#try-record"),
  file: $("#try-file"), fileLabel: $("#try-file-label"), status: $("#try-status"), bar: $("#try-bar"),
  result: $("#try-result"), foot: $("#try-foot"), canvas: $("canvas", sheet), said: $(".said-row", sheet),
  notes: $(".notes", sheet), play: $(".play", sheet),
};
const metrics = { start: performance.now() };
window.__openpronounce = metrics;

const status = (text) => { ui.status.textContent = text; };
const mb = (bytes) => (bytes / 1e6).toFixed(0);
const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/* Sentences */
for (const text of EXAMPLES) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "chip";
  chip.textContent = text;
  chip.setAttribute("aria-pressed", "false");
  chip.addEventListener("click", () => { ui.sentence.value = text; syncChips(); });
  ui.examples.append(chip);
}
const syncChips = () => {
  for (const chip of ui.examples.children) chip.setAttribute("aria-pressed", String(chip.textContent === ui.sentence.value.trim()));
};
ui.sentence.addEventListener("input", syncChips);
ui.sentence.value = params.get("text") || EXAMPLES[0];
syncChips();

/* Model download, kept in the Cache API so that it is fetched once */
async function openCache() {
  try {
    if (!("caches" in self)) return null;
    for (const name of await caches.keys()) if (name.startsWith("openpronounce-model-") && name !== MODEL_CACHE) await caches.delete(name);
    return await caches.open(MODEL_CACHE);
  } catch {
    return null;
  }
}

async function modelBytes(cache) {
  if (cache) {
    const hit = await cache.match(modelUrl).catch(() => null);
    if (hit) {
      metrics.modelFrom = "cache";
      status("Loading the model from your browser’s storage…");
      return new Uint8Array(await hit.arrayBuffer());
    }
  }
  metrics.modelFrom = "network";
  const response = await fetch(modelUrl);
  if (!response.ok) throw new Error(`the model could not be downloaded (HTTP ${response.status})`);
  const total = Number(response.headers.get("Content-Length")) || 0;
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  ui.bar.hidden = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total) ui.bar.firstElementChild.style.width = `${(100 * received / total).toFixed(1)}%`;
    status(total ? `Downloading the model: ${mb(received)} of ${mb(total)} MB` : `Downloading the model: ${mb(received)} MB`);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  if (cache) {
    try {
      for (const key of await cache.keys()) await cache.delete(key);
      await cache.put(modelUrl, new Response(bytes, { headers: { "Content-Type": "application/octet-stream" } }));
    } catch (error) {
      console.warn("openpronounce: the model could not be stored, it will be downloaded again next time", error);
    }
  }
  return bytes;
}

let assessor = null;
async function load() {
  ui.load.disabled = true;
  status("Starting…");
  const cache = await openCache();
  const [ort, bytes] = await Promise.all([import(ORT_BASE + "ort.wasm.min.mjs"), modelBytes(cache)]);
  metrics.downloadMs = performance.now() - metrics.start;
  ort.env.wasm.wasmPaths = ORT_BASE;
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  ui.bar.firstElementChild.style.width = "100%";
  status("Preparing the model…");
  assessor = await createAssessor({ ort, modelBytes: bytes, dataUrl: new URL("data/", import.meta.url).href });
  metrics.readyMs = performance.now() - metrics.start;
  metrics.threads = ort.env.wasm.numThreads;
  ui.bar.hidden = true;
  ui.load.hidden = true;
  ui.record.hidden = false;
  ui.fileLabel.hidden = false;
  ui.record.disabled = false;
  ui.file.disabled = false;
  status("Ready. Press Record and read the sentence, or use an audio file.");
  if (params.get("clip")) {
    const response = await fetch(params.get("clip"));
    if (!response.ok) throw new Error(`clip: HTTP ${response.status}`);
    await score(await response.blob());
  }
}

/* Scoring */
let audioUrl = null;
let current = null;
async function score(blob) {
  const sentence = ui.sentence.value.trim();
  if (!wordsOf(sentence).length) {
    status("Type the sentence you are going to read first.");
    return;
  }
  ui.record.disabled = true;
  ui.file.disabled = true;
  status("Listening to your recording…");
  try {
    const t0 = performance.now();
    let samples;
    try {
      samples = await decodeToMono16k(await blob.arrayBuffer());
    } catch {
      throw new Error("this file could not be read as audio");
    }
    if (samples.length < 16000 * 0.3) throw new Error("the recording is too short");
    if (samples.length > 16000 * 60) throw new Error("the recording is longer than a minute; read one sentence");
    const result = await assessor.assess(samples, sentence);
    metrics.last = { seconds: samples.length / 16000, ...result.timings, totalMs: performance.now() - t0 };
    metrics.result = result;
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = URL.createObjectURL(blob);
    current = { result, sentence, samples };
    render();
    status("Done. Record again whenever you like.");
  } finally {
    ui.record.disabled = false;
    ui.file.disabled = false;
  }
}

function peaksOf(samples, n) {
  const peaks = new Float32Array(n);
  const step = samples.length / n;
  let max = 1e-6;
  for (let i = 0; i < n; i++) {
    let p = 0;
    for (let j = Math.floor(i * step); j < Math.floor((i + 1) * step); j++) p = Math.max(p, Math.abs(samples[j]));
    peaks[i] = p;
    max = Math.max(max, p);
  }
  return peaks.map((p) => p / max);
}

const flaggedWords = () => (current.result.differences.words ?? []).filter((w) => w.mispronounced);

function draw(time = -1) {
  if (!current) return;
  const canvas = ui.canvas, dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w) return;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const gap = 2, n = Math.max(20, Math.min(160, Math.floor((w + gap) / 4)));
  const { samples } = current, duration = samples.length / 16000, peaks = peaksOf(samples, n);
  const bw = (w - gap * (n - 1)) / n;
  const off = css("--wave"), on = css("--ink"), red = css("--red");
  const bad = flaggedWords().filter((x) => !x.missing && x.start != null);
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n * duration;
    const isBad = bad.some((x) => t >= x.start - 0.03 && t <= x.end + 0.03);
    const bh = Math.max(2, peaks[i] * (h - 4));
    ctx.fillStyle = isBad ? red : (t <= time ? on : off);
    ctx.fillRect(i * (bw + gap), (h - bh) / 2, bw, bh);
  }
}

function render() {
  const { result, sentence } = current;
  const words = result.differences.words ?? [];
  // The sentence as typed; each run of letters takes the report of the same position.
  let position = 0;
  ui.said.innerHTML = sentence.split(/(\s+)/).map((token) => {
    if (!token || /^\s+$/.test(token)) return token;
    const count = wordsOf(token).length;
    if (!count) return escape(token);
    const reports = words.slice(position, position + count);
    position += count;
    const report = reports.find((r) => r.mispronounced);
    if (!report) return `<span class="word">${escape(token)}</span>`;
    const pen = report.missing ? '<span class="pen">not said</span>'
      : `<span class="pen ipa">/${escape(report.actual.join(""))}/</span>`;
    return `<span class="word bad${report.missing ? " missing" : ""}">${escape(token)}${pen}</span>`;
  }).join("");

  const total = result.score;
  $(".big-score", sheet).innerHTML = total == null ? "?" : `${Math.round(total)}<small>/100</small>`;
  for (const el of sheet.querySelectorAll("[data-dim]")) {
    const value = result.scores?.[el.dataset.dim];
    el.textContent = value == null ? "?" : value.toFixed(1);
  }

  const notes = [];
  const flagged = flaggedWords();
  for (const w of flagged) {
    if (w.missing) {
      notes.push(`<p><em>${escape(w.word)}</em> was not heard.</p>`);
      continue;
    }
    const phones = w.phones.filter((p) => p.confidence >= 0.5)
      .map((p) => (p.heard ? `<span class="ipa">/${escape(p.expected)}/</span> sounded like <span class="ipa red">/${escape(p.heard)}/</span>`
        : `<span class="ipa">/${escape(p.expected)}/</span> was not heard`));
    notes.push(`<p><em>${escape(w.word)}</em>: expected <span class="ipa">/${escape(w.expected.join(""))}/</span>, heard `
      + `<span class="ipa red">/${escape(w.actual.join(""))}/</span>${phones.length ? ` (${phones.join(", ")})` : ""}.</p>`);
  }
  if (!flagged.length) notes.push("<p>No word stands out.</p>");
  if (!result.reliable) notes.push(`<p>Take this score with care: ${escape(result.reasons.join("; "))}.</p>`);
  ui.notes.innerHTML = notes.join("");

  const t = metrics.last;
  ui.foot.textContent = `${t.seconds.toFixed(1)} s of audio, analysed on this device in ${((t.model_ms + t.scoring_ms) / 1000).toFixed(1)} s.`;
  ui.foot.hidden = false;
  ui.result.hidden = false;
  const grade = $(".grade", sheet);
  grade.classList.remove("draw");
  void grade.offsetWidth;
  grade.classList.add("draw");
  stop();
}

/* Playback of the visitor's own recording */
const playIcon = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 3.5v13l11-6.5z" fill="currentColor"/></svg>';
const pauseIcon = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 3h3.5v14H5zM11.5 3H15v14h-3.5z" fill="currentColor"/></svg>';
const audio = new Audio();
let raf = 0;
const tick = () => { draw(audio.currentTime); if (!audio.paused) raf = requestAnimationFrame(tick); };
function stop() {
  cancelAnimationFrame(raf);
  ui.play.innerHTML = playIcon;
  ui.play.setAttribute("aria-label", "Play your recording");
  draw(-1);
}
audio.addEventListener("ended", stop);
audio.addEventListener("pause", () => { cancelAnimationFrame(raf); ui.play.innerHTML = playIcon; });
ui.play.addEventListener("click", () => {
  if (!audioUrl) return;
  if (audio.src !== audioUrl) audio.src = audioUrl;
  if (audio.paused) {
    audio.play().then(() => {
      ui.play.innerHTML = pauseIcon;
      ui.play.setAttribute("aria-label", "Pause");
      raf = requestAnimationFrame(tick);
    }, stop);
  } else audio.pause();
});
window.addEventListener("resize", () => draw(audio.paused ? -1 : audio.currentTime));
window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", () => draw(-1));

/* Recording and upload */
let recorder = null;
let limit = 0;
ui.record.addEventListener("click", async () => {
  if (recorder) {
    recorder.stop();
    return;
  }
  if (!wordsOf(ui.sentence.value).length) {
    status("Type the sentence you are going to read first.");
    return;
  }
  try {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      throw new Error("this browser cannot record here; use an audio file instead");
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.addEventListener("dataavailable", (e) => { if (e.data.size) chunks.push(e.data); });
    recorder.addEventListener("stop", () => {
      clearTimeout(limit);
      stream.getTracks().forEach((track) => track.stop());
      const type = recorder.mimeType;
      recorder = null;
      ui.record.textContent = "Record";
      ui.record.classList.remove("recording");
      score(new Blob(chunks, { type })).catch(fail);
    });
    recorder.start();
    limit = setTimeout(() => recorder?.stop(), MAX_SECONDS * 1000);
    ui.record.textContent = "Stop";
    ui.record.classList.add("recording");
    status("Recording. Read the sentence, then press Stop.");
  } catch (error) {
    recorder = null;
    fail(error.name === "NotAllowedError" ? new Error("the browser was not allowed to use the microphone") : error);
  }
});

ui.file.addEventListener("change", () => {
  const file = ui.file.files[0];
  ui.file.value = "";
  if (file) score(file).catch(fail);
});

function fail(error) {
  console.error(error);
  ui.bar.hidden = true;
  ui.load.disabled = false;
  status(`Something went wrong: ${error.message ?? error}.`);
}

ui.load.addEventListener("click", () => load().catch(fail));

// Start on its own when the model is already stored, or when testing with ?model= / ?clip=.
(async () => {
  const cache = await openCache();
  const cached = cache ? await cache.match(modelUrl).then(Boolean, () => false) : false;
  metrics.cachedAtStart = cached;
  if (cached || params.has("model") || params.has("clip")) load().catch(fail);
})();
