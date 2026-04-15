# Personal Financial Dashboard (findash)

Dashboard financiero personal para Colombia con clasificación AI, presupuestos e insights.

## Stack

- **Next.js 16** (App Router, Turbopack default)
- **Bun 1.3+** runtime
- **Drizzle ORM** + **PostgreSQL 17** (nativo en ia-server, peer auth)
- **Tailwind 4** + shadcn/ui (pendiente)
- **Claude API** (Haiku para clasificación, Sonnet para insights, Vision para OCR)
- **pm2** para deploy en ia-server

## Setup local

```bash
bun install
cp .env.example .env.local
# Editar .env.local con tu ANTHROPIC_API_KEY
bun run db:push        # crea las tablas
bun run db:seed        # cuentas, categorías y reglas colombianas
bun run dev            # arranca en http://localhost:3100
```

## Comandos DB

| Comando | Qué hace |
|---------|----------|
| `bun run db:generate` | Genera migrations a partir del schema |
| `bun run db:migrate` | Aplica migrations pendientes |
| `bun run db:push` | Sincroniza schema sin migration (dev) |
| `bun run db:studio` | Abre Drizzle Studio (UI para la DB) |
| `bun run db:seed` | Carga seed inicial |

## Deploy (ia-server)

```bash
bun install --production
bun run build
pm2 start ecosystem.config.cjs
pm2 save
```

Acceso: `http://ia-server.tailcabcc8.ts.net:3100` (via Tailscale).

Ver `PLAN.md` para detalle completo de arquitectura, flujos de ingesta y roadmap.
