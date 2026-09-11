# Data Ingestion — the six channels

> Extracted from `PLAN.md` on 2026-09-11 (issue #922).

## Data Ingestion — 6 canales (el corazón del sistema)

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

### Canal 6: Email (Gmail) 📧

**Cubre dos casos distintos sobre la misma infra (OAuth + pull engine + parsers framework):**

**6a. Enrichment de gateways opacos** — disambigua transacciones cuyo merchant en el extracto bancario es la pasarela y no el comercio real.

```
Banco dice: "MERCADOPAGO COLOMBIA $65.990"
    → Buscar mail de MP del mismo monto, ±2 días, scoped por user_id
    → Mail dice: "Pagaste a Rappi $65.990"
    → enriched_merchant = "Rappi" (descripción original preservada)
    → Re-clasificar tx con descripción enriquecida
```

Gateways MVP: Mercado Pago, PayU, Wompi, Apple (App Store/iCloud), PayPal. Google Play queda fuera (verificado que no aparece en el inbox de los users alpha; documentado como observación). dLocal (`DLO*` prefix) no se enriquece — el procesador no manda recibo, lo manda el merchant final.

**6b. Bancolombia como ingestion source paralelo a SMS** — el banco manda los mismos eventos por mail (`alertasynotificaciones@an.notificacionesbancolombia.com`). Email es más confiable que SMS (cloud nativo, no depende de señal celular) y permite **backfill histórico** que SMS no soporta.

```
Email Bancolombia llega
    → Parser cubre los 10 event types del SMS parser (parity)
    → Dedup A+: first-in wins, log diferencias entre canales
    → Si difiere significativamente del SMS: flag source_mismatch
```

- **Esfuerzo**: setup OAuth una vez por user (testing mode hasta ~10 users; verification de Google cuando escalemos)
- **Token expiry**: en testing mode los refresh tokens expiran cada 7 días → bot pinga al user para re-auth
- **Backfill inicial**: 2026-01-01 → hoy
- **Trigger**: cron horario + `/enriquecer` bot command
- **Ambiguous matches** (2+ candidatos): flag `needs_review` + bot pregunta interactivo con `/omitir`
- **Multi-tenant safety NO NEGOCIABLE**: TODOS los reads/writes de `gmail_connections` y `email_receipts` filtran por `user_id` del session. Matcher hace JOIN scoping `(user_id, amount_cents, occurred_at±2d)`, NUNCA solo `(amount, date)`. Razón: leak previo en #338.

### Cobertura por escenario

| Escenario                               | Canal                                  | Esfuerzo      |
| --------------------------------------- | -------------------------------------- | ------------- |
| Compra Apple Pay (cualquier tarjeta)    | 🍎 Transaction Trigger                 | Zero          |
| Compra tarjeta física Bancolombia       | 📱 SMS Shortcut + 📧 Email Bancolombia | Zero          |
| Suscripciones (e-card)                  | 📱 SMS Shortcut + 📧 Email Bancolombia | Zero          |
| Disambigua merchant tras pasarela opaca | 📧 Gmail enrichment                    | Zero          |
| Backfill histórico Bancolombia (2026)   | 📧 Email backfill                      | Setup único   |
| Cuota préstamo consolidado              | 🔁 Recurring                           | Zero          |
| Cualquier movimiento ARQ                | 📸 Screenshot OCR                      | ~1 min/semana |
| Efectivo                                | ✍️ Manual                              | ~30 seg/gasto |

**Cobertura automática estimada: ~95% (con email enrichment, suma específicamente claridad de merchant en transacciones de pasarela)**

### Deduplicación

Cuando llegan múltiples señales para el mismo evento, el pipeline aplica dedup por monto + fecha + ventana ±5 min:

- **Apple Pay + SMS Bancolombia** (compra Apple Pay con tarjeta Bancolombia): prioridad Apple Pay (datos más estructurados) > SMS.
- **SMS Bancolombia + Email Bancolombia** (Canal 2 + Canal 6b): estrategia **A+** — first-in wins (whichever source arrives first creates the tx). La segunda fuente intenta match por `(user_id, amount_cents, last4, occurred_at ±5min)`; si matchea → dedup silencioso. Diferencias menores se loguean. Diferencias significativas (monto distinto, merchant distinto) levantan flag `source_mismatch` en la tx + alerta en bot. Razón de A+ sobre overwrite: si SMS llegó primero y el user ya tocó la tx (categoría, nota, attachment), un overwrite ciego destruye trabajo del usuario.
- **Email enrichment de gateway** (Canal 6a): nunca crea tx nueva — solo enriquece tx existente del banco. Si no hay match con tx del banco, el receipt queda en `email_receipts` sin enrichment (idempotente por `gmail_msg_id`).

---

