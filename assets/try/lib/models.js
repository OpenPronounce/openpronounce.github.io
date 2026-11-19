// The JSON models of openpronounce/gop.py (gop.MODEL_TYPES) and openpronounce/scorer.py.
// Every ``predict`` takes rows as arrays of numbers, in the column order the Python caller uses.

import { sigmoid } from "./numeric.js";

export class LogisticModel {
  constructor(data) {
    this.features = data.features;
    this.mean = data.mean;
    this.scale = data.scale;
    this.coef = data.coef;
    this.intercept = Number(data.intercept);
    this.phoneBias = data.phone_bias ?? {};
  }

  predict(rows, phones = null) {
    const hasBias = phones && Object.keys(this.phoneBias).length;
    return rows.map((row, r) => {
      let z = this.intercept;
      for (let k = 0; k < row.length; k++) z += ((row[k] - this.mean[k]) / this.scale[k]) * this.coef[k];
      if (hasBias) z += this.phoneBias[phones[r]] ?? 0;
      return sigmoid(z);
    });
  }
}

function matvec(x, w, b) {
  // x (in), w (in x out) as nested arrays, b (out)
  const out = Float64Array.from(b);
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    if (xi === 0) continue;
    const wi = w[i];
    for (let j = 0; j < out.length; j++) out[j] += xi * wi[j];
  }
  return out;
}

export class MLPModel {
  constructor(data) {
    this.features = data.features;
    this.mean = data.mean;
    this.scale = data.scale;
    this.phones = data.phones ?? [];
    this.index = new Map(this.phones.map((p, i) => [p, i]));
    this.weights = data.weights;
    this.biases = data.biases;
    this.embedding = data.embedding ?? null;
    this.hiddenLayer = this.embedding ? this.embedding.layer : null;
  }

  /** ``rows`` of features, ``phones`` (one per row), ``embeddings`` (Float32Array/Float64Array per row) when the model has an embedding block. */
  predict(rows, phones = null, embeddings = null) {
    if (this.embedding && !embeddings) throw new Error("this model needs the phone embeddings (hidden states of the recognizer)");
    return rows.map((row, r) => {
      let x = row.map((v, k) => (v - this.mean[k]) / this.scale[k]);
      if (this.phones.length) {
        const onehot = new Array(this.phones.length).fill(0);
        const i = this.index.get(phones[r]);
        if (i !== undefined) onehot[i] = 1;
        x = x.concat(onehot);
      }
      if (this.embedding) {
        const { mean, projection, scale } = this.embedding;
        const e = embeddings[r];
        const proj = new Float64Array(scale.length);
        for (let i = 0; i < e.length; i++) {
          const d = e[i] - mean[i];
          const pi = projection[i];
          for (let j = 0; j < proj.length; j++) proj[j] += d * pi[j];
        }
        for (let j = 0; j < proj.length; j++) x.push(proj[j] / scale[j]);
      }
      let h = x;
      const last = this.weights.length - 1;
      for (let l = 0; l < last; l++) {
        h = matvec(h, this.weights[l], this.biases[l]).map((v) => Math.max(v, 0));
      }
      const z = matvec(h, this.weights[last], this.biases[last])[0];
      return sigmoid(z);
    });
  }
}

export class TreeEnsemble {
  constructor(data) {
    this.features = data.features;
    this.baseline = Number(data.baseline);
    this.link = data.link ?? "sigmoid";
    // flatten every tree into typed arrays: feature, threshold, left, right, value
    this.trees = data.trees.map((tree) => ({
      feature: Int32Array.from(tree, (n) => n[0]),
      threshold: Float64Array.from(tree, (n) => n[1]),
      left: Int32Array.from(tree, (n) => n[2]),
      right: Int32Array.from(tree, (n) => n[3]),
      value: Float64Array.from(tree, (n) => n[4]),
    }));
  }

  raw(row) {
    let s = this.baseline;
    for (const t of this.trees) {
      let node = 0;
      while (t.feature[node] >= 0) node = row[t.feature[node]] <= t.threshold[node] ? t.left[node] : t.right[node];
      s += t.value[node];
    }
    return s;
  }

  predict(rows) {
    return rows.map((row) => (this.link === "identity" ? this.raw(row) : sigmoid(this.raw(row))));
  }
}

export const MODEL_TYPES = { logistic: LogisticModel, mlp: MLPModel, trees: TreeEnsemble };

export function stage(data) {
  const Type = MODEL_TYPES[data.type ?? "logistic"];
  if (!Type) throw new Error(`unknown model type ${data.type}`);
  return new Type(data);
}
