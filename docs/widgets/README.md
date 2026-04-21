# Findash — Widgets de pantalla de inicio

Tiles que ves sin desbloquear mucho. Diseñados para leer de un vistazo: cupo
disponible, gasto de hoy, últimas transacciones, proyección de mes. Se
conectan a tu instancia Findash vía un **widget token** por usuario, leído
por cada tile con un `Authorization: Bearer <token>` contra
`GET /api/widget/v1/<widget_id>`.

## ¿Por qué widgets nativos y no una PWA?

Las pantallas de inicio de iOS y Android NO corren JavaScript. Para tener
tiles 2×2 y 4×2 que se actualicen en background necesitás el runtime nativo
del sistema operativo. En iOS eso significa Scriptable (o una app nativa, que
viene en Fase 5), en Android eso significa Tasker (o una app nativa). Los
widgets son parte esencial del proyecto — el bot de Telegram cubre el flujo
conversacional, pero nada reemplaza un tile que mostrás sin desbloquear.

Para el contexto de producto, ver [bot-primary-interface-strategy][memory].

## Widgets disponibles

| ID           | Widget     | Tamaños              | Uso                                                      |
| ------------ | ---------- | -------------------- | -------------------------------------------------------- |
| `tc-focus`   | TC Focus   | S (2×2)              | Una tarjeta específica — cupo, utilización, días a corte |
| `mis-tcs`    | Mis TCs    | M (4×2), L (4×4)     | Roster completo de tarjetas de crédito, ordenado por uso |
| `hoy`        | Hoy        | S (2×2)              | Gasto de hoy + comparación con promedio diario del mes   |
| `mes-actual` | Mes actual | M (4×2)              | MTD + proyección fin de mes + delta vs mes pasado        |
| `recent-tx`  | Últimas 5  | M (3 txs), L (5 txs) | Feed de últimas transacciones en todas las cuentas       |

Ver el JSON que devuelve cada widget en [`api-reference.md`](./api-reference.md).

## Setup por plataforma

> **iOS (primary path):** el camino rápido es el **tutorial en la app** —
> entrá a `/settings/widgets` y seguí los 7 pasos. Los botones de copiar
> bajan los scripts al portapapeles (con la URL de tu instancia ya
> pre-cargada en el setup) y te evitan cualquier typo. La guía markdown
> queda como referencia para debugging.

| Plataforma | Guía                                     | Requisitos                                                                                             |
| ---------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| iOS        | [`setup-ios.md`](./setup-ios.md)         | iPhone + [Scriptable](https://scriptable.app) (gratis)                                                 |
| Android    | [`setup-android.md`](./setup-android.md) | Android + [Tasker](https://play.google.com/store/apps/details?id=net.dinglisch.android.taskerm) (pago) |

Ambos flujos siguen la misma secuencia:

1. Ir a `/settings/widgets` en Findash y **mintear un widget token**.
   Guardarlo ya — el plaintext se muestra **una sola vez**.
2. En el dispositivo, correr un script de setup una vez para guardar el
   token y la base URL en el almacenamiento seguro del OS (Keychain en iOS,
   vars globales en Tasker).
3. Pegar el script del widget en la app (Scriptable en iOS, Scenes en
   Tasker).
4. Agregar el widget al home screen, configurar qué widget mostrar por su
   parámetro (`hoy.S`, `tc-focus.S|<card_id>`, etc.).
5. Opcional: crear múltiples instancias con distintos parámetros para
   distintos widgets en el mismo home.

### URLs crudas de los scripts (fallback)

Sirvelos Next.js como estáticos, siempre apuntan a la versión desplegada:

- Widget principal: `https://findash.alejoframes.com/widgets/scriptable/findash-widget.js`
- Setup token: `https://findash.alejoframes.com/widgets/scriptable/findash-set-token.js`

En tu propia instancia reemplazá el host por el tuyo. Usalos sólo si el
tutorial en la app no te funciona o si querés un enlace directo para
compartir.

## Formato del parámetro

Todos los widgets se seleccionan con un único string en el campo
**Parameter** del widget (iOS) o **%par1** del Task (Android):

```
<widget_id>.<size>[|<extra>]
```

- `<widget_id>`: uno de los IDs de la tabla de arriba.
- `<size>`: `S` | `M` | `L`. Cada widget soporta un subset — ver la tabla.
- `<extra>`: opcional, separado por `|`. Hoy sólo `tc-focus` lo usa, para
  recibir el `target` (UUID de `physical_cards` para TCs multi-currency, o
  entero de `accounts.id` para TCs single-currency).

Ejemplos válidos:

```
hoy.S
mis-tcs.M
mis-tcs.L
mes-actual.M
recent-tx.L
tc-focus.S|3a4b5c6d-1234-5678-9abc-def012345678
tc-focus.S|42
```

## Rotar un token

Si comprometiste el token (ej. quedó en un screenshot, lo perdiste) o lo
querés rotar por higiene:

1. `/settings/widgets` → revocá el token viejo.
2. Minteá uno nuevo → copiá el plaintext.
3. Re-corré el script de setup en el dispositivo (iOS: `findash-set-token.js`;
   Android: editá la var global `%FINDASH_TOKEN`).

Los widgets existentes en home siguen funcionando — lo único que cambia es el
valor guardado en el device.

## Troubleshooting rápido

| Error en el widget                             | Causa                              | Solución                                                    |
| ---------------------------------------------- | ---------------------------------- | ----------------------------------------------------------- |
| "Sin conexión"                                 | Red caída o URL mal                | Verificá `FINDASH_BASE_URL`; probá en el browser del device |
| "Token inválido — revisá en /settings/widgets" | Token revocado/vencido             | Mintear uno nuevo + re-run setup                            |
| "Widget desconocido"                           | Typo en el parameter               | Consultar tabla de arriba                                   |
| "Parámetros inválidos"                         | Tamaño no soportado por ese widget | Ej. `tc-focus.M` no existe — sólo `S`                       |
| Muestra "• datos en caché"                     | Última petición falló              | Se reintentará en el próximo refresh (30 min)               |

## Ver también

- [API reference](./api-reference.md) — el JSON exacto que devuelve cada endpoint
- [iOS setup](./setup-ios.md)
- [Android setup](./setup-android.md)
- Issue [#382](https://github.com/ingamartinez/personal-financial-dashboard/issues/382) — epic umbrella

[memory]: #
