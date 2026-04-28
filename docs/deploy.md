# Findash — Deployment Runbook

Production URL: **https://findash.alejoframes.com**

---

## 1. Topology

```
User request
     |
     v
Cloudflare edge  (Full strict TLS, WAF, DDoS mitigation)
     |  HTTPS/443 — CF terminating cert
     v
Caddy 2 :443     (TLS: Cloudflare origin cert, 15yr, expires 2041-04-14)
     |  HTTP localhost:3000
     v
Next.js 16       (standalone, systemd unit: findash.service)
     |  Unix socket /var/run/postgresql
     v
PostgreSQL 17    (on-droplet, peer auth, no TCP listener, role=findash)
```

Each hop's purpose:
- **Cloudflare edge**: public TLS termination, caching, DDoS scrubbing. Origin IP is not in public DNS — only CF knows it.
- **Caddy**: reverse-proxy only. Origin cert from CF (not Let's Encrypt) so CF ↔ origin is encrypted end-to-end under "Full strict" mode.
- **Next.js**: App Router, standalone output, reads env from systemd EnvironmentFile.
- **PostgreSQL**: peer-auth via Unix socket — no password, no network exposure.

---

## 2. Host inventory

| Item | Value |
|---|---|
| Droplet IP | 147.182.138.79 |
| Region | NYC3 |
| Plan | $21/mo — AMD 2 vCPU / 2 GB RAM / 60 GB NVMe |
| OS | Ubuntu 24.04 LTS |
| Domain | findash.alejoframes.com |
| SSH users | `root` (admin), `deploy` (CD target), `findash` (app runtime) |

### File layout under `/srv/findash/`

```
/srv/findash/
  app/
    releases/
      <sha>/          — each CD deploy writes here (Next.js standalone)
        release.env   — per-release env (GIT_SHA=<sha>), 0640 findash
        migrate-prod.ts
        drizzle/
        node_modules/drizzle-orm, postgres
        ...
    current -> releases/<sha>   — active symlink, read by systemd
  env/
    findash.env       — baseline prod env, 0640 root:findash (never in git)
    r2.env            — R2 backup credentials, 0600 root:root (never in git)
  backups/
    daily/            — pg_dump .sql.gz files
  logs/               — Next.js app logs (journald is primary; this for tail)
```

Ownership conventions:
- `/srv/findash/env/` — `0750 root:findash` (findash group can read, not write)
- `findash.env` — `0640 root:findash`
- `r2.env` — `0600 root:root`
- `releases/<sha>/` — `0755 findash:findash`
- `backups/`, `logs/` — `0750 findash:findash`

---

## 3. First-time droplet bring-up

Ordered steps matching what was actually done:

1. **Provision droplet** on DigitalOcean: Ubuntu 24.04 LTS, AMD, NYC3. Add your SSH key at creation.

2. **Cloudflare DNS**: Add an `A` record `findash.alejoframes.com → 147.182.138.79`, proxied (orange cloud). Set SSL/TLS mode to **Full (strict)**.

3. **Cloudflare origin cert**: Dashboard → SSL/TLS → Origin Server → Create Certificate. Choose 15 years. Download the cert (PEM) and private key. You will paste them on the droplet in step 6.

4. **Run bootstrap** (from repo root on the droplet):
   ```bash
   sudo bash infra/bootstrap.sh
   ```
   This installs Bun, PG17, Caddy, creates users/dirs/firewall/swap, and sets up the backup cron. Safe to re-run.

5. **Paste origin cert**:
   ```bash
   # As root on droplet:
   nano /etc/caddy/origin.pem   # paste the CF origin cert (full chain)
   chmod 644 /etc/caddy/origin.pem
   nano /etc/caddy/origin.key   # paste the private key
   chmod 600 /etc/caddy/origin.key
   chown root:caddy /etc/caddy/origin.key
   ```

6. **Populate `findash.env`** (see `.env.example` for all vars):
   ```bash
   nano /srv/findash/env/findash.env
   # Required at minimum:
   #   AUTH_SECRET, AUTH_GOOGLE_ID, AUTH_GOOGLE_SECRET
   #   AUTH_URL=https://findash.alejoframes.com
   #   AUTH_TRUST_HOST=true
   #   ANTHROPIC_API_KEY, GROQ_API_KEY, TELEGRAM_TOKEN_ENCRYPTION_KEY
   #   FX_REFRESH_TOKEN, BOOTSTRAP_USER_EMAIL, BOOTSTRAP_USER_NAME
   # Optional:
   #   AI_FALLBACK_ENABLED=true  (SMS AI fallback kill-switch; default off, #257)
   ```

7. **Add deploy SSH key** to the `deploy` user:
   ```bash
   mkdir -p /home/deploy/.ssh
   echo "<public key>" >> /home/deploy/.ssh/authorized_keys
   chmod 700 /home/deploy/.ssh
   chmod 600 /home/deploy/.ssh/authorized_keys
   chown -R deploy:deploy /home/deploy/.ssh
   ```
   Install the sudoers drop-in (already done by bootstrap.sh):
   ```
   /etc/sudoers.d/findash-deploy
   ```

8. **Set GitHub Secrets** (repo Settings → Secrets → Actions):
   - `DEPLOY_SSH_KEY` — private ed25519 key corresponding to the public key added above
   - `DEPLOY_HOST` — `147.182.138.79`
   - `DEPLOY_USER` — `deploy`
   - `APP_HEALTH_URL` — `https://findash.alejoframes.com/api/health`

9. **Enable services and trigger first deploy**:
   ```bash
   systemctl enable --now caddy
   # First deploy will enable findash.service via the workflow
   ```
   Push to `main` (or use `workflow_dispatch`) to trigger the first CD deploy.

---

## 4. Deploy flow

Trigger: push to `main` (after CI passes) or `workflow_dispatch`.

Workflow file: `.github/workflows/deploy.yml`

Sequence:
1. **workflow_run** event fires when CI workflow completes with `success` on `main`.
2. **Checkout** the exact SHA that passed CI.
3. **Build** Next.js standalone output (dummy `AUTH_SECRET` at build time; real secrets on droplet).
4. **Package tarball**: bundles `.next/standalone`, `.next/static`, `public/`, `drizzle/`, `migrate-prod.ts`, plus `drizzle-orm` and `postgres` node_modules overlaid (Next.js standalone doesn't auto-trace the migrator).
5. **SCP tarball** to `/tmp/release-<sha>.tar.gz` on droplet (as `deploy` user).
6. **Extract**: `sudo -u findash` creates `releases/<sha>/`, unpacks tarball, writes `release.env` with `GIT_SHA`.
7. **Run migrations**: `sudo -u findash bun migrate-prod.ts` in the release dir.
8. **Flip symlink**: `ln -sfn releases/<sha> app/current`, then `sudo systemctl restart findash.service`.
9. **Health probe**: polls `$APP_HEALTH_URL` for `"ok":true` — 15 attempts × 3s = 45s timeout.
10. **Rollback on failure**: if health probe fails and a previous `current` symlink existed, flip back and restart.
11. **Prune**: on success, removes all but the 5 most recent release dirs.

---

## 5. Manual deploy (workflow_dispatch)

Via GitHub Actions UI:
1. Go to Actions → Deploy → Run workflow.
2. Enter a git ref (branch name, tag, or full SHA). Leave blank for `main`.
3. Click "Run workflow".

Via `gh` CLI:
```bash
# Deploy main
gh workflow run deploy.yml

# Deploy a specific SHA
gh workflow run deploy.yml --field ref=<sha>

# Watch the run
gh run list --workflow=deploy.yml --limit=1
gh run watch <run-id>
```

---

## 6. Rollback

### Automatic (built into deploy workflow)

If the health probe fails after a symlink flip, the workflow's "Rollback on failure" step automatically:
1. Flips `app/current` back to the previous release dir.
2. Restarts `findash.service`.

This covers the case where CI was green but the app fails to start in production.

### Manual via SSH

```bash
ssh root@147.182.138.79

# List available releases (newest first)
ls -lt /srv/findash/app/releases/

# Flip to a specific release
sudo -u findash ln -sfn /srv/findash/app/releases/<previous-sha> /srv/findash/app/current
systemctl restart findash.service

# Verify
curl -s https://findash.alejoframes.com/api/health
```

---

## 7. Day-2 ops

```bash
# Tail app logs (primary — journald)
ssh root@147.182.138.79 'journalctl -u findash -f'

# Last 100 lines
ssh root@147.182.138.79 'journalctl -u findash -n 100'

# Restart app
ssh root@147.182.138.79 'systemctl restart findash'

# Reload Caddy (e.g. after cert rotation)
ssh root@147.182.138.79 'systemctl reload caddy'

# DB shell (peer auth — no password)
ssh root@147.182.138.79 'sudo -u findash psql -d findash'

# Check disk usage
ssh root@147.182.138.79 'df -h'

# Check app memory
ssh root@147.182.138.79 'systemctl status findash | grep Memory'

# List releases on disk
ssh root@147.182.138.79 'ls -lth /srv/findash/app/releases/'

# Check backup log
ssh root@147.182.138.79 'tail -50 /srv/findash/logs/backup.log'

# Trigger a manual backup now
ssh root@147.182.138.79 'sudo -u findash /usr/local/bin/findash-backup.sh'

# Trigger backup + R2 sync now (skip Sunday check)
ssh root@147.182.138.79 'sudo -u findash /usr/local/bin/findash-backup.sh --force-r2'
```

---

## 8. Backup and restore

### How backups are made

See `infra/cron/` for scripts and schedule.

- **Daily at 03:15 UTC**: `pg_dump findash | gzip` → `/srv/findash/backups/daily/findash-YYYYMMDDTHHMM.sql.gz`. Local retention: 14 dumps.
- **Every Sunday**: local daily dir synced to Cloudflare R2 (`s3://findash-backups/findash/`). R2 retention: 12 dumps.
- Cron runs as `findash` user (peer-auth to PG, no password needed).
- All activity logged to `/srv/findash/logs/backup.log`.

### List available local backups

```bash
ssh root@147.182.138.79 'ls -lth /srv/findash/backups/daily/'
```

### Restore from a local daily dump

```bash
ssh root@147.182.138.79

# Pick the dump to restore
DUMP=/srv/findash/backups/daily/findash-20260418T0315.sql.gz

# Stop the app first to avoid writes during restore
systemctl stop findash

# Restore (as findash user — peer auth)
sudo -u findash bash -c "
  dropdb --if-exists findash
  createdb findash
  gunzip -c '$DUMP' | psql -d findash
"

systemctl start findash
curl -s https://findash.alejoframes.com/api/health
```

### List backups on R2

```bash
# On the droplet (requires r2.env to be configured):
ssh root@147.182.138.79

. /srv/findash/env/r2.env
AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
  aws --endpoint-url "https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com" \
    s3 ls s3://${R2_BUCKET}/findash/
```

### Restore from R2

```bash
ssh root@147.182.138.79

. /srv/findash/env/r2.env
ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
KEY="findash/findash-20260413T0315.sql.gz"   # pick from list above
DEST="/srv/findash/backups/daily/$(basename $KEY)"

# Download
AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
  aws --endpoint-url "$ENDPOINT" \
    s3 cp "s3://${R2_BUCKET}/${KEY}" "$DEST"
chown findash:findash "$DEST"

# Now restore as local dump (see section above)
systemctl stop findash
sudo -u findash bash -c "
  dropdb --if-exists findash
  createdb findash
  gunzip -c '$DEST' | psql -d findash
"
systemctl start findash
curl -s https://findash.alejoframes.com/api/health
```

---

## 9. Secret rotation

### AUTH_SECRET

`AUTH_SECRET` is the NextAuth signing key. Rotating it **invalidates all active sessions** — every user will be logged out.

```bash
# Generate new secret
openssl rand -base64 32

# On droplet:
ssh root@147.182.138.79
nano /srv/findash/env/findash.env   # update AUTH_SECRET=<new value>
systemctl restart findash
```

No code change or redeploy needed — findash.service reads the env file at startup.

### FX_REFRESH_TOKEN

Bearer token protecting `POST /api/fx/refresh`. Changing it requires updating both the droplet env and any external cron that calls the endpoint.

```bash
openssl rand -hex 32   # generate new token

# On droplet:
nano /srv/findash/env/findash.env   # update FX_REFRESH_TOKEN=<new value>
systemctl restart findash

# Update the cron/script that calls /api/fx/refresh with the new token.
```

### DEPLOY_SSH_KEY

1. Generate a new ed25519 keypair locally:
   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/findash-deploy-new -C "findash-deploy"
   ```
2. Add the new public key to the droplet:
   ```bash
   ssh root@147.182.138.79
   echo "<new public key>" >> /home/deploy/.ssh/authorized_keys
   ```
3. Update GitHub Secret `DEPLOY_SSH_KEY` to the new private key contents.
4. Trigger a test deploy to confirm it works.
5. Remove the old public key from `/home/deploy/.ssh/authorized_keys`.

### Cloudflare origin cert

The current cert expires **2041-04-14**. When rotation is needed:

1. Cloudflare dashboard → SSL/TLS → Origin Server → Create Certificate (new 15yr).
2. On droplet:
   ```bash
   nano /etc/caddy/origin.pem   # paste new cert
   nano /etc/caddy/origin.key   # paste new private key
   chmod 600 /etc/caddy/origin.key
   chown root:caddy /etc/caddy/origin.key
   systemctl reload caddy
   ```
3. Verify: `curl -sv https://findash.alejoframes.com/api/health 2>&1 | grep -E 'SSL|subject|expire'`

### R2 credentials

See `infra/cron/README.md` → "R2 credential rotation" for the full steps.

Summary: revoke old R2 API token in CF dashboard → create new one → update `/srv/findash/env/r2.env` on droplet → test with `--force-r2`.

---

## 10. R2 setup (off-site backups)

These are manual ops you perform once after this PR merges. The backup script is installed but will skip R2 sync until `r2.env` exists.

### Step 1 — Create the R2 bucket

1. Log into Cloudflare dashboard → **R2 Object Storage** → **Create bucket**.
2. Bucket name: `findash-backups`. Region: **Auto** (recommended).
3. Leave all other settings at default. Click Create.

### Step 2 — Create an R2 API token

1. R2 dashboard → **Manage API Tokens** (top right) → **Create API Token**.
2. Token name: `findash-backup`.
3. Permissions: **Object Read & Write** — scope to bucket `findash-backups` only. Do NOT use "Admin Read & Write".
4. Click Create API Token.
5. Copy the **Access Key ID** and **Secret Access Key** — they are shown only once.

You will also need your **Cloudflare Account ID**, visible in the right sidebar of your CF dashboard.

### Step 3 — Create r2.env on the droplet

```bash
ssh root@147.182.138.79

cat > /srv/findash/env/r2.env <<'EOF'
R2_ACCOUNT_ID=<your cloudflare account id>
R2_ACCESS_KEY_ID=<access key id from step 2>
R2_SECRET_ACCESS_KEY=<secret access key from step 2>
R2_BUCKET=findash-backups
EOF

chmod 600 /srv/findash/env/r2.env
```

### Step 4 — Ensure awscli is installed

`bootstrap.sh` handles this automatically via pipx (Ubuntu 24.04 dropped the `awscli` apt package). If running on an existing droplet without re-running bootstrap:

```bash
apt-get install -y pipx
PIPX_HOME=/opt/pipx PIPX_BIN_DIR=/usr/local/bin pipx install awscli
aws --version   # sanity check
```

### Step 5 — Verify connectivity

```bash
. /srv/findash/env/r2.env
AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
  aws --endpoint-url "https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com" \
    s3 ls s3://${R2_BUCKET}/

# Expect: empty output (no error = success)
```

### Step 6 — Trigger first off-site backup

```bash
sudo -u findash /usr/local/bin/findash-backup.sh --force-r2
tail -f /srv/findash/logs/backup.log
```

---

## 11. Threat model

### Compromised droplet

If the droplet is compromised, the attacker has access to the database and application secrets. Recovery path:

1. Provision a new droplet, run bootstrap.
2. Restore the latest daily or R2 backup (§8).
3. Rotate all secrets (§9) before bringing the new droplet live.
4. Point Cloudflare DNS `A` record to new droplet IP.

R2 backups are stored off-droplet, so a full disk wipe does not lose more than the current day's data.

### Stolen GitHub token / DEPLOY_SSH_KEY leak

The `DEPLOY_SSH_KEY` only grants SSH access to the `deploy` user, whose sudoers drop-in is limited to `sudo -u findash` and `sudo systemctl {restart,reload,status} findash.service`. It cannot read `/srv/findash/env/findash.env` (owned root:findash, no deploy group).

Mitigation: rotate `DEPLOY_SSH_KEY` immediately per §9. The attacker can deploy arbitrary code but cannot exfiltrate the baseline env before the key is revoked.

### Cloudflare API token leak

The CF API token used to provision the origin cert has been revoked post-setup. The origin cert itself is on the droplet at `/etc/caddy/origin.{pem,key}` — see §9 for rotation. A leaked cert only enables MITM if an attacker also controls a CF-proxied zone.

### Database dump stolen (R2 breach)

R2 bucket ACL is set to private (default). Only the scoped API token can access it. Dumps are gzip-compressed but not separately encrypted at the application level — R2 storage is encrypted at rest by Cloudflare.

If the R2 token is stolen: revoke it in the CF dashboard, create a new token, update `r2.env`. Historical backups in the bucket remain accessible to the attacker until the bucket is renamed or the objects are deleted. Rotate `AUTH_SECRET` to invalidate all sessions.

---

## 13. Redis (BullMQ queue backend)

Added by Epic #586 / issue #587.

### Installation (first-time on fresh droplet)

```bash
ssh root@147.182.138.79

# Install Redis 7 from Ubuntu 24.04 repos
apt-get install -y redis-server

# Copy the Findash systemd unit (overrides the stock service file)
cp /path/to/repo/infra/systemd/redis.service /etc/systemd/system/redis.service
systemctl daemon-reload

# Enable + start
systemctl enable --now redis.service
```

Verify it's bound to localhost only and AOF is enabled:

```bash
redis-cli ping                     # PONG
redis-cli CONFIG GET appendonly    # appendonly yes
redis-cli INFO server | grep bind  # bind_addresses:127.0.0.1
```

Add `REDIS_URL` to the app env file:

```bash
nano /srv/findash/env/findash.env
# Add:
# REDIS_URL=redis://127.0.0.1:6379
```

### Monitoring

```bash
# General health + memory
redis-cli INFO

# Connected clients
redis-cli CLIENT LIST

# Queue key counts (BullMQ uses sorted sets per queue)
redis-cli KEYS "bull:*" | head -20

# Real-time command stats (press Ctrl-C to stop)
redis-cli MONITOR
```

Via systemd:

```bash
systemctl status redis.service
journalctl -u redis-findash -f       # SyslogIdentifier from the unit file
```

### AOF backup

Redis AOF file lives at `/var/lib/redis/appendonly.aof`. It's written to
continuously and survives a process crash.

To take a point-in-time copy:

```bash
# Trigger a blocking BGREWRITEAOF first (compacts the AOF)
redis-cli BGREWRITEAOF

# Wait for completion
redis-cli INFO persistence | grep aof_rewrite_in_progress  # 0 = done

# Copy the compacted AOF
cp /var/lib/redis/appendonly.aof /srv/findash/backups/daily/redis-aof-$(date +%Y%m%dT%H%M).aof
```

The daily Postgres pg_dump cron (§8) does NOT cover Redis. Job data is
transient (queues are drained within seconds under normal operation) — losing
the AOF on a catastrophic failure means in-flight jobs are re-enqueued on next
app start by the application logic, not by Redis restore.

### Restart procedure

```bash
# Graceful restart (flushes AOF before stopping)
systemctl restart redis.service

# Full stop (drains in-flight BGSAVE/AOF writes first — up to 10s)
systemctl stop redis.service
```

### Troubleshooting

| Symptom | Check |
|---|---|
| BullMQ throws `maxRetriesPerRequest must be null` | ioredis connection created without `maxRetriesPerRequest: null` — see `src/lib/queue/index.ts` |
| `redis-cli ping` → Connection refused | `systemctl status redis.service`; check bind address |
| Jobs stuck in waiting | Worker not running; check instrumentation logs |
| AOF growing unboundedly | Run `redis-cli BGREWRITEAOF` to compact |

### AOF size monitoring and rotation

AOF can grow if the app crashes repeatedly or BGREWRITEAOF is never triggered. Monitor:

```bash
# AOF file size
ls -lh /var/lib/redis/appendonly.aof

# Persistence stats (aof_current_size, aof_rewrite_in_progress, etc.)
redis-cli INFO persistence

# Auto-rotation trigger: compacts log by rewriting it from the current dataset
redis-cli BGREWRITEAOF
# Wait for completion:
redis-cli INFO persistence | grep aof_rewrite_in_progress   # 0 = done
```

Redis auto-triggers a rewrite when the AOF grows 100% over its base size (`auto-aof-rewrite-percentage 100`). For a consistently busy production instance, add an explicit weekly cron that calls BGREWRITEAOF (outside the app, as root/redis user).

---

## 14. Queue ops runbook (BullMQ)

All background work (cron schedules + async jobs) runs via BullMQ backed by Redis. There is no `node-cron` in the project — `node-cron` was removed in issue #594.

### Active queues

| Queue name | Purpose | Schedule |
|---|---|---|
| `fx-refresh` | Update exchange rates from external API | Daily 03:00 America/Bogota |
| `classify-tx` | Run AI classifier on a single transaction | On-demand (enqueued after import) |
| `recurring-gap` | Detect missing recurring transactions | Daily 07:00 America/Bogota |
| `health-snapshots` | Write account-balance snapshots | Daily 01:00 America/Bogota |
| `slo-alerts` | Check SLOs and send Telegram alerts | Every 5 minutes |
| `gmail-pull` | Pull email transactions for all active connections | Hourly |

### Bull-Board dashboard

Bull-Board is mounted at `/admin/queues`. It requires an authenticated session with the `admin` role (`requireAdmin` gate — unauthorized requests get a 403 before the dashboard ever loads).

Access:

```
https://findash.alejoframes.com/admin/queues
```

The dashboard shows each queue's waiting / active / completed / failed / delayed counts and lets you inspect individual job payloads and logs.

### Manually trigger a stuck job

If a job is stuck in `waiting` or `delayed` state (e.g., the worker crashed before picking it up):

1. Open Bull-Board → select the queue → find the job.
2. Click **Promote** (available on `delayed` jobs) to move it to `waiting` immediately.
3. If the worker is running, the job will be picked up within seconds.

If the worker itself is not running, restart the app first (see "Restart workers" below).

### Retry failed jobs

Jobs land in `failed` state after exhausting their retry attempts (default: 3 with exponential backoff starting at 1 s).

1. Open Bull-Board → select the queue → **Failed** tab.
2. Click **Retry** on individual jobs, or **Retry All** to re-enqueue everything.
3. Watch the **Active** count — jobs should move from `failed` → `waiting` → `active` → `completed`.

Alternatively, via `redis-cli` (advanced):

```bash
# List failed job IDs for a queue
redis-cli LRANGE "bull:classify-tx:failed" 0 -1

# Move a specific failed job back to waiting (BullMQ internal key format)
# Prefer Bull-Board UI over manual key manipulation.
```

### Inspect job logs and payloads

Via Bull-Board:

1. Click any job row to expand it.
2. **Data** tab: the full JSON payload passed when the job was enqueued.
3. **Logs** tab: structured log lines emitted via `job.log()` inside the processor.

Via `redis-cli`:

```bash
# List all BullMQ keys for a queue
redis-cli KEYS "bull:fx-refresh:*" | sort

# Inspect a waiting job's data (BullMQ stores jobs as hashes)
redis-cli HGETALL "bull:fx-refresh:<job-id>"
```

### Drain a backed-up queue

If a queue accumulates more waiting jobs than the worker can process (e.g., after a long downtime):

```bash
# Count jobs in each state
redis-cli LLEN "bull:<queue-name>:wait"
redis-cli ZCARD "bull:<queue-name>:failed"

# Obliterate everything in a queue (waiting + failed + completed) — DESTRUCTIVE
# Only use this if the backlog is stale and safe to discard.
# Prefer Bull-Board "Clean" buttons (by state + age) for surgical cleanup.
redis-cli DEL "bull:<queue-name>:wait" "bull:<queue-name>:failed"
```

The safer option is Bull-Board → queue → **Clean** button: lets you delete jobs older than N ms in a given state without touching active or recent jobs.

### Restart workers

Workers run inside the Next.js process (registered in `src/instrumentation.node.ts`). Restarting the app restarts all workers:

```bash
ssh root@147.182.138.79
systemctl restart findash.service
```

After restart, workers re-register their recurring schedules (the `jobId: "<name>-recurring"` ensures idempotency — BullMQ will not add a duplicate repeat entry if one already exists).

### Verify worker health

```bash
# App logs — look for "worker_init" and "job_completed" events
journalctl -u findash -n 200 | grep -E 'worker_init|job_completed|job_failed|worker_error'

# Redis active list (jobs currently being processed)
redis-cli LRANGE "bull:fx-refresh:active" 0 -1
redis-cli LRANGE "bull:classify-tx:active" 0 -1

# Delayed jobs (scheduled future runs — repeating jobs appear here)
redis-cli ZRANGE "bull:fx-refresh:delayed" 0 -1 WITHSCORES

# Quick count across all queues
for q in fx-refresh classify-tx recurring-gap health-snapshots slo-alerts gmail-pull; do
  echo -n "$q waiting: "
  redis-cli LLEN "bull:$q:wait"
done
```

A healthy worker will show `worker_init` in logs at startup and `job_completed` entries after each run. If a worker is missing from logs after restart, check for a startup error in `journalctl -u findash -n 50 --no-pager`.

---

## 12. Engram keys for deeper context

Prior SDD planning artifacts for this deployment can be retrieved by future agents:

| Artifact | Engram topic key |
|---|---|
| Exploration | `sdd/feat-digitalocean-deploy/explore` |
| Proposal | `sdd/feat-digitalocean-deploy/proposal` |
| Spec | `sdd/feat-digitalocean-deploy/spec` |
| Design | `sdd/feat-digitalocean-deploy/design` |
| Tasks | `sdd/feat-digitalocean-deploy/tasks` |
| Apply progress | `sdd/feat-digitalocean-deploy/apply-progress` |

Retrieve with:
```
mem_search(query: "sdd/feat-digitalocean-deploy/<artifact>", project: "personal-financial-dashboard")
mem_get_observation(id: <id from search>)
```
