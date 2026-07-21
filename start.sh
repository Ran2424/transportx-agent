#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$project_dir"

if [[ ! -d node_modules ]]; then
  echo "[Tau] Dependencies are missing. Run 'npm install' first." >&2
  exit 1
fi

export TAU_HOST="${TAU_HOST:-127.0.0.1}"
export TAU_PORT="${TAU_PORT:-3000}"

echo "[Tau] Building project..."
npm run build

printf '[Tau] Starting on http://%s:%s\n' "$TAU_HOST" "$TAU_PORT"
echo "[Tau] Press Ctrl-C or close this terminal window to stop the service."
exec node bin/tau.js "$@"
