// Audio helpers: recording quality (openpronounce/audio.py), the input normalization of
// the wav2vec2 feature extractor, WAV parsing, and browser decoding to 16 kHz mono.

import { pyRound, quantile } from "./numeric.js";

export const TARGET_SR = 16000;
export const MIN_SECONDS = 0.5;
export const MAX_CLIPPING_RATIO = 0.01;
export const MIN_LEVEL_DB = -60.0;
export const MIN_SNR_DB = 10.0;

/** ``audio.quality``: duration, level, clipping, rough SNR and the issues found. */
export function quality(waveform, sr = TARGET_SR) {
  const duration = waveform.length / sr;
  const report = { duration: pyRound(duration, 3), level_db: null, clipping_ratio: 0.0, snr_db: null, issues: [] };
  if (duration < MIN_SECONDS) report.issues.push("too_short");
  let audible = false;
  for (const v of waveform) if (Math.abs(v) > 1e-4) { audible = true; break; }
  if (!waveform.length || !audible) {
    report.issues.push("silent");
    return report;
  }
  const frame = Math.min(waveform.length, 400);
  const nFrames = Math.floor(waveform.length / frame);
  const levels = new Float64Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    let s = 0;
    for (let i = f * frame; i < (f + 1) * frame; i++) s += Math.fround(waveform[i] * waveform[i]);
    levels[f] = Math.fround(Math.sqrt(Math.fround(s / frame)));
  }
  const loud = quantile(levels, 0.9);
  const quiet = quantile(levels, 0.1);
  let clipped = 0;
  for (const v of waveform) if (Math.abs(v) >= 0.999) clipped++;
  report.level_db = pyRound(20 * Math.log10(Math.max(loud, 1e-6)), 1);
  report.clipping_ratio = pyRound(clipped / waveform.length, 4);
  report.snr_db = pyRound(20 * Math.log10(Math.max(loud, 1e-6) / Math.max(quiet, 1e-6)), 1);
  if (report.level_db < MIN_LEVEL_DB) report.issues.push("too_quiet");
  if (report.clipping_ratio > MAX_CLIPPING_RATIO) report.issues.push("clipped");
  if (report.snr_db < MIN_SNR_DB && duration >= 2.0) report.issues.push("noisy");
  return report;
}

/** Zero mean, unit variance (``Wav2Vec2FeatureExtractor(do_normalize=True)``), as the ONNX graph expects. */
export function normalizeInput(waveform) {
  let s = 0;
  for (const v of waveform) s += v;
  const m = s / waveform.length;
  let v2 = 0;
  for (const v of waveform) v2 += (v - m) * (v - m);
  const denom = Math.sqrt(v2 / waveform.length + 1e-7);
  const out = new Float32Array(waveform.length);
  for (let i = 0; i < waveform.length; i++) out[i] = (waveform[i] - m) / denom;
  return out;
}

/** Decode a PCM or float WAV file (ArrayBuffer/Uint8Array) to ``{samples: Float32Array (mono), sampleRate}``. */
export function parseWav(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a RIFF/WAVE file");
  let offset = 12;
  let fmt = null;
  while (offset + 8 <= bytes.length) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      fmt = { format: view.getUint16(body, true), channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true), bits: view.getUint16(body + 14, true) };
      if (fmt.format === 0xfffe && size >= 26) fmt.format = view.getUint16(body + 24, true);
    } else if (id === "data") {
      if (!fmt) throw new Error("WAV data before fmt chunk");
      const { format, channels, bits, sampleRate } = fmt;
      const width = bits / 8;
      const end = Math.min(body + size, bytes.length);
      const n = Math.floor((end - body) / (width * channels));
      const samples = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let acc = 0;
        for (let c = 0; c < channels; c++) {
          const o = body + (i * channels + c) * width;
          let v;
          if (format === 3 && bits === 32) v = view.getFloat32(o, true);
          else if (format === 3 && bits === 64) v = view.getFloat64(o, true);
          else if (bits === 16) v = view.getInt16(o, true) / 32768;
          else if (bits === 8) v = (view.getUint8(o) - 128) / 128;
          else if (bits === 24) v = ((view.getUint8(o) | (view.getUint8(o + 1) << 8) | (view.getInt8(o + 2) << 16))) / 8388608;
          else if (bits === 32) v = view.getInt32(o, true) / 2147483648;
          else throw new Error(`unsupported WAV sample format ${format}/${bits}`);
          acc += v;
        }
        samples[i] = acc / channels;
      }
      return { samples, sampleRate };
    }
    offset = body + size + (size % 2);
  }
  throw new Error("no data chunk in WAV file");
}

/**
 * Browser only: decode any file the browser can play (wav, webm/opus, mp3, m4a...) to
 * 16 kHz mono. ``decodeAudioData`` on a 16 kHz OfflineAudioContext resamples with the
 * browser's own resampler; the channels are then averaged, as librosa does.
 */
export async function decodeToMono16k(arrayBuffer) {
  if (typeof OfflineAudioContext === "undefined") throw new Error("decodeToMono16k needs the Web Audio API (a browser)");
  const ctx = new OfflineAudioContext(1, 1, TARGET_SR);
  const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
  return mixDown(decoded);
}

/** Average the channels of an AudioBuffer (already at the wanted rate) into one Float32Array. */
export function mixDown(audioBuffer) {
  const n = audioBuffer.numberOfChannels;
  if (n === 1) return Float32Array.from(audioBuffer.getChannelData(0));
  const out = new Float32Array(audioBuffer.length);
  for (let c = 0; c < n; c++) {
    const data = audioBuffer.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += data[i] / n;
  }
  return out;
}
