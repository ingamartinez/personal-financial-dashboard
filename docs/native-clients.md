# Native Clients Strategy (deferred)

> Extracted from `PLAN.md` on 2026-09-11 (issue #922).
>
> Trigger criteria for Phases 5 and 6 live in
> [`business-model.md`](./business-model.md) § Validation Triggers.

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

