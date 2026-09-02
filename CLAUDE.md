# 旅 Travel Diary — CLAUDE.md

Contexto para Claude Code. Leer antes de tocar cualquier archivo.

---

## Qué es

App web de diario de viaje personal. El usuario registra cada día con fotos, videos, audios y notas. Todo se almacena en Google Drive del usuario. PWA instalable.

**En transición de "app familiar" a producto con suscripción** (freemium + pago mensual/anual vía Mercado Pago) — ver la sección "Suscripciones" más abajo. Mientras dura la migración, **la app sigue viva en GitHub Pages** con el `start_url` viejo; el corte a Firebase Hosting es un paso manual explícito, no automático (ver "Pendientes conocidos").

**URL producción actual (GitHub Pages):** `https://leandro-couretot.github.io/travel-diary/app.html`
**URL futura (Firebase, todavía no cortada):** `https://family-fotos-491610.web.app/app.html`
**Repo:** `https://github.com/Leandro-Couretot/travel-diary`

---

## Stack

- HTML + CSS + JS vanilla en el frontend, sin frameworks ni bundler
- Google Drive API v3 para persistencia de fotos/videos/notas (sigue siendo la única "base de datos" del contenido del diario — eso no cambia con la suscripción)
- Google Identity Services (GSI) para OAuth, con `userinfo.email` sumado al scope para tener una identidad estable (ver "Suscripciones")
- **Backend nuevo** (`functions/`): Node.js sobre Firebase Cloud Functions — antes la app no tenía backend propio, esto es exclusivamente para la lógica de suscripciones/pagos, no para el contenido del diario
- Firebase Hosting (reemplaza a GitHub Pages una vez cortada la migración) + Supabase (Postgres, estado de suscripciones — proyecto compartido `pluxow-clients`, schema propio `travel_diary`, ver "Suscripciones") + Mercado Pago (cobros)
- PWA instalable (manifest.json)

---

## Estructura de archivos

```
travel-diary/
├── app.html          ← SPA principal — TODO vive acá (home + diario)
├── drive.js          ← Lógica Google Drive (auth, CRUD archivos/carpetas, caché de días)
├── billing.js        ← Frontend de suscripciones: habla con /api/* (Cloud Functions), nunca directo con Supabase/Mercado Pago
├── exif.js           ← Lector EXIF liviano para fechas de fotos
├── style.css         ← Design system compartido
├── debug.js          ← Overlay de errores para debug en mobile
├── sw.js             ← Service worker: shell offline (stale-while-revalidate)
├── manifest.json     ← PWA manifest (íconos + config)
├── icon-192.png, icon-512.png, icon-maskable-512.png, apple-touch-icon.png ← íconos de instalación
├── privacy.html      ← Política de privacidad (requerida por Google OAuth)
├── terms.html        ← Términos de servicio
├── index.html        ← Redirige a app.html (legacy)
├── diary.html        ← Redirige a app.html (legacy)
├── firebase.json     ← Config de Firebase Hosting (rewrites /api/** → Cloud Functions) + de dónde salen las functions
├── .firebaserc       ← Proyecto de Firebase/GCP de este repo (family-fotos-491610)
├── functions/        ← Backend de suscripciones (Node.js, Cloud Functions) — ver "Suscripciones"
│   └── schema.sql    ← Fuente de verdad del schema `travel_diary` en Supabase (pluxow-clients)
└── CLAUDE.md         ← Este archivo
```

**Archivo principal: `app.html`** (~2400 líneas). Contiene todo el HTML, CSS y JS del frontend en un solo archivo. Es una SPA — no hay navegación entre páginas, todo se maneja con JS mostrando/ocultando vistas.

---

## Arquitectura SPA

Dos vistas principales manejadas por `navigateTo(view, params)`:

- `#view-home` — grilla de álbumes
- `#view-diary` — diario de un álbum (tabs: Día / Lista / Mes / Libro)

La navegación entre vistas es JS puro (`classList.add/remove('active')`), sin `location.href` ni `history.pushState`. Esto es intencional para que la PWA en iOS no abra Safari al navegar.

---

## Arquitectura de datos en Drive

```
Google Drive/
└── travel-diary/
    ├── albums.json              ← índice de álbumes propios
    ├── shared-albums.json       ← álbumes compartidos con este usuario
    ├── japon-2026/              ← carpeta por álbum (id = slug del nombre)
    │   └── 2026-03-24/          ← carpeta por día
    │       ├── day.json         ← { version, title, notes, media[] }
    │       ├── foto.jpg
    │       └── grabacion.webm
    └── otro-viaje/
```

### `day.json` estructura
```json
{
  "version": 2,
  "title": "Llegamos a Kyoto",
  "notes": "...",
  "media": [
    { "type": "image", "name": "foto.jpg", "driveFileId": "1ABC...", "caption": "..." },
    { "type": "audio", "name": "audio.webm", "driveFileId": "1XYZ...", "caption": "..." },
    { "type": "video", "name": "clip.mp4", "driveFileId": "1DEF...", "caption": "..." }
  ]
}
```

---

## OAuth / Drive config

```js
// en drive.js
const DRIVE_CLIENT_ID = '29099211489-421jp27om456sbegj4qhcohvimkfbd5m.apps.googleusercontent.com';
const DRIVE_SCOPE     = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email';
const SCOPE_VERSION   = 4; // incrementar si cambia el scope para forzar re-auth
```

- Scope `drive.file`: solo accede a archivos que la app creó. **No tocar sin revisar el proceso de verificación OAuth.**
- Scope `userinfo.email` (sumado en v1.15): scope no sensible, no debería requerir una nueva revisión de verificación — se usa exclusivamente para tener una identidad estable (`sub`/`email` de Google) con la que trackear suscripciones. No se usa para nada del diario en sí.
- El token de Drive se guarda en `localStorage` como `drive_token`; el JWT propio de sesión de suscripción (ver "Suscripciones") como `td_session` — mismo patrón, mismo mecanismo de storage.
- La app **ya pasó la verificación de OAuth de Google** — cualquier cuenta de Google puede autenticarse, no hace falta estar en una lista de prueba (proyecto de Google Cloud: `family-fotos-491610`).
- El `tokenClient` (`google.accounts.oauth2.initTokenClient`) y el botón "Conectar Drive" viven en **`app.html`** (`initGoogleAuth()` / `handleDriveBtn()`), no en `drive.js` — drive.js solo restaura una sesión ya guardada (`initDrive()`). Había una segunda copia de `initGoogleAuth`/`tokenClient` en `drive.js` que nunca se ejecutaba (quedaba tapada por la de `app.html`, que se carga después) — se sacó en v1.14 para que no vuelva a confundir.
- Cada pedido de acceso manda un `state` aleatorio (`pendingAuthState`, declarado en drive.js) y el callback lo valida contra lo que Google devuelve antes de aceptar el token — mitiga que se cuele una respuesta que la app no pidió (recomendación de Google Cloud Console → "Use secure flows").

---

## Suscripciones (Mercado Pago + Supabase + Firebase Functions)

Freemium + suscripción mensual/anual. **Todavía no se decidió qué funciones puntuales quedan detrás del pago** (candidatas: fotolibro, video, compartir) — esta capa es solo la infraestructura para saber "¿esta cuenta pagó?"; el gateo feature por feature se agrega después, cuando se decida.

Arquitectura:
```
app.html (Drive OAuth ampliado con email) → billing.js → /api/** (Firebase Hosting rewrite)
                                                        → Cloud Functions → Supabase (estado) + Mercado Pago (cobro)
```

- **Nunca** se habla directo con Supabase ni Mercado Pago desde el navegador — todo pasa por Cloud Functions, las únicas que tienen los secretos.
- La identidad se valida del lado del servidor: el frontend manda el `access_token` de Google en bruto; `functions/auth-session.js` lo valida contra `tokeninfo`/`userinfo` de Google antes de confiar en el `sub`/`email`.
- Fuente de verdad de "¿es usuario pago?" = `status === 'authorized'` en la tabla `subscriptions` de Supabase, que a su vez refleja el estado real del `preapproval` en Mercado Pago (consultado en vivo cuando hace falta, nunca confiando ciegamente en el cuerpo de un webhook individual).

### `functions/` (Cloud Functions, Node.js, región `southamerica-east1`)
- `auth-session.js` — valida el access_token de Google, crea/actualiza la fila en Supabase, devuelve un JWT propio de sesión.
- `checkout-create.js` — crea el `preapproval` (suscripción) en Mercado Pago con `status: "pending"`, devuelve el `init_point` (URL de checkout de MP) para redirigir. **Precios en `PRECIOS_ARS` al principio del archivo** — hoy $14.000/mes, 20% off anual, todavía no cerrado como modelo de negocio, cambiar ahí nomás.
- `subscription-status.js` — estado actual; si sigue `pending` con un `preapproval` ya creado, re-consulta Mercado Pago en vivo antes de responder (cubre el margen mientras el webhook no llegó todavía).
- `webhook-mercadopago.js` — Mercado Pago llama acá en cada evento. Valida la firma `x-signature` (HMAC-SHA256, ver el código para el detalle exacto del manifest) antes de procesar nada. Guarda cada notificación cruda en `subscription_events` para poder auditar pagos después.

**Paso manual obligatorio después del primer deploy (y de agregar cualquier función nueva):** en proyectos de Google Cloud creados recientemente, una función nueva **no queda invocable públicamente por default** — el deploy la crea pero nadie (ni el propio frontend) tiene permiso para llamarla. Sin esto, cualquier pedido a `/api/**` devuelve un `403 Forbidden` genérico de Google ("Your client does not have permission...") sin que la función llegue siquiera a ejecutarse — no aparece nada en sus logs, porque nunca corrió. Se arregla en [console.cloud.google.com/run](https://console.cloud.google.com/run) → entrar a cada servicio (`authsession`, `checkoutcreate`, `subscriptionstatus`, `webhookmercadopago`) → pestaña **Permissions** → **Add Principal** → principal `allUsers`, rol **Cloud Run Invoker** → Save. Se hace una vez por función; no hace falta repetirlo en cada deploy salvo que se agregue una función nueva.

### `billing.js` (frontend)
`isPaidUser()`, `establishSession()`, `refreshSubscriptionStatus()`, `startCheckout(planType)`. `establishSession()` se llama con el mismo `access_token` de Drive apenas se conecta (en `app.html`, dentro del callback de `initTokenClient` y en la rama de sesión restaurada de `initGoogleAuth()`) — no hay un segundo login. El botón "✨" del header de Home abre `#modal-subscribe`.

### Variables de entorno (Firebase Functions Secret Manager — `firebase functions:secrets:set NOMBRE`)
`GOOGLE_CLIENT_ID`, `SESSION_JWT_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET` — más `APP_BASE_URL` como parámetro no-secreto (`defineString`).

### Supabase: proyecto compartido `pluxow-clients`, schema `travel_diary`
Travel Diary **no tiene su propio proyecto Supabase** — usa `pluxow-clients`, el mismo proyecto compartido entre todos los clientes de la agencia (Pluxow), siguiendo la convención de esa arquitectura: un schema aislado por cliente en vez de un proyecto nuevo por cada uno. El schema de esta app es **`travel_diary`** (nunca `public` — ahí viven los schemas de otros clientes como `kinesicpro`, sin relación con este producto).

- `functions/lib/supabase.js` fija `db: { schema: 'travel_diary' }` al crear el cliente — con eso alcanza, ninguna query (`.from('subscriptions')`, etc.) necesita mencionar el schema explícitamente.
- **`functions/schema.sql` es la fuente de verdad del schema** — no un SQL de una sola vez. Tablas: `subscriptions` (una fila por `google_sub`: `plan`, `status`, `mp_preapproval_id`, etc.) y `subscription_events` (log crudo de webhooks, para auditoría). **Cuando se agregue una tabla/columna/índice nuevo, se agrega ahí (con `if not exists`) y se commitea junto con el código que lo usa** — no alcanza con correrlo a mano en el SQL Editor de Supabase, el repo tiene que reflejar siempre el estado real de la base.
- **Pasos manuales obligatorios, fuera del SQL** (Dashboard → Settings → Data API): (1) agregar `travel_diary` en **"Exposed schemas"**; (2) activar `travel_diary.subscriptions` y `travel_diary.subscription_events` en **"Exposed tables"** — el schema expuesto no alcanza solo, cada tabla se activa aparte. Sin esto, toda query desde `functions/lib/supabase.js` falla en silencio del lado del servidor aunque el schema y las tablas existan bien. Costó detectar esto la primera vez (el síntoma fue: Drive se conectaba bien pero `establishSession()` nunca creaba la sesión de suscripción).
- **Un cuarto permiso, este sí en SQL** (ya incluido en `functions/schema.sql`, sección final): un schema creado a mano no le hereda `GRANT` a ningún rol como sí le pasa a `public` — exponerlo en Data API solo lo rutea, pero Postgres igual devuelve `permission denied for schema travel_diary` hasta correr `grant usage on schema travel_diary to service_role` (+ tablas/secuencias). Los cuatro pasos manuales (Exposed schemas, Exposed tables, estos GRANTs, y el invoker de Cloud Run de más abajo) hay que repetirlos completos si en algún momento se recrea el proyecto de Supabase o de Firebase desde cero.
- RLS activado en ambas tablas sin policies — solo la `service_role_key` (usada por las Cloud Functions) puede leer/escribir, nunca el cliente.
- Travel Diary no usa las tablas base de esa convención (`conversaciones`/`mensajes`, pensadas para bots de WhatsApp) — no aplican acá.

---

## Features implementadas

### Home (`#view-home`)
- Grilla de álbumes propios + álbumes compartidos
- Crear álbum, compartir álbum con otro usuario por email — con selector **Puede ver / Puede editar** (rol `reader`/`writer` de Drive; por defecto solo lectura)
- Botón ▶ slideshow automático por álbum (fotos 3-7s random, videos completos)
- Carga masiva ⬆ con detección EXIF de fecha, subida con concurrencia limitada (5 en simultáneo) y botón "Reintentar los que faltan" si algo falla
- Botón ? ayuda

### Diario (`#view-diary`)
- **Tab Día:** editor con título, notas, upload fotos/videos/audios, grabación de audio in-app
- **Tab Lista:** todos los días del álbum con thumbnail
- **Tab Mes:** calendario mensual con foto de portada de cada día
- **Tab Libro:** vista de fotobook con layouts variados (1/2/3/4 fotos por página, max 4), swipe horizontal
- Drag & drop para reordenar media (desktop + touch)
- Lightbox al tocar foto (swipe entre fotos, botón compartir)
- Modo selección múltiple (menú ···): seleccionar fotos → compartir o eliminar en bloque
- Botón compartir individual por foto/video (Web Share API)
- Carga masiva dentro del álbum

### Drive helpers (`drive.js`)
- `setAuthImg(imgEl, fileId, size)` — carga imágenes con fallback autenticado (resuelve el problema de PWA en iOS donde las thumbnail URLs de Drive no funcionan sin sesión)
- `fetchFileAsDataUrl(fileId)` — descarga y devuelve un **blob URL** (`URL.createObjectURL`, no base64). Quien lo use debe revocarlo con `URL.revokeObjectURL()` cuando el video/audio deja de estar en pantalla — ver los puntos de revocación en `app.html` (loadDay, showSsItem/closeSlideshow, deleteSelected, shareMediaItem/shareSelected)
- `groupFilesByDate(files)` — agrupa archivos por fecha EXIF
- `driveReq()` — reintenta con backoff exponencial ante 429/5xx (hasta 3 veces, respeta `Retry-After`)
- **Caché de días** (`_dayCache` en `drive.js`): `loadDayFromDrive()` cachea folderId + contenido de `day.json` por `albumFolderId+fecha` (clave compuesta — dos álbumes pueden tener un día con el mismo nombre). Devuelve siempre un clon para que el editor pueda mutar `currentDay.media` sin corromper la caché. Se invalida en `saveDayToDrive()` y con `invalidateDayCache(albumFolderId, dateStr)` en los flujos de carga masiva. Lista/Mes/Libro comparten esta caché — cambiar de tab no vuelve a pedir lo mismo dos veces.

---

## Estado actual y pendientes

### Funcionando bien
- PWA instalable en iOS y Android, con íconos propios (192/512/maskable + apple-touch-icon)
- Imágenes cargan correctamente en PWA (via API autenticada con fallback)
- Navegación interna sin abrir Safari
- OAuth con re-auth automático si cambia el scope
- **Modo selección múltiple**: checkbox con 2 estados (círculo vacío / tilde + marco dorado) funcionando correctamente. El bug era que `.selection-check` tenía `background`/`border` inline que pisaban la regla CSS `.media-card.selected .selection-check`, dejando el tilde blanco sobre blanco (invisible). Corregido quitando el inline y agregando el checkbox faltante en las cards de audio (v1.7).
- **Menú ···**: hubo problemas con el overlay interceptando clicks. Solución actual: `document.addEventListener('click')` para cerrar en lugar de overlay. Todos los items del menú (Seleccionar, Carga masiva, Ver álbum, Ayuda) funcionan.
- **Sanitización de HTML de usuario**: nombre de archivo, caption, título y notas pasan por `escHtml()` antes de insertarse en el DOM (v1.9) — antes se insertaban sin escapar en 7 puntos (cards de media, fotolibro, vista "Ver álbum"), lo que permitía HTML/script guardado ejecutándose para cualquiera que abriera el álbum.
- **Eliminar borra de verdad**: sacar una foto/video/audio de un día y guardar ahora manda el archivo a la papelera de Drive (`trashed:true`, recuperable 30 días) en vez de dejarlo huérfano en la carpeta (v1.9). Ver `currentDayOriginalIds` en `app.html` y el parámetro `previousIds` de `saveDayToDrive()`.
- **Caché de días + fotolibro en paralelo**: Lista, Mes y Libro comparten la caché de `day.json` (ver arriba); el fotolibro pasó de cargar los días secuencial a `Promise.all`. El layout de cada página del fotolibro ya no es `Math.random()` — sale de un hash estable de fecha+página, así que no cambia solo entre visitas (v1.9).
- **Carga masiva concurrente**: sube hasta 5 archivos a la vez (antes uno por uno) y, si algo falla, guarda igual lo que sí se subió y ofrece "Reintentar los que faltan" (v1.9). Compartido por `confirmBulkUpload` (Home) y `confirmBulkDiary` (dentro de un álbum) vía el helper `runBulkUpload()`.
- **Video/audio sin overhead de base64**: `fetchFileAsDataUrl()` devuelve blob URL en vez de base64 (v1.9) — con la revocación correspondiente para no acumular memoria en sesiones largas.
- **Shell offline**: `sw.js` (service worker) precachea app.html/style.css/drive.js/exif.js/debug.js/manifest.json/íconos con stale-while-revalidate — la segunda visita en adelante carga al toque y sin conexión la PWA abre igual en vez de romperse (v1.10). Deliberadamente NO cache-first: no depende de acordarse de bumpear una versión en cada deploy.
- **UI de solo lectura en álbumes compartidos**: al entrar a un álbum compartido, `bootstrapDiaryPage()` consulta `canEditFolder()` (drive.js, usa `capabilities.canEdit` de Drive) y guarda el resultado en `albumCanEdit`. Si es `false`, se ocultan/deshabilitan todos los controles de edición: drop-zone y grabador de audio, título/notas quedan `readonly`, no aparecen los botones eliminar/portada por foto ni el drag-handle para reordenar, "Carga masiva" desaparece del menú ···, y el botón Eliminar del modo selección se oculta. El banner de "Álbum compartido" suma "· Solo podés ver" (v1.11).
- **Manejo de errores de Drive** (v1.17, ver `ERROR_HANDLING_PLAN.md` para el diseño completo): (1) cuota de Drive excedida al subir → `uploadFile()` chequea `res.ok` y lanza `DriveQuotaExceededError` en vez de dejar el archivo perdido en silencio; `saveCurrentDay()` y `runBulkUpload()` muestran el mensaje específico. (2) Archivo de media borrado a mano desde Drive → `fetchAuthImgUrl`/`fetchFileAsDataUrl` chequean `res.ok`; `setAuthImg()` muestra un placeholder ("No disponible", clase CSS `.media-unavailable`) en vez del ícono roto del navegador — como todas las vistas de imagen usan `setAuthImg()`, el fix es central. (3) `day.json` borrado con la carpeta del día todavía con archivos → `loadDayFromDrive()` reconstruye un día en memoria listando los archivos presentes (`listFilesInFolder()`), marcado con `_reconstructed: true`; no se persiste solo, y `loadDay()` en `app.html` muestra un aviso ("Día reconstruido... no se encontró título ni notas"). Título/notas no son recuperables si se borró el JSON — limitación real, comunicada, no un bug.
- **Slideshow por lotes** (v1.18): `startSlideshow()` pedía el `day.json` de cada día del álbum uno por uno (`for...await` secuencial) antes de mostrar la primera foto — con álbumes grandes eso significaba varios segundos de "Cargando..." Ahora pide los días de a `SLIDESHOW_BATCH_SIZE` (10) con `Promise.all`, arranca el show apenas el primer lote trae contenido, y sigue pidiendo el resto de fondo mientras el usuario ya está mirando. Si el show alcanza a lo cargado antes de que llegue el siguiente lote, `showSsItem()` muestra el loader (`#slideshow-loader`, animación de ondas concéntricas) en vez de cerrar de golpe — se retoma solo cuando llega más contenido (`ssLoadingMore` en `app.html`).

### Pendientes conocidos
- **Corte a Firebase Hosting (EN CURSO, no completado)**: el código de `billing.js`/`functions/`/`firebase.json` y los cambios de `manifest.json`/`drive.js` para la suscripción están escritos, pero **no se pusheó a `main` todavía** — ver "Convenciones importantes" antes de tocar esto. Faltan, todos manuales, del lado del usuario: activar el plan Blaze en Firebase, correr el SQL de Supabase, cargar los secrets (`firebase functions:secrets:set`), configurar el webhook en Mercado Pago Developers, agregar la URL de Firebase a "Authorized JavaScript origins" en Google Cloud Console, y recién después `firebase deploy`. Mientras tanto la app sigue funcionando normal en GitHub Pages, sin nada de esto activo.
- **Qué funciones quedan detrás del pago**: sin decidir todavía (ver "Suscripciones").
- **Medición/analytics de producto**: hay un plan completo pero **sin ejecutar** en `ANALYTICS_PLAN.md` (tabla `usage_events`, función `track-event.js`, puntos de instrumentación en el frontend) — logins por período, fotos por álbum, uso de títulos/notas, álbumes compartidos, tracking de errores. Deliberadamente no implementado todavía: con 1-2 usuarios de prueba cualquier dato ahí sería ruido. Retomar cuando haya una decena de usuarios reales o una pregunta de negocio concreta.
- **Compartir múltiples fotos**: implementado con Web Share API. En iOS funciona bien; en desktop hace descarga individual como fallback.
- **Streaming real de video**: hoy el video se descarga entero (como blob URL) antes de reproducirse — no hay range requests. La solución de fondo (un service worker que intercepte el pedido a Drive, inyecte el header `Authorization` vía postMessage desde la página, y reenvíe Range/206) quedó deliberadamente afuera de la Fase 6 del plan de auditoría por su complejidad y riesgo (reescribe el pipeline de video) sin poder probarla en un dispositivo real. Retomar cuando se pueda testear en mobile.

### Deuda técnica
- `app.html` tiene ~2400 líneas — considerar dividir en módulos JS separados cuando crezca más
- `compressImage()` y `compressImageFile()` (`app.html`) son funciones idénticas duplicadas — unificar cuando se toque esa zona de nuevo

---

## Convenciones importantes

1. **No usar `location.href` para navegación interna** — rompe la PWA en iOS. Usar `navigateTo()` siempre.
2. **No usar `localStorage` para datos** — solo para el token OAuth (`drive_token`) y preferencias menores. Todo el contenido va a Drive.
3. **Imágenes siempre con `setAuthImg()`** — nunca hardcodear URLs de `drive.google.com/thumbnail` directamente, no funcionan en PWA.
4. **Versión en dos lugares** — al cambiar features, actualizar la versión en el header de `#view-home` y en el modal de ayuda `#modal-help`.
5. **Push directo a main** — el usuario prefiere mergear directo sin PRs, **salvo para cambios que dependan de infraestructura externa todavía no configurada** (como el corte a Firebase: `SCOPE_VERSION` fuerza re-consentimiento de OAuth a toda la familia ya mismo, y `manifest.json` con `start_url: /app.html` rompe instalaciones nuevas de la PWA en GitHub Pages hasta que Firebase esté realmente sirviendo desde la raíz). Para esos casos: commitear en la rama de trabajo, avisar explícitamente qué falta configurar del lado de las cuentas externas, y esperar confirmación antes de mergear a `main`.

---

## Cómo hacer deploy

**Frontend + fixes normales (GitHub Pages, hoy en producción):**
```bash
git add .
git commit -m "feat/fix: descripción"
git push origin main
```
GitHub Pages despliega automáticamente en ~1 minuto. Verificar en:
`https://leandro-couretot.github.io/travel-diary/app.html`

**Backend de suscripciones (Firebase, todavía no cortado a producción):**
```bash
cd functions && npm install   # una vez, o cuando cambien las dependencias
firebase deploy               # Hosting + Functions juntos
```
Requiere `firebase login` y el plan Blaze activado en el proyecto. Ver "Suscripciones" para las variables de entorno que hacen falta cargar antes del primer deploy.
