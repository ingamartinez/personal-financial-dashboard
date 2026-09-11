# Phased Roadmap

> Extracted from `PLAN.md` on 2026-09-11 (issue #922).
>
> **The GitHub Project board ("Findash Roadmap") is the live status.** This file
> keeps only what a board column cannot express: what each phase *means*, and the
> validation evidence that gates the deferred ones. Trigger criteria live in
> [`business-model.md`](./business-model.md) § Validation Triggers.

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

**Pendiente (orden por dependencias):**

1. **`/settings/accounts` page con UI de creación/edición de cuentas** (#245) — CRÍTICO. Sin esto, ningún amigo puede dar de alta su primera cuenta. El bot Telegram ya apunta a esta ruta (en su zero-accounts guard) pero la ruta no existe; `/accounts` existe pero solo lista, sin crear (su empty state dice "use the seed script or DB"). Onboarding blocker absoluto — es el primero en la cola.
2. **Ingestion Inbox — recuperación de errores de ingesta huérfanos** (#261) — CRÍTICO. Hoy, si un SMS/Apple-Pay llega antes de que exista cuenta que matchee, el endpoint falla con `status="error"` y la txn nunca se crea. El raw queda en `ingestion_logs` sin UI ni path de recuperación → **data loss silenciosa**, rompe el SLO _"Data loss incidents por user/mes: 0"_. Requiere #245 para la UX end-to-end (dropdown de cuentas para retry). Va segundo.
3. **Per-user telemetry foundation** (#248) — tabla `user_health_snapshots`, cron de actualización, vista admin privada `/admin/health` con last_sms_received_at, capture source breakdown, parser success rate, churn signals, **unresolved ingest errors** (surface del inbox #261).
4. **Bancolombia parser SLO instrumentation** (#249) — logging estructurado por intento de parseo + dashboard mostrando las 6 SLOs definidas + alerting cuando degrada. Tiene sentido DESPUÉS del inbox: telemetría sin recovery path es prender una luz roja y quedarse mirándola.
5. **Billing-ready columns en `users`** (#246) — `subscription_status`, `plan_id`, `trial_ends_at`, `mercadopago_customer_id` nullable. Seam para Phase 7 sin enforcement en v1. Independiente del resto — cualquier orden.
6. **`canIngest(userId)` seam** en `/api/ingest/*` (#247) — wrapper que retorna `true` en v1, hook para futuro paywall sin tocar endpoints. Independiente.
7. **iOS Shortcut onboarding polish** (#250) — más allá de la card actual: video/GIF demostrativo, troubleshooting section, advertencias sobre gotchas (no guardar como contacto, no responder 3+ veces — aplica también a la futura app nativa). Independiente.

### Phase 4.6: Web Product Depth (active, sequential to 4.5)

**Objetivo**: hacer la app web tan buena que valga la pena cobrar por ella. Esto es lo que desbloquea Phase 7 (SaaS productization).

Cinco epics grandes aquí:

- **Epic V — Currency Visual Toggle**: dropdown COP/USD/native aplicado globalmente
- **Epic R — Bank Statement Reconciliation**: balance adjustment (quick win) + CSV Excel parsers (savings/TC/e-card) + engine + UI reconcile + flagged review + divergence tracking
- **Epic T — Telegram Bot Expansion**: Stage 1 (queries + summaries + charts + inbox), Stage 2 (smart notifs + NLU + write actions + goals), Stage 3 deferred (conversational AI Premium)
- **Epic I — Insights & Behavioral**: Subscription Hub, anomaly detection, CDT/FIC optimization, TC utilization, forecasting, tax tracking
- **Epic G — Gmail Email Integration**: OAuth multi-tenant (testing mode → verification al escalar) + pull engine + parsers gateway (MP/PayU/Wompi/Apple/PayPal) + matcher tenant-safe + Bancolombia parser parity con SMS + backfill 2026 + dedup A+ + needs_review UX + bot interactivo. Atacka el problema de "MERCADOPAGO COLOMBIA" cayendo siempre en `Otros` (gateway opacity) Y agrega email Bancolombia como fuente de ingesta más confiable que SMS.

Ver secciones arriba por detalle de cada epic. Sub-issues se crean just-in-time cuando arranca cada sub-task.

**Costo incremental**: tiempo de dev. Potencialmente ~$2-5 más/mes en Claude API si conversational AI se enciende. Gmail API es free tier (1B quota units/día, no llegamos cerca).

### Phase 5: iOS native app (TRIGGER-GATED — see Validation Triggers)

Arranca **solo si dispara el trigger de iOS native**. Documentación completa en "Native Clients Strategy" arriba.

> **Reevaluación por Epic G (Gmail Integration)**: el ingestion source de email Bancolombia (Canal 6b) cubre el mismo dominio que el SMS extension nativo, con mayor confiabilidad (cloud nativo, no depende de capturar SMS) y permite backfill que SMS no soporta. **Antes de invertir en `ILMessageFilterExtension` validar el valor incremental** — si email captura el 100% de los eventos Bancolombia con baja latencia (<5min), el SMS extension nativo pierde gran parte de su justificación. Esto NO cancela Phase 5 (la app nativa sigue siendo deseable por widgets, push, AASA, distribución), pero **reorienta el alcance**: app nativa puede ser shell + WebView + pairing, sin extension de SMS, dependiendo de los datos del beta.

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

