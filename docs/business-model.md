# Business Model & Closed Beta

> Extracted from `PLAN.md` on 2026-09-11 (issue #922). `PLAN.md` no longer exists.
>
> **Read this before touching `canIngest`, `canAccessFeature`, or the nullable
> billing columns in `schema.ts`.** They are deliberate no-op seams, not dead code
> someone forgot to delete — this document is the rationale they cite.
>
> **Status 2026-09-11:** the profitable-product goal was dropped. The seams below
> are documented history, not an active roadmap. See issue #922 task 12 for the
> audit. What is left of them, what it costs, and why it is not being dropped:
> [`phase-7-seam-audit.md`](./phase-7-seam-audit.md).

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


---

## Validation Triggers

Phases futuras se activan por **EVIDENCIA, no por calendario**. No quemamos plata ni tiempo en infra antes de que el producto lo justifique.

### Trigger para iOS native app (Phase 5)

Activar cuando se cumplan TODAS:

- ≥ 5 amigos activos en beta por ≥ 30 días
- Retention semanal: abren dashboard ≥ 1 vez/semana
- ≥ 1 amigo pide explícitamente _"esto necesita app"_
- Parser Bancolombia cumpliendo SLOs por ≥ 14 días
- **Validado el valor incremental del SMS extension nativo sobre Canal 6b (Email Bancolombia)** — métricas a comparar: latencia p50/p95, % eventos capturados, falsos negativos. Si email cubre ≥99% con latencia <5min, el alcance de Phase 5 se reorienta (shell+WebView+widgets, sin SMS extension).

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

