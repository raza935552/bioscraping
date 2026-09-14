// PM2 process file — `pm2 start infra/ecosystem.config.cjs` (infra/deploy.sh does this).
//
// PM2 runs tsx's JavaScript entry under Node 22. It must not point at
// node_modules/.bin/tsx: that is a shell wrapper, and PM2 tries to parse it as
// JavaScript ("SyntaxError: missing ) after argument list").
//
// NODE_BIN picks the interpreter when the default `node` on PATH is too old
// (the gemboxpk server has Node 20 system-wide and Node 22 in /opt/node22/bin).
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const TSX = path.join(ROOT, "node_modules/tsx/dist/cli.mjs");
const NODE = process.env.NODE_BIN || "node";
const PATH = process.env.NODE_BIN ? `${path.dirname(process.env.NODE_BIN)}:${process.env.PATH}` : process.env.PATH;

const app = (name, entry) => ({
  name,
  cwd: ROOT,
  script: TSX,
  args: entry,
  interpreter: NODE,
  env: { NODE_ENV: "production", PATH },
  max_restarts: 10,
  restart_delay: 5000,
});

module.exports = {
  apps: [app("biolinx-api", "apps/api/src/index.ts"), app("biolinx-worker", "apps/worker/src/index.ts")],
};
