#!/usr/bin/env bash
# Run dev CLI from any directory — ensures ts-node resolves from cli's node_modules
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export TS_NODE_PROJECT="$DIR/tsconfig.json"
exec node --loader "$DIR/node_modules/ts-node/esm.mjs" --no-warnings=ExperimentalWarning "$DIR/bin/dev.mjs" "$@"
