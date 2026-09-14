#!/usr/bin/env bash
# Redeploy the engine on the server. Idempotent — safe to run any time.
# Usage (from anywhere):  /var/www/bioscraping/infra/deploy.sh
#
# Steps: find Node 22 → pull → install → apply SQL → build admin → restart PM2
# → wait for /health. Stops at the first failing step. Restarting the worker
# spends nothing: spending jobs never run on boot.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Node 22: prefer /opt/node22 when the system node is older.
if [ -x /opt/node22/bin/node ]; then export PATH="/opt/node22/bin:$PATH"; fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "✗ Node $(node -v) found; Node 22+ is required (install it or put it on PATH)." >&2
  exit 1
fi
export NODE_BIN="$(command -v node)"
for bin in pnpm pm2; do
  command -v "$bin" >/dev/null || { echo "✗ $bin not found on PATH" >&2; exit 1; }
done
echo "▸ node $(node -v) at $NODE_BIN"

echo "▸ pulling latest"
git pull --ff-only

echo "▸ installing deps"
pnpm install --frozen-lockfile

echo "▸ applying database schema (idempotent SQL files)"
pnpm --filter @biolinx/db apply-sql sql

echo "▸ building admin panel"
pnpm --filter @biolinx/admin build

echo "▸ restarting processes"
CONFIG="infra/ecosystem.config.cjs"
# A process started from an older config keeps its old script path on `reload`,
# so re-create any process whose script isn't tsx's JS entry.
for app in biolinx-api biolinx-worker; do
  script="$(pm2 jlist | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s).find(x=>x.name===process.argv[1]);console.log(p?p.pm2_env.pm_exec_path:"")})' "$app")"
  if [ -n "$script" ] && [ "$script" != "$ROOT/node_modules/tsx/dist/cli.mjs" ]; then
    echo "  re-creating $app (was $script)"
    pm2 delete "$app" >/dev/null
  fi
done
pm2 startOrReload "$CONFIG" --update-env
pm2 save >/dev/null

PORT="$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 || true)"
PORT="${PORT:-3001}"
echo "▸ waiting for health on :$PORT"
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    echo "✓ deployed. $(curl -fsS "http://127.0.0.1:$PORT/health")"
    exit 0
  fi
  sleep 1
done
echo "✗ API did not answer /health within 30s — check: pm2 logs biolinx-api --lines 50" >&2
exit 1
