# Server setup — BiolinX Affiliate Engine (no Docker)

Native Ubuntu deploy. Three long-lived pieces: **MySQL** (data), **Node** (API +
worker via PM2), **Caddy** (TLS + reverse proxy). The admin panel is a static
build the API serves. Target host: `engine.biolinxlabs.com`.

---

## 0. Provision

- A VPS (Ubuntu 22.04+), 2 vCPU / 4 GB is plenty. 4 GB+ if you later run the
  Playwright scraper on the same box.
- A DNS **A record**: `engine.biolinxlabs.com → <server IP>` (in Cloudflare;
  DNS-only / grey-cloud is fine — Caddy issues the cert).
- SSH access.

## 1. System packages

```bash
sudo apt update && sudo apt -y upgrade
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -   # Node 22
sudo apt -y install nodejs git build-essential mysql-server
sudo corepack enable && corepack prepare pnpm@latest --activate
sudo npm i -g pm2
# Caddy
sudo apt -y install debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt -y install caddy
sudo mysql_secure_installation
```

## 2. Database

```bash
sudo mysql <<'SQL'
CREATE DATABASE biolinx_engine CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'biolinx'@'localhost' IDENTIFIED BY 'STRONG_PASSWORD_HERE';
GRANT ALL PRIVILEGES ON biolinx_engine.* TO 'biolinx'@'localhost';
FLUSH PRIVILEGES;
SQL
```

## 3. Code + secrets

```bash
sudo mkdir -p /srv && cd /srv
git clone https://github.com/raza935552/biolinkxaffilaiteengine.git engine
cd engine
pnpm install --frozen-lockfile

cp .env.example .env
node -e "console.log('APP_SECRET='+require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log('SETTINGS_KEY='+require('crypto').randomBytes(32).toString('hex'))"
# Put those two into .env, set DATABASE_URL (the password from step 2) and
# ADMIN_ORIGIN=https://engine.biolinxlabs.com. Leave all API keys blank —
# they go in the admin Settings page later.
nano .env
chmod 600 .env
```

## 4. Schema, build, first admin

```bash
pnpm --filter @biolinx/db exec drizzle-kit push   # first-time only: creates the base tables
pnpm --filter @biolinx/db apply-sql sql            # every later change, safe to re-run
pnpm --filter @biolinx/admin build
pnpm --filter @biolinx/api seed:admin you@biolinxlabs.com "Your Name"
# prints an invite link — open it once the site is live to set your password.
```

## 5. Run under PM2

```bash
pm2 start infra/ecosystem.config.cjs
pm2 save
pm2 startup     # run the command it prints so PM2 restarts on reboot
```

Runs `biolinx-api` (:3001, also serves the admin SPA) and `biolinx-worker`
(scheduled jobs).

## 6. Caddy (TLS + proxy)

`/etc/caddy/Caddyfile`:

```
engine.biolinxlabs.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3001
}
```

```bash
sudo systemctl reload caddy
```

Open `https://engine.biolinxlabs.com`, use the invite link, log in, then go to
**Settings** and enter the API keys (stored encrypted).

## 7. Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp
sudo ufw enable
# MySQL stays on localhost — never expose 3306.
```

Optional belt-and-braces: Cloudflare Access on the subdomain, locked to your
team's emails.

## 8. Redeploy

```bash
cd /srv/engine && ./infra/deploy.sh
```

## 9. Nightly backup

```bash
mkdir -p /srv/backups
sudo tee /etc/cron.d/biolinx-backup >/dev/null <<'CRON'
0 3 * * * root mysqldump -u biolinx -pSTRONG_PASSWORD biolinx_engine | gzip > /srv/backups/engine-$(date +\%F).sql.gz
CRON
```

---

## Notes for the deploy agent

- **No Docker** — native processes only: MySQL (systemd), Node×2 (PM2), Caddy.
- **Migrations:** `drizzle-kit push` is idempotent; safe every deploy.
- **`.env` holds only** DATABASE_URL, APP_SECRET, SETTINGS_KEY, ADMIN_ORIGIN,
  PORT, NODE_ENV, BUSINESS_TZ. All third-party API keys are entered in the admin
  Settings page and stored AES-256-GCM encrypted in the DB. Never commit `.env`.
- **Health:** `GET /health` → `{"ok":true}`.
- **Logs:** `pm2 logs`. Secrets are redacted from request logs.
