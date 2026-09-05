# 旅 Travel Diary — CLAUDE.md

Contexto para Claude Code. Leer antes de tocar cualquier archivo.

---

## Qué es

App web de diario de viaje personal. El usuario registra cada día con fotos, videos, audios y notas. Todo se almacena en Google Drive del usuario. PWA instalable.

**Ya migrada de "app familiar" a producto con suscripción** (freemium + pago mensual/anual vía Mercado Pago) — ver la sección "Suscripciones" más abajo. **El corte a Firebase ya se hizo**: Firebase Hosting es la producción real (Blaze activado, SQL de Supabase corrido, secrets cargados, webhook de Mercado Pago configurado). GitHub Pages sigue existiendo y sigue actualizándose sola en cada push a `main` (GitHub Pages sirve directo desde el repo, no hay forma de "apagarla" sin borrar el sitio), pero **es una URL vieja que ya nadie usa como app real** — no confundirla con producción.

**Deploy no es automático como en GitHub Pages**: pushear a `main` no alcanza para que los cambios lleguen a Firebase. Hay que correr `firebase deploy` a mano desde una máquina con `firebase login` ya hecho (ver "Cómo hacer deploy" más abajo) — típicamente parado en la rama de trabajo donde se hizo el fix, sin esperar a que esa rama se mergee a `main` primero.

**URL de producción (Firebase):** `https://family-fotos-491610.web.app/app.html`
**URL vieja, sin uso real (GitHub Pages):** `https://leandro-couretot.github.io/travel-diary/app.html`
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
├── firebase.json     ← Config de Firebase Hosting (rewrites /api/** → Cloud Functions, header no-cache para sw.js) + de dónde salen las functions
├── .firebaserc       ← Proyecto de Firebase/GCP de este repo (family-fotos-491610)
├── functions/        ← Backend de suscripciones (Node.js, Cloud Functions) — ver "Suscripciones"
│   └── schema.sql    ← Fuente de verdad del schema `travel_diary` en Supabase (pluxow-clients)
├── .github/workflows/deploy.yml ← Deploy manual (workflow_dispatch) vía GitHub Actions — ver "Deploy automático vía GitHub Actions"
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
    │   ├── book.json             ← páginas + drawer del fotolibro (ver "Diario" → Tab Libro), opcional
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
`GOOGLE_CLIENT_ID`, `SESSION_JWT_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET` — más `APP_BASE_URL` como parámetro no-secreto (`defineString`). Su valor (`https://family-fotos-491610.web.app`) vive commiteado en `functions/.env.family-fotos-491610` — a diferencia de los secrets de arriba, `firebase deploy --non-interactive` (usado por el workflow de GitHub Actions) necesita este archivo presente en el repo para resolver el parámetro sin preguntar interactivamente; en la Mac del usuario ya existía localmente (por eso los deploys manuales nunca fallaron por esto), pero nunca se había commiteado.

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
- **Tab Libro:** vista de fotobook con layouts variados (1/2/3/4 fotos por página, max 4), swipe horizontal. Páginas explícitas + un "drawer" de fotos sin ubicar, con arrastre entre páginas/drawer — ver "Fotolibro: páginas explícitas + drawer" (v1.26) y las entregas previas "Orden manual del fotolibro" (v1.23) y "Modo reordenar del fotolibro" (v1.24)
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
- **Shell offline**: `sw.js` (service worker) precachea app.html/style.css/drive.js/exif.js/debug.js/manifest.json/íconos con stale-while-revalidate — la segunda visita en adelante carga al toque y sin conexión la PWA abre igual en vez de romperse (v1.10). Deliberadamente NO cache-first: no depende de acordarse de bumpear una versión en cada deploy. **Refinado en v1.25**: `stale-while-revalidate` puro implicaba que, después de cada deploy, un usuario con la PWA instalada veía la versión vieja en la primera apertura y recién la nueva en la segunda (la que "sirve lo cacheado ya" nunca prioriza lo recién bajado en esa misma visita) — confirmado en la práctica al probar v1.24. Ahora el pedido del documento principal (`app.html`, identificado por `request.mode === 'navigate'`) usa **red primero, caché como respaldo** (`networkFirst()`), así que con conexión siempre se ve el último deploy ya en la primera apertura; el resto del shell (CSS/JS/íconos) sigue con `stale-while-revalidate` sin cambios. Sin conexión, todo sigue cayendo al caché (o al aviso de "sin conexión" si no hay nada guardado todavía) exactamente igual que antes.
- **UI de solo lectura en álbumes compartidos**: al entrar a un álbum compartido, `bootstrapDiaryPage()` consulta `canEditFolder()` (drive.js, usa `capabilities.canEdit` de Drive) y guarda el resultado en `albumCanEdit`. Si es `false`, se ocultan/deshabilitan todos los controles de edición: drop-zone y grabador de audio, título/notas quedan `readonly`, no aparecen los botones eliminar/portada por foto ni el drag-handle para reordenar, "Carga masiva" desaparece del menú ···, y el botón Eliminar del modo selección se oculta. El banner de "Álbum compartido" suma "· Solo podés ver" (v1.11).
- **Manejo de errores de Drive** (v1.17, ver `ERROR_HANDLING_PLAN.md` para el diseño completo): (1) cuota de Drive excedida al subir → `uploadFile()` chequea `res.ok` y lanza `DriveQuotaExceededError` en vez de dejar el archivo perdido en silencio; `saveCurrentDay()` y `runBulkUpload()` muestran el mensaje específico. (2) Archivo de media borrado a mano desde Drive → `fetchAuthImgUrl`/`fetchFileAsDataUrl` chequean `res.ok`; `setAuthImg()` muestra un placeholder ("No disponible", clase CSS `.media-unavailable`) en vez del ícono roto del navegador — como todas las vistas de imagen usan `setAuthImg()`, el fix es central. (3) `day.json` borrado con la carpeta del día todavía con archivos → `loadDayFromDrive()` reconstruye un día en memoria listando los archivos presentes (`listFilesInFolder()`), marcado con `_reconstructed: true`; no se persiste solo, y `loadDay()` en `app.html` muestra un aviso ("Día reconstruido... no se encontró título ni notas"). Título/notas no son recuperables si se borró el JSON — limitación real, comunicada, no un bug.
- **Slideshow por lotes** (v1.18): `startSlideshow()` pedía el `day.json` de cada día del álbum uno por uno (`for...await` secuencial) antes de mostrar la primera foto — con álbumes grandes eso significaba varios segundos de "Cargando..." Ahora pide los días de a `SLIDESHOW_BATCH_SIZE` (10) con `Promise.all`, arranca el show apenas el primer lote trae contenido, y sigue pidiendo el resto de fondo mientras el usuario ya está mirando. Si el show alcanza a lo cargado antes de que llegue el siguiente lote, `showSsItem()` muestra el loader (`#slideshow-loader`, animación de ondas concéntricas) en vez de cerrar de golpe — se retoma solo cuando llega más contenido (`ssLoadingMore` en `app.html`).
- **Botón de Drive pegado en "Conectar Drive" estando conectado** (v1.19): `navigateTo('home')` llama a `renderHomeHeader()` cada vez que se vuelve a Home, que resetea el botón al texto default por HTML fijo — pero nunca llamaba a `updateDriveBtn()` después para corregirlo al estado real. Los álbumes cargaban bien igual (dependen de `driveToken`/`rootFolderId`, no del texto del botón) — era puramente cosmético. Arreglado agregando el llamado a `updateDriveBtn()` justo después.
- **Refresh silencioso del token de Drive** (v1.20): el `access_token` de Google vence a la hora siempre, y `initTokenClient` (el flujo que usa esta app) nunca da `refresh_token` — así que hasta ahora, pasada esa hora, la próxima llamada a Drive tiraba 401 y mandaba al usuario a reconectar a mano. Ahora se guarda `drive_token_expires_at` en `localStorage` cuando llega un token nuevo, y ~5 minutos antes de que venza se pide uno nuevo **en silencio** (`requestAccessToken({ prompt: '' })`, sin popup) vía `scheduleSilentRefresh()`/`trySilentRefresh()` — tanto por un timer como al volver a la pestaña/PWA (`visibilitychange`, porque los timers se retrasan con la app en segundo plano). **No es 100% confiable**: Google recomienda llamar `requestAccessToken()` desde un evento iniciado por el usuario, y esto se dispara desde un timer — funciona mejor en Chrome/Android que en Safari/iOS (más restrictivo con este tipo de flujo). Si falla, no rompe nada: el usuario simplemente ve el flujo de reconexión normal, igual que antes de este cambio.
- **Guardado parcial resiliente a interrupciones** (v1.21): si el navegador corta una subida a mitad de camino (la app se minimiza en el celular durante una carga, algo que iOS/Safari puede hacer bastante rápido — no hay API web confiable para evitarlo, ni `fetch keepalive` -tope de 64KB, inservible para fotos- ni Background Sync -no soportada en Safari-), `saveDayToDrive()` ya no aborta todo el guardado: seguía con el resto de los archivos, persiste en `day.json` únicamente lo que sí llegó a subir (nunca un `driveFileId: null` fantasma que no se puede volver a renderizar), y tira un error marcado (`err.driveSaveFailedCount`) que `saveCurrentDay()` en `app.html` muestra como "se guardó lo que se pudo, tocá Guardar para reintentar" en vez de un error genérico — mismo criterio que ya tenía `runBulkUpload()`. Los items fallidos quedan intactos en memoria (con su `data`/`_file`) listos para reintentar con un segundo toque de "Guardar", sin volver a subir lo que ya está bien. Además, las dos modales de carga masiva muestran un aviso ("No minimices la app...") mientras dura la subida.
- **Aviso de posibles duplicados en carga masiva** (v1.22): antes de subir, la carga masiva (tanto desde Home como desde dentro de un álbum) compara por **nombre de archivo** contra lo que ya figura en el `day.json` de cada fecha destino (`getExistingNamesForDate()` en `drive.js`, que reutiliza `loadDayFromDrive()` y por lo tanto su caché) — no por contenido/tamaño, para no requerir cambios de schema ni descargar los archivos ya subidos. Los que coinciden se marcan (`markBulkDuplicates()`) y aparecen destildados por default dentro de un aviso ⚠ en su fecha (`renderBulkDatedList()`, compartido entre ambos flujos de carga masiva) — el usuario puede re-tildarlos igual si de verdad quiere subirlos de nuevo (decisión explícita del usuario: marcar pero dejar elegir, no auto-descartar). `confirmBulkUpload()`/`confirmBulkDiary()` excluyen los que quedaron destildados al armar los grupos a subir; si una fecha se queda sin ningún archivo tras el filtro, se salta esa fecha entera, y si no queda ningún archivo en toda la carga se avisa en vez de llamar a `runBulkUpload()` con un grupo vacío. En la carga desde Home, cambiar el álbum de destino en el selector vuelve a chequear duplicados contra el álbum nuevo (`refreshBulkDuplicates()`, listener en el `change` de `#bulk-album-select`), ya que cada álbum tiene contenido distinto en Drive.
- **Orden manual del fotolibro, independiente de la fecha** (v1.23): el usuario reportó que en el Libro podían quedar fotos de temas distintos (ej. una foto familiar junto a una del bebé) agrupadas en la misma página solo porque así estaban ordenadas dentro del día — y que pedirle reordenar desde la pestaña Día para arreglar eso era poco intuitivo. Se separó el orden del fotolibro del modelo por fecha del diario: `book.json` (nuevo archivo en la raíz de la carpeta del álbum, `loadBookOrder()`/`saveBookOrder()` en `drive.js`) guarda solo un array de `driveFileId` con el orden elegido por el usuario — el diario (`day.json` por fecha) no cambia en nada. `renderBook()` arma la lista real de fotos del álbum recorriendo los días como siempre, pero el ORDEN sale de `book.json`; si no existe todavía, arranca en orden cronológico sin persistir nada (recién se guarda la primera vez que el usuario reordena). Cada vez que se abre el Libro se reconcilia solo: fotos nuevas subidas después se agregan al final, fotos borradas se sacan — evita que quede "colgado" de una referencia vieja. El reorder es arrastrando directamente en la vista Libro (`initBookDragReorder`/`initBookTouchReorder`, mismo mecanismo de `dragstart`/`dragover`/`drop` + clon touch con `.drag-handle` que ya usa la pestaña Día para reordenar media, pero operando sobre `bookOrder` en vez de `currentDay.media`) — se puede arrastrar una foto de una página a cualquier otra sin importar la fecha de cada una, y el nuevo orden se guarda solo en segundo plano en cada drop (`moveBookPhoto()`). Como las páginas ya pueden mezclar fechas distintas, se sacó el encabezado grande de fecha+título por página y se puso una etiqueta chica de fecha (+ caption si la foto tiene) en la esquina de cada foto individual (`.bp-chip`) — decisión explícita del usuario sobre las alternativas evaluadas. En álbumes compartidos de solo lectura no se ofrece el asa de arrastre ni se intenta escribir `book.json` ni siquiera al reconciliar (fallaría por permisos). Fuera de esta entrega, evaluado pero pospuesto a pedido del usuario: ajustar el zoom/encuadre de una foto dentro de su recuadro, y forzar el layout de una página puntual.
- **Modo reordenar del fotolibro (mover fotos entre páginas)** (v1.24): el usuario probó v1.23 en producción y reportó que arrastrar dentro de una misma página funcionaba, pero no podía cambiar una foto de página — causa real: cada página del Libro ocupa el 100% del ancho de pantalla (carrusel con swipe), así que nunca hay dos páginas visibles al mismo tiempo para soltar algo en la otra. Se agregó un botón "Reordenar" en `.book-controls` (`toggleBookReorderMode()`, solo visible si `albumCanEdit`) que cambia la vista del Libro a una grilla de páginas en miniatura (`renderBookReorderGrid()`/`buildBookReorderTile()`, tarjetas de ancho fijo ~150px en una tira con scroll horizontal — entran 2 en celular, más en pantallas anchas, sin codear breakpoints a mano) donde varias páginas sí están visibles a la vez. Para el caso de querer mover una foto a una página que ni siquiera es una de las visibles en la tira, se sumó `checkBookEdgeScroll()`/`clearBookEdgeScroll()`: sostener el arrastre cerca de un borde (~60px) medio segundo hace avanzar la tira sola a la siguiente tanda de páginas — mismo gesto que mover un ícono entre pantallas de inicio en iOS (un solo avance por acercamiento, hay que alejarse y volver a acercarse para seguir avanzando más de una tanda — se evaluó un intervalo continuo y se descartó por complejidad). La misma detección de borde se sumó también a la vista inmersiva original.
- **Fotolibro: páginas explícitas + drawer** (v1.26): el usuario pidió 3 cosas de una vez sobre el fotolibro — (1) que las miniaturas del modo reordenar se vean como páginas reales (layouts variados), no un cuadrado uniforme; (2) que mover una foto no corra a todas las demás cuando pisa otra; (3) poder aislar fotos puntuales en su propia página (ej. 2 fotos de un familiar que no quiere mezcladas con las del bebé) y más adelante forzar el layout de una página. Los 3 pedidos compartían la misma causa raíz: una "página" no existía como cosa en sí, solo salía de cortar un array plano (`bookOrder`, v1.23/v1.24) cada 4 elementos — por eso insertar una foto corría todo lo que venía después, y no había forma de que una página quedara fija con fotos puntuales.
  - **Modelo nuevo de `book.json` (v2)**: `{ version: 2, pages: [{ images: [driveFileId,...], layout: string|null }], drawer: [driveFileId,...] }`. Cada página es ahora una cosa explícita con su propia lista de fotos (1 a 4) y un layout opcional forzado (`null` = automático, como siempre, vía `pickLayout()`; validado contra la cantidad de fotos con `isValidBookLayout()` — si la cantidad cambia y el layout guardado ya no aplica, vuelve a `null` solo). El `drawer` son fotos del álbum que no están en ninguna página — no entran al fotolibro impreso, pero tampoco se pierden (el usuario decide después, capaz ni las quiere en el libro).
  - **Migración automática desde v1** (`loadBookLayout()` en `drive.js`): si `book.json` todavía tiene el array plano viejo (`order`), se agrupa de a 4 en el mismo orden que ya se veía (mismo resultado visual, drawer vacío) y se persiste ya en v2 la primera vez que se abre el Libro después de este deploy — sin que el usuario tenga que hacer nada, y sin riesgo si por algún motivo una versión vieja de la app llegara a leer un `book.json` ya migrado (no reconoce `pages`, no encuentra `order`, arranca de cero en cronológico — no rompe ni borra nada).
  - **Reconciliación** (en `renderBook()`): fotos nuevas del álbum que no están ni en ninguna página ni en el drawer → van al drawer (nunca se auto-asignan a una página). Fotos borradas del álbum → se sacan de donde estén (página o drawer); si una página se queda sin fotos, desaparece.
  - **Mecánica de arrastre** (`moveBookPhoto(srcId, target)`, donde `target` viene de `resolveBookDropTarget()` interpretando sobre qué se soltó): soltar sobre otra foto puntual **siempre** manda la pisada al drawer y la arrastrada toma su lugar exacto — misma regla sin importar si ambas estaban en la misma página, en páginas distintas, o si alguna venía del drawer (decisión explícita del usuario: sin casos especiales, más predecible). Si la página de origen queda sin fotos, desaparece. Soltar sobre el fondo de una página con lugar (menos de 4 fotos) simplemente la agrega ahí, sin desplazar a nadie; soltar sobre el drawer la saca del libro sin reemplazo. `initBookDragReorder`/`initBookTouchReorder` pasaron de wirear un listener por celda a delegación de eventos en la raíz (necesario para poder resolver drops sobre el fondo de una página o del drawer, no solo sobre otra foto puntual).
  - **UI del drawer**: nueva franja debajo de la grilla de reordenar (`#book-drawer-container`, dentro de `#book-reorder-area` que ahora envuelve grilla + drawer) con las fotos sin ubicar en miniatura — solo visible en modo Reordenar, no en la vista inmersiva (las fotos del drawer no forman parte del libro final, no tiene sentido mostrarlas ahí).
  - Pendiente de esta misma entrega (ver "Pendientes conocidos"): miniaturas con forma real de libro (sigue siendo el cuadrado uniforme de v1.24 por ahora), botón "+" para crear una página nueva arrastrando una foto ahí, selector de layout forzado por página, botón "Recrear libro" (vaciar todo al drawer para armar de cero), y la adaptación específica a celular — el usuario pidió resolver primero en PC.
- **`sw.js` quedaba pegado en versiones viejas de sí mismo** (fix de infraestructura, sin bump de versión de la app): el usuario reportó que, después de deployar v1.26, la app seguía mostrando v1.24 incluso recargando varias veces — con el `git log` confirmando que sí se había deployado el código correcto. Causa: Firebase Hosting sirve todos los archivos estáticos (`sw.js` incluido) con un `Cache-Control` que permite al navegador guardarlo en caché HTTP normal por un rato; si el navegador nunca vuelve a pedirle `sw.js` al servidor, ni se entera de que existe una versión nueva del Service Worker — sin importar qué tan bien esté escrita la lógica de actualización *adentro* de `sw.js` (el fix de v1.25 de "red primero" para `app.html`, por ejemplo, nunca llega a activarse si el propio `sw.js` viejo sigue siendo el que corre). Se agregó en `firebase.json` una regla de `headers` forzando `Cache-Control: no-cache` específicamente para `/sw.js` — así el navegador siempre revalida contra el servidor antes de usar cualquier copia guardada. Es un problema conocido y frecuente en PWAs en general (no específico de esta app) — la config quedó agregada de una vez para no volver a pisarla en el futuro. Nota: este fix evita que el problema se repita en próximos deploys, pero no "destraba" retroactivamente un navegador que ya tenía `sw.js` viejo guardado en caché desde antes de este deploy — para ese caso puntual puede hacer falta un hard refresh o desregistrar el Service Worker a mano una única vez.
- **Deploy automático vía GitHub Actions, probado y funcionando**: el usuario se encontró varias veces sin poder deployar desde el celular (Cloud Shell + login interactivo de Firebase es muy frágil en mobile — la sesión se corta al cambiar de app para copiar el link/código). Se evaluó n8n como alternativa y se descartó — no aporta nada que GitHub Actions no tenga ya integrado (clonado del repo, Node.js listo), y sumaría un servidor propio para mantener. Se armó `.github/workflows/deploy.yml` (dispara a mano con `workflow_dispatch` — botón "Run workflow" en la pestaña Actions, accesible desde la app/web de GitHub en el celular — corre `npm install` en `functions/` y `firebase deploy --non-interactive`, autenticado vía el secret `FIREBASE_TOKEN` generado con `firebase login:ci`) — deployar pasa a ser un botón en GitHub, sin terminal ni login interactivo desde el dispositivo que dispara el deploy. El primer intento (`run #1`) falló con `In non-interactive mode but have no value for the following environment variables: APP_BASE_URL` — ese parámetro no-secreto (`defineString`, ver "Variables de entorno") vivía resuelto en `functions/.env.family-fotos-491610` solo en la Mac del usuario, nunca commiteado, así que un checkout fresco (como el que usa GitHub Actions) no lo tenía. Se commiteó ese archivo (es seguro, el valor no es secreto) y el segundo intento (`run #2`) deployó bien. Nota para el futuro: la CLI avisa que autenticar con `FIREBASE_TOKEN` está deprecado a favor de una cuenta de servicio con `GOOGLE_APPLICATION_CREDENTIALS` — sigue funcionando hoy, pero si en algún momento `firebase-tools` lo saca del todo, hay que migrar el workflow a ese método.
- **Sin el ícono de "imagen rota" mientras cargan las miniaturas de Drive** (v1.27): el usuario reportó (screenshot de la grilla de Home) que un signo de pregunta aparecía brevemente (menos de 1 segundo) sobre las tapas de álbum al entrar. Causa: los `<img>` de tapas de álbum (y de ~12 puntos más en `app.html` — Lista, Mes, Libro, lightbox, previews) se insertan al DOM sin `src` todavía, y `setAuthImg()` (drive.js) recién le asigna el `src` real (la miniatura de Drive) un instante después — en ese hueco, el navegador pinta su propio ícono nativo de "imagen sin cargar", que el `background` ya declarado en `.album-cover` no puede tapar porque ese `background` está en el propio `<img>` (el ícono nativo se pinta encima/en lugar del contenido del elemento, no debajo). Arreglado centralizado en `setAuthImg()` en vez de tocar cada punto de llamada: agrega la clase `auth-img-loading` (`opacity:0`) apenas empieza a resolver el `src` y la saca en el evento `load` del propio `<img>` — funciona sin importar cuál de las 3 ramas termine resolviendo (la miniatura de Drive directo, el fallback autenticado de `fetchAuthImgUrl()`, o el SVG de "no disponible"), porque `onload` se mantiene activo entre reasignaciones de `src` hasta que efectivamente dispara. Sumada una transición CSS genérica (`img { transition: opacity 0.25s ease; }`) para que la foto aparezca con un fade suave en vez de un pop abrupto, en lugar del glitch del ícono roto.
- **Orden de álbumes en Home + carga de portadas en tandas** (v1.28): a raíz del fix del ícono roto (v1.27), el usuario preguntó en qué orden se cargaban los álbumes y pidió algo "más lindo". Antes `albums.json` no tenía ningún orden explícito — `renderAlbums()` mostraba los álbumes tal cual venían del array (orden de creación, el más viejo primero), y las portadas de **todos** los álbumes pedían su miniatura de Drive en paralelo apenas se armaba la grilla, así que aparecían en el orden que respondiera Drive, no en el orden visual de las tarjetas. Dos cambios, confirmados por el usuario vía pregunta explícita: (1) `sortAlbumsByTripDateDesc()` ordena tanto álbumes propios como compartidos por `dateFrom` descendente (viaje más reciente primero; los sin fecha quedan al final) — se aplica a `albums` (la variable global, también usada por el selector de álbum de la carga masiva) y a la lista de compartidos, cada una ordenada por separado. (2) `scheduleCoverLoad()` reemplaza el llamado directo a `setAuthImg()` en las tapas: las primeras `EAGER_COVER_COUNT` (6, pensado para cubrir la primera fila en la mayoría de anchos de pantalla) piden su miniatura de inmediato como antes; el resto se registra en un `IntersectionObserver` compartido (`coverObserver`, con `rootMargin: '300px'` para adelantarse un poco al scroll) y recién pide la miniatura cuando la tarjeta está por entrar en pantalla — evita que álbumes con muchas tapas compitan todos por red al mismo tiempo. El índice se cuenta de forma continua entre la sección propia y la de compartidos (no se reinicia en compartidos), y el observer viejo se desconecta (`coverObserver.disconnect()`) al principio de cada `renderAlbums()` para no dejar observers apuntando a nodos ya reemplazados.

### Pendientes conocidos
- **Fotolibro: ajustar zoom/encuadre por foto**: pedido original del usuario junto con el orden manual del fotolibro (v1.23), sigue sin resolver — gestos de arrastre/pellizco dentro de la foto para el encuadre, guardar un punto focal por foto. Más trabajo y no era el problema urgente en ninguna de las entregas hechas hasta ahora. Retomar si hace falta más control fino sobre el encuadre de cada foto dentro de su recuadro.
- **Fotolibro: siguientes pasos de "páginas explícitas + drawer" (v1.26)**: quedaron pendientes, en este orden acordado con el usuario — (1) miniaturas del modo reordenar con forma real de libro (reusar `pickLayout`/los layouts 1-4 fotos en vez del cuadrado uniforme); (2) botón "+" para crear una página nueva aislada arrastrando una foto ahí (hoy no hay forma de aislar 2 fotos puntuales si no existe ya una página con lugar); (3) selector para forzar el layout de una página puntual (el modelo de datos ya lo soporta — `page.layout` — falta la UI para elegirlo); (4) botón "Recrear libro" que vacíe todas las páginas al drawer con confirmación, para el caso de "entré a mirar, ahora quiero armarlo en serio"; (5) adaptar toda la interacción a celular — el usuario pidió explícitamente resolver primero en PC y dejar esto para el final.
- **Migraciones de datos con usuarios reales**: anotado por el usuario durante la migración de `book.json` v1→v2 (que en este caso se hizo sin aviso porque el único usuario es él mismo) — cuando haya usuarios reales, un cambio de formato de datos futuro debería evaluarse caso a caso si amerita avisarles (ej. una notificación explicando qué cambió y cómo les impacta en sus fotos/libro) en vez de migrar en silencio como ahora. Sin resolver todavía — no hay mecanismo de notificación a usuarios en la app (ver `ANALYTICS_PLAN.md` para lo más cercano, que tampoco está implementado). Retomar cuando haya una base de usuarios real y un cambio de formato que lo amerite.
- **Aviso de duplicados no detecta la misma foto subida por dos personas distintas**: el aviso de v1.22 compara por nombre de archivo, así que solo pesca cuando la misma persona re-sube desde el mismo dispositivo (donde el nombre se mantiene). En un álbum compartido, si dos usuarios distintos suben la misma foto desde sus propios teléfonos, los nombres casi seguro difieren y no se marca como duplicado. Una detección real por contenido necesitaría un hash — ideal un **hash perceptual** (compara qué tan parecidas se ven dos imágenes, tolerante a recompresión/resize) en vez de un hash exacto, porque si la foto se compartió por WhatsApp antes de subirla, WhatsApp la recomprime y un hash exacto ya no coincide. Implica guardar un campo de hash por item en `day.json` (cambio de schema chico) y calcularlo client-side en cada subida. Evaluado y pospuesto a pedido del usuario — no es trivial y el caso de uso actual (1-2 usuarios) no lo justifica todavía.
- **`main` quedó atrás de lo que hay realmente en producción**: como el deploy a Firebase se hace corriendo `firebase deploy` a mano desde la rama de trabajo (no depende de mergear a `main`), el repo terminó con `main` congelado en v1.14 mientras Firebase (la producción real) ya sirve versiones más nuevas. `main` sigue siendo lo único que ve GitHub Pages, así que **no reflejan lo mismo** — no asumir que `main` = "lo que está en producción" en este repo, hay que mirar qué se deployó a Firebase específicamente. Sería bueno en algún momento mergear las ramas de trabajo pendientes a `main` para que el historial de git no siga divergiendo, pero no es urgente porque no afecta el funcionamiento de la app real (Firebase).
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
5. **Push directo a main** — el usuario prefiere mergear directo sin PRs, **salvo para cambios que dependan de infraestructura externa todavía no configurada**. Para esos casos: commitear en la rama de trabajo, avisar explícitamente qué falta configurar del lado de las cuentas externas, y esperar confirmación antes de mergear a `main`.
6. **Deployar a Firebase (la producción real) no depende de `main`** — es `firebase deploy`, corrido a mano por el usuario desde su máquina, parado en la rama que tenga el código que quiere publicar. Terminar de commitear/pushear a la rama de trabajo no implica que ya esté en producción: avisar siempre que falta ese paso manual (ver "Cómo hacer deploy"), no asumir que el usuario ya lo corrió.

---

## Cómo hacer deploy

**Firebase (producción real — Hosting + Functions juntos):**
```bash
cd functions && npm install   # una vez, o cuando cambien las dependencias
cd ..
firebase deploy
```
Se corre a mano, desde la máquina del usuario (`firebase login` ya hecho, plan Blaze activado), parado en la rama que tenga el código a publicar — **no hace falta mergear a `main` primero**, `firebase deploy` no mira ramas de git, solo el estado de los archivos en el momento en que se ejecuta. Verificar en:
`https://family-fotos-491610.web.app/app.html`

**GitHub Pages (URL vieja, sin uso real como producción):**
```bash
git add .
git commit -m "feat/fix: descripción"
git push origin main
```
Despliega automáticamente en ~1 minuto en `https://leandro-couretot.github.io/travel-diary/app.html` apenas se pushea a `main` — pero como nadie usa esa URL como app real, esto es más que nada higiene del repo (mantener `main` al día), no una entrega a usuarios.
