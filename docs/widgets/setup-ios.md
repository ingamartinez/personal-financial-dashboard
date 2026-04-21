# Findash widgets en iPhone (Scriptable)

Setup paso a paso para tener tiles de Findash en la pantalla de inicio del
iPhone. Usa [Scriptable](https://scriptable.app) — app gratis, mantiene el
código en iCloud, corre JavaScript nativo con acceso a `Keychain`, `Request`,
y primitivas de widget (`ListWidget`, `Stack`, `Text`).

## Camino recomendado — usá el tutorial en la app

El camino soportado y **menos propenso a typos** es el tutorial
embebido en Findash:

1. Abrí **Findash → Settings → Widgets** en el iPhone.
2. Seguí los 7 pasos del tutorial arriba del gestor de tokens.
3. Cada botón **Copiar** deja el script en el portapapeles — el
   `findash-set-token.js` ya viene con la URL de tu instancia
   pre-cargada, así que no podés typear mal el dominio.

Si por lo que sea el tutorial no carga (sin JS en el browser, clipboard
API bloqueada, etc.), el resto de esta guía describe el flujo manual
tradicional usando los archivos crudos del repo.

## Requisitos (flujo manual)

- iPhone con iOS 16+ (widgets en escritorio).
- [Scriptable](https://apps.apple.com/app/scriptable/id1405459188) instalado.
- Acceso a tu instancia de Findash (debe estar en una URL alcanzable desde el
  iPhone — por Tailscale, Cloudflare Tunnel, o público).
- Un widget token minteado en `/settings/widgets`.

## Paso 1 — Mintear el widget token

1. Abrí Findash en el browser (podés usar el del iPhone, no importa).
2. Ir a **Settings → Widgets**.
3. Click en **Nuevo token**. Poné un label descriptivo (`"iPhone — personal"`,
   `"iPad Emilia"`, lo que sea).
4. Copiá el **plaintext** que aparece. **Se muestra una sola vez.** Si lo
   perdés tenés que mintear uno nuevo y revocar el viejo.

[screenshot-placeholder: pantalla /settings/widgets con el modal de token
minteado mostrando el plaintext]

## Paso 2 — Instalar los scripts en Scriptable

Next.js sirve los scripts como assets estáticos desde `public/`:

- Widget principal: <https://findash.alejoframes.com/widgets/scriptable/findash-widget.js>
  (en tu propia instancia, reemplazá el host).
- Setup token: <https://findash.alejoframes.com/widgets/scriptable/findash-set-token.js>

### Abrir los scripts en tu iPhone

1. En Safari del iPhone, abrí la URL del widget principal (arriba).
2. Tocá el texto, **seleccioná todo** y **Copy**.
3. Abrí Scriptable → **+** (nuevo script) → pegás el código. Renombrás el
   script a `Findash Widget` (tocando el título arriba).
4. Repetís con el script de setup, llamándolo `Findash Set Token`.

> Alternativa: copiar los archivos a iCloud Drive →
> `Scriptable/` (Scriptable los levanta directo si el folder está linkeado).

[screenshot-placeholder: Scriptable con los dos scripts — "Findash Widget" y
"Findash Set Token" — listados]

## Paso 3 — Correr el setup una vez

1. Abrí Scriptable → tocá `Findash Set Token`.
2. Tocá el botón ▶ (arriba a la derecha).
3. Te aparece un `Alert` con dos campos:
   - **Base URL**: pegá `https://findash.tu-dominio.com` (sin slash al final).
   - **Widget token**: pegá el plaintext del paso 1.
4. Tocá **Guardar**. Aparece "Listo" y listo — las credenciales están en
   Keychain.

[screenshot-placeholder: alert de `Findash Set Token` con los dos campos]

## Paso 4 — Agregar un widget al home

1. Mantené presionado el home screen hasta que los íconos vibren.
2. Tocá **+** arriba a la izquierda → buscá **Scriptable**.
3. Elegí el tamaño de widget (Small, Medium, Large).
4. Tocá **Add Widget** → sin soltar, tocá el widget para configurarlo:
   - **Script**: `Findash Widget`
   - **When Interacting**: `Run Script`
   - **Parameter**: el parámetro del widget que querés mostrar (ver tabla
     abajo).

[screenshot-placeholder: pantalla de configuración del widget mostrando los
tres campos]

### Tabla de parámetros

| Parámetro | Widget | Tamaño recomendado |
|-----------|--------|--------------------|
| `hoy.S` | Hoy — gasto del día | Small |
| `mes-actual.M` | Mes actual — MTD + proyección | Medium |
| `mis-tcs.M` | Mis TCs — top 3 | Medium |
| `mis-tcs.L` | Mis TCs — roster completo | Large |
| `recent-tx.M` | Últimas 3 transacciones | Medium |
| `recent-tx.L` | Últimas 5 transacciones | Large |
| `tc-focus.S|<card_id>` | TC focus — una tarjeta | Small |

Para `tc-focus` necesitás el `<card_id>`:

- **TC single-currency** (una moneda): el ID es el `accounts.id` — un entero.
  Lo podés ver en el URL de la página de detalle de la tarjeta en Findash, o
  en la respuesta de `/api/widget/v1/mis-tcs?size=L`.
- **TC multi-currency** (COP + USD en la misma tarjeta física): el ID es un
  UUID de `physical_cards.id`. Mismo procedimiento para sacarlo.

## Paso 5 — Repetir para cada widget

No hay límite real — podés tener 1 Scriptable widget de cada tamaño por
pantalla, y múltiples pantallas. Un setup típico:

- Home principal: `hoy.S` + `mes-actual.M` (abajo).
- Segunda pantalla: `mis-tcs.M` + `recent-tx.L`.
- `tc-focus.S|...` junto a Apple Wallet para las tarjetas principales.

[screenshot-placeholder: home screen del iPhone con 4 widgets de Findash
distribuidos]

## Troubleshooting

### "Sin conexión"

- Verificá que la base URL sea alcanzable desde el iPhone: abrí
  `https://findash.tu-dominio.com/api/widget/v1/hoy?size=S` en Safari — debe
  devolver un `{"error":{"code":"unauthorized",...}}` (sin token).
- Si estás en Tailscale, asegurate de que Tailscale esté activo en el
  iPhone **y** el iPhone tenga permitido el tráfico a ia-server.
- Si estás en un modal "Always On VPN" corporativo, el request puede estar
  bloqueado — probá con datos celulares.

### "Token inválido — revisá en /settings/widgets"

- El token fue revocado o tenés un typo. Volvé a correr `Findash Set Token`
  con el token actualizado.
- Si el token es reciente y no lo revocaste, verificá en la DB que
  `webhook_tokens.revoked_at` sea NULL para ese token (Findash server).

### "Widget desconocido"

- Typo en el Parameter — compará contra la tabla de arriba.
- Tu instancia Findash podría estar en una versión previa que no registra
  ese widget — ver [registry index](../../src/lib/widgets/handlers/index.ts).

### Widget muestra "• datos en caché"

- La última fetch falló (red intermitente). Los datos son los de la última
  fetch exitosa. Se reintenta automáticamente en el próximo refresh (cada 30
  minutos por defecto, configurable en `REFRESH_MINUTES` del script).

### Widget muestra `—` donde debería haber un número

- El handler devolvió `null` legitimamente. Ejemplo: `hoy.vs_daily_avg_pct`
  es `null` si es el día 1 del mes (no hay días previos para comparar). NO
  es un bug.

### El refresh es muy lento

- iOS decide cuándo correr el widget en background — Scriptable pide 30
  minutos pero el OS puede espaciarlos más si el widget no se mira mucho.
  Tocar el widget fuerza una actualización.

## Mantenimiento

- Si rotás el token en `/settings/widgets`, re-corré `Findash Set Token`.
- Si la base URL cambia (nuevo dominio, nueva instancia), lo mismo.
- Si actualizás el script (`findash-widget.js`), copiar el nuevo contenido
  en Scriptable. Los widgets en home se recargan solos en el próximo
  refresh con la nueva lógica.

## Privacidad

- Token + base URL viven en el **Keychain** del iPhone — cifrado a nivel
  OS, no accesible por otras apps.
- Cada respuesta cachea ~2 KB en Keychain bajo la key `FINDASH_CACHE_<param>`.
  El cache sobrevive reboots y se overwritea en cada fetch exitoso.
- Ninguna telemetría sale a Anthropic / OpenAI / Apple a través del script:
  el único outbound es a tu propia instancia Findash.
