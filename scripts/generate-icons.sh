#!/usr/bin/env bash
#
# Regenerates the PNG icons apps/web serves, from scripts/icons/app-icon.svg.
#
# Standing constraints this script enforces:
# - Opaque output only. iOS composites transparency onto black before applying its
#   rounded mask and Android's maskable mask paints the backdrop itself, so an
#   alpha channel here is a defect rather than a style choice. Force `PNG24:` and
#   strip alpha, rather than trusting the SVG's backdrop to survive the rasteriser.
# - Fixed pixel sizes: the manifest declares 192x192 and 512x512, and iOS looks for
#   a 180x180 `apple-touch-icon.png`; the file names and the sizes are the contract.
# - Deterministic: same source, same bytes. No timestamps, no randomisation, and no
#   text in the source (a glyph drawn as text would depend on installed fonts).
# - The maskable variant is derived, never drawn separately: the source art sits at
#   a 20% margin, so scaling it into the 80% maskable safe zone is one padding step
#   and cannot drift from the plain icon.
#
# The verifier (apps/web/tests/installability.test.ts) decodes these files and
# asserts size, opacity and content, so this script's output is checked by the test
# run rather than by eye.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$REPO_ROOT/scripts/icons/app-icon.svg"
OUT_DIR="$REPO_ROOT/apps/web/public"

# The app's own backdrop (slate-950), matching the manifest's background_color and
# theme_color. A seam shows up as a mismatched corner once the platform masks the icon.
BACKDROP='#020617'
SAFE_ZONE='400x400'

if ! command -v convert >/dev/null 2>&1; then
  echo "generate-icons: ImageMagick 'convert' is required to rasterise $SOURCE" >&2
  exit 1
fi

if [ ! -f "$SOURCE" ]; then
  echo "generate-icons: missing source $SOURCE" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

# `-alpha remove -alpha off` flattens onto the backdrop and drops the channel;
# the explicit `PNG24:` prefix pins truecolor-without-alpha at the encoder too, so
# the two mechanisms have to fail together before an alpha channel reaches a file.
# `-strip` drops the metadata ImageMagick otherwise stamps in (it writes a
# `date:timestamp` text chunk, which makes two runs of the same source differ).
render() {
  local size="$1"
  local target="$2"
  convert -background "$BACKDROP" "$SOURCE" \
    -resize "${size}x${size}" \
    -alpha remove -alpha off \
    -strip \
    "PNG24:$OUT_DIR/$target"
  echo "generate-icons: $target ($(identify -format '%wx%h %[channels]' "$OUT_DIR/$target"))"
}

render 180 apple-touch-icon.png
render 192 icon-192.png
render 512 icon-512.png

# Maskable: the source padded into the platform's 80% safe zone on the same
# full-bleed backdrop, so the launcher's mask can crop to any shape without
# touching the glyph.
convert -background "$BACKDROP" "$SOURCE" \
  -resize "$SAFE_ZONE" -gravity center -extent 512x512 \
  -alpha remove -alpha off \
  -strip \
  "PNG24:$OUT_DIR/icon-512-maskable.png"
echo "generate-icons: icon-512-maskable.png ($(identify -format '%wx%h %[channels]' "$OUT_DIR/icon-512-maskable.png"))"

# A blank render is the failure mode this pipeline actually hits (a rasteriser that
# silently drops the artwork still writes a valid, empty PNG), so fail loudly here
# instead of shipping an invisible icon.
for file in apple-touch-icon.png icon-192.png icon-512.png icon-512-maskable.png; do
  mean="$(convert "$OUT_DIR/$file" -format '%[fx:mean]' info:)"
  if awk "BEGIN{exit !($mean < 0.01)}"; then
    echo "generate-icons: $file looks blank (mean=$mean)" >&2
    exit 1
  fi
  echo "generate-icons: $file mean=$mean"
done
