// PM2 process file — `pm2 start infra/ecosystem.config.cjs`
module.exports = {
  apps: [
    {
      name: "biolinx-api",
      cwd: __dirname + "/..",
      script: "node_modules/.bin/tsx",
      args: "apps/api/src/index.ts",
      env: { NODE_ENV: "production" },
      max_restarts: 10,
      restart_delay: 5000,
    },
    {
      name: "biolinx-worker",
      cwd: __dirname + "/..",
      script: "node_modules/.bin/tsx",
      args: "apps/worker/src/index.ts",
      env: { NODE_ENV: "production" },
      max_restarts: 10,
      restart_delay: 5000,
    },
  ],
};
