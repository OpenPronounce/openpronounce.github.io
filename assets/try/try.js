// The "Try it" page: OpenPronounce's read-speech pipeline in the browser.
// lib/ is the JavaScript port of the library (AGPL-3.0-or-later, copied by scripts/vendor-try.sh),
// data/ holds the word model, the scorer and the CMUdict lexicon it reads. The ONNX phone model
// comes from Hugging Face and is kept with the Cache API; onnxruntime-web comes from jsDelivr.
//
// There is no download button: the model starts downloading on the first press of Record, while
// the visitor reads, and on page load when the browser already holds it.
//
// Debug parameters, for testing without a microphone:
//   ?model=<url>                 another copy of the ONNX model (loads it right away)
//   ?clip=<url>&text=<sentence>  score that clip as if it had been uploaded, once the model is ready
import { createAssessor, decodeToMono16k, wordsOf } from "./lib/index.js";

const ORT_VERSION = "1.22.0";
const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
const MODEL_URL = "https://huggingface.co/OpenPronounce/wav2vec2-base-phones-en/resolve/main/onnx/model_int8.onnx";
const MODEL_CACHE = "openpronounce-model-v2";
const MAX_SECONDS = 20;
const EXAMPLES = [
  "The quick brown fox jumps over the lazy dog",
  "I would like a cup of coffee, please",
  "She sells seashells by the seashore",
  "We are going to the theatre on Thursday",
  "Could you tell me the way to the station",
  "The weather was much better than we expected",
];

const params = new URLSearchParams(location.search);
const modelUrl = params.get("model") || MODEL_URL;
const $ = (sel, root = document) => root.querySelector(sel);
const sheet = $("#try");
const ui = {
  text: $("#try-text"), input: $("#try-input"), count: $("#try-count"), prev: $("#try-prev"), next: $("#try-next"),
  own: $("#try-own"), record: $("#try-record"), status: $("#try-status"), bar: $("#try-bar"), size: $("#try-size"),
  ask: $("#try-ask"), file: $("#try-file"), act: $("#try-act"), grade: $("#try-grade"), again: $("#try-again"),
  player: $("#try-player"), notes: $("#try-notes"), foot: $("#try-foot"), canvas: $("canvas", sheet), play: $(".play", sheet),
};
const FOOT = ui.foot.textContent;
const metrics = { start: performance.now() };
window.__openpronounce = metrics;

const mb = (bytes) => (bytes / 1e6).toFixed(0);
const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const status = (text) => { ui.status.textContent = text; };
const setState = (state) => { sheet.dataset.state = state; };
const setModel = (model) => { sheet.dataset.model = model; };
const IDLE_TEXT = { none: "Press to get the model ready: about 130 MB, once.", ready: "Ready. Press, then read the sentence." };
const idleText = () => (sheet.dataset.model === "ready" ? IDLE_TEXT.ready : IDLE_TEXT.none);

/* The sentence: one of the examples, or the visitor's own */
let index = 0;
let custom = params.get("text");
const sentence = () => (custom ?? EXAMPLES[index]).trim();

function showSentence() {
  ui.text.textContent = sentence();
  ui.text.hidden = false;
  ui.input.hidden = true;
  ui.count.textContent = custom != null ? "Your sentence" : `Sentence ${index + 1} of ${EXAMPLES.length}`;
}
function step(delta) {
  if (recorder) return;
  index = custom != null ? 0 : (index + delta + EXAMPLES.length) % EXAMPLES.length;
  custom = null;
  clearResult();
  showSentence();
}
ui.prev.addEventListener("click", () => step(-1));
ui.next.addEventListener("click", () => step(1));
ui.own.addEventListener("click", () => {
  if (recorder) return;
  clearResult();
  ui.input.value = custom ?? "";
  ui.text.hidden = true;
  ui.input.hidden = false;
  ui.count.textContent = "Your sentence";
  ui.input.focus();
});
const commitInput = () => {
  if (ui.input.hidden) return;
  const value = ui.input.value.replace(/\s+/g, " ").trim();
  if (wordsOf(value).length) custom = value;
  showSentence();
};
ui.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); commitInput(); ui.record.focus(); }
  if (e.key === "Escape") { e.preventDefault(); showSentence(); }
});
ui.input.addEventListener("blur", commitInput);
showSentence();

/* The model, kept in the Cache API so that it is fetched once */
async function openCache() {
  try {
    if (!("caches" in self)) return null;
    for (const name of await caches.keys()) if (name.startsWith("openpronounce-model-") && name !== MODEL_CACHE) await caches.delete(name);
    return await caches.open(MODEL_CACHE);
  } catch {
    return null;
  }
}
const cacheReady = openCache();

const progress = { received: 0, total: 0, phase: "" };
function showProgress() {
  const { received, total, phase } = progress;
  if (!waiting) {
    if (phase === "download") {
      status(total ? `Getting the model ready: ${mb(received)} of ${mb(total)} MB.` : `Getting the model ready: ${mb(received)} MB.`);
      if (total) ui.record.style.setProperty("--elapsed", (received / total).toFixed(4));
    } else if (sheet.dataset.model === "loading") {
      status("Almost ready…");
      ui.record.style.setProperty("--elapsed", "1");
    }
    return;
  }
  if (phase === "download") {
    status(total ? `Got it. The model is on its way: ${mb(received)} of ${mb(total)} MB.` : `Got it. The model is on its way: ${mb(received)} MB.`);
    ui.bar.hidden = !total;
    if (total) ui.bar.firstElementChild.style.width = `${(100 * received / total).toFixed(1)}%`;
  } else {
    ui.bar.hidden = true;
    status("Marking your reading…");
  }
}

async function modelBytes(cache) {
  if (cache) {
    const hit = await cache.match(modelUrl).catch(() => null);
    if (hit) {
      metrics.modelFrom = "cache";
      return new Uint8Array(await hit.arrayBuffer());
    }
  }
  metrics.modelFrom = "network";
  progress.phase = "download";
  progress.received = 0;
  progress.total = 0;
  const response = await fetch(modelUrl, { cache: "no-store" });
  if (!response.ok) throw new Error(`the model could not be downloaded (HTTP ${response.status})`);
  // Content-Length counts compressed bytes when the response is encoded: only trust it otherwise.
  progress.total = response.headers.get("Content-Encoding") ? 0 : Number(response.headers.get("Content-Length")) || 0;
  const reader = response.body.getReader();
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    progress.received += value.length;
    showProgress();
  }
  progress.phase = "";
  const size = chunks.reduce((n, chunk) => n + chunk.length, 0);
  if (progress.total && size !== progress.total) {
    throw new Error(`the download stopped at ${mb(size)} of ${mb(progress.total)} MB; try again`);
  }
  const bytes = new Uint8Array(size);
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

let assessorPromise = null;
function ensureModel() {
  assessorPromise ??= (async () => {
    const cache = await cacheReady;
    const [ort, bytes] = await Promise.all([import(ORT_BASE + "ort.wasm.min.mjs"), modelBytes(cache)]);
    metrics.downloadMs = performance.now() - metrics.start;
    ort.env.wasm.wasmPaths = ORT_BASE;
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
    const dataUrl = new URL("data/", import.meta.url).href;
    let assessor;
    try {
      assessor = await createAssessor({ ort, modelBytes: bytes, dataUrl });
    } catch (error) {
      // A stored copy that no longer parses is thrown away and fetched again, once.
      if (metrics.modelFrom !== "cache") throw error;
      if (cache) await cache.delete(modelUrl).catch(() => {});
      assessor = await createAssessor({ ort, modelBytes: await modelBytes(cache), dataUrl });
    }
    metrics.readyMs = performance.now() - metrics.start;
    metrics.threads = ort.env.wasm.numThreads;
    setModel("ready");
    ui.record.style.removeProperty("--elapsed");
    ui.record.setAttribute("aria-label", "Record");
    if (sheet.dataset.state === "idle" && !recorder) status(IDLE_TEXT.ready);
    return assessor;
  })();
  assessorPromise.catch(() => { assessorPromise = null; });
  return assessorPromise;
}

/* Scoring: a recording or a file, through the same path */
let waiting = false;
let audioUrl = null;
let current = null;
async function score(blob) {
  const text = sentence();
  if (!wordsOf(text).length) throw new Error("type the sentence you are going to read first");
  setState("analysing");
  waiting = true;
  ui.record.disabled = true;
  showProgress();
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
    const assessor = await ensureModel();
    status("Marking your reading…");
    ui.bar.hidden = true;
    const t1 = performance.now();
    const result = await assessor.assess(samples, text);
    metrics.last = { seconds: samples.length / 16000, ...result.timings, totalMs: performance.now() - t1, sinceStopMs: performance.now() - t0 };
    metrics.result = result;
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = URL.createObjectURL(blob);
    current = { result, sentence: text, samples };
    render();
  } finally {
    waiting = false;
    ui.record.disabled = false;
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
  if (!current || ui.player.hidden) return;
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
  const { result, sentence: text } = current;
  const words = result.differences.words ?? [];
  // The sentence as typed, marked in place; each run of letters takes the report of the same position.
  let position = 0, flaggedSoFar = 0;
  ui.text.innerHTML = text.split(/(\s+)/).map((token) => {
    if (!token || /^\s+$/.test(token)) return token;
    const count = wordsOf(token).length;
    if (!count) return escape(token);
    const reports = words.slice(position, position + count);
    position += count;
    const report = reports.find((r) => r.mispronounced);
    if (!report) return `<span class="word">${escape(token)}</span>`;
    const pen = report.missing ? '<span class="pen">not said</span>'
      : `<span class="pen ipa">/${escape(report.actual.join(""))}/</span>`;
    return `<span class="word bad${report.missing ? " missing" : ""}" style="--i:${flaggedSoFar++}">${escape(token)}${pen}</span>`;
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
  if (!flagged.length) notes.push("<p>No word stands out. Press play to hear yourself.</p>");
  if (!result.reliable) notes.push(`<p>Take this score with care: ${escape(result.reasons.join("; "))}.</p>`);
  ui.notes.innerHTML = notes.join("");
  ui.notes.hidden = false;

  const t = metrics.last;
  ui.foot.textContent = `${t.seconds.toFixed(1)} s of audio, marked on this device in ${((t.model_ms + t.scoring_ms) / 1000).toFixed(1)} s. Nothing left it.`;
  ui.player.hidden = false;
  ui.act.hidden = true;
  ui.grade.hidden = false;
  setState("result");
  const grade = $(".grade", sheet);
  grade.classList.remove("draw");
  void grade.offsetWidth;
  grade.classList.add("draw");
  stop();
  const box = sheet.getBoundingClientRect();
  if (box.top < 64 || box.top > innerHeight * 0.5) sheet.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}

function clearResult() {
  audio.pause();
  current = null;
  ui.player.hidden = true;
  ui.notes.hidden = true;
  ui.grade.hidden = true;
  ui.act.hidden = false;
  ui.foot.textContent = FOOT;
  ui.bar.hidden = true;
  ui.ask.hidden = true;
  setState("idle");
  status(idleText());
  showSentence();
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
$(".wave", sheet).addEventListener("click", (e) => {
  if (!current || !audio.src) return;
  const r = ui.canvas.getBoundingClientRect();
  audio.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (current.samples.length / 16000);
  tick();
});
window.addEventListener("resize", () => draw(audio.paused ? -1 : audio.currentTime));
window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", () => draw(-1));
new MutationObserver(() => draw(-1)).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

/* Recording: the level drives the ring around the button, the ring fills over the 20 seconds */
let recorder = null;
let meter = null;
let cachedAtStart = false;
let downloadAgreed = false;
let pending = null;
// With "save data" on, nothing is downloaded before the visitor says yes.
function mustAsk(action) {
  if (assessorPromise || cachedAtStart || downloadAgreed || !navigator.connection?.saveData) return false;
  pending = action;
  ui.ask.hidden = false;
  ui.size.hidden = true;
  status("One question first.");
  $("#try-ask-yes").focus();
  return true;
}

function startMeter(stream) {
  try {
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    context.createMediaStreamSource(stream).connect(analyser); // not connected to the speakers
    const buffer = new Float32Array(analyser.fftSize);
    const started = performance.now();
    let frame = 0;
    const loop = () => {
      analyser.getFloatTimeDomainData(buffer);
      let sum = 0;
      for (const v of buffer) sum += v * v;
      const level = Math.min(1, Math.sqrt(sum / buffer.length) * 6);
      const elapsed = (performance.now() - started) / 1000;
      ui.record.style.setProperty("--level", level.toFixed(3));
      ui.record.style.setProperty("--elapsed", Math.min(1, elapsed / MAX_SECONDS).toFixed(4));
      const secs = Math.floor(elapsed);
      status(`Recording 0:${String(secs).padStart(2, "0")}. Press to stop.`);
      frame = requestAnimationFrame(loop);
    };
    loop();
    return { stop: () => { cancelAnimationFrame(frame); context.close(); } };
  } catch {
    return { stop: () => {} };
  }
}

async function startRecording() {
  if (recorder) return;
  if (!wordsOf(sentence()).length) {
    status("Type the sentence you are going to read first.");
    return;
  }
  if (mustAsk(startRecording)) return;
  try {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      throw new Error("this browser cannot record here; score an audio file instead");
    }
    if (current) clearResult();
    ensureModel().catch(() => {}); // in parallel with the reading; its errors surface when scoring
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const chunks = [];
    const rec = new MediaRecorder(stream);
    recorder = rec;
    rec.addEventListener("dataavailable", (e) => { if (e.data.size) chunks.push(e.data); });
    rec.addEventListener("stop", () => {
      clearTimeout(rec.limit);
      meter?.stop();
      meter = null;
      stream.getTracks().forEach((track) => track.stop());
      recorder = null;
      ui.record.setAttribute("aria-label", "Record");
      ui.record.style.removeProperty("--level");
      ui.record.style.removeProperty("--elapsed");
      score(new Blob(chunks, { type: rec.mimeType })).catch(fail);
    });
    rec.start();
    rec.limit = setTimeout(() => rec.state !== "inactive" && rec.stop(), MAX_SECONDS * 1000);
    setState("recording");
    ui.record.setAttribute("aria-label", "Stop recording");
    meter = startMeter(stream);
  } catch (error) {
    recorder = null;
    fail(error.name === "NotAllowedError" ? new Error("the browser was not allowed to use the microphone; you can score an audio file instead") : error);
  }
}

function prepare() {
  if (sheet.dataset.model !== "none") return;
  if (mustAsk(prepare)) return;
  setModel("loading");
  ui.record.setAttribute("aria-label", "Getting the model ready");
  status("Getting the model ready…");
  ensureModel().then(() => ui.record.focus(), (error) => { setModel("none"); ui.record.setAttribute("aria-label", "Get the model ready"); fail(error); });
}

ui.record.addEventListener("click", () => {
  if (recorder) recorder.stop();
  else if (sheet.dataset.model === "ready") startRecording();
  else prepare();
});
ui.again.addEventListener("click", () => { clearResult(); startRecording(); });
$("#try-ask-yes").addEventListener("click", () => {
  downloadAgreed = true;
  ui.ask.hidden = true;
  ui.size.hidden = false;
  const action = pending;
  pending = null;
  action?.();
});
$("#try-ask-no").addEventListener("click", () => {
  pending = null;
  ui.ask.hidden = true;
  ui.size.hidden = false;
  status("Nothing was downloaded.");
});

const scoreFile = (file) => {
  if (current) clearResult();
  if (sheet.dataset.model === "none") setModel("loading");
  score(file).catch((error) => { if (sheet.dataset.model !== "ready") setModel("none"); fail(error); });
};
ui.file.addEventListener("change", () => {
  const file = ui.file.files[0];
  ui.file.value = "";
  if (file && !mustAsk(() => scoreFile(file))) scoreFile(file);
});

function fail(error) {
  console.error(error);
  waiting = false;
  ui.bar.hidden = true;
  ui.record.disabled = false;
  ui.act.hidden = false;
  ui.grade.hidden = true;
  setState("idle");
  status(`Something went wrong: ${error.message ?? error}.`);
}

// Load on its own when the model is already stored, or when testing with ?model= / ?clip=.
(async () => {
  const cache = await cacheReady;
  cachedAtStart = cache ? await cache.match(modelUrl).then(Boolean, () => false) : false;
  metrics.cachedAtStart = cachedAtStart;
  if (cachedAtStart) ui.size.textContent = "The model is already on this device.";
  else ui.size.textContent = "Downloaded once, then kept by your browser. Nothing you record is uploaded.";
  if (cachedAtStart || params.has("model") || params.has("clip")) {
    setModel("loading");
    status("Getting the model ready…");
    ensureModel().catch((error) => { setModel("none"); fail(error); });
  }
  if (params.get("clip")) {
    try {
      const response = await fetch(params.get("clip"));
      if (!response.ok) throw new Error(`clip: HTTP ${response.status}`);
      await score(await response.blob());
    } catch (error) {
      fail(error);
    }
  }
})();
