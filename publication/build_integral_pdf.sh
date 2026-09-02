#!/bin/zsh
set -euo pipefail

root_dir=${0:A:h:h}
generator="$root_dir/publication/build_integral_pdf.js"
target="$root_dir/docs/pdf/woordenlijst-a-z-compact.pdf"
parts_dir=$(mktemp -d /tmp/woordenlijst-integral.XXXXXX)
workers=("abcdefghi" "jklmnopqr" "stuvwxyz")
worker_pids=()

cleanup() {
  for pid in ${worker_pids[@]:-}; do kill "$pid" 2>/dev/null || true; done
  rm -rf "$parts_dir"
}
trap cleanup EXIT INT TERM

NODE_OPTIONS=--max-old-space-size=2048 node "$generator" \
  --letters=abcdefghijklmnopqrstuvwxyz --cover-only=1 --output="$parts_dir/cover.pdf"

build_group() {
  local group=$1
  for letter in ${(s::)group}; do
    NODE_OPTIONS=--max-old-space-size=2048 node "$generator" \
      --letters="$letter" --cover=0 --output="$parts_dir/$letter.pdf" \
      >"$parts_dir/$letter.log" 2>&1
    echo "compact $letter $(stat -f %z "$parts_dir/$letter.pdf") bytes"
  done
}

for group in $workers; do
  build_group "$group" &
  worker_pids+=("$!")
done
for pid in $worker_pids; do wait "$pid"; done
worker_pids=()

inputs=("$parts_dir/cover.pdf")
for letter in {a..z}; do inputs+=("$parts_dir/$letter.pdf"); done
pdfunite $inputs "$parts_dir/merged.pdf"
qpdf --warning-exit-0 --linearize --object-streams=generate \
  --compress-streams=y --recompress-flate --compression-level=9 \
  "$parts_dir/merged.pdf" "$target.part"
mv "$target.part" "$target"

pages=$(pdfinfo "$target" | awk '/^Pages:/{print $2}')
bytes=$(stat -f %z "$target")
echo "Integral PDF complete: $pages pages, $bytes bytes"
