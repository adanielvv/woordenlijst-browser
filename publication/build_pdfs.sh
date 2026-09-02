#!/bin/zsh
set -euo pipefail

root_dir=${0:A:h:h}
output_dir="$root_dir/docs/pdf"
mkdir -p "$output_dir"

workers=("0-9,a,b,c,d,e,f,g,h,i" "j,k,l,m,n,o,p,q,r" "s,t,u,v,w,x,y,z,other")
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
  local group=$1 port=$2
  local sections=(${(s:,:)group})
  for section in $sections; do
    target="$output_dir/$section.pdf"
    if [[ -s "$target" && "${FORCE:-0}" != "1" ]]; then
      echo "skip $section"
      continue
    fi
    temp="$target.part"
    curl -fsS "http://127.0.0.1:$port/api/export.pdf?sections=$section" -o "$temp"
    mv "$temp" "$target"
    echo "pdf $section $(stat -f %z "$target") bytes"
  done
}

group_pids=()
for index in {1..3}; do
  build_group "${workers[$index]}" "$((3190 + index))" &
  group_pids+=("$!")
done
for pid in $group_pids; do wait "$pid"; done

echo "PDF build complete: $(find "$output_dir" -name '*.pdf' | wc -l | tr -d ' ') files"
