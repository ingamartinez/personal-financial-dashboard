# AI Strategy & Classification Pipeline

> Extracted from `PLAN.md` on 2026-09-11 (issue #922).
>
> Cited by `src/lib/db/schema.ts` (classification confidence columns) — see
> § AI Strategy for why AI complements the rule engine instead of replacing it.

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

