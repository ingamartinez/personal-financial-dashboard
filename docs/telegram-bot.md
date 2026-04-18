# Telegram bot

Canal unificado para ingresar transacciones desde el celular. Fase 1 cubre
**sólo texto libre** (NLU con Claude Haiku). Foto/OCR y SMS forwardeado van
en #169 (Fase 2). Nota de voz va en #170 (Fase 3).

## Setup (una vez)

### 1. Crear el bot

1. Abrí Telegram y mandale `/newbot` a [@BotFather](https://t.me/BotFather).
2. Elegí un display name (ej: `Findash`) y un username terminado en `bot`
   (ej: `@fin_dash_bot`).
3. BotFather te devuelve un token tipo `1234567890:AAH...`.
4. Pegalo en `.env.local`:
   ```
   TELEGRAM_BOT_TOKEN=1234567890:AAH...
   ```

### 2. Conseguir tu user ID

1. Mandale `/start` a [@userinfobot](https://t.me/userinfobot).
2. Te devuelve tu `Id: 123456789`.
3. Pegalo en `.env.local`:
   ```
   TELEGRAM_ALLOWED_USER_IDS=123456789
   ```
   Podés poner más de un id separado por coma.

### 3. Arrancar el dashboard

El bot corre dentro del mismo proceso que Next.js (hook de instrumentación,
mismo patrón que el cron de recurring-gap). No hay servicio separado.

```bash
bun run dev
```

Al arrancar, en los logs vas a ver:

```
[findash] recurring-gap cron registered (...)
[telegram] long-poll worker started (offset=N)
```

Si ves `[findash] TELEGRAM_BOT_TOKEN not set — telegram worker skipped`, el
token no está cargado. Revisá que `.env.local` esté al lado de `package.json`.

### 4. Probarlo

Mandale `/start` al bot. Debería responder con la bienvenida. Si no, chequeá:

- `Id` del `/start` matchea `TELEGRAM_ALLOWED_USER_IDS`.
- El bot no está en modo privado ni en un grupo — usalo en DM con el bot.

## Uso

Mandale un mensaje describiendo una transacción. Ejemplos:

| Mensaje                                  | Interpretación                          |
| ---------------------------------------- | --------------------------------------- |
| `pagué 45k en el restaurante`            | Gasto 45.000 COP, categoría restaurantes |
| `70 mil uber`                            | Gasto 70.000 COP, categoría transporte  |
| `mercado 123.450 con la visa *2575`      | Gasto 123.450 COP, cuenta Visa *2575    |
| `ayer gasté 30k en gasolina`             | Gasto 30.000 COP, fecha ayer            |
| `ingresé 2 millones del sueldo`          | Ingreso 2.000.000 COP                   |

El bot te muestra un resumen con inline keyboard:

- ✅ **Confirmar** — inserta la transacción y dispara el evento `transaction:created`
- ❌ **Cancelar** — descarta el draft
- ✏️ **Cuenta** — elegir cuenta de una lista
- ✏️ **Categoría** — elegir categoría de una lista

Si falta el monto o la cuenta, el bot pregunta antes de mostrar el card de
confirmación. La sesión expira a los 30 minutos de inactividad.

## Operación

### Apagar el bot sin tocar el token

```
FINDASH_DISABLE_TELEGRAM=1
```

### Apagar TODOS los workers en background

```
FINDASH_DISABLE_CRON=1
```

### Reiniciar el offset de long-poll

Si el bot dejó mensajes sin procesar (por ejemplo, error persistente), el
offset queda apuntando al último update procesado. Para descartar pendientes:

```sql
UPDATE telegram_poll_state SET last_update_id = (
  SELECT COALESCE(MAX((data->>'update_id')::bigint), 0)
  FROM <...>
) WHERE id = 1;
```

O más simple — reiniciar en 0:

```sql
UPDATE telegram_poll_state SET last_update_id = 0 WHERE id = 1;
```

### Logs

Todo va a stdout del proceso de Next.js:

- `[telegram] long-poll worker started (offset=N)`
- `[telegram] handler error: <stack>` — error procesando un update específico (no mata al worker)
- `[telegram] poll error: <stack>` — error en `getUpdates` (backoff + reintento)

## Troubleshooting

### "No pude procesar el mensaje"

El NLU (Claude Haiku) falló. Causas típicas:

- `ANTHROPIC_API_KEY` sin saldo o mal seteada.
- Rate limit (el bot reintenta el siguiente mensaje, no reintenta éste).
- Anthropic caído.

### El bot ignora mis mensajes

- Verificá que tu `Id` está en `TELEGRAM_ALLOWED_USER_IDS` (sin espacios).
- Verificá que el worker arrancó (`[telegram] long-poll worker started` en logs).
- Mandale `/start` — si responde, la conectividad está OK.

### Mensajes duplicados

El `externalId` de cada transacción Telegram es `tg:<chatId>:<messageId>`, con
`onConflictDoNothing` sobre `(accountId, externalId)`. Si el mismo `messageId`
llega dos veces (típicamente tras un crash del worker), la segunda vez se
descarta como `duplicated`. Si te pasa en uso normal, revisá
`telegram_poll_state` — puede estar en 0 y reprocesando todo el buffer de 24h.
