# Personal Financial Dashboard — Plan

## Vision & Guiding Principles

**Findash arranca como herramienta personal (yo + algunos amigos), pero el objetivo a largo plazo es escalarla como producto rentable.** Toda decisión arquitectónica, de producto, y de implementación debe contemplar esta trayectoria — no construimos solo para el "ahora".

Principios que se derivan de esto:

- **Calidad > velocidad**: si una solución toma más tiempo pero queda bien, ese es el camino. No tomamos atajos que después haya que rehacer.
- **Multi-tenant desde el diseño**: aunque el deploy actual sea single-user, las decisiones de schema, auth, ingesta y UI tienen que sostener N usuarios sin un rewrite. Ver `docs/multi-user-plan.md`.
- **Onboarding pensado para users no-técnicos**: soluciones tipo "importá este perfil de Tasker / configurá este Shortcut a mano" sirven para nosotros, pero NO son el destino. Cuando el costo de fricción supere el costo de construirlo bien, vamos por el camino bueno (apps nativas, flows guiados, etc.).
- **Cada canal de ingesta es una superficie de producto**: SMS, notificaciones, OCR, manual — todos tienen que ser pulidos eventualmente. Las versiones "personal hack" son válidas como paso 1 si están explícitamente marcadas como tal.
- **Las decisiones de costo (Claude API, infra) se evalúan a estado-estable de N usuarios, no a 1**.

Cuando haya que elegir entre "rápido y desechable" vs "más lento y sostenible", default es el segundo.

---

## Context

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

## Business Model & Pricing (Deferred — gated by validation)

Findash arranca como herramienta para usuarios cercanos (closed beta, sin pagos). La infra de monetización queda **diseñada pero NO implementada** hasta que el producto se valide con users reales. Ver "Validation Triggers" abajo para los disparadores concretos.

### Modelo SaaS (cuando se active)

Dos tiers:

| Tier    | Precio COP/mes      | Incluye                                                                    |
| ------- | ------------------- | -------------------------------------------------------------------------- |
| Basic   | 15,000 (~$3.75 USD) | Dashboard, captura SMS/Apple Pay, rule engine, Claude Haiku classification |
| Premium | 25,000 (~$6.25 USD) | Todo Basic + insights AI mensuales (Claude Sonnet), OCR ilimitado, widgets |

- **Trial**: 30 días gratis, todas las features incluidas. Suficiente para ver al menos 1 insight mensual AI (el "moment of truth" del producto).
- **Paywall soft (no hard)**: al expirar, dashboard histórico sigue visible pero captura se pausa. Banner persistente: _"Tu app está pausada. Pagá para reactivar."_ Hard paywall hace que el user se vaya y no vuelva; soft paywall convierte mejor.
- **Billing provider**: **MercadoPago** (web-first signup). Stripe no acepta bien tarjetas locales colombianas; MercadoPago es nativo y acepta PSE, Nequi, tarjetas. Comisión ~3.5% + IVA.

### Distribución de apps móviles: web-first signup

Las apps iOS/Android son **client-only** — NO ofrecen signup ni mencionan precios adentro. Razón técnica: Apple/Google exigirían IAP (15-30% comisión) si la app desbloquea features de suscripción. Con web-first signup (patrón de Netflix, Spotify, Linear) quedamos con 3.5% MercadoPago y margen sano.

### Schema y seams para monetización (preparados desde v1)

Aunque billing NO se implementa, el schema multi-tenant desde day 1 incluye columnas nullable: `subscription_status`, `plan_id`, `trial_ends_at`, `mercadopago_customer_id`. En `/api/ingest/*` hay un seam `canIngest(userId)` que retorna `true` en v1. El día que se active SaaS, se enchufa MercadoPago y se cambia la función — sin migration dolorosa.

**Status**: **DEFERRED.** Implementation gated por triggers en "Validation Triggers" abajo.

---

## Decisión de Approach

**Next.js 16 standalone + PostgreSQL nativo + Claude API**, self-hosted en ia-server. Sin Docker — ia-server ya corre PostgreSQL 17 nativo y la app es de un solo proceso, así que un container sería overhead puro.

- **¿Por qué no Firefly III / Actual Budget?** Customización heavy para Colombia (categorías locales, merchants colombianos, TRM, CDTs/FICs). Un tool genérico requiere más trabajo de adaptación que construir desde cero.
- **¿Por qué no Streamlit?** MVP rápido pero techo bajo en UX, no mobile-friendly, difícil de extender.
- **¿Por qué no backend separado?** Next.js API routes manejan todo el backend necesario. Multi-tenant desde el diseño, pensado para escalar a N users sin rewrite.

---

## Architecture

```
┌──────────────────────────────────────────────────┐
│               Next.js 16 (App Router)            │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
│  │Dashboard │  │ Txn List │  │  Insights     │  │
│  │(Recharts)│  │ + Search │  │  + AI Tips    │  │
│  └──────────┘  └──────────┘  └───────────────┘  │
│               API Routes (Route Handlers)        │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
│  │Ingestion │  │Classify  │  │  Reports      │  │
│  │Pipeline  │  │Pipeline  │  │  Generator    │  │
│  └──────────┘  └──────────┘  └───────────────┘  │
└──────────────────┬───────────────────────────────┘
                   │
            ┌──────┴──────┐
            │ PostgreSQL  │
            │  (port 5433)│
            └─────────────┘
```

- **Sin auth inicial** — acceso solo via Tailscale (ia-server.tailcabcc8.ts.net:3100)
- **Cron via node-cron** en Next.js instrumentation hook
- **Runtime**: Bun 1.3+ (`bun start`), gestionado por pm2 (ya instalado en ia-server)
- **DB**: PostgreSQL 17 nativo en ia-server, database dedicada `findash`

---

## Tech Stack

| Capa              | Elección                                   | Razón                                                                                       |
| ----------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Framework         | Next.js 16 (App Router, Turbopack default) | SSR para dashboard, API routes para backend                                                 |
| Lenguaje          | TypeScript                                 | Expertise existente                                                                         |
| DB                | PostgreSQL 16                              | Ya corre en ia-server                                                                       |
| ORM               | Drizzle ORM                                | Type-safe, liviano                                                                          |
| Charts            | Recharts                                   | React-native, buenos componentes financieros                                                |
| UI                | Tailwind + shadcn/ui                       | Ya usado en otros proyectos                                                                 |
| AI Classification | Claude API (Haiku)                         | Clasificación barata (~$0.001/txn)                                                          |
| AI Insights       | Claude API (Sonnet)                        | Reportes mensuales con análisis profundo                                                    |
| AI OCR            | Claude Vision API                          | Screenshot parsing para ARQ                                                                 |
| Runtime           | Bun 1.3+                                   | Más rápido que Node, native TS                                                              |
| Deployment        | pm2 en ia-server                           | Puerto 3100 (evita conflicto con CC en 3000), reuso de pm2 ya instalado, logs/monit nativos |

---

## Data Ingestion — 4 canales (el corazón del sistema)

### Canal 1: Apple Pay Transaction Trigger (iOS 17+) 🍎

**Cubre**: Cualquier compra con Apple Pay (todas las tarjetas en Apple Wallet)

```
Pagás con Apple Pay
    → iOS Shortcut "Transaction" trigger se dispara automáticamente
    → Captura: merchant, monto, tarjeta usada, fecha
    → POST https://ia-server:3100/api/ingest/apple-pay
    → Clasificación + storage
```

- **Esfuerzo**: Zero (background, sin desbloquear)
- **Setup**: Un iOS Shortcut una sola vez
- **Dato clave**: Desde iOS 17, Apple Shortcuts tiene trigger nativo por transacción Apple Pay

### Canal 2: SMS Bancolombia 📱

**Cubre**: Compras con tarjeta física Bancolombia (cuando no se usa Apple Pay)

```
Compra con tarjeta física
    → SMS de código 891602 (débito) o 891333 (crédito)
    → iOS Shortcut trigger "Message Contains 'Bancolombia'"
    → POST raw SMS text al API
    → Server parsea monto/merchant/fecha con regex
    → Clasificación + storage
```

- **Esfuerzo**: Zero (background)
- **Formato típico SMS**: "Bancolombia le informa compra por $45,000 en EXITO CALLE 80..."
- **Limitación**: Solo Bancolombia, no funciona para ARQ

### Canal 3: Transacciones Recurrentes 🔁

**Cubre**: Cuota del préstamo de libre inversión + cualquier gasto fijo predecible (arriendo, servicios base, salario)

```
Tabla recurring_transactions:
- amount_cents, category, account_id, day_of_month, active, label

Cron mensual (día 1, 6am COT)
    → SELECT * FROM recurring_transactions WHERE active
    → INSERT cada una como transacción del mes
    → Marcar source = 'recurring'
```

- **Esfuerzo**: Zero (una vez configurado)
- **Bonus**: el préstamo consolidado tiene cuota fija, encaja perfecto con este patrón
- **Nota**: las suscripciones (Netflix, Spotify, iCloud, etc.) NO van acá — caen por SMS Bancolombia de la e-card automáticamente

### Canal 4: Screenshot OCR (ARQ + fallback universal) 📸

**Cubre**: ARQ (sin API ni export) + cualquier banco como fallback

```
Screenshot de la app
    → Upload al dashboard (drag & drop o desde celular)
    → Claude Vision API extrae transacciones
    → Preview editable (confirmar/corregir antes de guardar)
    → Clasificación + storage
```

- **Esfuerzo**: ~1 min/semana
- **Costo**: ~$0.01 por screenshot
- **Capacidad**: Un screenshot puede tener 5-15 transacciones
- **Para ARQ**: Establecer saldo inicial, luego cada transacción por pantallazo

### Canal 5: Manual Entry ✍️

**Cubre**: Efectivo (tiendas, buses, comida callejera)

- Formulario rápido en el dashboard
- Colombia tiene economía de efectivo significativa

### Cobertura por escenario

| Escenario                            | Canal                  | Esfuerzo      |
| ------------------------------------ | ---------------------- | ------------- |
| Compra Apple Pay (cualquier tarjeta) | 🍎 Transaction Trigger | Zero          |
| Compra tarjeta física Bancolombia    | 📱 SMS Shortcut        | Zero          |
| Suscripciones (e-card)               | 📱 SMS Shortcut        | Zero          |
| Cuota préstamo consolidado           | 🔁 Recurring           | Zero          |
| Cualquier movimiento ARQ             | 📸 Screenshot OCR      | ~1 min/semana |
| Efectivo                             | ✍️ Manual              | ~30 seg/gasto |

**Cobertura automática estimada: ~95%**

### Deduplicación

Si pagás con Apple Pay usando tarjeta Bancolombia → llegan DOS señales (Transaction Trigger + SMS). El pipeline de ingesta deduplica: mismo monto + misma fecha + ventana de ±5 minutos = misma transacción. Prioridad: Apple Pay (datos más estructurados) > SMS.

---

## AI Classification Pipeline

```
Transacción nueva
    │
    ▼
[Rule Engine] — tabla classification_rules, ILIKE patterns, prioridad
    │ match → categorizar, guardar
    │ no match ↓
    ▼
[Claude Haiku] — batch hasta 20 txns por llamada
    │
    ▼
Guardar resultado + confidence
    │
    ▼
[Learning Loop] — corrección manual → auto-genera regla nueva
```

**30+ reglas seed para merchants colombianos:**

- EXITO/CARULLA/JUMBO/D1/ARA → Mercado
- RAPPI → Delivery
- UBER/DIDI → Transporte
- EPM/ETB/CLARO/TIGO → Servicios Públicos
- NETFLIX/SPOTIFY → Suscripciones
- SURA/EPS → Salud/Seguros

**Costo estimado**: 500 txns/mes, 90% matched por rules = ~50 llamadas AI = ~$0.05/mes

### Refinamientos (Phase 4.6)

El skeleton del pipeline ya existe (`src/lib/classification/{rules,ai,pipeline}.ts`). En Phase 4.6 se enriquece con cinco refinamientos para que la auto-clasificación sea **realmente autónoma + transparente + que aprenda bien**.

#### 1. Confidence-aware UX en 3 bandas

| Confianza                      | Comportamiento                            | UX                                                     |
| ------------------------------ | ----------------------------------------- | ------------------------------------------------------ |
| > 0.9 (rule match o AI fuerte) | Silent auto-classify                      | Sin badge                                              |
| 0.6 – 0.9 (AI medio)           | Auto-classify con badge visible           | 🤖 _"Auto: {cat} — confirmar"_ + 1-click re-categorize |
| < 0.6 (AI dudoso)              | Auto-classify + ruteo al `/inbox` del bot | Telegram push: _"¿fue {A} o {B}?"_ con inline buttons  |

#### 2. Learning loop hybrid (anti-overfit)

- **1 sola corrección** → **soft signal**. Se guarda en contexto del user, AI lo consume en futuros calls. **NO genera rule.**
- **3+ correcciones del mismo merchant al mismo destino en 30 días** → sistema **propone** rule. 1-click approve.
- Approved → rule auto-generada con flag `auto_generated = true`. Visible y deshabilitable en `/settings/rules`.

Razón del hybrid: si se auto-generara rule tras UNA corrección, user que compra cookware en Carulla una vez (corrige a "Hogar") rompería todas sus futuras compras Mercado. El threshold de 3+ filtra ruido.

#### 3. Explainability por txn

Click-through _"¿Por qué esta categoría?"_ que surfacea:

- _"Matched rule #N: pattern X → Y (creada 2026-03-12, auto-generated from 3 corrections)"_
- _"Claude Haiku clasificó como X (confidence 0.87)"_
- _"Primera aparición de merchant — asumido X por contexto similar"_

No inline — click-through. Build trust sin clutter.

#### 4. Retroactive rule application

Al crear rule (manual desde `/settings/rules` o auto-aprobada vía learning loop):

- Prompt: _"Aplicar a transacciones pasadas? 147 matches en últimos 90 días."_
- User confirma → bulk update con `previous_category_slug` preservado por txn (audit trail reversible)

Killer para onboarding: una corrección limpia 3 meses de historial.

#### 5. First-encounter flagging

Primera vez que aparece un merchant en la cuenta del user:

- Badge `🆕 Primer encuentro` en el row de `/transactions`
- Push bot: _"Nueva compra en MERCHANT_X ($45K). ¿Mercado, Restaurantes, otro?"_ con inline buttons
- Si user no actúa → auto-classification default queda

Esto coordina con Epic I.B _"New merchant alert"_ — una sola fuente de verdad, no doble-badge.

### Schema additions (para todos estos refinamientos)

- `classification_rules.auto_generated BOOLEAN DEFAULT false`
- `classification_rules.generated_from_corrections JSONB NULL` (audit trail de qué txn_ids gatillaron)
- `transactions.classification_confidence DECIMAL NULL`
- `transactions.previous_category_slug VARCHAR NULL` (reversibilidad retroactiva)
- `user_classification_context` — tabla nueva o JSONB column en `users` (soft-learning signals)

Tracked: issue #256.

---

## Database Schema

### Tipos de producto soportados

```
SAVINGS (Ahorros)          CREDIT CARD (TC)              LOAN (Préstamo)
─────────────────          ──────────────────             ─────────────────
• Balance actual           • Cupo total                  • Monto original
• Transacciones            • Cupo disponible             • Saldo actual
                           • Fecha de corte              • Tasa de interés (E.M.)
                           • Fecha pago mínimo           • Plazo (meses)
                           • Pago mínimo                 • Cuota mensual
                           • Pago total                  • Intereses pagados
                           • Compras en cuotas           • Capital pagado
                           • Intereses causados          • Próximo pago
```

### Key tables

- **accounts** — nombre, institución, tipo (savings/credit_card/loan), moneda, balance, metadata por tipo (cupo, tasa, plazo)
- **categories** — jerárquico (parent_slug), con iconos y colores para charts
- **transactions** — amount_cents (BIGINT), descripción raw + clean, category, método de clasificación, confidence, source (apple_pay/sms/ocr/recurring/manual), raw_data (JSONB)
- **classification_rules** — pattern, prioridad, categoría, hit_count
- **budgets** — por categoría, período, rango de fechas
- **ingestion_logs** — auditoría de cada sync/upload
- **account_snapshots** — balance diario por cuenta (para gráficos históricos)

**Categorías colombianas seed**: Vivienda, Alimentación (Mercado, Restaurantes, Delivery), Transporte (Uber/Didi, Gasolina, Transporte público), Salud (EPS, Pensión, Medicamentos), Educación, Entretenimiento, Servicios Públicos (Energía, Agua, Gas, Internet/Telecom), Seguros, Inversiones (CDTs, FICs), Deudas (TC, Préstamos), Ropa, Tecnología, Suscripciones, Transferencias, Otros.

---

## UI Pages

| Ruta                   | Propósito                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------- |
| `/`                    | Dashboard: patrimonio neto, flujo de caja mensual, donut de categorías, tendencia, barras de presupuesto |
| `/transactions`        | Lista con filtros (fecha, categoría, cuenta, búsqueda), edición inline de categoría                      |
| `/budgets`             | Creación y tracking de presupuestos por categoría                                                        |
| `/insights`            | Reporte mensual AI con análisis + sugerencias colombianas (CDTs, FICs, ahorro)                           |
| `/accounts`            | Vista por cuenta: balance, últimas transacciones, estado de TC y préstamos                               |
| `/settings/import`     | Upload CSV + Screenshot OCR (drag & drop)                                                                |
| `/settings/accounts`   | Manage cuentas, saldos iniciales, recurring transactions                                                 |
| `/settings/categories` | CRUD categorías                                                                                          |
| `/settings/rules`      | Gestión de reglas de clasificación                                                                       |

**Dashboard highlights:**

- Net worth card con conversión COP/USD (TRM del Banco de la República)
- Burn rate: "A este ritmo, tenés X meses de runway"
- Heatmap diario de gastos (estilo GitHub contributions)
- Budget vs actual con highlight de excesos
- Estado de deuda: TCs + préstamo consolidado (saldo, progreso de pago, amortización)

---

## Project Structure

```
personal-financial-dashboard/
├── PLAN.md
├── ecosystem.config.cjs         # pm2 config para deploy en ia-server
├── drizzle/
│   ├── 0000_initial.sql
│   └── seed.ts                    # Categorías + reglas colombianas
├── src/
│   ├── app/
│   │   ├── page.tsx               # Dashboard
│   │   ├── transactions/page.tsx
│   │   ├── accounts/page.tsx
│   │   ├── budgets/page.tsx
│   │   ├── insights/page.tsx
│   │   ├── settings/{import,accounts,categories,rules}/
│   │   └── api/
│   │       ├── transactions/route.ts
│   │       ├── classify/route.ts
│   │       ├── ingest/
│   │       │   ├── apple-pay/route.ts
│   │       │   ├── sms/route.ts
│   │       │   ├── csv/route.ts
│   │       │   └── ocr/route.ts
│   │       ├── accounts/route.ts
│   │       ├── budgets/route.ts
│   │       ├── insights/route.ts
│   │       └── cron/monthly-recurring/route.ts
│   ├── lib/
│   │   ├── db/{index,schema}.ts
│   │   ├── ingestion/
│   │   │   ├── apple-pay.ts       # Parse Apple Pay transaction trigger data
│   │   │   ├── sms-bancolombia.ts # Parse Bancolombia SMS format
│   │   │   ├── csv-parser.ts      # Generic CSV parser
│   │   │   ├── ocr.ts             # Claude Vision screenshot processing
│   │   │   ├── recurring.ts       # Monthly recurring transactions generator
│   │   │   └── dedup.ts           # Deduplication logic (±5 min window)
│   │   ├── classification/
│   │   │   ├── rules.ts           # Rule engine (ILIKE patterns)
│   │   │   ├── ai.ts              # Claude Haiku batch classifier
│   │   │   └── pipeline.ts        # Rules → AI fallback orchestrator
│   │   ├── currency/trm.ts        # TRM Banco de la República API
│   │   └── utils/format.ts        # COP/USD formatting
│   └── components/
│       ├── ui/                    # shadcn
│       ├── dashboard/
│       ├── transactions/
│       └── layout/
├── ios-shortcuts/
│   └── README.md                  # Instrucciones setup iOS Shortcuts
└── CLAUDE.md
```

---

## Phased Roadmap

### Phase 1: Foundation + Manual Import (Semana 1-2)

- Scaffold Next.js 16 + Drizzle + Docker Compose + shadcn
- Schema + migrations + seed (categorías colombianas, 6 cuentas)
- CSV upload para Bancolombia (bancolombia-extractor Chrome extension)
- Screenshot OCR para ARQ (Claude Vision)
- Transaction list con filtros y búsqueda
- Dashboard básico: totales mensuales + donut de categorías
- Rule engine con 30+ reglas colombianas
- Entrada manual de gastos en efectivo
- **Costo: $0/mes** (solo Claude Vision por screenshots)

### Phase 2: Real-time Ingestion (Semana 3-4)

- iOS Shortcut: Apple Pay Transaction Trigger → webhook
- iOS Shortcut: SMS Bancolombia → webhook
- API endpoints para recibir webhooks (`/api/ingest/apple-pay`, `/api/ingest/sms`)
- SMS parser (regex para formato Bancolombia)
- Deduplicación (Apple Pay + SMS misma compra)
- Claude Haiku classification para unmatched transactions
- User correction flow → auto-genera reglas
- **Costo: ~$2/mes**

### Phase 3: Budgets + Recurring + Loan Tracking (Semana 5-6)

- Tabla `recurring_transactions` + cron mensual
- Vista de préstamo consolidado (saldo, progreso, próximo pago, amortización)
- Presupuestos por categoría con tracking
- Vista dedicada "Suscripciones" (derivada de e-card + detección de recurrencia)
- Charts de tendencias (12 meses histórico)
- Conversión TRM COP/USD (API Banco de la República)
- PWA manifest para acceso mobile
- **Costo: ~$3/mes**

### Phase 4: Insights + Polish (Semana 7-8)

- Insights page: reporte mensual AI (Claude Sonnet)
- Sugerencias colombianas (CDTs, FICs, ahorro)
- Heatmap diario de gastos
- Detección de transferencias entre cuentas propias
- Detección de gastos recurrentes
- Comparación mes vs mes / año vs año
- Export CSV/PDF para declaración de renta
- Dark mode
- Backup automático de DB (pg_dump cron)
- **Costo: ~$7/mes (estado estable)**

### Phase 4.5: Closed Beta Foundation (active)

Pre-requisito para invitar amigos al beta cerrado.

**Ya hecho (verificado en GitHub):**

- ✅ Multi-tenant (#179, #183): `user_id` en todas las tablas tenant + query rewrite
- ✅ NextAuth v5 + Google OAuth + session middleware (#181)
- ✅ Tablas `users` + `invite_codes` + bootstrap (#182)
- ✅ Invite-code signup flow (#184)
- ✅ Admin UI para mintear invites + role gate (#189)
- ✅ Absolute invite URLs + soft-disable (#231)
- ✅ Per-user webhook token auth (#194)
- ✅ Public deploy en DigitalOcean + CD (#186)
- ✅ iOS Shortcut install card surfaced en `/settings/webhooks` (#243)
- ✅ Telegram bot zero-accounts guard (#233 — fix de loop infinito)

**Pendiente (issues nuevos a crear):**

1. **`/settings/accounts` page con UI de creación/edición de cuentas** — CRÍTICO. Sin esto, ningún amigo puede dar de alta su primera cuenta. El bot Telegram ya apunta a esta ruta (en su zero-accounts guard) pero la ruta no existe; `/accounts` existe pero solo lista, sin crear (su empty state dice "use the seed script or DB"). Onboarding blocker.
2. **Billing-ready columns en `users`** — `subscription_status`, `plan_id`, `trial_ends_at`, `mercadopago_customer_id` nullable. Seam para Phase 7 sin enforcement en v1.
3. **`canIngest(userId)` seam** en `/api/ingest/*` — wrapper que retorna `true` en v1, hook para futuro paywall sin tocar endpoints.
4. **Per-user telemetry foundation** — tabla `user_health_snapshots`, cron de actualización, vista admin privada `/admin/health` con last_sms_received_at, capture source breakdown, parser success rate, churn signals.
5. **Bancolombia parser SLO instrumentation** — logging estructurado por intento de parseo + dashboard mostrando las 6 SLOs definidas + alerting cuando degrada.
6. **iOS Shortcut onboarding polish** — más allá de la card actual: video/GIF demostrativo, troubleshooting section, advertencias sobre gotchas (no guardar como contacto, no responder 3+ veces — aplica también a la futura app nativa).

### Phase 4.6: Web Product Depth (active, sequential to 4.5)

**Objetivo**: hacer la app web tan buena que valga la pena cobrar por ella. Esto es lo que desbloquea Phase 7 (SaaS productization).

Cuatro epics grandes aquí:

- **Epic V — Currency Visual Toggle**: dropdown COP/USD/native aplicado globalmente
- **Epic R — Bank Statement Reconciliation**: balance adjustment (quick win) + CSV Excel parsers (savings/TC/e-card) + engine + UI reconcile + flagged review + divergence tracking
- **Epic T — Telegram Bot Expansion**: Stage 1 (queries + summaries + charts + inbox), Stage 2 (smart notifs + NLU + write actions + goals), Stage 3 deferred (conversational AI Premium)
- **Epic I — Insights & Behavioral**: Subscription Hub, anomaly detection, CDT/FIC optimization, TC utilization, forecasting, tax tracking

Ver secciones arriba por detalle de cada epic. Sub-issues se crean just-in-time cuando arranca cada sub-task.

**Costo incremental**: tiempo de dev. Potencialmente ~$2-5 más/mes en Claude API si conversational AI se enciende.

### Phase 5: iOS native app (TRIGGER-GATED — see Validation Triggers)

Arranca **solo si dispara el trigger de iOS native**. Documentación completa en "Native Clients Strategy" arriba.

- Apple Developer Program enrollment ($99/año, individual)
- Xcode project setup en `ios/` (monorepo)
- AASA file hosted en `<findash-domain>/.well-known/apple-app-site-association`
- `POST /api/ios/sms-filter` endpoint (backend)
- Device pairing flow (6-digit code + endpoint)
- Main app: SwiftUI shell + WebView wrapper del dashboard + sign-in + pairing UI
- `FindashSMSFilter` extension: `ILMessageFilterExtension` con network deferral
- `FindashWidgets` extension: WidgetKit + SwiftUI (spend del mes, budget, últimas txns)
- APNs push notifications (insights mensuales, alertas)
- TestFlight beta interno (5-10 amigos)
- App Store submission (privacy policy, marketing copy, review notes con narrativa "Transactions/Finance categorization")

**Costo incremental**: $99/año Apple Developer.

### Phase 6: Android native app (TRIGGER-GATED)

Arranca **solo si dispara el trigger de Android native**.

- Google Play Developer account ($25 USD one-time)
- Android Studio project setup en `android/` (monorepo)
- `POST /api/android/notification` y `POST /api/android/sms` endpoints
- Main app: Kotlin + Jetpack Compose, WebView wrapper
- `NotificationListenerService` (captura notifs de apps bancarias)
- `SMSReceiver` (captura SMS, fallback)
- Device pairing UX (mismo 6-digit code que iOS)
- Play Store submission

### Phase 7: SaaS productization (TRIGGER-GATED)

Arranca **solo si dispara el trigger de SaaS productization**.

- MercadoPago integration (checkout + webhooks + recurring billing + retry logic)
- Plan enforcement middleware (tiers Basic 15K / Premium 25K)
- `canIngest(userId)` implementa lógica real de subscription_status
- Soft paywall UI (banner + pause de captura cuando expira)
- Onboarding web público (signup → plan choice → 30-day trial)
- Landing page pública + pricing page
- Email transactional (welcome, trial expiring, payment failed)

**Costo incremental**: comisiones MercadoPago (3.5% + IVA) al activar.

### Phase 8: Multi-bank (TRIGGER-GATED por SLOs Bancolombia)

Cada banco nuevo (Nu, Davivienda, Banco de Bogotá) requiere:

- Research de shortcodes y formatos de SMS/notif del banco
- Parser específico (módulo en `src/lib/ingestion/parsers/<bank>.ts`)
- Regression test suite con samples reales
- SLOs medidos igual que Bancolombia v1 (≥30 días verdes para considerar production-ready)

---

## Costos Estimados (Estado Estable)

| Item                             | Costo/mes         |
| -------------------------------- | ----------------- |
| Claude Haiku (classification)    | $0.05-1           |
| Claude Sonnet (monthly insights) | $1-2              |
| Claude Vision (OCR screenshots)  | $0.50-1           |
| ia-server compute                | $0 (ya corriendo) |
| **Total**                        | **~$2-7/mes**     |

---

## AI Strategy

### Tesis

Con pricing actual de Claude API (Haiku $1/M input / $5/M output; Sonnet $3/M input / $15/M output), **AI está prácticamente regalado para nuestro volumen**. Operaciones individuales cuestan fracciones de centavo. Esto cambia la conversación sobre cuándo usar AI.

### Pricing observado (por operación típica)

| Operación                         | Haiku   | Sonnet  |
| --------------------------------- | ------- | ------- |
| Parse 1 SMS Bancolombia           | $0.0015 | $0.0045 |
| Classify 1 txn                    | $0.0008 | $0.0024 |
| OCR 1 screenshot (Vision)         | $0.004  | $0.012  |
| NLU query (_"cuánto gasté en X"_) | $0.0014 | $0.0042 |
| Insight anomaly check             | $0.0021 | $0.0063 |

Proyectado por user activo/mes (100 SMS + 50 classif + 5 screenshots + 20 queries):

- **Haiku-heavy**: ~$0.40/user/mes worst-case
- **Mix actual (rules first + Haiku fallback)**: ~$0.05/user/mes

Revenue Basic 15K COP = $3.75 USD → margen holgado incluso en peor escenario (~10%). Con **prompt caching** de Anthropic (`cache_control` en system prompts + fewshots), costos bajan 50-70% adicional.

### Principios

1. **AI como fallback + validator + enabler, NO como hot path.** Regex parsers siguen siendo primera línea — rápidos (<50ms vs 500-2000ms de AI), deterministas, debuggeables, gratis. AI complementa, no reemplaza.

2. **Determinismo manda en datos financieros.** Amount, date, sign, currency — no queremos hallucinations ahí. Regex parsea, AI valida/fallback solo cuando regex falla.

3. **Prompt caching desde day 1.** Todos los calls a Claude API usan `cache_control` para system prompts y fewshots. No es optimización futura — es decisión arquitectónica de entrada.

4. **Cost ceiling: 15% del revenue.** Si AI costs superan ese umbral, revisar. Target estado-estable: <10%.

### Dónde AI manda (vs regex)

| Caso                               | Por qué AI gana                                                          |
| ---------------------------------- | ------------------------------------------------------------------------ |
| Edge cases que regex no puede      | Format drift, misspellings, new merchants                                |
| Canary / drift detection           | Sample paralelo para detectar cambios de formato ANTES que afecten users |
| Razonamiento multi-step            | Anomaly con contexto temporal, counterparty disambig                     |
| Compresión semántica               | Merchant canonicalization, recurring detection avanzada, semantic dedup  |
| Conversational queries             | Stage 3 del bot — razonamiento sobre datos del user                      |
| Excel statement parsing            | Formatos variables, celdas combinadas, headers raros — AI resiliente     |
| Category learning from corrections | Pattern detection across N corrections                                   |

### Patrones concretos decididos

- **Classification pipeline (#256)** — rules first, AI fallback, soft-learning de correcciones, pattern-based auto-rule con approve manual
- **SMS parser fallback** — regex first; si `needs_review`, Haiku intenta; guardar con `parsed_by='ai_fallback'`. Tracked en issue separado
- **Canary detection** — 1% de SMS shadow-parsed con Haiku; si discrepancia >3% sobre 24h → alerta "parser regex posiblemente desactualizado". Tracked en issue separado
- **Bot conversational (Epic T Stage 3)** — Sonnet + tool use en Basic tier con soft quota (100 queries/mes free, unlimited Premium)
- **Excel statement parser (Epic R)** — AI-driven primero por velocidad de iteración; regex específicos cuando tengamos confianza/volumen
- **Merchant canonicalization, counterparty disambig, recurring detection avanzada, anomaly reasoning** — todos AI-native (sub-tasks de Epic I)

---

## Native Clients Strategy (Deferred — gated by validation)

### Filosofía: automatización es el moat

La captura autónoma es el producto. Cuanto menos piensa el user, mejor. Apps nativas reemplazan la configuración manual de Shortcut/Tasker con captura en background — user instala app, otorga UN permiso, se olvida.

### Secuencia: iOS primero, Android después

- **iOS primero**: el user + beta inicial son iOS. Aprender el flow de App Store review temprano de-risks fases posteriores. El Shortcut actual (current state) es serviceable para beta iOS — tenemos runway.
- **Android después**: los 1-2 beta testers Android pueden usar Tasker temporalmente. No es aceptable para SaaS público pero sí para beta cerrado.

### iOS native app — architecture

**Monorepo layout (`personal-financial-dashboard/ios/`):**

```
ios/
├── Findash.xcodeproj
├── Findash/                   # main app (WebView wrapper del web dashboard)
├── FindashSMSFilter/          # ILMessageFilterExtension (captura SMS)
├── FindashWidgets/            # WidgetKit + SwiftUI (home screen widgets)
└── FindashTests/              # unit tests
```

**Tres targets Xcode, cada uno con un rol específico:**

| Target                         | Rol                                                       | Tech                                 |
| ------------------------------ | --------------------------------------------------------- | ------------------------------------ |
| `Findash` (main app)           | Shell + sign-in + dashboard WebView + device pairing UI   | UIKit + `WKWebView`                  |
| `FindashSMSFilter` (extension) | Capturar SMS Bancolombia en background, postear a backend | SwiftUI + `IdentityLookup` framework |
| `FindashWidgets` (extension)   | Widgets de home screen (spend, budget, últimas txns)      | SwiftUI + `WidgetKit`                |

**Data flow — SMS capture:**

```
Bancolombia SMS (shortcode 891602 o 891333)
    ↓
iOS detecta: sender no en contactos → route al extension
    ↓
FindashSMSFilter (network deferral mode)
    ↓ POST
https://<findash-domain>/api/ios/sms-filter
    Body: { sender, body, appVersion }
    Auth: AASA-bound + bundle ID check + shared secret
    ↓
Backend: parseSmsBancolombia() existente
    ↓ response
{ action: "none" }  ← pass-through, NO ocultar SMS del user
```

**Widgets comparten data vía App Group:**

- Main app, al abrir, cachea summary data (`spend_this_month`, `budget_progress`, `last_3_txns`) en App Group container
- Widget lee del App Group en su `TimelineProvider`
- Widget puede también pegar directo al backend con auth token guardado en Keychain (compartido vía App Group)

### iOS SMS capture — research findings (KEY SECTION)

**Esta es la API que desbloquea captura autónoma de SMS en iOS sin Shortcut manual.** Documentado acá para no re-researchar más adelante. Research ejecutado 2026-04-19.

#### La API: `ILMessageFilterExtension`

Del framework `IdentityLookup` de Apple, disponible desde iOS 11. Originalmente diseñado para bloqueadores de spam (Truecaller, Hiya, Bouncer), soporta un modo **"network deferral"** donde la extensión postea el body del SMS a un backend propio. **Es el único path legal, aprobado por Apple, para que una app de terceros acceda a contenido de SMS de remitentes no-contacto.**

#### Por qué funciona para Findash

- **Shortcodes Bancolombia (`891602` débito, `891333` crédito) NO son contactos** — califican para el filtro.
- **iOS 16+ agregó la sub-categoría `Transactions > Finance`**, documentada por Apple como _"for bank account activities and credit card alerts"_ — Apple bendijo literalmente este use case.
- Fuentes: WWDC17 session 249, WWDC22 session 110341, [IdentityLookup docs](https://developer.apple.com/documentation/identitylookup).

#### Flow técnico

1. SMS llega de sender no-contacto
2. iOS rutea el SMS a nuestra extension `FindashSMSFilter`
3. Extension en network-deferral mode → `POST https://<findash-domain>/api/ios/sms-filter` con `{ sender, body, appVersion }`
4. Backend procesa, retorna `{ action: "none" }` (pass-through — NO ocultar del Messages app del user)
5. SMS está en nuestra DB, parseado server-side con el pipeline existente

#### Gotchas (MUST cover en onboarding)

| Gotcha                                                                                     | Impacto                                                         | Mitigación                                                                                         |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Filter solo dispara para senders NO en contactos                                           | Si user guarda "Bancolombia" como contacto → filter se bypassea | Onboarding: _"no guardes el banco como contacto"_                                                  |
| Responder al hilo 3+ veces → iOS deja de rutear futuros SMS al filter                      | Silent breakage                                                 | Onboarding: _"no respondas los SMS del banco"_                                                     |
| Apple muestra prompt INEDITABLE mencionando "bank verification codes" al activar el filter | User puede asustarse                                            | Onboarding: explicar POR QUÉ antes de que toggle en Settings                                       |
| URL hard-coded en Info.plist (sin query tokens)                                            | No podemos pasar per-user auth vía URL                          | AASA + bundle ID verification + shared secret server-side, correlación por user vía device-pairing |
| HTTPS only, sin redirects                                                                  | Cert issues rompen silencioso                                   | Monitorear AASA + endpoint health                                                                  |

#### Backend requirements

- **AASA file** en `https://<findash-domain>/.well-known/apple-app-site-association` — HTTPS only, sin redirects, content-type `application/json`. Declara `messagefilter` associated domain + bundle ID.
- **Endpoint `POST /api/ios/sms-filter`** — acepta payload de la extension, rutea a Bancolombia parser, retorna pass-through classification.
- **Device pairing endpoint** — user se loguea en web, obtiene código 6-dígitos, lo ingresa en la app iOS, app asocia el device al user.

#### App Store review: riesgo MEDIUM

**Por qué medium**: no hay precedente LATAM conocido de fintech usando `ILMessageFilterExtension` para captura de transacciones. Spam blockers se aprueban de rutina; uso no-spam es novel.

**Mitigación para submission**:

- Pitch: _"categorizar transacciones bancarias en la carpeta Transactions/Finance"_ (verdadero — retornamos esa clasificación a iOS)
- NO como _"scrape SMS para un dashboard"_
- Incluir criterios (lista de shortcodes Bancolombia) en review notes, per Guideline 2.5.12
- Privacy policy sólida que disclose processing server-side

#### Lo que iOS SIGUE SIN PODER (confirmado, no hay workaround)

- **Leer notificaciones de otras apps** (Bancolombia app, Nu, etc.). `UNNotificationServiceExtension` solo modifica notifs de TU propia app. No hay API pública ni privada-que-pase-review.
- **Registrarse como "default SMS handler"** — este concepto no existe en iOS.
- **Cualquier hook en background sobre SMS** más allá de la filter extension.

#### Apple Developer Program — requerido

`com.apple.developer.messagefilter` entitlement requiere **paid account**. También App Groups (para widgets), APNs, TestFlight, App Store submission.

- **Costo**: $99 USD/año (~470K COP)
- **Account type**: arrancar **individual**. Migrar a Organization cuando SaaS formalizado (Apple tiene proceso de transfer documentado).
- **Cuándo enrolar**: SOLO cuando triggers de validación disparen. Pagar antes = premature optimization.

#### Fuentes (para referencia futura)

- [ILMessageFilterExtension — Apple Developer](https://developer.apple.com/documentation/identitylookup/ilmessagefilterextension)
- [WWDC17 Session 249: Filtering Unwanted Messages with Identity Lookup](https://developer.apple.com/videos/play/wwdc2017/249/)
- [WWDC22 Session 110341: Explore SMS message filters](https://developer.apple.com/videos/play/wwdc2022/110341/)
- [Creating a Message Filter App Extension](https://developer.apple.com/documentation/identitylookup/creating-a-message-filter-app-extension)
- [App Review Guidelines §2.5.12](https://developer.apple.com/app-store/review/guidelines/)
- [Apple Legal — SMS Filtering Privacy](https://www.apple.com/legal/privacy/data/en/sms-filtering/)
- [Bouncer (open-source reference)](https://github.com/afterxleep/Bouncer)

### Android native app (Phase 6 sketch)

Spec completa TBD cuando dispare el trigger. Key points:

**Permisos & APIs**:

- `NotificationListenerService` — puede leer notifs de otras apps (incluyendo app de Bancolombia, que suele tener MÁS info que el SMS).
- `BroadcastReceiver` con `SMS_RECEIVED` — fallback para bancos que solo notifican vía SMS. Nota: Android 4.4+ restringe `READ_SMS` a "default SMS handler" o con permisos especiales — necesita estrategia.
- Tasker/MacroDroid como fallback para users que no instalen la app (rol similar al Shortcut en iOS).

**Arquitectura paralela a iOS (monorepo `android/`)**:

- Main app (Kotlin + Jetpack Compose) — WebView wrapper del web dashboard
- `NotificationListenerService` — captura notifs bancarias
- `SMSReceiver` — captura SMS (donde aplique)
- Endpoints backend: `POST /api/android/notification` y `POST /api/android/sms`
- Mismo device-pairing UX que iOS (QR / 6-digit code)

**Distribución**: Google Play Store. Play Billing NO se usa (web-first signup).

**Costo**: Google Play Developer account $25 USD **one-time** (vs Apple $99/año).

**Play Store review risk: MÁS BAJO que iOS.** Android es más permisivo, pero `NotificationListenerService` requiere grant explícito del user en Settings, y Play Store flag-ea apps que lo usan — hay que justificar el use case.

### Shortcut (iOS) — current state, stays as fallback

El Shortcut iOS que postea a `/api/ingest/sms` se mantiene indefinidamente como fallback:

- Users que no quieren instalar la app nativa
- Users en iOS < 16 (sin sub-categoría Transactions/Finance)
- Path de diagnóstico/recovery si la app nativa tiene issues

Setup instructions live en `/settings/webhooks` de la web app.

#### Shortcut 1: Apple Pay Transaction Trigger (fallback)

1. Shortcuts → Automation → + → Transaction
2. Seleccionar tarjetas a trackear
3. "Run Immediately" activado
4. Acción: Get Contents of URL → `POST https://<findash-domain>/api/ingest/apple-pay` con `{ merchant, amount, card, date }` + `Authorization: Bearer <token>`

Nota: este trigger tiene issues conocidos (ver issues #11, #39). Bloqueado hasta que user tenga datáfono para testing.

#### Shortcut 2: SMS Bancolombia (fallback)

1. Shortcuts → Automation → + → Message
2. "Message Contains": `Bancolombia`
3. "Run Immediately" activado
4. Acción: Get Contents of URL → `POST https://<findash-domain>/api/ingest/sms` con `{ body, sender, receivedAt }` + Bearer token

---

## Currency Visual Toggle (Epic V)

Feature de display puro — NO cambia storage. Permite ver montos en la moneda preferida del user usando la TRM del día.

**Modos** (persistencia: user preference, cookie o row en DB):

- `native` (default) — cada txn/balance en su moneda original
- `all-cop` — todo convertido a COP usando TRM actual
- `all-usd` — todo convertido a USD usando TRM actual

**Alcance de aplicación**: dashboard cards, lista de transacciones, accounts page, budgets, insights — cualquier componente que muestre montos.

**UI**: dropdown en el header, siempre visible (set-and-visible, no set-and-forget). Al cambiar, la vista actualiza en vivo.

**Storage**: intacto. El ORM ya tiene `getCurrentFxRate()` en `src/lib/fx/repo.ts`. Los componentes de display consultan la preferencia + el rate y muestran lo convertido con un footnote ("≈$11.28 USD @ 3990 TRM").

**Edge case**: si TRM no disponible (fallback de FX), mostrar en modo native con tooltip explicativo. No romper la vista.

---

## Bank Statement Reconciliation (Epic R)

**El feature más diferenciador del producto.** Mayoría de apps de finanzas personales no lo hacen bien — por eso los saldos siempre divergen. Findash lo va a hacer bien.

### Problema que resuelve

SMS/Apple Pay/notifs son **lossy por diseño**: los bancos hacen cosas que no notifican (abonos de intereses, cuotas de manejo, anulaciones que desaparecen del historial, ajustes silenciosos). Resultado: el saldo en Findash diverge del real en semanas.

### Filosofía: extracto bancario = source of truth

En contabilidad seria, **el extracto del banco siempre gana**. Tu sistema interno se reconcilia contra él, nunca al revés. Esto es lo que hace YNAB, Copilot Money, y cualquier ERP serio. Es el patrón "bank reconciliation".

### Tres herramientas complementarias

| Herramienta                                       | Cuándo se usa                               | Frecuencia        |
| ------------------------------------------------- | ------------------------------------------- | ----------------- |
| Ingesta real-time (SMS, Apple Pay, Telegram, OCR) | Captura incremental, visibilidad inmediata  | Continuo          |
| **CSV/Excel Reconciliation**                      | Sync completo periódico, autoritativo       | Quincenal/mensual |
| **Balance Adjustment**                            | Ajuste rápido sin subir Excel, fix residuos | Ad-hoc            |

Son **complementarias**, no rivales.

### Schema additions

```
transactions:
  + reconciled_at TIMESTAMPTZ NULL
  + reconciliation_status VARCHAR           -- 'unreconciled' | 'matched' | 'flagged' | 'imported_from_statement'
  + statement_import_id INTEGER NULL FK     -- qué import lo confirmó
  + channel VARCHAR DEFAULT 'bank'          -- 'bank' | 'manual' | 'transfer' (excluye manual de matching)
  + is_adjustment BOOLEAN DEFAULT false     -- flag para excluir de analytics de spending

new table: statement_imports
  id, user_id, account_id, file_hash, period_start, period_end,
  imported_at, txn_count, balance_at_end_cents

new table: reconciliation_decisions
  txn_id, action ('archived' | 'kept' | 'merged_into:N'), decided_at, user_id

new seeded category: "Ajustes de saldo"
```

### Reconciliation algorithm (CSV/Excel)

```
On upload for account A, period [start, end]:
  1. Parse CSV → list of canonical txns (date, amount, merchant, sign)
  2. Load our existing txns for A in [start, end] where channel='bank'
  3. For each CSV row:
     - Match against ours by (amount exact, ±3 days, fuzzy merchant)
     - If match → mark as 'matched', link to statement
     - If no match → insert with source='csv_reconcile', status='imported_from_statement'
  4. For each of ours NOT matched:
     - Mark as 'flagged' (probable reverso, anulación, o duplicado)
  5. Show reconciliation summary: N new, M flagged, K confirmed
  6. User reviews flagged: archive | keep | merge (decision persisted)
  7. Final balance = balance_at_end from CSV (autoritativo)
```

**Regla crítica**: NO auto-delete flagged txns. Flag + user decision. CSV puede ser parcial, borrado silencioso mata trust.

### Balance Adjustment (pattern YNAB)

Para fixes rápidos sin Excel. User declara _"mi saldo real es $X"_, app crea una transacción especial:

```
diff = declared_balance - current_known_balance

INSERT transaction (
  amount_cents = diff,
  category = "Ajustes de saldo",
  source = 'balance_adjustment',
  is_adjustment = true,
  description = "Ajuste de saldo a $X COP (declarado 2026-04-19)",
  raw_data = { reason: <optional_note>, declared_balance, previous_balance }
)
```

**Treatment en reportes:**

- ✅ Incluye en: balance de cuenta, net worth, lista /transactions (con badge diferenciado)
- ❌ Excluye de: gasto del mes, donut de categorías, insights AI, heatmap

Se filtra con `WHERE is_adjustment = false` en queries de spending.

### Parsers Bancolombia (tres formatos)

Bancolombia descarga Excel diferente según producto:

- **Cuenta de ahorros** — format A
- **Tarjeta de crédito** — format B (incluye currency por row, si es internacional)
- **e-card (suscripciones)** — format C

Cada parser es un issue separado. Necesitamos samples reales (uno por producto) antes de implementar.

### Bot integration

El bot Telegram es el touchpoint natural para:

- _"📋 Han pasado 14 días desde tu última reconciliación de Bancolombia. ¿Subir Excel?"_
- _"📊 Reconciliación lista: 3 nuevas (intereses), 2 flagged. Review en /settings/accounts/<id>/reconcile"_

### Insight derivado: parser bug detection

Si user hace N ajustes en la misma dirección (ej: siempre +), señal de que el parser está perdiendo algo sistemáticamente. Insight automático: _"Has hecho 3 ajustes positivos a cuenta de ahorros este mes. ¿Bancolombia está abonando intereses no capturados?"_

Telemetría per-user útil: divergencia actual, frecuencia de ajustes, dirección.

---

## Telegram Bot Expansion (Epic T)

### Tesis

El bot es **la interfaz primaria** del producto pasivo — donde el user ya vive, donde las cosas llegan sin fricción. La web app queda para configuración pesada (reconciliación, settings). El día a día pasa por el bot.

Nadie está haciendo esto bien en español/LATAM. Cleo ($5/mes) y Copilot Money lo hacen en inglés. Oportunidad clara.

### Three stages

**Stage 1 — Queries + digest + charts (prioridad alta)**

| Feature                  | Detalle                                                                                                                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read queries             | `/saldo`, `/saldo <account>`, `/cupo`, `/ultimas`, `/budgets`, `/recurring`                                                                                                        |
| Notif compra clasificada | Al parsear SMS → push al bot con inline button "✏️ Re-categorizar"                                                                                                                 |
| Daily summary (8 PM)     | Resumen día: total, top categoría, comparativa con promedio                                                                                                                        |
| Chart commands           | `/donut` (categorías), `/tendencia` (6 meses), `/heatmap` (diario), `/networth` (12 meses). Generación via [QuickChart](https://quickchart.io) (PNG, no requiere headless browser) |
| Inbox / queue            | `/inbox` → lista de pendientes (flagged txns, txns sin categoría, recurrings nuevos detectados, reconciliación pendiente) con inline actions                                       |

**Stage 2 — Smart notifications + write actions (when validated)**

| Feature       | Detalle                                                                                                                             |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Smart notifs  | Anomaly ("compra inusual $800K"), budget al 80%, statement TC en 3 días, recurring no cobrado, SMS gap detection, pre-cuota warning |
| NLU queries   | _"cuánto gasté en restaurantes"_, _"gastos esta semana"_, _"top merchants este mes"_ — via Claude parse                             |
| Write actions | Transferencia interna, `/budget Mercado 500k`, `/cancel` (undo última txn), `/edit last`, `/snooze <recurring>`                     |
| Goal tracking | `/goal vacaciones 5M en 6 meses` + progreso semanal push                                                                            |
| Diagnostics   | `/health` (parser status, last sync), `/dump` (export completo — privacy feature)                                                   |

**Stage 3 — Conversational AI (DEFERRED, Premium tier gated)**

| Feature             | Detalle                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| Chat with your data | _"¿en qué gasto demasiado?"_, _"¿puedo permitirme vacaciones de 3M?"_, _"¿qué puedo cancelar?"_ |
| Tech                | Claude Sonnet + tool use (SQL read-only scoped por user_id)                                     |
| Gating              | Premium tier only ($25K/mes) — costo API por query no trivial                                   |

### Connection con otros epics

El bot es la **delivery layer** de todo lo demás:

- Anomaly detection (Epic I) → notif bot
- CDT/FIC suggestions (Epic I) → mensual via bot
- Subscription Hub (Epic I) → `/subs` command
- Balance Adjustment (Epic R) → `/ajuste` command
- Reconciliation pending (Epic R) → recordatorio via bot
- Flagged txns (Epic R) → aparecen en `/inbox`

---

## Insights & Behavioral Analysis (Epic I)

Features que convierten data cruda en valor real. Aquí vive la diferenciación "app que PIENSA por vos".

### Categorías

**A. Subscription Hub**

- Vista dedicada `/subscriptions`: lista, costo mensual, costo anual proyectado, próxima renovación, link al portal del servicio
- Auto-detección de suscripciones desde txns recurrentes en la e-card
- Alerta de price-hike (_"Netflix subió de 22K a 28K hace 3 meses"_)

**B. Anomaly detection**

- Por merchant: _"Esta compra de 240K en Carulla es 3x tu promedio ahí"_
- New merchant: _"Primera vez en este lugar, confirmá categoría"_
- Velocity: _"4 compras en 20 min con la misma TC — ¿fuiste vos?"_
- Categoría inusual: _"Este merchant usualmente cae en Mercado, hoy fue Hogar"_

**C. Optimización financiera (Colombia-específico)**

- Sugerencia CDT: _"Tenés 8M sin moverse; un CDT a 90 días te daría 240K"_
- Sugerencia FIC: comparación vs cuenta de ahorros (rendimiento)
- TC utilization: _"TC al 85%; pagando $X bajás intereses"_
- Pago doble detectado: _"Spotify aparece en TC1 y e-card, ¿cancelaste uno?"_

**D. Cash flow y salud financiera**

- Statement reminder TC (_"Bancolombia Visa cierra en 3 días, 78% utilization"_)
- Pre-cuota préstamo (_"Cuota en 2 días, saldo no cubre"_)
- Salary not received (recurring esperado no llegó)
- Flujo proyectado 30 días (basado en recurrentes + patrón)

**E. Forecasting + temporal**

- Heatmap diario (ya planeado en PLAN original)
- Días caros detectados (_"Viernes +40% vs promedio"_)
- Estacionalidad (_"Diciembre históricamente +60% gasto"_)

**F. Tax / declaración de renta (Colombia-específico)**

- Tracking de gastos deducibles (salud, educación) por categoría YTD
- Export para Información Exógena
- Alerta UVT thresholds
- Recomendación AFC (Ahorro Fomento Construcción)

### Delivery

Los insights se entregan por tres canales:

- **Dashboard**: cards de insights más relevantes del momento
- **Bot Telegram**: push proactivo cuando se dispara una condición
- **Monthly insights report**: agregado en el reporte Sonnet (Premium)

### Gating Premium

Algunos insights son heavy (cost AI) — gated en Premium tier ($25K):

- Monthly Sonnet report
- Conversational "¿por qué gasté tanto este mes?"
- CDT/FIC recomendaciones personalizadas

Los livianos (anomaly detection, statement reminders, budget alerts, heatmap) quedan en Basic tier.

---

## Bancolombia Parser SLOs (v1 gate)

No se agrega soporte de un segundo banco hasta que Bancolombia cumpla estas métricas durante **30 días corridos en el beta cerrado**:

| Métrica                                                  | Target v1 |
| -------------------------------------------------------- | --------- |
| SMS parse success rate (sin `needs_review`)              | ≥ 95%     |
| Clasificación automática (rules + Haiku, sin user input) | ≥ 90%     |
| Deduplicación correcta (Apple Pay + SMS misma compra)    | ≥ 98%     |
| Onboarding completion (signup → primera txn capturada)   | ≤ 5 min   |
| Data loss incidents por user/mes                         | 0         |
| Time-to-detect parser break (alerting interno)           | ≤ 24h     |

Cuando los 6 se cumplen 30 días seguidos → desbloqueamos segundo banco. Orden de prioridad tentativo: Nu Colombia, Davivienda, Banco de Bogotá.

---

## Per-user Telemetry

Dashboard interno (solo para el operador, no para users) con health signals per-user:

- **Last SMS received at** — si >7 días sin SMS entrantes → alerta: parser broken o user churning
- **Capture source breakdown** — Shortcut vs iOS native vs Android native vs Manual
- **Parser success rate** — últimos 30 días per user
- **Classification confidence distribution** — detectar regresiones del rule engine
- **Device heartbeat** — última vez que el cliente nativo pingueó home (solo cuando existan apps nativas)

**Rationale**: en un producto de "set and forget it", el user NO te avisa cuando algo se rompe — no lo nota. Vos tenés que detectarlo ANTES que él. Sin esta capa volás ciego y churneás en silencio.

**Implementación básica**: tabla `user_health_snapshots` actualizada por cron, vista admin privada en `/admin/health`, alertas por email/Slack cuando un user cruza umbrales.

---

## Closed Beta Gating

V1 NO tiene billing. Acceso controlado por **invite codes**.

**Invite codes**:

- Generables desde admin UI (solo el operador)
- Single-use, 30 días de vida
- Atados a `user_id` del que invitó (analytics de referidos orgánicos)

**Tamaño objetivo**:

- **Beta inicial**: 5-10 users (operador + amigos cercanos)
- **Beta extendido**: 30-50 users (amigos de amigos, orgánico)

**Criterio para cerrar beta y abrir SaaS**: ver "Validation Triggers" abajo.

**Schema seam**: columnas billing-ready (`subscription_status`, `plan_id`, `trial_ends_at`) presentes en `users` desde day 1 pero nullable. `canIngest(userId)` seam retorna `true` en v1 siempre.

---

## Validation Triggers

Phases futuras se activan por **EVIDENCIA, no por calendario**. No quemamos plata ni tiempo en infra antes de que el producto lo justifique.

### Trigger para iOS native app (Phase 5)

Activar cuando se cumplan TODAS:

- ≥ 5 amigos activos en beta por ≥ 30 días
- Retention semanal: abren dashboard ≥ 1 vez/semana
- ≥ 1 amigo pide explícitamente _"esto necesita app"_
- Parser Bancolombia cumpliendo SLOs por ≥ 14 días

Al disparar: pago Apple Developer ($99), arranco Epic B (iOS native).

### Trigger para SaaS productization (Phase 7)

Activar cuando se cumplan TODAS:

- iOS native app en TestFlight estable por ≥ 30 días
- ≥ 20 users activos en beta extendido
- Parser Bancolombia SLOs verdes ≥ 30 días corridos
- Churn en beta extendido < 20% mes a mes

Al disparar: arranco Epic A (MercadoPago, paywall, tiers, plan enforcement).

### Trigger para Android native app (Phase 6)

Activar cuando se cumplan TODAS:

- iOS native app en producción (App Store) con tracción
- ≥ 1 amigo Android pide la app explícitamente
- Capacidad de desarrollo (no estamos tapados en otras phases)

Al disparar: $25 Google Play Developer + arranco Epic D (Android native).

### Trigger para segundo banco (Phase 8)

Ver "Bancolombia Parser SLOs" arriba.

---

## Risks & Mitigaciones

| Riesgo                               | Mitigación                                                   |
| ------------------------------------ | ------------------------------------------------------------ |
| Apple cambia Transaction Trigger API | SMS Bancolombia como fallback; CSV upload siempre disponible |
| Bancolombia cambia formato SMS       | Parser aislado y testeable; raw data guardada en JSONB       |
| ARQ cierra o cambia                  | Solo 1 cuenta USD, impacto bajo; manual entry como fallback  |
| Doble ingesta (Apple Pay + SMS)      | Dedup por monto + fecha + ventana ±5 min                     |
| Claude API cost creep                | Rule engine 90%+; hard cap de presupuesto; Haiku es barato   |
| ia-server downtime                   | pg_dump backups; app stateless; webhooks con retry           |

---

## Verificación

1. **Phase 1**: Subir CSV Bancolombia → transacciones clasificadas → dashboard muestra totales y donut
2. **Phase 1**: Screenshot ARQ → OCR extrae transacciones → preview → confirmar → guardadas
3. **Phase 2**: Compra con Apple Pay → aparece en dashboard en <30 seg
4. **Phase 2**: Compra con tarjeta física Bancolombia → SMS → aparece en dashboard en <30 seg
5. **Phase 2**: Compra Apple Pay + SMS → solo UNA transacción (dedup funciona)
6. **Phase 3**: Configurar cuota del préstamo consolidado como recurring → día 1 de cada mes aparece automáticamente
7. **Phase 3**: Crear presupuesto → barra de progreso → alerta cuando excede
8. **Phase 4**: Insights page → reporte coherente con sugerencias accionables
9. **E2E**: Acceder desde celular via Tailscale → PWA instalable → dashboard responsive

---

## Related planning documents

- **[docs/multi-user-plan.md](./docs/multi-user-plan.md)** — migration plan from single-user to multi-tenant (NextAuth + Google OAuth + invite codes + `user_id` on every tenant table). Canonical design reference for issue #179 and everything it unblocks.
- **[docs/telegram-bot.md](./docs/telegram-bot.md)** — Telegram ingestion channel setup and usage.
- **[docs/events-bus-listen-notify.md](./docs/events-bus-listen-notify.md)** — migration plan from in-memory `EventEmitter` to Postgres `LISTEN/NOTIFY` for the SSE event bus. Decision record for issue #151; do not implement until multi-process is required.
