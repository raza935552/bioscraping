#!/usr/bin/env bash
# Redeploy the engine on the server. Idempotent — safe to run any time.
# Usage:  cd /srv/engine && ./infra/deploy.sh
set -euo pipefail

cd "$(dirname "$0")/.."
echo "▸ pulling latest"
git pull --ff-only

echo "▸ installing deps"
pnpm install --frozen-lockfile

echo "▸ applying database schema"
pnpm --filter @biolinx/db exec drizzle-kit push

echo "▸ building admin panel"
pnpm --filter @biolinx/admin build

echo "▸ restarting processes"
pm2 reload infra/ecosystem.config.cjs --update-env
pm2 save

echo "✓ deployed. Health:"
sleep 2
curl -fsS http://127.0.0.1:"${PORT:-3001}"/health && echo
