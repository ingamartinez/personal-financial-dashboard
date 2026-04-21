# Findash Widget API — v1 reference

Contrato HTTP que alimenta los clientes Scriptable (iOS) y Tasker (Android).
Todos los endpoints viven bajo el mismo route handler genérico con dispatch
por `widget_id`.

## Base

```
GET /api/widget/v1/<widget_id>
```

- **Método**: `GET` únicamente.
- **Auth**: `Authorization: Bearer <widget_token>`. El token se mintea desde
  `/settings/widgets` y tiene `purpose = 'widget'`. Tokens con otro purpose
  (ej. Telegram webhook) reciben `401`.
- **Content-Type** de la respuesta: `application/json; charset=utf-8`.
- **Rate limit**: por `tokenId` (no por usuario). 60 rpm en quemadura corta,
  20 rpm sostenido — ver
  [`src/app/api/widget/v1/[id]/rate-limit.ts`](../../src/app/api/widget/v1/[id]/rate-limit.ts)
  para números actuales.
- **Timezone**: toda fecha/hora en responses está anclada a `America/Bogota`
  (UTC-5, sin DST). `generated_at` se emite en ISO-8601 con sufijo `-05:00`.
- **Moneda**: COP-pesos enteros (sin decimales). USD se convierte a COP al
  TRM actual antes de serializar.

## Query params comunes

| Param | Tipo | Obligatorio | Notas |
|-------|------|-------------|-------|
| `size` | `"S" \| "M" \| "L"` | sí | Cada widget soporta un subset — ver tabla |

## Errores

Todos los endpoints comparten esta forma:

```json
{ "error": { "code": "unauthorized", "message": "Invalid or missing widget token" } }
```

| Código | HTTP | Significado |
|--------|------|-------------|
| `unauthorized` | 401 | Token faltante, mal-formado, revocado o con otro purpose |
| `forbidden` | 403 | Reservado — no se emite hoy |
| `widget_not_found` | 404 | `widget_id` no está registrado |
| `invalid_params` | 422 | `size` no aceptado por ese widget, o un extra requerido falta |
| `rate_limited` | 429 | Throttle — incluye `Retry-After` header |
| `internal_error` | 500 | Handler lanzó excepción — ver logs del server |

Los clientes (Scriptable / Tasker) mapean estos códigos a mensajes para el
usuario — ver `findash-widget.js` → `FindashError`.

## Tabla de widgets

| `widget_id` | Tamaños | Params extra | Fuente |
|-------------|---------|--------------|--------|
| `tc-focus` | S | `target=<id>` | [`handlers/tc-focus.ts`](../../src/lib/widgets/handlers/tc-focus.ts) |
| `mis-tcs` | M, L | — | [`handlers/mis-tcs.ts`](../../src/lib/widgets/handlers/mis-tcs.ts) |
| `hoy` | S | — | [`handlers/hoy.ts`](../../src/lib/widgets/handlers/hoy.ts) |
| `mes-actual` | M | — | [`handlers/mes-actual.ts`](../../src/lib/widgets/handlers/mes-actual.ts) |
| `recent-tx` | M, L | — | [`handlers/recent-tx.ts`](../../src/lib/widgets/handlers/recent-tx.ts) |

---

## `tc-focus`

Snapshot de cupo + utilización para UNA tarjeta de crédito específica.
Soporta las dos formas de TC del modelo:

- **Single-currency** (una moneda, una `accounts` row): `target` es un
  entero (`accounts.id`). Cupo vive en `metadata.creditLimitCents`, balance
  es la suma derivada de transacciones.
- **Multi-currency** (TC física con sub-accounts COP + USD): `target` es un
  UUID (`physical_cards.id`). Cupo + cutoff viven en la row física; los
  balances per-moneda viven en los sub-accounts y se convierten al TRM
  actual.

### Request

```
GET /api/widget/v1/tc-focus?size=S&target=<id>
```

### Response (200)

```json
{
  "widget_id": "tc-focus",
  "size": "S",
  "data": {
    "card_name": "Bancolombia *1234",
    "network": "VISA",
    "last4": "1234",
    "credit_limit_cop": 5000000,
    "used_cop": 1235000,
    "available_cop": 3765000,
    "utilization_pct": 25,
    "next_statement_cutoff": "2026-05-15",
    "days_to_cutoff": 24
  },
  "generated_at": "2026-04-21T14:32:10-05:00"
}
```

| Campo | Tipo | Nota |
|-------|------|------|
| `card_name` | `string` | Label final (via `formatAccountLabel` o fallback institución + *last4) |
| `network` | `string \| null` | "VISA", "MASTERCARD", "AMEX", "DINERS" o null |
| `last4` | `string \| null` | Últimos 4 dígitos si los hay |
| `credit_limit_cop` | `number` | Pesos enteros |
| `used_cop` | `number` | Pesos enteros (valor absoluto; clampado ≥ 0) |
| `available_cop` | `number` | Pesos enteros (clampado ≥ 0) |
| `utilization_pct` | `number` | Entero 0..100 |
| `next_statement_cutoff` | `string \| null` | `YYYY-MM-DD`, fecha Bogota del próximo corte |
| `days_to_cutoff` | `number \| null` | Días desde hoy hasta `next_statement_cutoff` |
| `generated_at` | `string` | ISO-8601 con offset `-05:00` |

### Errores específicos

- `422 invalid_params` — `size` distinto de `S`, o `target` faltante.
- `404 target_not_found` — `target` no existe para este usuario (NUNCA revela
  si existe bajo otro usuario — fail cerrada).

---

## `mis-tcs`

Roster completo de TCs del usuario. Combina multi-currency y single-currency
en una sola lista ordenada por `utilization_pct DESC`.

### Request

```
GET /api/widget/v1/mis-tcs?size=M
GET /api/widget/v1/mis-tcs?size=L
```

- `size=M` → top 3 por utilización.
- `size=L` → todas las tarjetas.
- `size=S` → `422 invalid_params`.

### Response (200)

```json
{
  "widget_id": "mis-tcs",
  "size": "L",
  "data": {
    "cards": [
      {
        "id": "3a4b5c6d-1234-5678-9abc-def012345678",
        "name": "Bancolombia Mastercard",
        "network": "MASTERCARD",
        "last4": "4321",
        "available_cop": 2500000,
        "credit_limit_cop": 5000000,
        "utilization_pct": 50
      },
      {
        "id": 42,
        "name": "Colpatria VISA *1234",
        "network": "VISA",
        "last4": "1234",
        "available_cop": 3765000,
        "credit_limit_cop": 5000000,
        "utilization_pct": 25
      }
    ],
    "total_available_cop": 6265000,
    "total_credit_cop": 10000000
  },
  "generated_at": "2026-04-21T14:32:10-05:00"
}
```

| Campo | Tipo | Nota |
|-------|------|------|
| `cards[].id` | `string \| number` | UUID (multi-currency) o entero (single) |
| `cards[].name` | `string` | Label final |
| `cards[].network` | `string \| null` | |
| `cards[].last4` | `string \| null` | |
| `cards[].available_cop` | `number` | Pesos enteros |
| `cards[].credit_limit_cop` | `number` | Pesos enteros |
| `cards[].utilization_pct` | `number` | Entero 0..100 |
| `total_available_cop` | `number` | Suma sobre **todas** las tarjetas, no solo las trimeadas |
| `total_credit_cop` | `number` | Idem |

### Notas

- Roster vacío (usuario sin TCs) devuelve `200` con `cards: []` y totales en
  `0`. No es un error.
- Los totales se calculan sobre el roster COMPLETO, no sobre `cards[]`
  trimeados — útil para `size=M` que muestra 3 pero anuncia el total real.

---

## `hoy`

Gasto del día en Bogota TZ, con comparación contra el promedio diario del mes.

### Request

```
GET /api/widget/v1/hoy?size=S
```

Sizes distintos de `S` → `422 invalid_params`.

### Response (200)

```json
{
  "widget_id": "hoy",
  "size": "S",
  "data": {
    "spent_cop": 85000,
    "tx_count": 4,
    "vs_daily_avg_pct": -12,
    "day_label": "Martes 21 abr"
  },
  "generated_at": "2026-04-21T14:32:10-05:00"
}
```

| Campo | Tipo | Nota |
|-------|------|------|
| `spent_cop` | `number` | Pesos enteros, **outflows** del día (amounts negativos, vueltos positivos) |
| `tx_count` | `number` | Nº de transacciones que contaron para `spent_cop` |
| `vs_daily_avg_pct` | `number \| null` | `round((spent_today / avg_daily_MTD - 1) * 100)`. `null` si es día 1 |
| `day_label` | `string` | Label es-CO: `Martes 21 abr` |

### Exclusiones

No cuentan como gasto:

- Transacciones archivadas (`deleted_at IS NOT NULL`).
- Balance adjustments (`source = 'balance_adjustment'` OR `is_adjustment`).
- Transferencias (`channel = 'transfer'`) — incluidos pagos a TC.
- Inflows (`amount_cents > 0`).

### Semántica de `vs_daily_avg_pct`

- `avg_daily_MTD = |sum(qualifying txs from day 1 through yesterday)| /
  (today.day - 1)`.
- Si `today.day === 1` → `null` (no hay días previos).
- Si `avg_daily_MTD === 0` y `spent_cop === 0` → `0`.
- Si `avg_daily_MTD === 0` y `spent_cop > 0` → `null` (no se divide por 0).
- Valor negativo = gastaste MENOS que el promedio MTD.
- Valor positivo = gastaste MÁS.

---

## `mes-actual`

Gasto MTD + proyección fin de mes + delta vs mes pasado.

### Request

```
GET /api/widget/v1/mes-actual?size=M
```

Sizes distintos de `M` → `422 invalid_params`.

### Response (200)

```json
{
  "widget_id": "mes-actual",
  "size": "M",
  "data": {
    "month_label": "Abril 2026",
    "spent_cop": 1250000,
    "day_of_month": 21,
    "last_month_same_day_cop": 1400000,
    "delta_pct": -11,
    "delta_direction": "down",
    "projection_month_end_cop": 1785714
  },
  "generated_at": "2026-04-21T14:32:10-05:00"
}
```

| Campo | Tipo | Nota |
|-------|------|------|
| `month_label` | `string` | es-CO: `Abril 2026` |
| `spent_cop` | `number` | MTD outflows en Bogota TZ |
| `day_of_month` | `number` | Día actual en Bogota (1..31) |
| `last_month_same_day_cop` | `number` | Mismo rango del mes pasado, capado al último día |
| `delta_pct` | `number \| null` | `round((spent / last_month_same_day - 1) * 100)`, `null` si el comparador es 0 |
| `delta_direction` | `"up" \| "down" \| "flat" \| null` | Sincronizado con `delta_pct` |
| `projection_month_end_cop` | `number` | Extrapolación lineal `round(spent/day * daysInMonth)` |

### Exclusiones

Mismo set que `hoy`.

### Edge cases

- Día 31 en mes de 31 → `last_month_same_day_cop` se capa al último día del
  mes pasado (ej. Feb 28).
- `spent_cop === 0` y `day === 1` → `projection_month_end_cop === 0`.
- `last_month_same_day_cop === 0` → `delta_pct` y `delta_direction` ambos
  `null`.

---

## `recent-tx`

Feed de las últimas 3 o 5 transacciones del usuario.

### Request

```
GET /api/widget/v1/recent-tx?size=M   # 3 txs
GET /api/widget/v1/recent-tx?size=L   # 5 txs
```

`size=S` → `422 invalid_params`.

### Response (200)

```json
{
  "widget_id": "recent-tx",
  "size": "L",
  "data": {
    "transactions": [
      {
        "id": "12345",
        "occurred_at": "2026-04-21T13:45:00-05:00",
        "merchant": "Éxito Superstore",
        "amount_cop": -42500,
        "category_name": "Mercado",
        "category_emoji": "shopping-cart",
        "account_label": "Bancolombia Ahorros *1234"
      }
    ]
  },
  "generated_at": "2026-04-21T14:32:10-05:00"
}
```

| Campo | Tipo | Nota |
|-------|------|------|
| `transactions[].id` | `string` | ID de la tx como string |
| `transactions[].occurred_at` | `string` | ISO-8601 con offset Bogota `-05:00` |
| `transactions[].merchant` | `string \| null` | Nombre del comercio |
| `transactions[].amount_cop` | `number` | Firma preservada: negativo = outflow, positivo = inflow/refund |
| `transactions[].category_name` | `string \| null` | Nombre de la categoría (null si archivada) |
| `transactions[].category_emoji` | `string \| null` | Hoy: lucide icon name. Cuando category.emoji sea columna-primera-clase, será emoji |
| `transactions[].account_label` | `string` | Via `formatAccountLabel` |

### Exclusiones

A diferencia de `hoy` / `mes-actual`, este feed SÍ incluye:

- Transferencias (`channel = 'transfer'`) — pagar una TC es actividad real.
- Inflows — con `amount_cop` positivo.

Sigue excluyendo:

- Archivadas (`deleted_at`).
- Balance adjustments.

---

## Generación de este doc

Los shapes aquí están hand-rolled a partir de los tipos TS en
`src/lib/widgets/handlers/*.ts`. Si cambia un handler, actualizar este doc en
el mismo PR. No hay schema JSON auto-generado todavía — si se adopta Zod en
el hot path (issue candidate), se puede generar desde ahí.

## Ver también

- [Overview de widgets](./README.md)
- [Setup iOS](./setup-ios.md)
- [Setup Android](./setup-android.md)
- Código: [`src/lib/widgets/handlers/`](../../src/lib/widgets/handlers/)
- Router: [`src/app/api/widget/v1/[id]/route.ts`](../../src/app/api/widget/v1/%5Bid%5D/route.ts)
