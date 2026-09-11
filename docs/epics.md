# Epic design notes

> Extracted from `PLAN.md` on 2026-09-11 (issue #922).
>
> Status for each epic lives on the GitHub Project board. This file keeps the
> design rationale the board cannot hold. Epic G has its own file:
> [`gmail-integration.md`](./gmail-integration.md).

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

