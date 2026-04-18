# Telegram bot

Cada usuario de Findash registra su propio bot de Telegram. La arquitectura
es **webhook por usuario** (no hay long-poll, no hay bot compartido): cada
bot apunta a `/api/telegram/webhook/<botId>`, el handler resuelve el
`userId` desde la tabla `telegram_bots` y despacha al router con las deps
de ese user.

Issue de referencia: [#185](../../../issues/185).

## Setup (una vez por usuario)

### 1. Pre-requisitos en prod

Estas tareas son responsabilidad del operador del droplet — si estás
registrando un bot en findash.alejoframes.com ya están hechas:

- `TELEGRAM_TOKEN_ENCRYPTION_KEY` en `/srv/findash/env/findash.env`
  (32 bytes base64, generada con `openssl rand -base64 32`). Rotar la key
  invalida todos los tokens guardados — los usuarios tienen que volver a
  registrar su bot.
- `AUTH_URL=https://findash.<dominio>` en el mismo env. Sirve como base
  para el `webhook_url` que Findash le pasa a Telegram.

### 2. Crear el bot con BotFather

1. Abrí Telegram, mandale `/newbot` a
   [@BotFather](https://t.me/BotFather).
2. Elegí un display name (ej: `Findash de Alejo`) y un username que
   termine en `bot` (ej: `@alejo_findash_bot`).
3. BotFather devuelve un token `1234567890:AAH...`. Copialo.

### 3. Registrarlo en Findash

1. Entrá a `/settings/telegram`.
2. Pegá el token en el input "BotFather token" (se manda como password
   — nunca queda visible).
3. Click "Register bot".

Qué hace el server action por detrás (`registerBotAction`):

1. Valida el formato del token (`/^\d{8,12}:[A-Za-z0-9_-]{30,}$/`).
2. Si ya tenés un bot registrado → error ("delete it first").
3. Resuelve `AUTH_URL` como base del webhook. Sin `AUTH_URL` → error.
4. Llama `getMe` contra el token para validar que Telegram lo acepta y
   levantar el `@username`.
5. Inserta la fila en `telegram_bots` con el token encriptado
   (AES-256-GCM) y un `webhook_secret` de 32 bytes hex.
6. Llama `setWebhook(https://<AUTH_URL>/api/telegram/webhook/<botId>,
   secret_token=<webhook_secret>, allowed_updates=[message,callback_query])`.
7. Si `setWebhook` falla → borra la fila (rollback) y te muestra el
   error.

### 4. Probarlo

Abrí Telegram, buscá tu bot (`@<username>`), mandale `/start`. Debería
responder con la bienvenida. Si no responde, ver [Troubleshooting](#troubleshooting).

## Uso

Todos los flujos del bot (texto libre, SMS reenviado, foto con OCR, voz
con Whisper) siguen igual que antes — cambió sólo la capa de transporte.

Ejemplos:

| Mensaje | Interpretación |
| --- | --- |
| `pagué 45k en el restaurante` | Gasto 45.000 COP, categoría restaurantes |
| `70 mil uber` | Gasto 70.000 COP, categoría transporte |
| `mercado 123.450 con la visa *2575` | Gasto 123.450 COP, cuenta Visa *2575 |
| `ayer gasté 30k en gasolina` | Gasto 30.000 COP, fecha ayer |
| `ingresé 2 millones del sueldo` | Ingreso 2.000.000 COP |

El bot responde con inline keyboard: ✅ Confirmar · ❌ Cancelar · ✏️
Cuenta · ✏️ Categoría. Si falta monto o cuenta, el bot pregunta antes de
mostrar el card de confirmación. Las sesiones expiran a los 30 minutos.

## Revocar un bot

`/settings/telegram` → "Delete bot". El server action:

1. Descifra el token guardado.
2. Llama `deleteWebhook` contra la API de Telegram. Si Telegram falla
   (5xx, red caída), logueamos y seguimos con el delete local.
3. Borra la fila de `telegram_bots` y los `telegram_sessions` de ese
   user (los sessions referencian estado producido por este bot).

Tras revocar podés registrar otro bot — el flujo vuelve a la tarjeta de
registro.

## Operación

### Apagar TODOS los workers en background

```
FINDASH_DISABLE_CRON=1
```

Esto solo apaga el cron de recurring-gap. Los webhooks siguen respondiendo
(son request-scoped, no workers).

### Rotar la encryption key

Rotación destructiva — todos los usuarios quedan sin bot funcional hasta
que re-registren.

```
# en el droplet, como root
sudo nano /srv/findash/env/findash.env
# reemplazá TELEGRAM_TOKEN_ENCRYPTION_KEY con una key nueva
sudo systemctl restart findash
```

Después, cada usuario tiene que ir a `/settings/telegram`, borrar su
bot (el DELETE logra decryptar el token viejo con la nueva key? NO — va
a tirar `InvalidTokenError`. El server action maneja eso: loguea,
no llama `deleteWebhook`, borra la fila igual), y registrarlo de nuevo.

## Troubleshooting

### "AUTH_URL must be set"

El server action no encontró `AUTH_URL` en el env. En prod tiene que
estar en `/srv/findash/env/findash.env`. En dev no podés registrar bots
desde localhost (Telegram necesita HTTPS público) — usá un tunnel tipo
cloudflared si querés probar local:
`cloudflared tunnel --url http://localhost:3100` y pegás esa URL en
`.env.local:AUTH_URL`.

### "Telegram rejected the token"

El `getMe` contra `api.telegram.org/bot<TOKEN>/getMe` devolvió un 401 u
otro error. Típicamente el token está mal copiado (espacios, newlines,
caracteres invisibles). Volvé a copiar desde BotFather.

### "setWebhook failed"

Causas comunes:

- `AUTH_URL` apunta a un host que Telegram no puede resolver
  (localhost, IP privada, puerto non-443).
- El cert TLS no es válido para Telegram — revisá el setup de Cloudflare
  Full (strict) o el origin cert en Caddy.
- Rate limit transitorio — re-intentá en unos minutos.

La fila queda auto-roll-backeada: no hace falta limpiar manualmente.

### El bot no responde a `/start`

1. Verificá que el webhook está configurado:
   `curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"`. El `url`
   debería matchear `https://<tu-dominio>/api/telegram/webhook/<botId>`.
2. Si `last_error_message` está poblado, ese es el error que Telegram ve
   cuando intenta POSTear al webhook. Típicamente 401
   (`webhook_secret` drift), 404 (botId borrado), o timeout.
3. Mirá los logs del droplet:
   `sudo journalctl -u findash -n 200 --no-pager | grep telegram`.

### Mensajes duplicados

Los `externalId` en `transactions` para transacciones vía Telegram son
`tg:<chatId>:<messageId>`. El UNIQUE `(accountId, externalId)` garantiza
idempotencia — si Telegram retrasmite el mismo update (por ejemplo
después de un 5xx), la segunda inserción se descarta como `duplicated`.
