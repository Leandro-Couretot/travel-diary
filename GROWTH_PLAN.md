# Plan de crecimiento: onboarding + medición — Travel Diary

**Estado: PLAN, NO EJECUTADO.** Nada de lo que describe este documento está
implementado todavía. Se guarda en el repo para no perder el orden acordado
y las decisiones de diseño — se ejecuta fase por fase, probando cada una
antes de seguir con la próxima (mismo criterio que se usó para todo el
modelo freemium, ver CLAUDE.md → "Suscripciones").

---

## Qué cubre y en qué orden

Tres iniciativas relacionadas — las tres miden o afectan el mismo embudo
(alguien llega a la app → se registra con Google → eventualmente paga):

1. **Fase 1 — Onboarding nuevo**: la home no le pide Google de entrada, sino
   que ofrece "Crear tu primer álbum", explica brevemente la app, y recién
   ahí pide conectar con Google.
2. **Fase 2 — Métricas de producto**: ejecutar `ANALYTICS_PLAN.md` (ya
   diseñado, nunca ejecutado) para saber cómo se usa la app de verdad —
   logins, álbumes creados, qué tabs se usan, etc.
3. **Fase 3 — Meta Pixel + Conversions API**: medir el embudo publicitario
   (de un clic en un anuncio a un registro o una suscripción pagada), para
   poder optimizar campañas de Meta Ads.

**Orden decidido con el usuario:** Fase 1 → Fase 2 → Fase 3. La Fase 3 va
última a propósito — todavía no están a mano el Pixel ID ni el access token
de Conversions API (hay que generarlos en Meta Business Manager), así que no
tiene sentido bloquear las otras dos fases esperándolos.

Nota técnica que quedó de la discusión previa, para no perderla: cambiar el
orden (Fase 1 antes que Fase 3) no implica retrabajo real — `handleDriveBtn()`
(la función que dispara el login real de Google) sigue siendo la misma
sin importar qué pantalla la llame; el onboarding nuevo solo cambia desde
dónde se la invoca.

---

## Fase 1 — Onboarding: "Crear álbum" → explicación breve → login con Google ✅ (v1.61)

### Qué cambia

Hoy (`renderDisconnected()` en `app.html`), si no estás conectado a Drive ves
una sola pantalla: "Tu diario de viaje / Conectá Google Drive para acceder a
tus álbumes... / [Conectar con Google Drive]" — pide el login de entrada, sin
explicar antes qué hace la app.

Pasa a ser:
1. **Pantalla inicial** con un CTA principal tipo **"Crear tu primer álbum"**
   (en vez de pedir Drive directamente) — mismo lugar donde hoy vive
   `renderDisconnected()`.
2. Al tocarlo, se abre un **modal corto** (`#modal-onboarding`, 2-3 puntos,
   no un wizard largo) explicando la app: algo como "📷 Guardá cada día de tu
   viaje con fotos, videos y notas", "☁️ Todo se guarda en tu propio Google
   Drive — vos sos dueño de tus datos", "📖 Armá un fotolibro para imprimir
   cuando quieras".
3. El modal termina con un botón **"Continuar con Google"**, que recién ahí
   dispara `handleDriveBtn()` (el login real, sin cambios en su lógica).

### Decisiones a confirmar antes de programar

- **Copy exacto del modal** (los 2-3 puntos + textos de los botones) — lo
  redacto y lo paso para aprobar antes de tocar código, mismo criterio que
  usamos para cualquier texto de cara al usuario.
- **¿El modal se puede cerrar sin loguearse?** (ej. con una X) — probablemente
  sí, para no sentirse forzado; si lo cierra, vuelve a la pantalla inicial
  con el CTA "Crear tu primer álbum".
- ¿Aplica también al caso de "invitación a álbum" (`renderJoinPending()`), que
  hoy tiene su propia pantalla mínima? Evaluar si conviene el mismo modal
  explicativo ahí o dejarlo como está (alguien invitado ya tiene contexto de
  qué es la app, quizás no haga falta explicarle de nuevo).

### Archivos

- `app.html`: reemplazar el botón/CTA de `renderDisconnected()`, agregar
  `#modal-onboarding` (mismo patrón de modal que el resto de la app, ver
  `customConfirm()` v1.34 como referencia de estilo), función
  `openOnboardingModal()`/`closeOnboardingModal()`.
- Sin cambios en `drive.js` ni backend — es puramente de UI, no toca la
  lógica de auth.

### Tests + deploy

Mismo patrón vm-sandbox del resto del proyecto: el CTA abre el modal, el
modal no dispara `handleDriveBtn()` hasta tocar "Continuar con Google", cerrar
el modal no inicia sesión. Versionar, documentar en CLAUDE.md, commitear,
pushear, deployar.

---

## Fase 2 — Métricas de producto (ejecutar `ANALYTICS_PLAN.md`) ✅ (v1.62)

El diseño técnico completo ya está escrito y revisado — ver
[`ANALYTICS_PLAN.md`](./ANALYTICS_PLAN.md) para el detalle (tabla, función,
principio de privacidad "conteos y booleanos, nunca contenido"). Este plan
no lo reescribe, solo fija que ahora sí se ejecuta y agrega los eventos del
onboarding nuevo que ese documento no contemplaba porque es anterior a la
Fase 1.

### Qué se ejecuta, tal cual está diseñado

- Tabla `usage_events` en Supabase (`schema.sql`, mismos 4 pasos manuales ya
  conocidos: Exposed schemas/tables en Data API + GRANTs — ver CLAUDE.md →
  "Suscripciones" → Supabase, se repiten para esta tabla nueva).
- Cloud Function `track-event.js` (`POST /api/track`, autenticada con el JWT
  de `td_session`, fire-and-forget desde el frontend).
- Instrumentación en `app.html`/`billing.js`: `login`, `day_saved` (con
  `photo_count`/`has_title`/`has_notes`), `tab_viewed`, `album_shared`,
  `error`.

### Batching — pensado como eficiente desde el diseño, no como optimización después

Cada invocación de una Cloud Function se cobra por cantidad de invocaciones +
tiempo de cómputo, con un overhead fijo por request (arrancar, autenticar,
conectar a Supabase) que se paga aunque el trabajo real sea mínimo. `tab_viewed`
en particular puede dispararse varias veces por sesión — mandar un POST por
evento sería N invocaciones por sesión. Se diseña `track-event.js` desde el
día uno para recibir un **array** de eventos en un solo request en vez de uno
por evento — no cuesta más trabajo hacerlo así de entrada y evita un rediseño
después:

- **Body de `track-event.js`**: `{ events: [{ event_name, event_props, occurred_at_client }, ...] }`
  en vez de un evento suelto. Inserta todos con un solo `.insert([...])` a
  Supabase (una sola ida y vuelta a Postgres para todo el lote, no una por
  evento).
- **Buffer del lado del cliente** (`app.html`): un array en memoria donde se
  van empujando los eventos (`login`, `tab_viewed`, etc.) en vez de mandarlos
  al toque. Se vacía (flush) en dos casos: (a) cada ~10-15s si hay algo
  pendiente, con un `setInterval`/`setTimeout` encadenado — mismo criterio de
  "no bloquear nada" que ya usan `establishSessionAndEnforceLimit()` o
  `maybeReconcileAudioUsage()`; (b) al ocultar/cerrar la pestaña
  (`visibilitychange` a `hidden`, o `pagehide`), usando
  `navigator.sendBeacon()` en vez de `fetch()` — `sendBeacon` está pensado
  justo para esto: manda el request aunque la página ya se esté cerrando,
  algo que un `fetch()` normal puede cortar a mitad de camino (mismo tipo de
  escenario de conexión/app cortada que ya motivó el guardado parcial de
  v1.21).
- **No aplica a Meta Conversions API (Fase 3)**: los eventos de ahí (signup,
  pago confirmado) son de bajo volumen y conviene que salgan al toque, no
  vale la pena demorarlos por juntarlos con otros.

### Eventos nuevos que suma esta fase (no estaban en el plan original)

- `onboarding_viewed`: se abrió el modal de la Fase 1.
- `signup_started`: se tocó "Continuar con Google" desde el onboarding.
- `signup_completed`: `establishSession()` respondió OK por primera vez para
  ese `google_sub` (se puede inferir del lado del servidor, en
  `auth-session.js`, comparando si la fila en `subscriptions` se acaba de
  crear vs. ya existía — más confiable que inferirlo del cliente).

### Orden interno sugerido

1. Tabla + Cloud Function + pasos manuales de Supabase (infraestructura).
2. Instrumentar los eventos "viejos" del plan original (login, day_saved,
   tab_viewed, album_shared, error).
3. Instrumentar los eventos nuevos del onboarding (ya debería estar shippeada
   la Fase 1 para este punto).
4. Confirmar en el SQL Editor de Supabase que los eventos llegan bien antes
   de dar la fase por cerrada.

### Tests + deploy

Mismo patrón de siempre. Como toca Supabase, recordar los 4 pasos manuales
(Exposed schemas ya está desde `subscriptions`, pero **Exposed tables** hay
que activarlo de nuevo para `usage_events` puntualmente) antes de que
`track-event.js` funcione de verdad — si no, falla en silencio del lado del
servidor, mismo síntoma que ya pasó una vez con `subscriptions`.

---

## Fase 3 — Meta Pixel + Conversions API (código completo ✅ v2.05 — deploy bloqueado hasta setear el secret)

### Qué hace falta del usuario antes de arrancar esta fase

1. Un Pixel creado en Meta Events Manager (Business Manager) → el **Pixel ID**
   — ✅ ya lo tenemos: `1609371220699065` (el usuario compartió el link a su
   dataset en Events Manager).
2. Un **access token de Conversions API** (Events Manager → Configuración →
   Conversions API → Integración directa → Generar token de acceso) — ✅ el
   usuario ya lo generó (vía "Integración directa", sin pasar por Google Tag
   Manager — evaluado y descartado: el evento crítico de esta app, el pago
   confirmado, nace en un webhook de servidor, no en el navegador, así que
   GTM no simplifica nada acá, solo agrega una cuenta/dashboard más que
   mantener sincronizado con el código). **Falta cargarlo**: `firebase
   functions:secrets:set META_CAPI_ACCESS_TOKEN` desde la máquina del
   usuario — bloquea el deploy hasta que se corra (mismo patrón que
   `GOOGLE_CLIENT_SECRET` en v1.91).

Como el Pixel ID no es un secreto (cualquier navegador que corre la página lo
ve igual que ve `G-0ZM7BKFP5G`, el measurement ID de GA ya hardcodeado desde
v2.00), 3a y 3d no necesitaban esperar al access token — se implementaron en
v2.04. 3b/3c sí lo necesitaban del lado del servidor y quedaron completas en
v2.05, con el código ya commiteado pero **sin deployar** hasta que el secret
esté cargado.

### Decisión de Advanced Matching (PII hasheada) — resuelta

Preguntado al usuario explícitamente (mismo criterio que la decisión de "sin
PII" ya tomada para Google Analytics en v2.00): **no** se manda ningún dato
personal (email/teléfono, ni hasheado) en las llamadas a Conversions API — el
matching se apoya únicamente en `fbp`/`fbc` (cookies de primera parte del
propio Pixel). El único costo real: si alguien clickea el anuncio desde un
dispositivo y paga desde otro, ese caso puntual no matchea tan bien como con
email hasheado — aceptado como un caso chico para el volumen actual de la
app, a cambio de no abrir una categoría nueva de dato sensible que esta app
nunca manejó.

### Sub-pasos

- ✅ **3a — Pixel del lado del cliente (v2.04)**: `fbq()` base (snippet
  estándar de Meta, sin modificar) agregado al `<head>` de `app.html`, con el
  Pixel ID de arriba y `PageView` automático. `trackMetaPixelEvent(name, params)`
  (`billing.js`, junto a `appCheckHeaders()`) es el wrapper defensivo que usan
  el resto de los eventos — `try/catch` + chequeo de `typeof fbq`, mismo
  criterio que el resto de las llamadas a servicios externos de esta app: un
  adblocker que bloquee `fbevents.js` (caso frecuente, no un borde raro) nunca
  puede romper nada real, solo perderse ese evento puntual de medición.
  `ViewContent` se dispara al abrir el modal de suscripción
  (`openSubscribeModal()`), `InitiateCheckout` al tocar un plan
  (`startCheckout()`, con `value`/`currency` desde `META_PIXEL_PLAN_PRICES_ARS`
  — mismo comentario de sincronización manual que ya usa el texto de los
  botones del modal con `PRECIOS_ARS` en `functions/checkout-create.js`).
  Verificable con la extensión "Meta Pixel Helper", sin tocar nada del backend.
- ✅ **3d — `CompleteRegistration` (v2.04)**: se dispara al conectar Drive,
  pero **solo si es un signup genuino** — nunca en una sesión restaurada ni un
  re-login, que hubiera inflado el conteo de registros en Meta Ads Manager con
  cada apertura de la app. `auth-session.js` ya calculaba `isNewUser`
  internamente (chequeando si la fila de `subscriptions` existía antes del
  upsert, para `signup_completed` de la Fase 2) — solo hacía falta devolverlo
  también en la respuesta JSON. `applySessionResponse()` (`billing.js`) lo lee
  y dispara el evento únicamente si `data.isNewUser === true`.
- ✅ **3b — Guardar `fbp`/`fbc` en el checkout (v2.05)**: `checkout-create.js`
  lee las cookies `_fbp`/`_fbc` directo de `req.headers.cookie`
  (`readCookie()`) — como `/api/checkout/create` es same-origin (rewrite de
  Firebase Hosting), viajan solas en el pedido, sin que el frontend tenga que
  leerlas ni mandarlas a mano — y las guarda junto al resto de la fila de
  `subscriptions` en el mismo `.update()` que ya corría ahí. 2 columnas
  nuevas en `schema.sql` (`fbp`, `fbc`, `if not exists`).
- ✅ **3c — Conversions API en el webhook (v2.05)**: `sendMetaSubscribeEvent()`
  (`webhook-mercadopago.js`) dispara `Subscribe` a la Graph API de Meta con
  el `fbp`/`fbc` guardados en 3b + el monto/moneda reales (leídos de la
  respuesta de Mercado Pago, `mpData.auto_recurring`, no de una copia
  hardcodeada de `PRECIOS_ARS`). Se dispara únicamente en la **transición**
  a `status:'authorized'` (se lee el status anterior de la fila ANTES de
  actualizarlo) — sin esto, cada reintento de notificación de Mercado Pago
  con el mismo status ya confirmado dispararía el evento de nuevo. Sin
  `fbp` ni `fbc` (adblocker, o un checkout que nunca pasó por un navegador
  con el Pixel activo) no se manda nada — Meta rechaza un evento sin al
  menos un identificador, así que mandar uno vacío sería peor que no mandar
  nada. **Sin ningún dato personal** (email/teléfono, ni hasheado) — ver
  "Decisión de Advanced Matching" más arriba. Solo `META_CAPI_ACCESS_TOKEN`
  es un secret nuevo (`META_PIXEL_ID` quedó hardcodeado como constante, igual
  que ya vive en `app.html` — no es sensible, no ameritaba Secret Manager).
- ✅ **Privacidad (v2.05)**: `privacy.html` — sección 5 ("Compartir datos con
  terceros") ampliada para nombrar Google Analytics y el Píxel de Meta
  (aprovechado para cerrar de paso que GA nunca había quedado declarado ahí
  desde que se agregó en v2.00), aclarando que ninguna de las dos recibe
  nombre/email/contenido real, solo datos agregados y (para Meta) un
  identificador de navegador sin PII.

### Tests + deploy

`test_meta_pixel.js` (vm-sandbox, corrido contra `billing.js` real): confirma
que `trackMetaPixelEvent()` nunca rompe nada (sin `fbq`, o si `fbq()` tira),
que llama a `fbq('track', eventName, params)` correctamente, que
`META_PIXEL_PLAN_PRICES_ARS` sigue sincronizado con `PRECIOS_ARS`, y que
`applySessionResponse()` dispara `CompleteRegistration` únicamente cuando
`isNewUser:true` (nunca en sesión restaurada/re-login). `node --check` en
`app.html`, `billing.js`, `functions/auth-session.js`.

3b/3c sí van a tocar `functions/schema.sql` de nuevo (columnas `fbp`/`fbc`) y
sumar 2 secrets nuevos en Firebase Functions Secret Manager — recordar el
paso manual de Cloud Run Invoker si en algún momento se separa esto en una
Cloud Function propia en vez de colgarlo de `webhook-mercadopago.js` (que ya
lo tiene concedido).

---

## Checklist rápido de lo que falta de vos, por fase

- **Fase 1**: ✅ nada pendiente.
- **Fase 2**: ✅ nada pendiente.
- **Fase 3**: ✅ Pixel ID + access token ya los tenemos, y la decisión de
  Advanced Matching ya está tomada (sin PII). Código de 3a-3d completo y
  commiteado. Solo falta un paso tuyo para que llegue a producción: `firebase
  functions:secrets:set META_CAPI_ACCESS_TOKEN` desde tu máquina — recién
  ahí se puede correr el deploy.
