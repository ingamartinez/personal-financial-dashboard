# findash backup cron

Daily automated backups for the findash PostgreSQL database.

## What it does

- **Daily at 03:15 UTC**: `pg_dump findash | gzip` → `/srv/findash/backups/daily/findash-YYYYMMDDTHHMM.sql.gz`
- Keeps the **14 most recent** local dumps; older ones are pruned automatically.
- **Every Sunday** (from within the same cron run): syncs the local daily dir to Cloudflare R2 (`s3://$R2_BUCKET/findash/`), then prunes R2 to the **12 most recent** dumps.
- R2 sync is skipped gracefully if `/srv/findash/env/r2.env` is not present — local backup still runs.

## Log location

```
/srv/findash/logs/backup.log
```

Tail live: `ssh root@droplet 'tail -f /srv/findash/logs/backup.log'`

## Manual one-off run

```bash
# Daily dump only
ssh root@droplet 'sudo -u findash /usr/local/bin/findash-backup.sh'

# Force R2 sync now (skips day-of-week check)
ssh root@droplet 'sudo -u findash /usr/local/bin/findash-backup.sh --force-r2'
```

## R2 credential rotation

1. Go to Cloudflare dashboard → R2 → Manage API Tokens → revoke old token → create new one.
2. SSH to droplet as root:
   ```bash
   nano /srv/findash/env/r2.env   # update R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY
   chmod 600 /srv/findash/env/r2.env
   ```
3. Verify: `sudo -u findash /usr/local/bin/findash-backup.sh --force-r2`

## Bootstrap install

`infra/bootstrap.sh` handles:

- Installing `awscli` via pipx into `/usr/local/bin` (apt dropped the package in Ubuntu 24.04)
- Creating `/srv/findash/backups/daily/` with correct ownership
- Copying `findash-backup.sh` to `/usr/local/bin/findash-backup.sh` (0755)
- Installing `findash-backup.cron` to `/etc/cron.d/findash-backup` (0644)

After re-running bootstrap on an existing droplet, the cron is live immediately.
