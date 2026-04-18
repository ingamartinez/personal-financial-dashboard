# infra/

Droplet-side scaffolding for the DigitalOcean deploy. The full runbook
(topology, day-2 ops, rollback, backup restore, secret rotation) lives
at [`docs/deploy.md`](../docs/deploy.md) — landed separately in T7.

## Files

| Path                      | Purpose                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| `bootstrap.sh`            | Idempotent server bootstrap. Run once on a fresh droplet with `sudo bash infra/bootstrap.sh`. |
| `systemd/findash.service` | systemd unit for the Next.js + Telegram worker process.                                       |
| `caddy/Caddyfile`         | Reverse proxy config for Cloudflare Full (strict) TLS.                                        |

## Quick start (first-time droplet bring-up)

1. Clone the repo on the droplet (e.g. `/home/deploy/personal-financial-dashboard`).
2. `sudo bash infra/bootstrap.sh`.
3. Paste the Cloudflare origin cert at `/etc/caddy/origin.{pem,key}`.
4. Populate `/srv/findash/env/findash.env` (all variables from `.env.example`).
5. Run the first CD deploy. On success: `systemctl enable --now findash caddy`.
6. `curl https://<your-subdomain>/api/health` — expect `{"ok":true,"db":"ok"}`.

The CD workflow (T5) automates step 5 for every push to `main`.
