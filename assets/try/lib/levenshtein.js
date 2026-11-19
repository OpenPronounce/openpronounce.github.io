// Levenshtein distance and opcodes over sequences of strings, ported from the pure
// Python implementation of rapidfuzz (MIT, Max Bachmann) so that ties between equally
// cheap alignments are broken the same way as in the Python library (Hyyrö's
// bit-parallel algorithm, with BigInt standing in for Python's unbounded integers).

function blocks(s1) {
  const block = new Map();
  let x = 1n;
  for (const ch of s1) {
    block.set(ch, (block.get(ch) ?? 0n) | x);
    x <<= 1n;
  }
  return block;
}

function matrix(s1, s2, keep) {
  if (!s1.length) return { dist: s2.length, VPs: [], VNs: [] };
  let VP = (1n << BigInt(s1.length)) - 1n;
  let VN = 0n;
  let dist = s1.length;
  const mask = 1n << BigInt(s1.length - 1);
  const block = blocks(s1);
  const VPs = [];
  const VNs = [];
  for (const ch2 of s2) {
    const X = block.get(ch2) ?? 0n;
    const D0 = (((X & VP) + VP) ^ VP) | X | VN;
    let HP = VN | ~(D0 | VP);
    let HN = D0 & VP;
    if (HP & mask) dist += 1;
    if (HN & mask) dist -= 1;
    HP = (HP << 1n) | 1n;
    HN <<= 1n;
    VP = HN | ~(D0 | HP);
    VN = HP & D0;
    if (keep) {
      VPs.push(VP);
      VNs.push(VN);
    }
  }
  return { dist, VPs, VNs };
}

/** Edit distance between two sequences (arrays of strings, or strings). */
export function distance(a, b) {
  const s1 = Array.from(a);
  const s2 = Array.from(b);
  if (!s1.length) return s2.length;
  if (!s2.length) return s1.length;
  if (s1.length <= 30) return matrix(s1, s2, false).dist;
  // plain dynamic programming is as fast for the lengths seen here and avoids BigInt
  let prev = new Int32Array(s1.length + 1);
  let cur = new Int32Array(s1.length + 1);
  for (let i = 0; i <= s1.length; i++) prev[i] = i;
  for (let j = 1; j <= s2.length; j++) {
    cur[0] = j;
    for (let i = 1; i <= s1.length; i++) {
      const sub = prev[i - 1] + (s1[i - 1] === s2[j - 1] ? 0 : 1);
      cur[i] = Math.min(sub, prev[i] + 1, cur[i - 1] + 1);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[s1.length];
}

function editops(a, b) {
  let s1 = Array.from(a);
  let s2 = Array.from(b);
  let prefix = 0;
  while (prefix < s1.length && prefix < s2.length && s1[prefix] === s2[prefix]) prefix++;
  let suffix = 0;
  while (suffix < s1.length - prefix && suffix < s2.length - prefix
         && s1[s1.length - 1 - suffix] === s2[s2.length - 1 - suffix]) suffix++;
  const srcLen = s1.length;
  const destLen = s2.length;
  s1 = s1.slice(prefix, s1.length - suffix);
  s2 = s2.slice(prefix, s2.length - suffix);
  let { dist, VPs, VNs } = matrix(s1, s2, true);
  const ops = new Array(dist);
  if (dist === 0) return { ops: [], srcLen, destLen };
  let col = s1.length;
  let row = s2.length;
  while (row !== 0 && col !== 0) {
    if (VPs[row - 1] & (1n << BigInt(col - 1))) {
      dist -= 1;
      col -= 1;
      ops[dist] = ["delete", col + prefix, row + prefix];
    } else {
      row -= 1;
      if (row && (VNs[row - 1] & (1n << BigInt(col - 1)))) {
        dist -= 1;
        ops[dist] = ["insert", col + prefix, row + prefix];
      } else {
        col -= 1;
        if (s1[col] !== s2[row]) {
          dist -= 1;
          ops[dist] = ["replace", col + prefix, row + prefix];
        }
      }
    }
  }
  while (col !== 0) {
    dist -= 1;
    col -= 1;
    ops[dist] = ["delete", col + prefix, row + prefix];
  }
  while (row !== 0) {
    dist -= 1;
    row -= 1;
    ops[dist] = ["insert", col + prefix, row + prefix];
  }
  return { ops, srcLen, destLen };
}

/** ``[tag, i1, i2, j1, j2]`` blocks turning ``a`` into ``b``, like ``rapidfuzz.distance.Levenshtein.opcodes``. */
export function opcodes(a, b) {
  const { ops, srcLen, destLen } = editops(a, b);
  const out = [];
  let src = 0;
  let dest = 0;
  let i = 0;
  while (i < ops.length) {
    if (src < ops[i][1] || dest < ops[i][2]) {
      out.push(["equal", src, ops[i][1], dest, ops[i][2]]);
      src = ops[i][1];
      dest = ops[i][2];
    }
    const srcBegin = src;
    const destBegin = dest;
    const tag = ops[i][0];
    while (i < ops.length && ops[i][0] === tag && src === ops[i][1] && dest === ops[i][2]) {
      if (tag === "replace") {
        src += 1;
        dest += 1;
      } else if (tag === "insert") {
        dest += 1;
      } else {
        src += 1;
      }
      i += 1;
    }
    out.push([tag, srcBegin, src, destBegin, dest]);
  }
  if (src < srcLen || dest < destLen) out.push(["equal", src, srcLen, dest, destLen]);
  return out;
}
