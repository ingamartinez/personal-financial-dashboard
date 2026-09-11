# Telemetry & SLOs

> Extracted from `PLAN.md` on 2026-09-11 (issue #922).
>
> Cited by `src/lib/telemetry/slos.ts` — the SLO table below is the source those
> constants encode.

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

