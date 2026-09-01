#!/bin/zsh
set -euo pipefail

root_dir=${0:A:h:h}
output_dir="$root_dir/docs/pdf"
mkdir -p "$output_dir"

workers=("abcdefghi" "jklmnopqr" "stuvwxyz")
pids=()

cleanup() {
  for pid in ${pids[@]:-}; do kill "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT INT TERM

for index in {1..3}; do
  port=$((3190 + index))
  PORT=$port node "$root_dir/web/server.js" >"/tmp/woordenlijst-pdf-$port.log" 2>&1 &
  pids+=("$!")
done

for index in {1..3}; do
  port=$((3190 + index))
  for attempt in {1..60}; do
    curl -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1 && break
    sleep .25
  done
done

build_group() {
  local letters=$1 port=$2
  for letter in ${(s::)letters}; do
    target="$output_dir/$letter.pdf"
    if [[ -s "$target" ]]; then
      echo "skip $letter"
      continue
    fi
    curl -fsS "http://127.0.0.1:$port/api/export.pdf?letters=$letter" -o "$target"
    echo "pdf $letter $(stat -f %z "$target") bytes"
  done
}

group_pids=()
for index in {1..3}; do
  build_group "${workers[$index]}" "$((3190 + index))" &
  group_pids+=("$!")
done
for pid in $group_pids; do wait "$pid"; done

echo "PDF build complete: $(find "$output_dir" -name '*.pdf' | wc -l | tr -d ' ') files"

