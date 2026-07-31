# infra/

Droplet-side scaffolding for the DigitalOcean deploy. The full runbook
(topology, day-2 ops, rollback, backup restore, secret rotation) lives
at [`docs/deploy.md`](../docs/deploy.md) — landed separately in T7.

## Files

| Path                      | Purpose                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| `bootstrap.sh`            | Idempotent server bootstrap. Run once on a fresh droplet with `sudo bash infra/bootstrap.sh`. |
| `systemd/findash.service` | systemd unit for the Next.js + Telegram worker process.                                       |
| `systemd/redis.service`   | Hardened Redis unit (BullMQ queue backend). Installed by the CD workflow.                     |
| `sudoers/`                | `/etc/sudoers.d/` drop-ins. See below — these are NOT applied automatically.                  |
| `caddy/Caddyfile`         | Reverse proxy config for Cloudflare Full (strict) TLS.                                        |

## sudoers drop-ins

`infra/sudoers/*` are the reviewable source of truth for the corresponding
files in `/etc/sudoers.d/` on the droplet. Nothing installs them for you —
editing one here does not change the running box.

| File                      | Grants                                                                                          |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| `findash-redis-provision` | `deploy` → install redis-server and the Redis unit, manage `redis.service` (#795)               |
| `findash-unit-install`    | `deploy` → install `findash.service` (and restore the previous copy on rollback) from CD (#799) |

To install or update one, on the droplet as root:

```bash
# ALWAYS validate first. A syntax error in /etc/sudoers.d/ locks sudo for
# every user on the box, and you may not have a second way in.
install -m 0440 -o root -g root infra/sudoers/<name> /tmp/sudoers.check
visudo -c -f /tmp/sudoers.check && rm -f /tmp/sudoers.check
install -m 0440 -o root -g root infra/sudoers/<name> /etc/sudoers.d/<name>
```

**Staging paths must never be under `/tmp`.** The droplet is shared with
unrelated services, and `/tmp` is world-writable — a local principal can
pre-create the staged file and rewrite it in the window before a privileged
install, getting root to install their content. The nightly backup crons run
as `findash`, `photoshowcase` and `zyeth` and cron does **not** apply
`PrivateTmp=`, so that window is reachable. Stage under
`/home/deploy/staging` (`0700`, inside `deploy`'s `0750`-with-empty-group
home) and install with `install -m 0644 -o root -g root`, never `mv`.

## Quick start (first-time droplet bring-up)

1. Clone the repo on the droplet (e.g. `/home/deploy/personal-financial-dashboard`).
2. `sudo bash infra/bootstrap.sh`.
3. Paste the Cloudflare origin cert at `/etc/caddy/origin.{pem,key}`.
4. Populate `/srv/findash/env/findash.env` (all variables from `.env.example`).
5. Run the first CD deploy. On success: `systemctl enable --now findash caddy`.
6. `curl https://<your-subdomain>/api/health` — expect `{"ok":true,"db":"ok"}`.

The CD workflow (T5) automates step 5 for every push to `main`.
