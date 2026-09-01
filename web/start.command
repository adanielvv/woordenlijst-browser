#!/bin/zsh
set -eu
cd "${0:A:h:h}"

if ! lsof -nP -iTCP:3080 -sTCP:LISTEN >/dev/null 2>&1; then
  nohup node web/server.js > logs/web-browser.log 2>&1 &
fi

open http://127.0.0.1:3080
