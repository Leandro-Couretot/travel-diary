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

## Fase 1 — Onboarding: "Crear álbum" → explicación breve → login con Google

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

## Fase 2 — Métricas de producto (ejecutar `ANALYTICS_PLAN.md`)

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

## Fase 3 — Meta Pixel + Conversions API (última, pendiente de credenciales)

### Qué hace falta del usuario antes de arrancar esta fase

1. Un Pixel creado en Meta Events Manager (Business Manager) → el **Pixel ID**.
2. Un **access token de Conversions API** (Events Manager → Configuración →
   Conversions API → Generar token de acceso).

Sin esto la fase queda bloqueada — está bien, por eso va última.

### Sub-pasos (una vez estén las credenciales)

- **3a — Pixel del lado del cliente**: `fbq()` base en `app.html`. Eventos
  estándar de Meta: `PageView` (automático), `ViewContent` al abrir el modal
  de suscripción, `InitiateCheckout` al tocar un plan (`startCheckout()`).
  Verificable con la extensión "Meta Pixel Helper" sin tocar nada del backend.
- **3b — Guardar `fbp`/`fbc` en el checkout**: para que el evento de compra
  confirmada (3c, del lado del servidor) tenga buen matching, `checkout-create.js`
  guarda la cookie `_fbp` y el click id `fbc` (si vino de un anuncio) junto a
  la fila de `subscriptions` — 2 columnas nuevas en `schema.sql`.
- **3c — Conversions API en el webhook**: cuando `webhook-mercadopago.js`
  confirma `status: 'authorized'` (la fuente de verdad real de "pagó"),
  dispara `Subscribe`/`Purchase` a la API de Meta con el `fbp`/`fbc` de 3b +
  el monto real (`PRECIOS_ARS`, ya existe en `checkout-create.js`). Secrets
  nuevos: `META_PIXEL_ID`, `META_CAPI_ACCESS_TOKEN` (mismo patrón que
  `MP_ACCESS_TOKEN`).
- **3d — `Lead`/`CompleteRegistration`** al conectar Drive por primera vez
  (evento de signup, no de pago) — alcanza con dispararlo del lado del
  cliente, es una señal de menor riesgo que la de 3c.
- **Privacidad**: sumar una línea a `privacy.html` declarando el uso de Meta
  Pixel/Conversions API con fines publicitarios — texto a preparar y pasar
  para aprobación antes de shippear esta fase.

### Tests + deploy

Mismo patrón. Esta fase sí toca `functions/schema.sql` de nuevo (columnas
`fbp`/`fbc`) y suma 2 secrets nuevos en Firebase Functions Secret Manager —
recordar el paso manual de Cloud Run Invoker si en algún momento se separa
esto en una Cloud Function propia en vez de colgarlo de `webhook-mercadopago.js`
(que ya lo tiene concedido).

---

## Checklist rápido de lo que falta de vos, por fase

- **Fase 1**: aprobar el copy del modal de onboarding (te lo paso antes de programar).
- **Fase 2**: nada externo — solo repetir los pasos manuales de Supabase (Exposed tables + GRANTs) para `usage_events` cuando llegue el momento.
- **Fase 3**: Pixel ID + access token de Conversions API de Meta Business Manager.
