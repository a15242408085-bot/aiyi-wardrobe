#!/bin/zsh
cd -- "${0:A:h}/app" || exit 1
if [[ -x "$HOME/.local/node/bin/node" ]]; then
  "$HOME/.local/node/bin/node" scripts/start_local.mjs
else
  node scripts/start_local.mjs
fi
