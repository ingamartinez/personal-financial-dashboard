#!/usr/bin/env bash
# findash — DigitalOcean droplet bootstrap (Ubuntu 24.04 LTS).
#
# Idempotent: safe to re-run after edits. Designed to be invoked from the
# repo root on a freshly-provisioned droplet:
#
#   sudo bash infra/bootstrap.sh
#
# What it does (in order):
#   1. apt update + security upgrade
#   2. Create `findash` (runtime) and `deploy` (CD target) OS users
#   3. Install Bun pinned to the version in .bun-version
#   4. Install PostgreSQL 17 from PGDG + create role/database via peer auth
#   5. Install Caddy 2 (reverse proxy with Cloudflare origin cert)
#   6. Create /srv/findash/{app/releases,app/current,env,backups,logs} layout
#   7. UFW default-deny + allow 22/80/443; block 5432 from the public
#   8. fail2ban on sshd + unattended security upgrades + 2 GB swap
#   9. Install the systemd unit and Caddyfile from the repo (does NOT enable;
#      the first real deploy will flip `app/current` and start the service)
#  10. Install backup cron + awscli; create /srv/findash/backups/daily/
#
# Cloudflare origin cert is NOT fetched here — paste the PEM + key at
# /etc/caddy/origin.pem and /etc/caddy/origin.key after the T2 ops step.
#
set -euo pipefail

FINDASH_USER="${FINDASH_USER:-findash}"
DEPLOY_USER="${DEPLOY_USER:-deploy}"
APP_ROOT="/srv/findash"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BUN_VERSION="$(tr -d '[:space:]' <"$REPO_ROOT/.bun-version")"

log() { printf '[bootstrap] %s\n' "$*" >&2; }

if [[ $EUID -ne 0 ]]; then
  log "must run as root (try: sudo bash infra/bootstrap.sh)"
  exit 1
fi

log "apt: update + security upgrade"
apt-get update -y
DEBIAN_FRONTEND=noninteractive apt-get upgrade -y

log "apt: install base packages"
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  curl ca-certificates gnupg lsb-release \
  ufw fail2ban unattended-upgrades \
  build-essential rsync unzip \
  debian-keyring debian-archive-keyring apt-transport-https \
  awscli

log "users: ensure $FINDASH_USER and $DEPLOY_USER exist"
for u in "$FINDASH_USER" "$DEPLOY_USER"; do
  if ! id "$u" &>/dev/null; then
    useradd -m -s /bin/bash "$u"
    log "  created $u"
  fi
done

log "layout: $APP_ROOT/{app/releases,env,backups,logs}"
install -d -m 0755 -o "$FINDASH_USER" -g "$FINDASH_USER" "$APP_ROOT"
install -d -m 0755 -o "$FINDASH_USER" -g "$FINDASH_USER" "$APP_ROOT/app"
install -d -m 0755 -o "$FINDASH_USER" -g "$FINDASH_USER" "$APP_ROOT/app/releases"
install -d -m 0750 -o root -g "$FINDASH_USER" "$APP_ROOT/env"
install -d -m 0750 -o "$FINDASH_USER" -g "$FINDASH_USER" "$APP_ROOT/backups"
install -d -m 0750 -o "$FINDASH_USER" -g "$FINDASH_USER" "$APP_ROOT/logs"

if [[ ! -f "$APP_ROOT/env/findash.env" ]]; then
  install -m 0640 -o root -g "$FINDASH_USER" /dev/null "$APP_ROOT/env/findash.env"
  log "  created empty $APP_ROOT/env/findash.env — populate before starting findash.service"
fi

log "bun: install pinned version $BUN_VERSION"
current_bun="$(bun --version 2>/dev/null || echo none)"
if [[ "$current_bun" != "$BUN_VERSION" ]]; then
  sudo -u "$FINDASH_USER" bash -c \
    "curl -fsSL https://bun.sh/install | bash -s bun-v$BUN_VERSION"
  ln -sf "/home/$FINDASH_USER/.bun/bin/bun" /usr/local/bin/bun
fi

log "postgres 17: install from PGDG"
if ! command -v psql &>/dev/null; then
  install -d /etc/apt/keyrings
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc |
    gpg --dearmor -o /etc/apt/keyrings/pgdg.gpg
  codename="$(lsb_release -cs)"
  printf 'deb [signed-by=/etc/apt/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt %s-pgdg main\n' \
    "$codename" >/etc/apt/sources.list.d/pgdg.list
  apt-get update -y
  DEBIAN_FRONTEND=noninteractive apt-get install -y postgresql-17 postgresql-contrib-17
fi
systemctl enable --now postgresql

log "postgres: ensure role + database for $FINDASH_USER (peer auth)"
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$FINDASH_USER'" | grep -q 1; then
  sudo -u postgres createuser --createdb "$FINDASH_USER"
fi
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='findash'" | grep -q 1; then
  sudo -u "$FINDASH_USER" createdb findash
fi

log "caddy 2: install"
if ! command -v caddy &>/dev/null; then
  # Caddy's cloudsmith sources.list (debian.deb.txt) declares
  # signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg — the
  # keyring MUST land at that exact path or apt rejects the repo with
  # NO_PUBKEY. Match the vendor's documented install flow exactly.
  curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/gpg.key" |
    gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt" \
    >/etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

log "caddy: install Caddyfile from repo"
install -m 0644 "$REPO_ROOT/infra/caddy/Caddyfile" /etc/caddy/Caddyfile

if [[ ! -s /etc/caddy/origin.pem || ! -s /etc/caddy/origin.key ]]; then
  log "WARNING: Cloudflare origin cert missing at /etc/caddy/origin.{pem,key}"
  log "  paste the CF-issued cert before enabling caddy.service"
fi

log "systemd: install findash.service from repo"
install -m 0644 "$REPO_ROOT/infra/systemd/findash.service" /etc/systemd/system/findash.service
systemctl daemon-reload

log "ufw: default-deny + allow 22/80/443"
ufw --force reset >/dev/null
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

log "fail2ban: enable"
systemctl enable --now fail2ban

log "unattended-upgrades: enable periodic security updates"
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

log "swap: ensure 2 GB /swapfile"
if ! swapon --show | grep -q '^/swapfile'; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi

log "backup: create daily backup dir"
install -d -m 0750 -o "$FINDASH_USER" -g "$FINDASH_USER" "$APP_ROOT/backups/daily"

log "backup: install backup script to /usr/local/bin"
install -m 0755 -o root -g root "$REPO_ROOT/infra/cron/findash-backup.sh" /usr/local/bin/findash-backup.sh

log "backup: install cron file to /etc/cron.d"
install -m 0644 -o root -g root "$REPO_ROOT/infra/cron/findash-backup.cron" /etc/cron.d/findash-backup

cat >&2 <<EOF

[bootstrap] done.

Next steps (manual, in order):
  1. Paste the Cloudflare origin cert:
       /etc/caddy/origin.pem   (0644 root:root)
       /etc/caddy/origin.key   (0600 root:caddy)
  2. Populate $APP_ROOT/env/findash.env with prod values
     (start from .env.example — fill every variable).
  3. (Optional) Create $APP_ROOT/env/r2.env for off-site backups
     (see docs/deploy.md §10 for exact steps and credentials).
  4. Run the first CD deploy (or manually rsync .next/standalone/ to
     $APP_ROOT/app/releases/<sha> and flip the app/current symlink).
  5. systemctl enable --now findash.service caddy
  6. curl https://<your-subdomain>/api/health → expect {ok:true,db:"ok"}.
EOF
