# Findash widgets en Android (Tasker)

Para Android la historia es más trabajosa que iOS — Android no tiene una
app equivalente a Scriptable que corra JS con acceso a widgets, pero
[Tasker](https://play.google.com/store/apps/details?id=net.dinglisch.android.taskerm)
cubre el mismo caso de uso: corre Tasks con `HTTP Request`, guarda vars
globales, y expone Scenes como widgets del home screen.

La guía completa paso a paso vive en [`tasker/setup.md`](./tasker/setup.md).

## Resumen

1. Instalar Tasker desde Play Store (pago).
2. Mintear un widget token en `/settings/widgets` de Findash.
3. Crear vars globales `%FINDASH_TOKEN` + `%FINDASH_BASE_URL` en Tasker.
4. Crear el Task `Findash Fetch Widget` (HTTP Request con Bearer header).
5. Crear una Scene por widget/tamaño (tc-focus, mis-tcs M/L, hoy, mes-actual,
   recent-tx M/L).
6. Anclar cada Scene al home screen vía el widget "Tasker Scene".
7. Opcional: perfil Time cada 30 min para refresco en background.

## ¿Por qué no un `.prj.xml` plug-and-play?

Los proyectos Tasker se exportan como XML — en teoría podrías importar uno
ya armado con todo. En la práctica:

- Los XMLs son sensibles a la versión de Tasker y al DPI/tamaño del device.
- Un XML hecho a mano casi seguro falla en otro device.
- Mantenerlo actualizado contra cambios de Tasker es un costo alto para el
  payoff — Findash es para mí + amigos, no tengo un QA team de Android
  devices.

Por eso la opción oficial hoy es el paso a paso de
[`tasker/setup.md`](./tasker/setup.md). Si un usuario arma un proyecto con
diseño lindo y validado, puede contribuirlo — ver la sección "Contribuir" al
final de esa guía.

## Screenshots de referencia

[screenshot-placeholder: cada widget renderizado en home screen — tc-focus,
mis-tcs M, hoy, mes-actual, recent-tx L]

## Troubleshooting específico de Android

Ver la sección correspondiente en [`tasker/setup.md`](./tasker/setup.md). Lo
más común:

- **Tasker no refresca en background**: batería optimizada. Whitelist a
  Tasker en `Ajustes → Apps → Tasker → Batería → No restringido`.
- **La Scene se ve cortada**: el tamaño del widget en Android es variable
  según launcher. Ajustar el tamaño de la Scene matching al canvas que te
  reserva el launcher (Nova, Pixel Launcher, etc).
- **HTTP Request 401**: el header `Authorization` tiene espacios trailing —
  Tasker es puntilloso. Verificá que sea exactamente `Bearer %FINDASH_TOKEN`
  sin espacios extra.

## Mantenimiento

- Si rotás el token: edit `%FINDASH_TOKEN` en Vars de Tasker.
- Si cambia la base URL: edit `%FINDASH_BASE_URL`.
- Los cambios son inmediatos — el próximo trigger del Task los lee.

## Alternativas

- **KWGT** (Kustom Widget Maker): permite widgets complejos pero no tiene
  un módulo HTTP nativo — necesitás Tasker de todas formas para el fetch.
- **HTTP Shortcuts**: apto para probar el endpoint manualmente, pero no
  expone Scenes al home screen.
- **App nativa Android**: está en el roadmap (Fase 6, ver `PLAN.md`), pero
  requiere una cadena de validación larga antes de empezar.

El paso intermedio más productivo hoy es Tasker. Si alguien tiene ganas de
armar una app Android simple con un `AppWidgetProvider` que haga lo mismo,
abrir un issue citando `#382` y discutimos.
