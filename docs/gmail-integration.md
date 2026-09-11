# Epic G — Gmail Email Integration

> Extracted from `PLAN.md` on 2026-09-11 (issue #922).
>
> Cited by `src/lib/gmail/registry.ts` — the gateway opacity table and the
> Canal 6b section below are what the sender patterns and gateway list encode.

## Gmail Email Integration (Epic G)

### Problema que resuelve

Dos problemas distintos sobre la misma infra:

1. **Gateway opacity**: transacciones tipo `MERCADOPAGO COLOMBIA $65.990` no tienen señal en la descripción para clasificar bien. Son pasarelas, no merchants. Si el user clasifica manualmente como "Comida" y el learning loop aprende esa regla, futuras compras MP (que pueden ser un vuelo de $2M) caen mal clasificadas. **No hay regla ni AI con ese único input que pueda hacerlo bien.**
2. **Confiabilidad de SMS Bancolombia**: SMS depende de captura del iPhone (sin señal = sin tx); no permite backfill (Apple no expone historial de SMS); muere con el iPhone. **Email Bancolombia tiene los mismos eventos** con cloud-native delivery + backfill posible.

### Arquitectura — 6 capas

1. **OAuth + tokens** — `gmail_connections` (multi-tenant, `user_id` scoped). Refresh tokens encriptados con `src/lib/crypto/symmetric.ts` (AES-256-GCM ya existente). Scope mínimo: `gmail.readonly`. Flow OAuth separado del NextAuth login (mejor para opt-in y revocación).
2. **Pull engine** — `node-cron` horario (alineado con jobs existentes en `src/instrumentation.node.ts`) + comando bot `/enriquecer` para trigger manual / debug. Filtra mails por sender registry; idempotente por `gmail_msg_id` (UNIQUE).
3. **Parsers por gateway** — uno por gateway, interfaz común `(html: string) → ParsedReceipt | null`. Registry pattern con `{senderPattern, parser, bankDescriptionPattern}`. Storage en `email_receipts` (raw HTML + parsed payload + `user_id`).
4. **Matcher tenant-safe** — JOIN scoping `(user_id, amount_cents, occurred_at±2d, gateway_keyword in description)`. **NUNCA** solo `(amount, date)`. Salida: confident match / ambiguous (2+ candidatos) / no match.
5. **Enrichment** — escribe `enriched_merchant` y `enrichment_source='gmail'` en la tx; descripción original preservada para audit/rollback. Trigger reclassify hook.
6. **Re-classify** — dispara el pipeline existente (`src/lib/classification/pipeline.ts`) sobre la tx enriquecida. Ahora rules + AI ven "Rappi", no "MERCADOPAGO COLOMBIA".

### Gateways MVP

| Gateway                  | Sender                         | Bank pattern           |
| ------------------------ | ------------------------------ | ---------------------- |
| Mercado Pago             | `*@mercadopago.com.co`         | `MERCADOPAGO COLOMBIA` |
| PayU                     | `*@payu.com`                   | `PAYU*`                |
| Wompi                    | `*@wompi.co`                   | `WOMPI*`               |
| Apple (App Store/iCloud) | `do_not_reply@email.apple.com` | `APPLE.COM/BILL`       |
| PayPal                   | `service@(intl.)?paypal.com`   | `PAYPAL*`              |
| ~~Google Play~~          | —                              | —                      |

**Observación Google Play**: verificado ausente en el inbox del user alpha; la tx `DLO*DiDi Food CO Pay` que parecía Google Pay es en realidad **dLocal** (procesador LATAM). Documentado como observación cerrada en el issue de parsers; se reabre si aparece en otro user beta.

**Out of MVP** (van a V1.5+): PSE (no es gateway único — cada merchant manda su propio mail), ePayco, Stripe internacional, dLocal, "Punto de Venta" (datáfono — no manda mail, problema diferente).

### Bancolombia email como ingestion source (Canal 6b)

- Sender: `alertasynotificaciones@an.notificacionesbancolombia.com` (y otros — investigar full lista durante implementación)
- Parser cubre los **10 event types** de `src/lib/ingestion/sms-bancolombia.ts` (purchase, transfer_sent, qr_payment, tc_payment, transfer_received, provider_payment, provider_payment_sent, atm_withdrawal, tc_credit_received, bre_b_transfer)
- **Backfill 2026** (2026-01-01 → hoy): one-shot via comando bot `/backfill-gmail`, idempotente
- **Dedup A+** (ver sección Deduplicación arriba): first-in wins, log diferencias, flag `source_mismatch` en divergencia significativa

### Disambiguation UX (matcher ambiguous)

Cuando el matcher encuentra 2+ candidatos para un mismo email receipt, **dos surfaces**:

1. **Web** — `/transactions` muestra el flag `needs_review` con opciones inline para elegir el match correcto o marcar "no match"
2. **Bot Telegram** — DM al user con: "Tenés tx de $65.990 el 22 mar. Posibles: (1) Rappi (2) Uber. ¿Cuál? `/omitir` para saltar". Reusa el patrón multi-step session/draft existente en `src/lib/telegram/router.ts`

Al confirmar match: enrichment + reclassify automático.

### OAuth strategy — Testing mode primero

- **Ahora (alpha, ≤10 users)**: testing mode. Refresh tokens expiran cada 7 días. Bot pinga al user para re-auth semanal. Aceptable porque solo el dev está testeando.
- **Cuando escale**: Google OAuth verification (~2 semanas). Privacy policy, demo video, justificación de scope, dominio verificado. Después: tokens persisten hasta que el user revoque.

### Multi-tenant safety (NO NEGOCIABLE — acceptance criterion bloqueante)

Razón: leak previo en #338 (per-table memory `per-user-table-join-tenant-safety.md`).

- TODOS los reads/writes de `gmail_connections` y `email_receipts` filtran por `user_id` del session
- Matcher JOIN scoping incluye `user_id` siempre
- Tests cubren caso "user A tiene tx del mismo monto/fecha que user B; ningún cross-match ocurre"

---

