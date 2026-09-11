# Personal Financial Dashboard (findash)

Dashboard financiero personal para Colombia con clasificación AI de gastos,
presupuestos, recurrentes e insights. Self-hosted, single-operator.

## Qué es esto y qué no

Findash es una **herramienta personal**, construida para un caso de uso concreto:
finanzas en Colombia, Bancolombia + ARQ, con ingesta automática para no tipear
transacciones a mano.

Empezó apuntando a producto rentable. **Ese objetivo se abandonó el 2026-09-11**
— demasiado complejo y demasiado atado a necesidades propias para generalizarlo.
La infraestructura multi-tenant que ya existe se queda (funciona y no cuesta
nada correrla), pero ya no justifica trabajo nuevo. Ver
[`docs/business-model.md`](./docs/business-model.md) para qué quedó de ese seam
y por qué el código que lo cita sigue ahí.

Lo que **sí** sigue guiando las decisiones:

- **Calidad > velocidad.** Si una solución toma más tiempo pero queda bien, ese
  es el camino. El costo real no es el tiempo de hacerlo: es tener que hacerlo
  dos veces.
- **Cada canal de ingesta es una superficie real.** SMS, email, OCR, manual — un
  canal a medias produce data sucia, y la data sucia contamina clasificación,
  presupuestos e insights aguas abajo.
- **Los costos se evalúan contra la billetera del operador**, que es una sola.

## Contexto

Developer en Colombia con finanzas desordenadas. Bancos principales: **Bancolombia** y **ARQ** (ex-DollarApp). El pain point central: no quiere ingresar datos manualmente. Necesita un dashboard con clasificación AI de gastos, gráficos, presupuestos y recomendaciones financieras.

**Estrategia de consolidación**: todas las deudas se reúnen en un único préstamo de libre inversión (cuota fija mensual, tasa conocida). Todas las suscripciones recurrentes se concentran en una **e-card de Bancolombia** dedicada, lo que la convierte en el _subscription hub_ del sistema.

### Cuentas (6 en total)

| #   | Banco       | Tipo                                     | Moneda |
| --- | ----------- | ---------------------------------------- | ------ |
| 1   | Bancolombia | Cuenta de ahorros                        | COP    |
| 2   | Bancolombia | Tarjeta de crédito #1                    | COP    |
| 3   | Bancolombia | Tarjeta de crédito #2                    | COP    |
| 4   | Bancolombia | e-card (suscripciones)                   | COP    |
| 5   | Bancolombia | Préstamo libre inversión (consolidación) | COP    |
| 6   | ARQ         | Cuenta de ahorros                        | USD    |

---

## Por qué este stack

**Next.js 16 standalone + PostgreSQL nativo + Claude API**, self-hosted en ia-server. Sin Docker — ia-server ya corre PostgreSQL 17 nativo y la app es de un solo proceso, así que un container sería overhead puro.

- **¿Por qué no Firefly III / Actual Budget?** Customización heavy para Colombia (categorías locales, merchants colombianos, TRM, CDTs/FICs). Un tool genérico requiere más trabajo de adaptación que construir desde cero.
- **¿Por qué no Streamlit?** MVP rápido pero techo bajo en UX, no mobile-friendly, difícil de extender.
- **¿Por qué no backend separado?** Next.js API routes manejan todo el backend necesario. Multi-tenant desde el diseño, pensado para escalar a N users sin rewrite.

---

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
# Editar .env.local: ANTHROPIC_API_KEY y FINDASH_WEBHOOK_TOKEN (ver abajo)
bun run db:push        # crea las tablas
bun run db:seed        # cuentas, categorías y reglas colombianas
bun run dev            # arranca en http://localhost:3100
```

## Environment variables

`.env.example` tiene la plantilla. `.env.local` nunca se commitea.

| Variable                                                 | Qué es                                                                               | Cómo obtenerla                                                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `PGHOST`, `PGDATABASE`, `PGUSER`, `PGPORT`, `PGPASSWORD` | Conexión a PostgreSQL                                                                | Dejar en blanco usa defaults: `/var/run/postgresql` + `findash` + `$USER` (peer auth en Linux).                     |
| `ANTHROPIC_API_KEY`                                      | Clasificación AI, insights y OCR con Claude                                          | https://console.anthropic.com/                                                                                      |
| `FINDASH_WEBHOOK_TOKEN`                                  | Bearer token per-user para `/api/ingest/{sms,debug}` (iOS Shortcut, scripts locales) | Mintá vía `/settings/webhooks` o `bun run db:bootstrap:webhook-tokens`. El plaintext se muestra una vez — guardalo. |

## Comandos DB

| Comando               | Qué hace                              |
| --------------------- | ------------------------------------- |
| `bun run db:generate` | Genera migrations a partir del schema |
| `bun run db:migrate`  | Aplica migrations pendientes          |
| `bun run db:push`     | Sincroniza schema sin migration (dev) |
| `bun run db:studio`   | Abre Drizzle Studio (UI para la DB)   |
| `bun run db:seed`     | Carga seed inicial                    |

## Deploy (ia-server)

```bash
bun install --production
bun run build
pm2 start ecosystem.config.cjs
pm2 save
```

Acceso: `http://ia-server.tailcabcc8.ts.net:3100` (via Tailscale).

## Costos estimados (estado estable)

| Item                             | Costo/mes         |
| -------------------------------- | ----------------- |
| Claude Haiku (classification)    | $0.05-1           |
| Claude Sonnet (monthly insights) | $1-2              |
| Claude Vision (OCR screenshots)  | $0.50-1           |
| ia-server compute                | $0 (ya corriendo) |
| **Total**                        | **~$2-7/mes**     |

## Documentación

`PLAN.md` se desmanteló el 2026-09-11 (issue #922): 19k tokens de los cuales la
mitad describía código que ya existe y llevaba 4.5 meses sin actualizarse. Lo que
sobrevivió está acá, por tema:

| Documento                                                                | Contiene                                                             |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| [`AGENTS.md`](./AGENTS.md)                                               | Contrato de trabajo para agentes y humanos. Se lee en cada arranque. |
| [`docs/ingestion.md`](./docs/ingestion.md)                               | Los 6 canales de ingesta, cobertura por escenario, deduplicación     |
| [`docs/ai-strategy.md`](./docs/ai-strategy.md)                           | Pipeline de clasificación, learning loop, dónde manda AI vs regex    |
| [`docs/roadmap.md`](./docs/roadmap.md)                                   | Qué significa cada fase y qué la destraba. Estado vivo: el board.    |
| [`docs/business-model.md`](./docs/business-model.md)                     | Seams de monetización (deferred), closed beta, validation triggers   |
| [`docs/phase-7-seam-audit.md`](./docs/phase-7-seam-audit.md)             | Qué queda del seam de Fase 7, qué cuesta, y por qué no se dropea     |
| [`docs/telemetry-slos.md`](./docs/telemetry-slos.md)                     | SLOs del parser Bancolombia y telemetría per-user                    |
| [`docs/gmail-integration.md`](./docs/gmail-integration.md)               | Epic G — gateway opacity, Canal 6b, multi-tenant safety              |
| [`docs/native-clients.md`](./docs/native-clients.md)                     | Estrategia iOS/Android (deferred), research de captura de SMS        |
| [`docs/epics.md`](./docs/epics.md)                                       | Epics V (currency), R (reconciliation), T (bot), I (insights)        |
| [`docs/deploy.md`](./docs/deploy.md)                                     | Runbook de producción completo                                       |
| [`docs/multi-user-plan.md`](./docs/multi-user-plan.md)                   | Migración single-user → multi-tenant (referencia de #179)            |
| [`docs/telegram-bot.md`](./docs/telegram-bot.md)                         | Setup y uso del canal Telegram                                       |
| [`docs/events-bus-listen-notify.md`](./docs/events-bus-listen-notify.md) | `EventEmitter` → Postgres `LISTEN/NOTIFY` (decisión de #151)         |

Arquitectura, schema de base de datos, estructura de carpetas y páginas de UI
**no** están documentados en prosa a propósito: se derivan del código, y una copia
en markdown se desactualiza en semanas. Usá CodeGraph (`codegraph explore "..."`)
o leé `src/lib/db/schema.ts` directamente.
