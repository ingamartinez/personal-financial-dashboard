# Personal Financial Dashboard — Plan

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

## Decisión de Approach

**Next.js 16 standalone + PostgreSQL nativo + Claude API**, self-hosted en ia-server. Sin Docker — ia-server ya corre PostgreSQL 17 nativo y la app es de un solo proceso, así que un container sería overhead puro.

- **¿Por qué no Firefly III / Actual Budget?** Customización heavy para Colombia (categorías locales, merchants colombianos, TRM, CDTs/FICs). Un tool genérico requiere más trabajo de adaptación que construir desde cero.
- **¿Por qué no Streamlit?** MVP rápido pero techo bajo en UX, no mobile-friendly, difícil de extender.
- **¿Por qué no backend separado?** Es herramienta personal, no SaaS multi-tenant. Next.js API routes manejan todo.

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

## iOS Shortcuts Setup (instrucciones para el usuario)

### Shortcut 1: Apple Pay Transaction Trigger

1. Abrir Shortcuts → Automation → + → Transaction
2. Seleccionar todas las tarjetas (o las que querés trackear)
3. "Run Immediately" activado
4. Acción: Get Contents of URL
   - URL: `https://ia-server.tailcabcc8.ts.net:3100/api/ingest/apple-pay`
   - Method: POST
   - Headers: `Authorization: Bearer <token>`
   - Body: JSON con `merchant`, `amount`, `card`, `date`

### Shortcut 2: SMS Bancolombia

1. Abrir Shortcuts → Automation → + → Message
2. "Message Contains": `Bancolombia`
3. "Run Immediately" activado
4. Acción: Get Contents of URL
   - URL: `https://ia-server.tailcabcc8.ts.net:3100/api/ingest/sms`
   - Method: POST
   - Body: JSON con `raw_text`, `timestamp`

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
