# Findash widgets en Android (Tasker)

Guía paso a paso para armar el widget de Findash en Android usando Tasker. No
viene un `.prj.xml` plug-and-play todavía — las versiones de Tasker difieren
lo suficiente como para que un XML hecho a mano se rompa en campo. La comunidad
puede contribuir uno una vez validado este flujo; ver
[`findash-widget.prj.xml`](./findash-widget.prj.xml) (placeholder).

## Requisitos

- [Tasker](https://play.google.com/store/apps/details?id=net.dinglisch.android.taskerm)
  6.3+ (pagado) O [Tasker Edition](https://tasker.joaoapps.com) en un
  dispositivo con licencia.
- Un widget token minteado desde `/settings/widgets` (guardalo, se muestra una
  sola vez).
- La base URL de tu instancia Findash (ejemplo: `https://findash.example.com`).

## Arquitectura del proyecto

Vamos a crear un único proyecto Tasker con tres piezas:

1. **Variables globales** — `%FINDASH_TOKEN` y `%FINDASH_BASE_URL`. Globales
   para que todos los Tasks las lean sin parametrizar.
2. **Task `Findash Fetch Widget`** — recibe `%par1` (el widget parameter, tipo
   `hoy.S` o `tc-focus.S|<id>`) y deja en `%FINDASH_OUTPUT` el JSON.
3. **Scenes** — una Scene por widget. Cada Scene corre el Task al abrirse,
   parsea el JSON, y pinta los elementos.

La Scene es lo que Tasker expone como "widget" en la home.

## Paso 1 — Guardar credenciales

1. Abrí Tasker → **Vars** (lápiz arriba a la derecha).
2. Tocá **+** y creá una variable global. Click en la ruedita al lado del
   nombre para marcarla como **Global**:
   - Nombre: `%FINDASH_TOKEN`
   - Valor: _tu widget token_
3. Repetí con:
   - Nombre: `%FINDASH_BASE_URL`
   - Valor: `https://findash.example.com` (sin slash al final)

> **Seguridad**: Tasker guarda las vars globales en claro en `/sdcard/Tasker/`.
> Si tu device no está cifrado, marcá ambas variables como `Structure Output`
> deshabilitado y considerá usar un perfil con contraseña de Tasker.

## Paso 2 — Crear el Task "Findash Fetch Widget"

1. Tab **TASKS** → **+** → Nombre: `Findash Fetch Widget`.
2. Agregar las siguientes **Actions** en este orden:

| # | Category | Action | Config |
|---|----------|--------|--------|
| 1 | Variables | Variable Set | `%widget_param` ← `%par1` |
| 2 | Variables | Variable Split | Name: `%widget_param` · Splitter: `\|` |
| 3 | Variables | Variable Set | `%widget_head` ← `%widget_param1` |
| 4 | Variables | Variable Set | `%widget_extra` ← `%widget_param2` (If set) |
| 5 | Variables | Variable Split | Name: `%widget_head` · Splitter: `.` |
| 6 | Variables | Variable Set | `%widget_id` ← `%widget_head1` |
| 7 | Variables | Variable Set | `%widget_size` ← `%widget_head2` |
| 8 | Variables | Variable Set | `%widget_url_extra` ← `` (vacío) |
| 9 | Task | If | `%widget_id ~ tc-focus` AND `%widget_extra Set` |
| 10 | Variables | Variable Set | `%widget_url_extra` ← `&target=%widget_extra` |
| 11 | Task | End If | |
| 12 | Net | HTTP Request | Method: `GET` · URL: `%FINDASH_BASE_URL/api/widget/v1/%widget_id?size=%widget_size%widget_url_extra` · Headers: `Authorization: Bearer %FINDASH_TOKEN` · Structure Output: ON · Timeout: 10s |
| 13 | Task | If | `%http_response_code ~ 2*` |
| 14 | Variables | Variable Set | `%FINDASH_OUTPUT` ← `%http_data` |
| 15 | Task | Else | |
| 16 | Variables | Variable Set | `%FINDASH_OUTPUT` ← `{"error":{"code":"network","message":"HTTP %http_response_code"}}` |
| 17 | Task | End If | |
| 18 | Variables | Variable Set | `%FINDASH_STATUS` ← `%http_response_code` |

3. Guardar el Task. Probalo en vacío: tocá el botón ▶ con `Argument: hoy.S` y
   verificá que `%FINDASH_OUTPUT` contenga JSON válido (pestaña **Vars**).

## Paso 3 — Crear las Scenes

Una Scene por widget. Vamos a detallar la Scene **"Findash Hoy S"** y dejar
las otras como referencia — la mecánica es idéntica.

### Scene "Findash Hoy S" (2×2)

1. Tab **SCENES** → **+** → Nombre: `Findash Hoy S`. Tamaño: 2×2 (arrastrá los
   manejadores hasta ~320x320 px).
2. Agregar elementos:
   - **Text** `label_day` (arriba): dummy content, color `#6b7280`, tamaño 10.
   - **Text** `amount` (centro, grande): dummy `$0`, tamaño 28, bold.
   - **Text** `tx_count` (debajo): dummy `0 txs`, tamaño 12, color `#6b7280`.
   - **Text** `delta` (abajo): dummy `vs promedio`, tamaño 10.
3. En **Properties** de la Scene → pestaña **Scene** → **Scene Created** →
   agregar Task:
   - Task: `Findash Fetch Widget`
   - Parameter (%par1): `hoy.S`
4. **Scene Created**, agregar Actions después del Task:

```
A1 JavaScriptlet:
   const p = JSON.parse(local('FINDASH_OUTPUT') || '{}');
   const d = p.data || {};
   setLocal('label_day', d.day_label || '—');
   setLocal('amount', '$' + ((d.spent_cop||0).toLocaleString('es-CO')));
   setLocal('tx_count', (d.tx_count||0) + ' txs');
   const v = d.vs_daily_avg_pct;
   setLocal('delta', v==null ? 'sin comparación'
     : (v>0?'↑':v<0?'↓':'→') + ' ' + Math.abs(v) + '% vs promedio');

A2 Element Text Set Text:  Element label_day  — To: %label_day
A3 Element Text Set Text:  Element amount     — To: %amount
A4 Element Text Set Text:  Element tx_count   — To: %tx_count
A5 Element Text Set Text:  Element delta      — To: %delta
```

5. Tocá el pin (arriba a la derecha) para colocarla en el home. Tasker la
   expone como "Scene Widget". Mantené presionado sobre el home → Widgets →
   Tasker → Scene → `Findash Hoy S`.

### Scenes restantes

Repetí el patrón arriba con los siguientes parámetros y campos:

| Scene | Tamaño | %par1 | Campos (data shape) |
|-------|--------|-------|---------------------|
| `Findash TC Focus` | 2×2 | `tc-focus.S\|<card_id>` | `card_name`, `available_cop`, `utilization_pct`, `days_to_cutoff` |
| `Findash Mis TCs M` | 4×2 | `mis-tcs.M` | `total_available_cop` + loop sobre `cards[0..2]` |
| `Findash Mis TCs L` | 4×4 | `mis-tcs.L` | `total_available_cop` + loop sobre `cards` |
| `Findash Hoy S` | 2×2 | `hoy.S` | arriba |
| `Findash Mes Actual M` | 4×2 | `mes-actual.M` | `month_label`, `spent_cop`, `projection_month_end_cop`, `delta_pct`, `delta_direction` |
| `Findash Recent TX M` | 3×2 | `recent-tx.M` | loop sobre `transactions[0..2]` — `merchant`, `amount_cop`, `category_name`, `account_label` |
| `Findash Recent TX L` | 3×3 | `recent-tx.L` | idem con `transactions[0..4]` |

Para los widgets que listan ítems (`mis-tcs`, `recent-tx`) agregá un
contenedor **Rect** o **Image** por fila y poné el JavaScriptlet para que
rellene cada fila desde el array.

## Paso 4 — Refresco automático

Los widgets Scene de Tasker se refrescan cuando se abre el Scene. Para
actualizar cada 30 minutos:

1. Tab **PROFILES** → **+** → **Time** → cada 30 minutos, todo el día.
2. Linkear a un Task nuevo `Findash Refresh All`.
3. Ese Task llama `Perform Task` → `Findash Fetch Widget` con cada parámetro
   que tengas en home, luego `Element Text Set Text` para cada elemento
   (como en el paso 3-A2/A5) apuntando al Scene correspondiente.

> **Gotcha**: Tasker 6.x limita los triggers de tiempo cuando la batería está
> optimizada. Ponelo en la lista blanca de batería (`Ajustes → Apps → Tasker
> → Batería → No restringido`), si no vas a ver refrescos salteados.

## Paso 5 — Manejo de errores

Agregá al final del Task **Findash Fetch Widget**:

```
If %FINDASH_STATUS !~ 2*
  JavaScriptlet:
    const p = JSON.parse(local('FINDASH_OUTPUT') || '{}');
    const code = p.error?.code;
    let msg = 'Sin conexión';
    if (code === 'unauthorized' || code === 'forbidden')
      msg = 'Token inválido — /settings/widgets';
    else if (code === 'widget_not_found')
      msg = 'Widget desconocido';
    else if (code === 'rate_limited')
      msg = 'Demasiadas peticiones';
    setLocal('FINDASH_ERROR', msg);
End If
```

Después en cada Scene, si `%FINDASH_ERROR` está seteado, mostrá ese mensaje en
el elemento principal en lugar de los datos.

## Troubleshooting

| Síntoma | Causa probable | Fix |
|---------|----------------|-----|
| Widget siempre muestra `$0` | JavaScriptlet no corrió | Chequear que el orden en Scene Created sea: HTTP Request → JavaScriptlet → Set Text |
| `401` en los logs | Token expirado o copiado mal | Re-generar en `/settings/widgets`, actualizar `%FINDASH_TOKEN` |
| `404` en widget desconocido | Typo en `%par1` | Ver cheatsheet en `/settings/widgets` |
| No refresca | Batería optimizada | Ponele no-restringido a Tasker |
| USD no se muestra | Esperado | Widgets convierten USD→COP al fetch |

## Contribuir

Si armás la Scene con un diseño lindo y querés contribuirla al proyecto:

1. Exportá el proyecto completo (`Projects → Findash → Export → Data Export`).
2. Abrí un PR reemplazando [`findash-widget.prj.xml`](./findash-widget.prj.xml).
3. Adjuntá capturas de pantalla de cada widget en funcionamiento.
