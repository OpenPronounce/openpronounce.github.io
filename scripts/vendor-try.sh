#!/usr/bin/env bash
# Copy the browser port of OpenPronounce into assets/try/ for the "Try it" page.
#   scripts/vendor-try.sh /path/to/OpenPronounce/js
# The js/ folder must have run `npm run build:data` (models/ holds the JSON models and the lexicon).
# The ONNX model is not copied: the page downloads it from Hugging Face.
set -euo pipefail
src="${1:?usage: scripts/vendor-try.sh /path/to/OpenPronounce/js}"
here="$(cd "$(dirname "$0")/.." && pwd)"
lib="$here/assets/try/lib"
data="$here/assets/try/data"
rm -rf "$lib" "$data"
mkdir -p "$lib" "$data"
for f in "$src"/src/*.js; do
  [ "$(basename "$f")" = node.js ] && continue
  cp "$f" "$lib/"
done
for f in vocab.json word_mdd_en.json word_missing_generic.json scorer_en.json cmudict.txt.gz cmudict.LICENSE; do
  cp "$src/models/$f" "$data/"
done
echo "copied $(ls "$lib" | wc -l) modules and $(ls "$data" | wc -l) data files"
