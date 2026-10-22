# Legado — CLAUDE.md

Contexto para Claude Code. Leer antes de tocar cualquier archivo.

---

## Qué es

App web para guardar recuerdos (fotos, videos, audios y notas) organizados en álbumes. El usuario registra cada día — de un viaje o de cualquier otro momento que quiera guardar — y todo se almacena en Google Drive del usuario. PWA instalable.

**Nombre de cara al usuario: "Legado"** (rebrand v1.64, hasta entonces "Travel Diary") — la app dejó de encuadrarse como "diario de viaje" para hablar de "recuerdos" en general (álbumes de cualquier tipo, no solo viajes), y el nombre cambió en todo lo que el usuario ve: título, header, textos de la landing, carpeta raíz en su Drive (`legado/`), nombre de los archivos que la app crea ahí, y el copy de Mercado Pago en el checkout. **Deliberadamente sin cambiar** (identificadores internos, invisibles para el usuario, cambiarlos hubiera sido puro riesgo sin ningún beneficio real): el nombre del repo de GitHub (`travel-diary`), el proyecto de Google Cloud/Firebase (`family-fotos-491610`), el schema de Supabase (`travel_diary`), y el nombre del paquete npm de `functions/` (`travel-diary-functions`). Ver la entrada de v1.64 en "Funcionando bien" para el detalle completo de qué se tocó y cómo se migró sin riesgo el contenido ya existente en Drive.

**Ya migrada de "app familiar" a producto con suscripción** (freemium + pago mensual/anual vía Mercado Pago) — ver la sección "Suscripciones" más abajo. **El corte a Firebase ya se hizo**: Firebase Hosting es la producción real (Blaze activado, SQL de Supabase corrido, secrets cargados, webhook de Mercado Pago configurado). GitHub Pages sigue existiendo y sigue actualizándose sola en cada push a `main` (GitHub Pages sirve directo desde el repo, no hay forma de "apagarla" sin borrar el sitio), pero **es una URL vieja que ya nadie usa como app real** — no confundirla con producción.

**Deploy no es automático como en GitHub Pages**: pushear a `main` no alcanza para que los cambios lleguen a Firebase. Hay que correr `firebase deploy` a mano desde una máquina con `firebase login` ya hecho (ver "Cómo hacer deploy" más abajo) — típicamente parado en la rama de trabajo donde se hizo el fix, sin esperar a que esa rama se mergee a `main` primero.

**Claude SÍ puede disparar el deploy, vía el workflow de GitHub Actions** (`.github/workflows/deploy.yml`, ver "Deploy automático vía GitHub Actions" en "Funcionando bien") — el usuario ya cargó el secret `FIREBASE_TOKEN` en el repo (Settings → Secrets and variables → Actions) para esto, y confirmó explícitamente que Claude puede dispararlo sin pedir confirmación cada vez. **Instrucción explícita del usuario (confirmada de nuevo): disparar el deploy a Firebase siempre, en cada sesión que termine con un cambio de código real commiteado/pusheado** — no hace falta que el usuario lo pida cada vez ("deployá"/"hacé el deploy"), es el comportamiento por default al cerrar cualquier entrega. Solo se salta este paso cuando el propio cambio depende de un secret/infraestructura todavía sin configurar del lado del usuario (ver convención #5) — en ese caso, avisar qué falta en vez de deployar código que va a fallar. El mecanismo: `mcp__github__actions_run_trigger` con `method:"run_workflow"`, `workflow_id:"deploy.yml"`, `owner:"Leandro-Couretot"`, `repo:"travel-diary"`, y `ref` = la rama que tenga el código a publicar (no hace falta mergear a `main` primero, igual que con el deploy manual). Esto no requiere el CLI de `firebase` instalado en la sesión de Claude — corre en un runner de GitHub que sí lo instala y lo autentica con ese secret. Tras dispararlo, confirmar que terminó bien con `mcp__github__actions_list`/`actions_get` (el run queda en estado `queued`→`in_progress`→`completed`, chequear `conclusion:"success"`) antes de avisarle al usuario que el deploy salió — no asumir que un 204 al disparar significa que ya terminó.

**Dominio propio de la app: `legadofamiliar.com.ar`** (comprado por el usuario, ver "Links de campaña con slug" en "Meta Ads: funnel completo instrumentado" para el detalle completo del plan original) — **confirmado en vivo desde una sesión de Claude (02/oct/2026)**: `curl https://legadofamiliar.com.ar` devuelve 200 y sirve el redirect a `app.html`, y `curl https://legadofamiliar.com.ar/app.html` trae exactamente el mismo `app.html` de este repo (mismos comentarios de GDPR/Meta Pixel) — el dominio personalizado de Firebase Hosting ya está andando de punta a punta, no es solo DNS. (Nota de infraestructura de la sesión: el egress proxy de la sandbox de Claude Code bloquea por default cualquier dominio fuera de una lista blanca chica — para poder hacer este fetch hubo que agregar `legadofamiliar.com.ar` a mano en "Allowed domains", en el environment de la sesión en la nube, `claude.ai` → environment → Edit → Network access → Custom. Sin ese paso, `curl`/`WebFetch` a este dominio fallan con un error de proxy que no tiene nada que ver con si el dominio en sí está vivo o no — no confundir una cosa con la otra en una sesión futura.)
**URL de producción (Firebase):** `https://family-fotos-491610.web.app/app.html`
**URL vieja, sin uso real (GitHub Pages):** `https://leandro-couretot.github.io/travel-diary/app.html`
**Repo:** `https://github.com/Leandro-Couretot/travel-diary`

---

## Stack

- HTML + CSS + JS vanilla en el frontend, sin frameworks ni bundler
- Google Drive API v3 para persistencia de fotos/videos/notas (sigue siendo la única "base de datos" del contenido del diario — eso no cambia con la suscripción)
- Google Identity Services (GSI) para OAuth, con `userinfo.email` sumado al scope para tener una identidad estable (ver "Suscripciones")
- **Backend nuevo** (`functions/`): Node.js sobre Firebase Cloud Functions — antes la app no tenía backend propio, esto es exclusivamente para la lógica de suscripciones/pagos, no para el contenido del diario
- Firebase Hosting (reemplaza a GitHub Pages una vez cortada la migración) + Supabase (Postgres, estado de suscripciones — proyecto compartido `pluxow-clients`, schema propio `travel_diary` — nombre interno, no cambió con el rebrand a Legado, ver "Qué es" — ver "Suscripciones") + Mercado Pago (cobros)
- PWA instalable (manifest.json)
- **Google Search Console + Google Analytics (gtag.js)**: verificación de dominio (archivo `google10a65c5cf7ded0c9.html` en la raíz — Google no pudo encontrar la etiqueta `<meta name="google-site-verification">` en `app.html`, se resolvió con el método de archivo en su lugar) + tag de Analytics (`G-0ZM7BKFP5G`, cargado al principio del `<head>` de `app.html`, justo como Google lo indica) — ninguno de los dos habla con `trackEvent()`/`usage_events` (Supabase, v1.62), son capas de medición separadas y sin relación entre sí.

---

## Estructura de archivos

```
travel-diary/
├── app.html          ← SPA principal — TODO vive acá (home + diario)
├── drive.js          ← Lógica Google Drive (auth, CRUD archivos/carpetas, caché de días)
├── billing.js        ← Frontend de suscripciones: habla con /api/* (Cloud Functions), nunca directo con Supabase/Mercado Pago
├── exif.js           ← Lector EXIF liviano para fechas de fotos
├── style.css         ← Design system compartido
├── debug.js          ← Overlay de errores para debug en mobile + reporte automático a Supabase (v1.96)
├── sw.js             ← Service worker: shell offline (stale-while-revalidate)
├── manifest.json     ← PWA manifest (íconos + config)
├── version.json      ← { version, changelog } — fuente de verdad del banner de actualización (ver "Funcionando bien"), se actualiza en cada bump de versión junto con los otros dos lugares
├── icon-192.png, icon-512.png, icon-maskable-512.png, apple-touch-icon.png ← íconos de instalación
├── privacy.html      ← Política de privacidad (requerida por Google OAuth)
├── terms.html        ← Términos de servicio
├── landing.html      ← Landing de marketing (general) — a partir de este deploy, ver "Funcionando bien"
├── landing-viaje.html ← Landing de marketing, variante viaje (misma base, copy adaptado) — ver "Funcionando bien"
├── consent.js        ← GA4 + Meta Pixel con gate de consentimiento (GDPR), port del módulo de app.html — usado por las dos landing — ver "Funcionando bien"
├── index.html        ← Redirige a app.html (legacy)
├── diary.html        ← Redirige a app.html (legacy)
├── firebase.json     ← Config de Firebase Hosting (rewrites /api/** → Cloud Functions, header no-cache para sw.js) + de dónde salen las functions
├── .firebaserc       ← Proyecto de Firebase/GCP de este repo (family-fotos-491610)
├── functions/        ← Backend de suscripciones (Node.js, Cloud Functions) — ver "Suscripciones"
│   └── schema.sql    ← Fuente de verdad del schema `travel_diary` en Supabase (pluxow-clients)
├── .github/workflows/deploy.yml ← Deploy manual (workflow_dispatch) vía GitHub Actions — ver "Deploy automático vía GitHub Actions"
├── HISTORIAL.md      ← Detalle completo de cada entrega (antes "Funcionando bien" de este archivo). No leer entero: buscar por versión o palabra clave
└── CLAUDE.md         ← Este archivo
```

**Archivo principal: `app.html`** (~2400 líneas). Contiene todo el HTML, CSS y JS del frontend en un solo archivo. Es una SPA — no hay navegación entre páginas, todo se maneja con JS mostrando/ocultando vistas.

---

## Arquitectura SPA

Dos vistas principales manejadas por `navigateTo(view, params)`:

- `#view-home` — grilla de álbumes
- `#view-diary` — diario de un álbum (tabs: Día / Mes / Galería / Libro)

La navegación entre vistas es JS puro (`classList.add/remove('active')`), sin `location.href` ni `history.pushState`. Esto es intencional para que la PWA en iOS no abra Safari al navegar.

---

## Arquitectura de datos en Drive

```
Google Drive/
└── legado/
    ├── [Legado] - Mis álbumes.json           ← índice de álbumes propios
    ├── [Legado] - Álbumes compartidos.json   ← álbumes compartidos con este usuario
    ├── [Legado] - Uso.json                   ← contador de audios "vivos" en la cuenta, para el gate de audio del plan gratis (v1.53, ver "Suscripciones")
    ├── japon-2026/                           ← carpeta por álbum (id = slug del nombre)
    │   ├── [Legado] - Fotolibro.json          ← páginas + drawer + tamaño de hoja del fotolibro (ver "Diario" → Tab Libro), opcional
    │   └── 2026-03-24/                       ← carpeta por día
    │       ├── [Legado] - Día 2026-03-24.json ← { version, title, notes, media[] }
    │       ├── [Legado] - foto - IMG_1699.jpeg
    │       └── [Legado] - audio - grabacion.webm
    └── otro-viaje/
```

Nombres de carpeta/archivo tal como se ven hoy (post-rebrand v1.64, ver esa entrada en "Funcionando bien"). Una cuenta que usa la app desde antes de ese deploy puede tener todavía la carpeta raíz como `travel-diary/` y/o archivos con el prefijo `[Travel Diary] - ...` (v1.36-v1.63) o incluso sin ningún prefijo (pre-v1.36, ej. `albums.json` a secas) — la app los sigue encontrando igual (`getOrCreateFolderMigrating`/`findFileInFolderMigrating` en `drive.js`, mismo patrón de migración lazy que ya existía) y los renombra en el momento en que vuelve a escribir cada uno, sin ningún paso de migración en bloque ni riesgo para el contenido ya guardado.

### `albums.json` estructura
```json
{ "version": 1, "albums": [
  { "id": "japon-2026", "name": "Japón 2026", "dateFrom": "2026-03-01", "dateTo": "2026-03-20", "coverFileId": "1ABC...", "archived": false }
] }
```
`archived` (v1.33): opcional, default `false`/ausente = activo. Un álbum archivado no aparece en la grilla principal de Home — vive en su propia sección "Archivados" con un link directo a la carpeta en Drive — pero sigue 100% intacto (no toca la carpeta ni su contenido, solo cambia este flag). Ver "Archivar álbum" en "Funcionando bien".
`archivedByDowngrade` (v1.41): opcional, default `false`/ausente. Solo tiene sentido cuando `archived` es `true` — distingue un archivado automático (por el downgrade del Paso 4) de uno manual, para que el auto-desarchivo al volver a pagar sepa cuáles tocar y cuáles no. Ver "Downgrade automático" en "Funcionando bien".

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

### Auth de Drive: de implícito a refresh_token real (v1.91 — código listo, **todavía sin deployar**, ver checklist abajo)

El usuario reportó "muchas veces entro a la app y no tengo la sesión iniciada" — ver v1.90 en "Funcionando bien" para el diagnóstico del bug real que causaba la mayoría de los casos (nunca se intentaba el refresh silencioso en un arranque en frío) y el fix rápido que ya está en producción. Esta entrega es el arreglo **de fondo**: mientras la app dependa pura y exclusivamente del flujo implícito (`initTokenClient`), cualquier cuenta sin sesión de Google activa en el navegador (Safari/iOS por sus políticas de storage/cookies, más seguido que Chrome/Android) sigue necesitando reconectar a mano tarde o temprano — no hay forma de evitarlo sin un `refresh_token` real, y ese flujo nunca lo da.

**Diseño — migración lazy, sin logout masivo** (mismo criterio que ya usa esta app en todos lados — nunca un big-bang, ver "Qué es"): conviven dos generaciones de auth.
- **Viejo** (`initTokenClient`, implícito): sigue existiendo como mecanismo de refresco de respaldo (`tryEagerSilentRefresh()`) para cuentas que todavía no migraron, y como red de seguridad si el flujo nuevo no llega a inicializarse.
- **Nuevo** (`initCodeClient`, authorization code): a partir de este deploy, **"Iniciar sesión" pasa a usar este flujo exclusivamente** (`handleDriveBtn()`) — pide un *código* en vez de un token directo; el intercambio por `access_token` + `refresh_token` real pasa del lado del servidor (`functions/auth-session.js`, el único lugar con el `client_secret` — nunca puede vivir en el navegador). El `refresh_token` queda guardado en Supabase (`subscriptions.drive_refresh_token`, columna nueva) y de ahí en más cualquier renovación de token pasa por la Cloud Function nueva `drive-token-refresh.js` — sin depender en absoluto de que el navegador siga teniendo sesión de Google viva. Toda cuenta que toque "Iniciar sesión" desde este deploy en adelante (conexión nueva, o reconectar porque el token viejo murió del todo) migra al flujo nuevo esa misma vez — nadie tiene que hacer nada especial, y nadie que ya esté conectado se desloguea por este cambio en sí.
- `access_type:'offline'` + `prompt:'consent'` en el `initCodeClient` — sin el segundo, Google solo entrega `refresh_token` en el primerísimo consentimiento histórico de la cuenta, y ninguna cuenta ya conectada con el flujo viejo dio ese consentimiento todavía.
- **`app.html`**: `refreshDriveToken()` (función compuesta, reemplaza lo que hacía `trySilentRefresh()`/`tryEagerSilentRefresh()` en solitario) prefiere el camino server-side si `localStorage.drive_refresh_available === '1'` (seteado apenas una conexión con el flujo nuevo devuelve `hasRefreshToken:true`); si el servidor dice que no hay nada guardado (cuenta no migrada, o Google invalidó el `refresh_token` porque el usuario revocó el acceso desde su cuenta de Google), se saca el flag y cae al mecanismo viejo como red de seguridad. Se usa tanto en el refresh de fondo (timer/`visibilitychange`) como en el chequeo eager del arranque en frío de v1.90 — este último es donde más se nota la mejora, justo el momento en que el mecanismo viejo es menos confiable.
- **`functions/auth-session.js`** acepta `{code}` (nuevo) o `{access_token}` (legacy, se mantiene mientras convivan las dos generaciones) — con `code`, intercambia primero contra el endpoint de tokens de Google (`redirect_uri:'postmessage'`, el valor especial que documenta Google para códigos obtenidos con `ux_mode:'popup'` de Identity Services) y de ahí en más sigue el mismo camino de validación/upsert de siempre. Devuelve `driveAccessToken`/`driveExpiresIn` (con `code`, el frontend nunca ve el token directo de Google, así que el servidor se lo tiene que devolver) y `hasRefreshToken` (le dice al frontend si puede prender el flag de arriba).
- **`functions/drive-token-refresh.js`** (`POST /api/drive/token/refresh`, función nueva): autenticado con el JWT de sesión propio (`td_session`, 30 días de vida — no con el access_token de Drive, que es justo lo que puede estar vencido acá) en vez del access_token de Drive. Busca el `drive_refresh_token` guardado para ese `google_sub`, lo cambia por un `access_token` nuevo contra Google. Si Google lo rechaza (`invalid_grant` — típicamente porque el usuario revocó el acceso desde `myaccount.google.com/permissions`), borra el `refresh_token` guardado (ya no sirve) y devuelve 401, para que el frontend sepa de una que hace falta un reconectar real en vez de reintentar con un token muerto en cada arranque.
- **Nunca se dejó de validar la identidad del lado del servidor** — mismo principio que ya regía acá: se siga viniendo por `code` o por `access_token`, `auth-session.js` sigue resolviendo la identidad real contra `tokeninfo`/`userinfo` de Google antes de confiar en nada, nunca acepta un `sub`/`email` que mande el cliente directo.

**Checklist antes de deployar esto** (bloqueante — `firebase deploy --non-interactive`, el que usa el workflow de GitHub Actions, va a fallar si falta el secret nuevo, porque `drive-token-refresh.js`/`auth-session.js` lo declaran en su `secrets: [...]`):
1. Conseguir el **Client Secret** del OAuth Client ID que ya usa esta app (`29099211489-421jp27om456sbegj4qhcohvimkfbd5m...`) — [console.cloud.google.com](https://console.cloud.google.com/) → APIs & Services → Credentials → click en ese Client ID (tipo "Web application") → el Client Secret ya está generado ahí (Google lo arma solo al crear cualquier client de tipo Web, aunque el flujo implícito nunca lo haya usado hasta ahora) — copiarlo o resetearlo si hace falta uno nuevo.
2. `firebase functions:secrets:set GOOGLE_CLIENT_SECRET` (mismo mecanismo que el resto de los secrets, ver "Variables de entorno").
3. Correr `functions/schema.sql` de nuevo en el SQL Editor de Supabase (agrega la columna `drive_refresh_token` con `if not exists` — no rompe nada existente, no hace falta ningún paso extra de Data API porque es una columna nueva en una tabla ya expuesta, no una tabla nueva).
4. Recién ahí correr el deploy.

Sin el secret, el código queda commiteado en la rama de trabajo pero sin deployar — convención de siempre para cambios que dependen de infraestructura externa (ver convención #5).

---

## Suscripciones (Mercado Pago + Supabase + Firebase Functions)

Freemium + suscripción mensual/anual. `isPaidUser()` (billing.js) existe desde hace tiempo pero **no gateó nada real hasta v1.40** — v1.33 (archivar) fue solo la pieza de UI reusable, sin conectar todavía con `isPaidUser()`; recién en v1.40 (Paso 3, límite de 4 álbumes gratis) empezó a bloquear algo de verdad.

### Modelo freemium/premium — acordado con el usuario (Meta AI + revisión propia), implementación en curso paso a paso

El usuario trajo una propuesta consolidada de Meta AI (investigación de mercado sobre competencia) para diferenciar free/premium, la revisamos punto por punto contra el código real, y quedó este modelo cerrado:

1. **Álbumes**: 4 gratis, ilimitado Pro. Cuentan los álbumes propios **activos** (no archivados) + **cualquier álbum compartido donde el usuario conserve acceso vigente**, sea como lector o editor (`countQuotaAlbums()`, `drive.js` — resuelto en vivo con `resolveMyGuestRole()`/`whoAmI`, nunca cacheado en `shared-albums.json`, para que una revocación real deje de contar al toque). **Cambiado en v2.83** — hasta esa versión solo contaban los compartidos donde el usuario era editor; el usuario decidió explícitamente que un compartido de solo lectura también ocupe cupo. La única excepción que sigue sin contar nunca es el rol **Contribuidor** (ver "Rol Contribuidor" más abajo — gratis sin límite, decisión de negocio aparte, no una omisión).
2. **Downgrade sin perder nada**: si una cuenta Pro deja de pagar y tiene más de 4 álbumes propios activos, los álbumes de más (todos menos los primeros 4 creados) se **archivan automáticamente** — no se borra nada, el usuario simplemente pierde la edición *dentro de la app* pero conserva acceso total a su Drive (ver "Archivar álbum" en "Funcionando bien", v1.33). Es la misma mecánica que el archivado manual, reusada.
3. **Fotolibro**: **modelo cambiado el 22/oct/2026, todavía sin implementar.** El fotolibro impreso se vende: se paga por hoja con fotos (precio a definir), Pro tiene 20% de descuento y Free paga precio lleno, cobro único con Mercado Pago. Con el pago confirmado sale un mail de confirmación al usuario y a la esposa del usuario, que imprime el libro y lo manda por correo. Se elimina el "1 PDF gratis por mes" (implementado en v1.59, sigue en el código hasta que se construya el pedido pago). Plan y dudas abiertas en `FOTOLIBRO_DISENO.md`.
4. **Audio**: hasta 4 audios en la cuenta gratis (subidos o grabados, cualquier álbum propio), Pro para no tener límite — tiene costo real de storage y es la feature más emocional para el usuario. A diferencia de la redacción original ("1 de por vida"), el modelo cerrado con el usuario es un **tope de cuántos audios "vivos" puede tener la cuenta al mismo tiempo** — se recupera al borrar, y **downgrade sin perder nada** (mismo espíritu que el límite de álbumes): si una cuenta Pro tiene más de 4 audios y baja a Free, ningún audio se toca ni se oculta — quedan igual de accesibles en su álbum de siempre, simplemente no se puede agregar uno nuevo hasta bajar de 4 (borrando) o volver a pagar. **Implementado en v1.53, ajustado a este modelo en v1.54** — ver "Gate de audio" en "Funcionando bien".
5. **Borrado de objetos con IA**: sin implementar (ni UI ni backend). Modelo de créditos ya acordado: 3 ediciones gratis de por vida, 20/mes incluidas en Pro (no acumulables), packs de 10 extra comprables aparte — ver "Pendientes conocidos" para el detalle de por qué conviene una API externa de inpainting antes que programar un algoritmo propio.

**Implementación, paso a paso (el usuario pidió explícitamente no construir todo de una — probar cada entrega antes de seguir):**
- ✅ **Paso 1 (v1.33)**: archivar/desarchivar álbum a mano + sección "Archivados" con link a Drive — la pieza de UI que todo lo demás reusa.
- ✅ **Paso 2 (v1.39)**: `deleteAlbum()` (trashea la carpeta completa en Drive, recuperable 30 días) + `leaveSharedAlbum()` (saca la entrada de tu propio `shared-albums.json`, no revoca el permiso real que te dio el dueño) — ver "Eliminar álbum propio + salir de álbum compartido" en "Funcionando bien".
- ✅ **Paso 3 (v1.40)**: `countEditableAlbums()` (propios activos + compartidos-editor en vivo) + gate reactivo en `submitNewAlbum()` (rama crear) — ver "Límite de 4 álbumes gratis" en "Funcionando bien". **Este es el primer punto donde `isPaidUser()` gatea algo real** — hasta acá existía la infraestructura de suscripciones pero no bloqueaba nada.
- ✅ **Paso 4 (v1.41)**: auto-archivado por downgrade + auto-desarchivado al volver a pagar, reusando el Paso 1 — ver "Downgrade automático" en "Funcionando bien".
- ✅ **Gate de audio (v1.53, tope subido a 4 y downgrade sin pérdida en v1.54)**: hasta 4 audios gratis en la cuenta, se recupera al borrar, bajar de Pro a Free nunca oculta ni borra audio existente — ver "Gate de audio" en "Funcionando bien".
- ✅ **Fotolibro** (v1.56-v1.59): export a PDF completo (ver "Pendientes conocidos" para el detalle de los 3 pasos de la exportación imprimible) + gate de 1 PDF gratis por mes, ilimitado Pro — ver "Gate de fotolibro" en "Funcionando bien". Créditos de IA — fase separada, ni empezada.

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

**⚠️ Confirmado por el usuario (20/oct/2026): las funciones nuevas YA quedan con `allUsers` / Cloud Run Invoker por default en este proyecto** — no hace falta pedirle que lo haga a mano después de un deploy (le pasó con `pushapi` y con las anteriores). Solo mencionarlo si una función nueva devuelve 403 genérico de Google; en ese caso recién verificar el permiso. El texto de abajo queda como referencia histórica del problema.

**Paso manual obligatorio después del primer deploy (y de agregar cualquier función nueva):** en proyectos de Google Cloud creados recientemente, una función nueva **no queda invocable públicamente por default** — el deploy la crea pero nadie (ni el propio frontend) tiene permiso para llamarla. Sin esto, cualquier pedido a `/api/**` devuelve un `403 Forbidden` genérico de Google ("Your client does not have permission...") sin que la función llegue siquiera a ejecutarse — no aparece nada en sus logs, porque nunca corrió. Se arregla en [console.cloud.google.com/run](https://console.cloud.google.com/run) → entrar a cada servicio (`authsession`, `checkoutcreate`, `subscriptionstatus`, `webhookmercadopago`) → pestaña **Permissions** → **Add Principal** → principal `allUsers`, rol **Cloud Run Invoker** → Save. Se hace una vez por función; no hace falta repetirlo en cada deploy salvo que se agregue una función nueva.

**Techo de instancias (`maxInstances`, v2.09)**: surgió de una consulta del usuario sobre si la app podía sufrir un ataque tipo el de un conocido (bots martillando el login hasta tumbar el server). Diagnóstico: `app.html` en sí no es tumbable así — lo sirve Firebase Hosting (CDN de Google), no un servidor propio. El punto real de exposición son las Cloud Functions (`/api/**`), donde el riesgo no es "se cae" (Cloud Run también escala mucho más que un VPS) sino **explotar la factura** — cada invocación cuesta, y sin ningún tope Cloud Run escala sin límite ante cualquier pico. La defensa principal ya estaba puesta (App Check, ver abajo) — esto es la red de seguridad que falta detrás, para el caso de que algo sí saque un token válido (un headless browser real, por ejemplo). Las 7 Cloud Functions llevan `maxInstances` en su config de `onRequest`: `authSession`/`checkoutCreate`/`subscriptionStatus`/`driveTokenRefresh`/`campaignLink`/`trackEvent` en `10` (tráfico de usuario normal, nunca necesitaron más), `webhookMercadopago` en `20` (la llaman los servidores de Mercado Pago, no un navegador — un tope más generoso para no descartar reintentos legítimos en un pico real de pagos). No reemplaza nada de lo que ya existía (App Check en las 4 que lo tienen, la firma HMAC del webhook, la budget alert de Google Cloud Billing que el usuario ya tiene configurada aparte) — es un techo duro adicional, gratis de mantener, sobre el peor caso posible.

### `billing.js` (frontend)
`isPaidUser()`, `establishSession()`, `refreshSubscriptionStatus()`, `startCheckout(planType)`. `establishSession()` se llama con el mismo `access_token` de Drive apenas se conecta (en `app.html`, dentro del callback de `initTokenClient` y en la rama de sesión restaurada de `initGoogleAuth()`) — no hay un segundo login. El botón "✨" del header de Home abre `#modal-subscribe`.

### Variables de entorno (Firebase Functions Secret Manager — `firebase functions:secrets:set NOMBRE`)
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (v1.91, ver "Auth de Drive: de implícito a refresh_token real" — **todavía sin cargar, bloquea el deploy de esa entrega**), `SESSION_JWT_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET`, `META_CAPI_ACCESS_TOKEN` (v2.05, ver "Meta Pixel + Conversions API" — **todavía sin cargar, bloquea el deploy de esa entrega**, mismo motivo que `GOOGLE_CLIENT_SECRET`) — más `APP_BASE_URL` como parámetro no-secreto (`defineString`). Su valor (`https://family-fotos-491610.web.app`) vive commiteado en `functions/.env.family-fotos-491610` — a diferencia de los secrets de arriba, `firebase deploy --non-interactive` (usado por el workflow de GitHub Actions) necesita este archivo presente en el repo para resolver el parámetro sin preguntar interactivamente; en la Mac del usuario ya existía localmente (por eso los deploys manuales nunca fallaron por esto), pero nunca se había commiteado.

### Supabase: proyecto compartido `pluxow-clients`, schema `travel_diary`
Travel Diary **no tiene su propio proyecto Supabase** — usa `pluxow-clients`, el mismo proyecto compartido entre todos los clientes de la agencia (Pluxow), siguiendo la convención de esa arquitectura: un schema aislado por cliente en vez de un proyecto nuevo por cada uno. El schema de esta app es **`travel_diary`** (nunca `public` — ahí viven los schemas de otros clientes como `kinesicpro`, sin relación con este producto).

- `functions/lib/supabase.js` fija `db: { schema: 'travel_diary' }` al crear el cliente — con eso alcanza, ninguna query (`.from('subscriptions')`, etc.) necesita mencionar el schema explícitamente.
- **`functions/schema.sql` es la fuente de verdad del schema** — no un SQL de una sola vez. Tablas: `subscriptions` (una fila por `google_sub`: `plan`, `status`, `mp_preapproval_id`, etc.) y `subscription_events` (log crudo de webhooks, para auditoría). **Cuando se agregue una tabla/columna/índice nuevo, se agrega ahí (con `if not exists`) y se commitea junto con el código que lo usa** — no alcanza con correrlo a mano en el SQL Editor de Supabase, el repo tiene que reflejar siempre el estado real de la base.
- **Pasos manuales obligatorios, fuera del SQL** (Dashboard → Settings → Data API): (1) agregar `travel_diary` en **"Exposed schemas"**; (2) activar `travel_diary.subscriptions` y `travel_diary.subscription_events` en **"Exposed tables"** — el schema expuesto no alcanza solo, cada tabla se activa aparte. Sin esto, toda query desde `functions/lib/supabase.js` falla en silencio del lado del servidor aunque el schema y las tablas existan bien. Costó detectar esto la primera vez (el síntoma fue: Drive se conectaba bien pero `establishSession()` nunca creaba la sesión de suscripción).
- **Un cuarto permiso, este sí en SQL** (ya incluido en `functions/schema.sql`, sección final): un schema creado a mano no le hereda `GRANT` a ningún rol como sí le pasa a `public` — exponerlo en Data API solo lo rutea, pero Postgres igual devuelve `permission denied for schema travel_diary` hasta correr `grant usage on schema travel_diary to service_role` (+ tablas/secuencias). Los cuatro pasos manuales (Exposed schemas, Exposed tables, estos GRANTs, y el invoker de Cloud Run de más abajo) hay que repetirlos completos si en algún momento se recrea el proyecto de Supabase o de Firebase desde cero.
- RLS activado en ambas tablas sin policies — solo la `service_role_key` (usada por las Cloud Functions) puede leer/escribir, nunca el cliente.
- Travel Diary no usa las tablas base de esa convención (`conversaciones`/`mensajes`, pensadas para bots de WhatsApp) — no aplican acá.

---

## Meta Ads: funnel completo instrumentado — ⚠️ leer antes de tocar estos puntos

Fase 3.1 de `GROWTH_PLAN.md` (v2.06, sobre la base de la Fase 3 — Pixel/CAPI
básico, v2.04/v2.05). El usuario pidió medir el embudo completo de punta a
punta antes de arrancar a pautar en Meta Ads: **9 pasos**, cada uno atado a
un punto de código muy específico. Si se refactoriza cualquiera de esas
funciones, hay que mover el disparo del evento junto con la lógica — si no,
el funnel queda con un agujero silencioso en Meta Ads Manager (nadie se
entera hasta que se nota que un paso dejó de tener datos).

| # | Evento (nombre exacto) | Se dispara en... | Pixel | CAPI |
|---|---|---|---|---|
| 1 | `PageView` (estándar) | `<head>` de `app.html`, automático al cargar | ✅ | — |
| 2 | `ClickLandingCTA` (custom) | `openOnboardingModal()`, `app.html` — clic en el botón de la landing "Iniciar sesión / Registrarse" | ✅ | — |
| 3 | `ClickContinueGoogle` (custom) | `startOnboardingLogin()`, `app.html` — clic en "Continuar con Google" dentro del modal, el que de verdad dispara el login | ✅ | — |
| 4 | `CompleteRegistration` (estándar) | `applySessionResponse()` en `billing.js` (Pixel) + el bloque `if (isNewUser)` de `auth-session.js` (CAPI) — solo en un signup genuino, nunca en sesión restaurada/re-login | ✅ | ✅ hybrid |
| 5-8 | `CreateAlbum1`…`CreateAlbum4` (custom) | rama "crear" de `submitNewAlbum()`, `app.html`, justo después de que `createAlbum()` resuelve | ✅ | — |
| 9 | `ViewContent` (estándar) | `openSubscribeModal()`, `app.html` — se abre el paywall | ✅ | — |
| 10 | `InitiateCheckout` (estándar) | `startCheckout()` en `billing.js` (Pixel) + `checkout-create.js` (CAPI) — se tocó "Mensual"/"Anual" | ✅ | ✅ hybrid |
| 11 | `Subscribe` (estándar) | `webhook-mercadopago.js`, únicamente en la transición a `status:'authorized'` | — | ✅ |

(El pedido original numeraba 9 pasos contando `CreateAlbumN` como uno solo — quedan 11 nombres de evento reales porque son 4 álbumes + Pixel/CAPI cuentan como una sola fila cada uno arriba.)

### Por qué el split Pixel vs. CAPI es el que es
Los eventos 1-3, 5-9 son puramente de UI en el navegador — no hay ningún
Cloud Function corriendo en simultáneo del que colgarse, así que agregar CAPI
ahí implicaría sumar infraestructura solo para reportar un clic, sin ningún
beneficio real. Los eventos 4 y 10 sí tienen un momento del lado del
servidor que ya existe por otro motivo (`auth-session.js` ya sabe si es
signup nuevo; `checkout-create.js` ya crea el `preapproval`) — ahí CAPI es
"gratis" y vale la pena por la resiliencia extra contra adblockers. El
evento 11 (`Subscribe`) es CAPI-only a propósito — nunca puede ser el
cliente el que reporte "se confirmó un pago", porque el cliente no tiene
forma de saber eso con certeza; la única fuente de verdad es el webhook de
Mercado Pago.

### El mecanismo de deduplicación hybrid (eventos 4 y 10)
Cuando el mismo evento lógico sale por Pixel Y por CAPI, las dos llegadas
tienen que compartir el mismo `eventID`/`event_id` — es el campo que usa
Meta para colapsarlas en una sola conversión en vez de contar doble.
- **CompleteRegistration**: el servidor (`auth-session.js`) ya sabe en su
  propio momento si es un signup nuevo, así que genera el id
  (`crypto.randomUUID()`) y se lo manda de vuelta al cliente en la respuesta
  JSON (`metaEventId`, solo presente si `isNewUser`); `applySessionResponse()`
  lo usa al llamar `trackMetaPixelEvent('CompleteRegistration', {}, data.metaEventId)`.
- **InitiateCheckout**: acá es al revés — el cliente dispara su Pixel
  ANTES de llamar a la red (para no demorar el evento esperando el
  round-trip), así que es el cliente el que genera el id
  (`newMetaEventId()` en `startCheckout()`) y lo manda en el body de
  `/api/checkout/create`; `checkout-create.js` lo reusa tal cual al llamar
  a `sendMetaCapiEvent()`.
- El helper compartido que arma el POST a la Graph API de Meta para
  cualquiera de estos tres endpoints server-side es
  **`functions/lib/metaCapi.js`** (`readFbCookie()`/`sendMetaCapiEvent()`)
  — extraído en esta entrega porque pasaron de 1 a 3 call-sites
  (`webhook-mercadopago.js`, `auth-session.js`, `checkout-create.js`); antes
  vivía duplicado solo en el primero.

### Ordinal de `CreateAlbum1`-`CreateAlbum4`
No hay ningún flag persistente de "¿ya disparé este paso alguna vez?" —
`submitNewAlbum()` simplemente mira `albums.length + 1` (la variable de
módulo que ya tiene la lista de álbumes propios **activos**, todavía sin
refrescar en ese punto exacto — `renderAlbums()`, que sí la recalcula, corre
recién después) y dispara `CreateAlbumN` si `N` está entre 1 y 4. **Límite
conocido y aceptado**: como cuenta álbumes activos y no un total histórico,
archivar un álbum de los primeros 4 y crear uno nuevo puede volver a
disparar un número ya alcanzado antes (ej. `CreateAlbum3` una segunda vez).
Se aceptó este caso borde a cambio de no sumar ningún estado nuevo que
persistir — ver también la sección "Usuarios únicos", más abajo.

### "Usuarios únicos" — no hace falta deduplicar nada del lado nuestro
El pedido original habla de "usuarios únicos" en cada paso — eso **no** se
resuelve escribiendo lógica de "ya disparé esto antes" en el código. Meta
Ads Manager ya calcula esa métrica solo (columna "Alcance"/"Eventos únicos"
en vez de "Eventos totales"), deduplicando por su propia identidad de
persona (cookie `fbp`/`fbc`, o mejor aún si hay Advanced Matching — que esta
app decidió explícitamente no usar, ver "Decisión de Advanced Matching" en
`GROWTH_PLAN.md`). La única deduplicación que sí importa programar a mano es
la del mecanismo hybrid de arriba (Pixel+CAPI del mismo evento lógico) — ahí
sí hace falta el `eventID` compartido, porque si no Meta cuenta la misma
conversión dos veces.

### Se evaluó Google Tag Manager para esto y se descartó
Meta Events Manager ofrece una integración directa vía Google Tag Manager
(server-side) para configurar Conversions API sin escribir código propio —
se evaluó explícitamente y NO se usó: el evento de mayor valor de este
funnel (`Subscribe`) nace en un webhook de Mercado Pago, no en el
navegador, así que GTM no tiene ninguna forma de verlo sin que igual haya
que mandarle un ping desde el propio código del servidor — la misma
cantidad de trabajo que llamar directo a la Graph API, pero sumando una
cuenta/dashboard externo más para mantener sincronizado con el repo. Ver
"Meta Pixel + Conversions API: 3b/3c" en "Funcionando bien" para el detalle
completo de esta decisión.

### Atribución de campaña (UTM) → Supabase, primer touch (v2.07)
Además de Meta Ads, el usuario va a lanzar campañas de Google Ads más
adelante y repartir tarjetas físicas en la calle — necesitaba saber, por
cuenta, de dónde vino cada usuario (Meta, Google, orgánico) sin depender
100% del propio Ads Manager de cada plataforma. Se agregó un mecanismo
genérico de "primer touch" — **no específico de Meta**, reusable el día de
mañana para `gclid` de Google Ads o cualquier otra campaña con UTMs.

- **Campos**: `utm_source`, `utm_medium`, `utm_campaign`, `utm_adsetname`,
  `utm_adsetid`, `utm_adname`, `utm_adid` — 7 columnas nuevas en
  `subscriptions` (`functions/schema.sql`, `if not exists`). Nombrado
  genérico a propósito (no "meta_adset_id") porque sirve para cualquier
  plataforma de ads que use esa jerarquía campaña→conjunto→anuncio.
- **Captura, `app.html`** (`captureUtmFirstTouch()`, corre una sola vez por
  carga de página, arriba de todo del script, sin depender de que el
  usuario llegue a conectar Drive ni de ninguna otra condición): lee
  `utm_*` de `location.search` y, si hay al menos uno, los guarda en
  `localStorage` bajo `td_first_touch` — **excepción explícita a la
  convención #2** (nunca `localStorage` para datos), mismo criterio que ya
  usan `drive_token`/`td_debug_plan`/`install_dismissed`: es metadata de
  atribución de corta vida, no contenido del diario. Si ya hay un primer
  touch guardado, no lo pisa — el primero en llegar es el que cuenta, así
  una visita orgánica días después de haber entrado por un anuncio no borra
  el touch real.
- **Envío, `billing.js`**: `establishSession()`/`establishSessionWithCode()`
  leen `getStoredUtmFirstTouch()` (función global de `app.html` — mismo
  patrón que ya usa `debug.js` para leer globals de un script que carga
  antes, resuelto en tiempo de llamada, no de parseo) y lo suman al body de
  `/api/auth/session` si existe. `applySessionResponse()` lo borra de
  `localStorage` al final, haya o no haya sido un signup nuevo — evita
  reenviar datos viejos en cada reconexión futura y evita que quede pegado
  a la próxima cuenta que use el mismo navegador.
- **Persistencia, `functions/auth-session.js`**: los 7 campos se agregan a
  `upsertRow` **solo dentro del `if (isNewUser)`** — mismo criterio que
  `fbp`/`fbc` (Meta CAPI): un re-login o sesión restaurada nunca pisa el
  primer touch real de la cuenta, aunque el cliente los mande de más (el
  gate es del lado del servidor, no confía en que el cliente no los mande
  fuera de lugar).
- **Sin ninguna Cloud Function nueva** — reusa `/api/auth/session` por
  completo, el mismo endpoint que ya resuelve identidad y calcula
  `isNewUser` para `signup_completed`/`CompleteRegistration`.
- **Ventana de atribución de campaña vs. señal cruda de Pixel**: si alguien
  hace clic en un anuncio de Meta y recién se registra 60+ días después,
  Meta NO va a atribuirle esa conversión a la campaña en sus reportes (la
  ventana máxima desde 2021 es 7 días clic / 1 día vista) — pero el Pixel sí
  sigue viendo el evento como señal cruda, útil para armar públicos
  personalizados/similares aunque no sirva para optimizar la campaña en sí.
  Por eso no conviene usar `CreateAlbum2`-`CreateAlbum4` (eventos tardíos
  del funnel) como objetivo de optimización de una campaña — son buenos
  para retargeting, no para "optimizar hacia esto".
### Links de campaña con slug (`legadofamiliar.com.ar/{slug}`) — afiliados + calle (v2.08)

El usuario compró **`legadofamiliar.com.ar`**, pensado como dominio único
para dos usos: (1) que sea el dominio real de la app (no un simple
redirect-only hacia el `.web.app` — se agrega como dominio personalizado de
Firebase Hosting apuntando al mismo sitio, así los usuarios ven
`legadofamiliar.com.ar` en la barra, nunca `family-fotos-491610.web.app`;
de paso esto es lo que va a permitir resolver el bloqueo de verificación de
marca de OAuth, ver "Pendientes conocidos" → OAuth, ya que `.web.app` es un
dominio compartido de Google, no "propio", y por eso Google rechazaba la
verificación) y (2) marketing por afiliados — darle a un instagrammer una
URL corta tipo `legadofamiliar.com.ar/christian` para que la publique (en
su bio, en un post, o incluso en sus propios ads pagados — el mecanismo no
le importa de dónde vino el click, solo que haya pasado por ese link).

**Decisión: slugs por path, no subdominios.** Un subdominio por afiliado
(`christian.legadofamiliar.com.ar`) hubiera necesitado un alta manual de
dominio personalizado por persona en Firebase Hosting (sin soporte simple
de wildcard) — con slugs por path (`/christian`) alcanza con el dominio
dado de alta **una sola vez**, y cualquier slug nuevo funciona solo, sin
tocar infraestructura. También es la convención esperada para este tipo de
link (mismo patrón que bit.ly, Linktree, cualquier programa de afiliados).

- **`travel_diary.campaign_links`** (`functions/schema.sql`, tabla nueva):
  `slug` (primary key, siempre en minúscula), `utm_source`, `utm_medium`,
  `utm_campaign` (opcional), `active`, `notes`. Genérico a propósito — sirve
  tanto para un afiliado (`utm_source: 'christian', utm_medium: 'affiliate'`)
  como para un punto de reparto de tarjetas en la calle
  (`utm_source: 'feria-palermo', utm_medium: 'street', utm_campaign: 'lanzamiento2026'`),
  reusando los mismos campos que ya existen en `subscriptions` desde v2.07 —
  ver "Atribución de campaña (UTM)" arriba. Agregar/editar/desactivar un
  link es un `insert`/`update` en esta tabla (a mano desde el SQL Editor o
  el Table Editor de Supabase) — **sin ningún deploy**.
- **`utm_source` = quién trajo la visita (el afiliado), `utm_medium` =
  constante `affiliate`** — no al revés (lo que se planteó al principio) —
  para que después sea intuitivo filtrar "todo lo de afiliados"
  (`utm_medium = affiliate`) y rankear por persona (`group by utm_source`).
- **`functions/campaign-link.js`** (Cloud Function nueva, `campaignLink`):
  resuelve el slug contra `campaign_links` y redirige (302, nunca 301 —
  la fila puede cambiar) a `/app.html?utm_source=...&utm_medium=...` — el
  destino es siempre una **ruta relativa**, nunca un dominio hardcodeado,
  así funciona igual sirviéndose desde `legadofamiliar.com.ar` o desde el
  `.web.app` viejo sin tocar código el día que se termine de migrar. Un
  slug que no existe en la tabla (typo, link viejo, o el navegador pidiendo
  `/favicon.ico`/`/robots.txt` porque no son archivos reales de este repo)
  redirige igual a `/app.html` **sin ningún UTM**, nunca un 404 — mismo
  criterio de "nunca romper un link ya impreso/publicado" que rige el resto
  de esta app. Una lista `RESERVED_SLUGS` evita consultar Supabase de más
  para esos casos conocidos.
- **`firebase.json`**: rewrite nuevo `{"source": "/:slug", "function": "campaignLink"}`
  — Firebase Hosting le da prioridad a un archivo estático real por sobre
  cualquier rewrite genérico, así que `/app.html`, `/privacy.html`,
  `/style.css`, etc. se siguen sirviendo tal cual; solo un path de un único
  segmento que NO coincide con ningún archivo real cae en este rewrite.
- **`app.html` no necesitó ningún cambio** — `captureUtmFirstTouch()`
  (v2.07) ya lee `utm_*` de `location.search` en cualquier carga de página,
  sin importar si esos parámetros llegaron por un link armado a mano para
  un ads o por este redirect — el mismo mecanismo de "primer touch" cubre
  los dos casos sin duplicar nada.
- **Pasos manuales pendientes, fuera del código** (mismo patrón que cada
  vez que se agrega una tabla nueva, ver "Suscripciones" → Supabase): (1)
  correr `functions/schema.sql` de nuevo en el SQL Editor de Supabase para
  crear `campaign_links`; (2) activarla en Dashboard → Settings → Data API
  → Exposed tables (sin esto, `campaign-link.js` nunca va a encontrar la
  fila — pero como el `try/catch` la trata igual que "slug no encontrado",
  el síntoma sería que TODOS los links redirigen sin UTMs, nunca un error
  visible); (3) agregar `legadofamiliar.com.ar` como dominio personalizado
  en Firebase Console → Hosting (apuntando al mismo sitio, no hace falta
  tocar `firebase.json` para esto) y cargar los registros DNS que Firebase
  indique en el registrador del dominio.
- Verificado con `test_campaign_link.js` (nuevo: un slug activo redirige
  con `utm_source`/`utm_medium` y suma `utm_campaign` solo si está presente;
  un slug desconocido o inactivo (`active:false`) redirige a `/app.html`
  sin ningún UTM; un slug reservado (`favicon.ico`) redirige sin siquiera
  consultar Supabase; el path raíz no rompe nada; el slug se normaliza a
  minúscula antes de buscar) + `node --check` en `campaign-link.js` e
  `index.js`.

---

## Features implementadas

### Home (`#view-home`)
- Grilla de álbumes propios + álbumes compartidos
- Crear álbum, compartir álbum con otro usuario por email — con selector **Puede ver / Puede editar** (rol `reader`/`writer` de Drive; por defecto solo lectura)
- Editar álbum propio (nombre, fecha desde/hasta) — botón ✎ en la tarjeta, solo en álbumes propios (v1.30)
- Archivar/reactivar álbum propio — botón "Archivar álbum" dentro del modal de editar; los archivados viven en su propia sección "Archivados" con link directo a la carpeta en Drive (v1.33)
- Botón ▶ slideshow automático por álbum (fotos 3-7s random, videos completos)
- Carga masiva ⬆ con detección EXIF de fecha, subida con concurrencia limitada (5 en simultáneo) y botón "Reintentar los que faltan" si algo falla
- Botón ? ayuda

### Diario (`#view-diary`)
- **Tab Día:** editor con título, notas, upload fotos/videos/audios, grabación de audio in-app
- **Tab Calendario** ("Mes" hasta v2.126): calendario mensual con foto de portada de cada día; tocar un día abre la vista Día (desde v2.126 Día no tiene botón propio)
- **Tab Galería** (llamada "Lista" hasta v1.88, ver esa entrada en "Funcionando bien" para el rediseño): grilla plana con todas las fotos y videos del álbum (videos desde v2.125, con ícono de play), sin agrupar por día. Tocar abre un carrusel a pantalla completa de todo el álbum, con botón "Ver el día" (v2.125)
- **Tab Libro:** grilla de páginas en miniatura con layouts variados (1/2/3/4 fotos por página, max 4) y scroll horizontal — única vista desde v2.02 (antes convivía con una vista inmersiva de una página a pantalla completa, ver "Funcionando bien"). Páginas explícitas + un "drawer" de fotos sin ubicar, con arrastre entre páginas/drawer — ver "Fotolibro: páginas explícitas + drawer" (v1.26) y las entregas previas "Orden manual del fotolibro" (v1.23) y "Modo reordenar del fotolibro" (v1.24)
- Drag & drop para reordenar media (desktop + touch)
- Lightbox al tocar foto (swipe entre fotos, botón compartir)
- Modo selección múltiple (menú ···, disponible en Día y Galería — v1.95): seleccionar fotos → compartir o eliminar en bloque, cruzando días si es desde Galería
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

Índice de lo entregado, una línea por entrega (lo más nuevo arriba). **El detalle completo de cada una está en `HISTORIAL.md`**: buscar por versión (`grep -n "(v2.86)" HISTORIAL.md`) o por palabra clave, y leer solo esa entrada. Cualquier referencia en este archivo del tipo "ver v2.86" o "ver Funcionando bien" apunta a ese detalle.

- v2.152 · "Invitar con QR" como opción propia del menú "⋯"
- v2.151 · Fotolibro: tapa y contratapa (entrega 1 del rediseño)
- v2.150 · Ayuda: sección "Instalar la app" con los pasos del dispositivo
- v2.149 · Novedades sin repetir y con reglas
- v2.148 · Notificaciones: un interruptor por tipo y el modal se pinta al toque
- v2.147 · Notificaciones: interruptor on/off, se habla de "notificaciones" (no "avisos") y se saca el cartel al entrar
- v2.146 · Pregunta de avisos push al entrar a la app
- v2.145 · Notificaciones push (Android + iOS): avisos cuando alguien agrega fotos o escribe algo en un álbum compartido
- v2.144 · Galería: eliminar fotos espera a "Guardar" + una sola fila de "agregar fotos" en el menú +
- v2.143 · El "+" flotante sube cuando aparece la barra "Cambios sin guardar"
- v2.142 · Visor de fotos con pantalla de carga en vez de negro total
- v2.141 · Contribuidor: la galería ya no se ve vacía + se saca el cartel "Acceso confirmado"
- v2.140 · Link/QR de Contribuidor: la pantalla previa al login nombra el álbum
- v2.139 · Contribuidor: progreso de subida y resistencia a que se apague la pantalla
- v2.138 · Contribuidor: sube y ve videos, no solo fotos
- v2.137 · "Carga masiva" pasa a llamarse "Agregar fotos y videos"
- v2.136 · Carga masiva: ningún archivo subido queda sin registrar (pendientes que se retoman solos + adopción de archivos ya en Drive)
- v2.135 · Carga masiva: si se corta el guardado final, se puede terminar sin volver a subir
- v2.134 · Cloudflare delante de `legadofamiliar.com.ar` pisaba el `no-cache` de los `.js`: el fix de v2.133 no le llegaba al teléfono
- v2.133 · Videos del carrete del iPhone fechados "hoy": iOS escribe en `mvhd` la hora de la exportación
- v2.132 · Compartir varias fotos/videos a la vez ya no falla en iPhone con "The request is not allowed by the user agent..."
- v2.131 · La PWA vuelve adonde estabas si iOS la cierra en segundo plano
- v2.130 · "Volver a mis álbumes" pasa al final de la hoja del "+" del diario
- v2.129 · Se borra la vista vieja "por días" de reproducir álbum
- v2.128 · Slideshow tipo historias de Instagram + "Reproducir álbum" del diario usa el mismo slideshow
- v2.127 · "Volver a mis álbumes" en el botón + del diario
- v2.126 · Tabs del diario: Día oculta (se entra desde Calendario), "Mes" pasa a "Calendario", y la tab Día sin la caja grande de subir archivos
- v2.125 · Galería con videos + carrusel al tocar + miniaturas y manifest más baratos en álbumes compartidos
- v2.124 · Registro de cuándo la subida directa cae al camino viejo
- v2.123 · Carga masiva en álbumes compartidos más rápida y clara: subida directa a Google, menos archivos a la vez, estados "en cola"/"preparando" y aviso en…
- v2.122 · Login con Google más rápido y con pantalla de espera: la landing ya no queda a la vista varios segundos tras el popup
- v2.121 · Videos subidos desde la Fototeca del iPhone quedaban fechados "hoy": se piden sin fecha y se registra de dónde sale la fecha
- v2.120 · Carga masiva: se avisa la etapa de "Guardando en el álbum" y hay botón "Listo" al terminar
- v2.119 · Home en celular: la grilla de álbumes ya no se ensancha más que la pantalla (cards pegadas al borde, header cortado)
- v2.118 · Globito de aviso sobre el avatar + el avatar abre directo las Notificaciones
- v2.117 · Se saca "Preferencias de cookies" del menú del avatar
- v2.116 · Menú de la cuenta (avatar) con Notificaciones y Preferencias de cookies + aviso de álbumes compartidos pendientes
- v2.115 · Fecha de las fotos: se lee la fecha de la toma (DateTimeOriginal), no la de última edición (DateTime)
- v2.114 · Fecha real de videos y fotos HEIC al importar: se lee del propio archivo, no de "cuándo se bajó"
- v2.113 · Importar videos desde Drive en iPhone: `accept` explícito en los selectores de archivos
- v2.112 · Álbumes compartidos más rápidos: medición, manifest de una sola llamada y caché persistente, probados primero solo en la cuenta del dev (allowlist)
- v2.111 · Botón "Enviar falla de prueba" en la sección debug del modal de ayuda (solo cuenta del dev)
- v2.110 · Registro técnico de fallas (tabla `error_log`) con código de error visible, independiente del consentimiento de analítica
- v2.109 · Carga masiva en la app instalada (iPhone): el aviso ya no nombra Chrome ni Safari y dice la URL
- v2.108 · Carga masiva en la app instalada (iPhone): aviso de abrir la app desde el navegador + botón "Copiar link", se saca el link al .web.app
- v2.107 · Aviso de Drive en la carga masiva: Chrome sin aviso, app instalada con link al navegador
- v2.106 · Aviso de Drive en la carga masiva: un texto corto por entorno
- v2.105 · Carga masiva en iPhone: aclaración distinta para la app instalada (PWA) y texto legible
- v2.104 · Carga masiva en iPhone/iPad: se oculta el botón "Importar desde Drive" (redundante con el menú nativo de iOS)
- v2.103 · "Importar desde Drive" en iPhone/iPad: se usa el selector de archivos nativo en vez del Picker de Google
- v2.96 · "Importar desde Drive" en la carga masiva: traer fotos/videos que ya vivían en el Drive del usuario, sin volver a subirlos desde el celular
- v2.97 · Bug real de v2.96: "Importar desde Drive" podía quedarse quieto para siempre, sin ningún error en consola
- v2.98 · Causa real de fondo de "Importar desde Drive" (v2.96/v2.97): el Picker de Google no puede abrir su ventana dentro de la PWA instalada en iOS — lími…
- v2.99 · Bug real, la hipótesis de v2.98 no explicaba todo: "Importar desde Drive" seguía colgado en Chrome normal (no solo en la PWA instalada) — faltaba u…
- v2.102 · "Importar desde Drive": faltaba `setAppId` en el Picker — Google lo exige con `drive.file` (v2.96-v2.101 lo armaron siempre sin ese dato)
- v2.101 · Causa real de "Importar desde Drive" por fin encontrada con la telemetría de v2.100: el Picker SÍ se abría — fallaba nuestro timeout/aviso y (proba…
- v2.100 · "Importar desde Drive" (v2.96-v2.99) sigue sin funcionar incluso con la API key y el OAuth Client ID ya bien configurados en Google Cloud — se agre…
- v2.95 · Rol Contribuidor: subidas simultáneas al mismo día ya no pueden dejar una foto invisible — verificación + reintento en el merge de `day.json`
- v2.94 · Popup de "Novedades": pasa de trackearse por dispositivo a trackearse por cuenta, sin sumar ninguna Cloud Function ni tocar el schema
- v2.93 · Banner de cookies: la misma experiencia en las landing, desde un único lugar — `consent.js` pasa a ser la fuente de verdad real, no una copia aparte
- v2.92 · Banner de cookies: texto nuevo + variante de botones según rija GDPR o no
- v2.91 · Texto de "Difusión": ajuste fino, "una capa gratuita"/"parte de la app" en vez de la app entera
- v2.90 · Texto de "Difusión" final — se adopta el copy de la auditoría, con el matiz que faltaba
- v2.89 · Consentimiento de cookies: opt-in estricto en cualquier país — se revierte el opt-out implícito de Marketing fuera de la UE/EEE/UK (v2.30-v2.35 que…
- v2.88 · FAB unificado en el diario: la esquina superior derecha queda solo con "?" — el "···" (Día/Mes/Galería) y el "Opciones" de Libro se consolidan en u…
- v2.87 · Entrar a un álbum aterriza en Galería, no en Día — y la tab de Galería se mueve al inicio
- v2.86 · Las fotos ya no pierden resolución al subirse + carga masiva con progreso real por archivo (en vez de solo "Subiendo X/N")
- v2.85 · Crear un álbum estando en el límite gratis abre directo el paywall (con la tabla Free/Pro), en vez de un error inline para reintentar
- v2.84 · Unirse a un álbum compartido ya con el cupo gratis lleno lo archiva solo — nunca bloquea el "unirse" en sí
- v2.83 · Un álbum compartido como LECTOR también cuenta contra el cupo gratis de 4 álbumes
- v2.82 · Álbumes compartidos: "Ver en Drive" para lector y editor + "Editar álbum" (nombre/fechas) deja de ofrecerse a invitados + se corrige la posición de…
- v2.81 · Bug real: unirse a un álbum que ya es tuyo lo duplicaba en Home — "Ama 1 año" aparecía dos veces, una como propio y otra como "Compartido" por tu p…
- v2.80 · Bug real de fondo, por fin encontrado: "Guardar cambios" del modal de editar álbum quedaba sin reaccionar a partir del segundo uso en la misma sesi…
- v2.79 · Se sacó el carácter "—" (raya/em dash) de todos los textos de cara al usuario, reescribiendo cada frase en vez de cambiar un signo por otro
- v2.78 · "Compartir álbum": nueva sección "Control de accesos" para ver y quitar quién ya tiene permiso
- v2.77 · Home: el total de fotos/videos ya suma los álbumes compartidos + red de seguridad en "Editar álbum"
- v2.76 · Modal "Compartir álbum": se elige el rol primero, recién ahí aparecen la explicación y (si corresponde) el email
- v2.75 · Rol "Contribuidor" — Pasos 6 y 7 (últimos del plan): gratis sin límite + la card de Home nunca le ofrece acciones de edición que no le corresponden
- v2.74 · Rol "Contribuidor" — Paso 5: vista restringida real — un Contribuidor ya puede subir y borrar sus propias fotos desde la app, sin tabs ni menú
- v2.73 · Rol "Contribuidor" — Paso 4: pantalla de unión del invitado — el link/QR del Paso 3 ya cierra el círculo completo
- v2.72 · Rol "Contribuidor" — Paso 3: UI de la dueña para generar el link/QR de invitación, desde el mismo modal "Compartir álbum"
- v2.71 · Rol "Contribuidor" — Paso 2: el proxy entiende el rol, con escritura acotada y "borrar solo lo propio" (backend puro, sin UI todavía)
- v2.70 · Rol "Contribuidor" — Paso 1: infraestructura de invitación por link/QR, sin mail ni Drive ACL (backend puro, sin UI todavía)
- v2.69 · Bug real: un video del slideshow sin sonido reproducible (navegadores embebidos restrictivos, ej. el in-app browser de WhatsApp) podía disparar un…
- v2.68 · Fotolibro personal por invitado — cualquier invitado (editor O viewer) arma su propio libro con las fotos de un álbum compartido, guardado en su pr…
- v2.67 · Álbumes compartidos: un invitado EDITOR gana el resto de las acciones que ya tiene un álbum propio — Editar álbum, Carga masiva, Compartir álbum, y…
- v2.66 · Slideshow ▶ (de la card) y "Reproducir álbum" (menú "···" del diario) no funcionaban en álbumes compartidos — fallaban en silencio, aunque los dos…
- v2.65 · Álbumes compartidos notoriamente más lentos que uno propio — el "preámbulo" de autorización del proxy se repetía sin caché en cada una de las decen…
- v2.61 · El scope `drive.file` no da acceso al contenido de una carpeta compartida, ni siquiera con el Picker — se reemplaza todo el mecanismo de re-consent…
- v2.64 · Home: álbumes propios y compartidos en una sola grilla + datos reales de la dueña (nombre/fechas/portada) en vez de una copia cacheada — + portada…
- v2.63 · Álbumes compartidos (v2.62): 2 bugs reales encontrados por la esposa del usuario — la portada de Home rota, y fotos de un álbum "colándose" al entr…
- v2.62 · Álbumes compartidos: escritura para invitados editores (subir/eliminar fotos, notas, audio) + el popup "Confirmando..." deja de ser invasivo
- v2.60 · Bug real de v2.59, encontrado en el primer uso real: el flag `pickerGranted` podía quedar persistido en `true` sin que el acceso real hubiera funci…
- v2.59 · El picker de v2.58 mostraba un paso extra de Google ("Allow Google access to your necessary cookies") en Safari/iOS, y aunque se lo aceptaba las fo…
- v2.58 · Causa de fondo de "no veo ni portada ni fotos" en álbumes compartidos: el scope `drive.file` nunca le dio a la app visibilidad real sobre una carpe…
- v2.57 · Bug real: los álbumes compartidos en Home siempre mostraban el placeholder "L" en vez de una foto real de portada — sin importar cuánto contenido t…
- v2.56 · `APP_BASE_URL` pasa de la URL vieja de Firebase a `legadofamiliar.com.ar`
- v2.55 · Bug real confirmado en producción: unirse a un álbum compartido nuevo fallaba siempre por una limitación del scope `drive.file`, nunca por un permi…
- v2.54 · Unirse a un álbum compartido: el error mudo "pedile al dueño que comparta" ahora suma el motivo real de Drive
- v2.53 · Corrección real sobre v2.51/v2.52: el archivo bloqueado NO era una foto subida manualmente — era el propio `day.json` del álbum, y el share en real…
- v2.52 · El error de "no se pudo compartir" (v2.51) suma un link directo a Drive para identificar el archivo con certeza
- v2.51 · Bug real: compartir un álbum podía fallar con el mensaje crudo de la API de Google Drive, sin decir qué hacer
- v2.50 · El aviso de "reconstruimos tus álbumes" pasa de un banner inline a un pop-up real, con el nombre del archivo y pidiendo no volver a borrarlo
- v2.49 · El aviso de "reconstruimos tus álbumes" aclara que el borrado fue desde Drive, no un problema de la app
- v2.48 · Slideshow proyectado a una TV: se saca la barra de estado del celular del mirroring + se permite rotar a horizontal para que las fotos llenen la pa…
- v2.47 · Fotolibro: fotos duplicadas — la misma foto (mismo `driveFileId`) referenciada dos veces dentro de `book.json`, "Recrear libro" no lo arreglaba
- v2.46 · 2 bugs reales reportados al proyectar el slideshow a una TV: sin audio en los videos + la pantalla se bloqueaba sola y cortaba el mirroring
- v2.45 · Sistema de íconos SVG — reemplaza los emojis/símbolos tipográficos de toda la app, pensado para el brandbook que va a armar la diseñadora
- v2.44 · Atribución de "vino por una invitación a álbum compartido" (UTM) + bug real encontrado en el camino: el link de invitación perdía sus parámetros al…
- Dos landing de marketing reales (`landing.html`, `landing-viaje.html`), construidas a partir del mockup de diseño
- GA4 + Meta Pixel en `landing.html`/`landing-viaje.html`, con el mismo gate de consentimiento (GDPR) que ya usa `app.html`
- v2.43 · Fotolibro: el aviso de "esto se va a ver borroso impreso" ahora dice CUÁLES fotos, con miniatura y la resolución real que haría falta
- v2.42 · Bug real, mismo patrón que v2.41 pero sin haber sido tocado en esa entrega: las tapas de álbum de Home se veían de baja calidad
- v2.41 · Regresión real de la auditoría de Drive (v2.38): fotos en blanco en Día/Galería + foto chica en el lightbox — corregida
- v2.40 · Fotos duplicadas real en producción (álbum "Ama 1 año", día 19 sep) — dos bugs de fondo encontrados y arreglados
- v2.38 · Auditoría interna de la API de Drive: menos requests de sobra, sin cortes silenciosos en álbumes grandes, y visibilidad real de uso
- v2.37 · Fotolibro: el aro dorado de "vas a soltar acá" a veces no se pintaba al arrastrar una foto sobre la de ABAJO de una página — bug real, puramente vi…
- v2.36 · Fotolibro: "Agregar fotos" en el menú Opciones — carga masiva (o individual) directo desde esa tab, con fecha automática y aviso de duplicados
- v2.35 · 2 fixes sobre "Preferencias de cookies": las dos categorías se pre-tildan fuera de la UE (no solo Difusión) + el modal ya no queda tapado detrás de…
- v2.34 · El banner de cookies deja de mostrarse al abrir la app fuera de la UE/EEE/UK — queda solo en "Preferencias de cookies" (menú de ayuda)
- v2.33 · Copy final de "Medición y uso"/"Difusión" orientado al beneficio del usuario + Difusión pre-tildada fuera de la UE
- v2.32 · Renombre de categorías del aviso de cookies (Analítica → Medición y uso, Marketing → Difusión) + corrección de un texto legalmente inexacto
- v2.31 · `?utm_country=AR` en el link de la campaña pisa el geo de Cloudflare — control de mano propia para las campañas pagas
- v2.30 · Consentimiento de Marketing (Meta Pixel) geo-diferenciado: opt-out fuera de la UE/EEE/UK
- v2.29 · Onboarding personalizado post-login + aceptación explícita de Términos/Privacidad + consentimiento de cookies (GDPR)
- v2.28 · Bug real, distinto a los de v2.26/v2.27: un encuadre guardado podía dejar un margen/hueco gigante en los layouts de 2 y 3 fotos
- v2.27 · El fix de v2.26 para el slider de zoom faltante no alcanzaba en la práctica — el bug seguía ahí
- v2.26 · Bug real: algunos layouts del fotolibro no mostraban la barrita de zoom en "Encuadrar foto"
- v2.25 · Bug real: confirmar un encuadre ("Listo") podía dejar TODA la grilla del fotolibro en blanco, no solo la foto editada
- v2.24 · Bug real, causa de fondo por fin encontrada: la franja negra de "Encuadrar foto" era un bug de Safari (`object-fit:cover` + `transform` en el mismo…
- v2.23 · Fotolibro: no se podía eliminar una página (el botón estaba tapado) + más resistencia en "Encuadrar foto"
- v2.22 · Carga masiva: al terminar, la app entra directo al último día de las fotos subidas
- v2.21 · Bug real, distinto al de v2.19: un encuadre de fotolibro ya guardado podía dejar la foto corrida, mostrando la misma franja negra
- v2.20 · Bug real: al guardar el día, el aviso "Guardado en Drive ✓" se ocultaba antes de llegar a pintarse en pantalla
- v2.19 · Bug real: el editor de encuadre del fotolibro trabajaba sobre una miniatura de Drive, no la foto real
- v2.18 · Fotolibro: el nombre va en la tab, no repetido arriba de la grilla
- v2.17 · Fotolibro: menú "Opciones" que junta todas las acciones en un solo lugar
- v2.16 · Bug real, distinto al de v1.97: en Galería la barra de "Seleccioná fotos" tapaba la última fila
- v2.15 · Home carga más rápido: caché de IDs de Drive ya resueltos + esqueleto en vez de spinner
- v2.14 · Menú "···" del diario: "Ver álbum" pasa a llamarse "Reproducir álbum"
- v2.13 · Bug real: "hoy" se calculaba en UTC, no en el huso horario del usuario
- v2.12 · Bug real, encontrado al probar el fix de v2.11: el lightbox se abría pero la foto quedaba invisible
- v2.11 · Bug real: tocar una foto en la tab Día no abría nada, ni el lightbox ni ninguna otra vista
- v2.10 · 3 fixes puntuales: aviso de duplicados más claro, diálogo de "otro día" con nuestra identidad, poster real en videos
- v2.08 · Links de campaña con slug (`legadofamiliar.com.ar/{slug}`) — afiliados + calle
- v2.07 · Atribución de campaña (UTM) → Supabase, primer touch
- v2.06 · Meta Ads: funnel completo instrumentado, de la home a la suscripción — Fase 3.1
- v2.05 · Meta Pixel + Conversions API: 3b/3c, cierra la Fase 3 de `GROWTH_PLAN.md` — código completo, deploy pendiente del secret
- v2.04 · Meta Pixel: medición del embudo de Meta Ads, primeros dos eventos (Fase 3a/3d de `GROWTH_PLAN.md`)
- v2.03 · Fotolibro: encuadre (zoom + mover) por foto
- v2.02 · Fotolibro: una sola vista (se saca la inmersiva), el número de página va debajo de la tarjeta, y los botones sueltos se mudan al menú "···"
- v2.01 · Fotolibro: lugares vacíos con más contraste — no era un bug de datos, era de legibilidad
- v2.00 · Google Analytics: pageviews virtuales por sección, sin tocar el routing de la SPA
- v1.99 · Fotolibro: carga perezosa de miniaturas — deja de pedir todas las fotos de todas las páginas de una
- v1.98 · Fotolibro: arrastrar páginas enteras para reordenarlas + "+" entre páginas para elegir dónde agregar una nueva
- v1.97 · Bug real: la barra inferior de "Seleccionar fotos" se veía cortada por el borde del celular en iPhone
- v1.96 · Los errores de JS se reportan solos a Supabase, con contexto para poder recrearlos
- v1.95 · "Seleccionar fotos" ahora funciona también en la tab Galería
- v1.94 · Bug real: una miniatura podía quedar "congelada" en pantalla al arrastrar una foto
- v1.93 · Fotolibro: botón "Recrear libro" — rearma todas las páginas al azar
- v1.92 · Auth de Drive: el login manda `state`, cerrando el aviso de seguridad "Use secure flows" de Google Cloud
- v1.91 · Auth de Drive: refresh_token real del lado del servidor
- v1.90 · Home: un solo botón de acceso + bug real de fondo arreglado — la sesión se perdía seguido en arranques en frío
- v1.89 · Tab "Lista" pasa a llamarse "Galería" y se reordenan las tabs del diario
- v1.88 · Tab "Lista": pasa de un renglón por día a una grilla plana con TODAS las fotos del álbum
- v1.87 · Se saca el corrimiento vertical de la grilla de Home — las tarjetas vuelven a estar alineadas
- v1.86 · El botón "＋" de Home pasa de menú de pastillas a hoja inferior
- v1.85 · Bug real, deploy anterior: el botón flotante "＋" de Home (v1.83) nunca llegaba a mostrarse
- v1.84 · Home saluda por el nombre + total de álbumes/fotos/videos, en vez del título fijo "Tus recuerdos"
- v1.83 · Botón flotante "＋" en Home: agregar fotos o crear álbum en un toque
- v1.82 · Fix real: la fecha de la tarjeta de álbum no coincidía con la del modal de editar — no era un bug de cálculo, eran dos fuentes distintas sin aclara…
- v1.81 · Avatar de Google en el header de Home — cierra el hueco vacío al lado de "Legado"
- v1.80 · Paywall: fila "Próximamente" para adelantar el borrado de objetos con IA
- v1.79 · Bug real: el botón "Anual" del paywall se veía cortado/superpuesto en iPhone
- v1.78 · Header de Home más limpio: sin el subtítulo "mis recuerdos" ni el botón de carga masiva
- v1.77 · Bug real, causa distinta a la de v1.76: el banner de "hay una versión nueva" seguía en loop incluso con `app.html` ya actualizado de verdad
- v1.76 · Bug real: el banner de "hay una versión nueva" (v1.73) podía quedar en loop — tocar "Actualizar" no actualizaba de verdad
- v1.75 · Cards de álbum rediseñadas: resumen de fotos/videos + menú "⋯" con todas las acciones
- v1.73 · Banner de "hay una versión nueva"
- v1.72 · Bug real: el toggle de debug "🧪 Forzar Free/Pro" (v1.60) no aparecía nunca, salvo la primerísima vez que se conectó Drive
- v1.71 · Dedupe defensivo de `day.json`: una foto podía quedar referenciada dos veces en el mismo día, mostrándose duplicada en el tab Día y en el fotolibro
- v1.70 · Se saca el botón "● Drive conectado" del header — generaba un hueco vacío en el logo en celular
- v1.69 · Fotolibro v3: capacidad de página fija (huecos en vez de recompactar) + "Agregar página" + "Eliminar página"
- v1.68 · Fotolibro: bug real en `moveBookPhoto()` — soltar una foto sobre el fondo de una página podía modificar la página SIGUIENTE en vez de la tocada
- v1.64 · Rebrand a "Legado"
- v1.66 · App Check (reCAPTCHA Enterprise), Fase 1 — instrumentación, todavía sin exigir nada
- v1.67 · App Check (reCAPTCHA Enterprise), Fase 2 — activado de verdad, con 3 problemas reales encontrados en el camino
- v1.65 · Limpieza de follow-ups del rebrand a Legado
- v1.63 · Onboarding: la pantalla de "Crear mi primer álbum" ya no muestra el chrome de la app
- v1.62 · Métricas de producto: tabla `usage_events` + `track-event.js`, Fase 2 de `GROWTH_PLAN.md`
- v1.61 · Onboarding nuevo: "Crear mi primer álbum" en vez de pedir Google de entrada, Fase 1 de `GROWTH_PLAN.md`
- v1.60 · Toggle de debug restringido a la cuenta del dev por email — cierra el riesgo abierto desde v1.52
- v1.59 · Gate de fotolibro: 1 PDF exportado gratis por mes, ilimitado Pro
- v1.58 · Fotolibro → PDF: el exportador en sí, Paso 3 (y último) de la exportación imprimible
- v1.57 · Fotolibro → PDF: tamaño de hoja real + "sensación de libro", Paso 2 de la exportación imprimible
- v1.56 · Fotolibro → PDF: registro `BOOK_LAYOUTS`, Paso 1 de la exportación imprimible
- v1.55 · Bug real en producción: la reconciliación de audio de v1.54 podía dejar el diario con loader infinito
- v1.54 · Gate de audio: tope de 4, downgrade sin perder ni ocultar nada
- v1.53 · Gate de audio: 1 a la vez gratis, se recupera al borrar
- v1.52 · Toggle de debug para forzar plan Free/Pro localmente, sin tocar Mercado Pago
- v1.51 · Corrimiento vertical de la grilla de Home, ampliado
- v1.50 · Grilla de Home con corrimiento vertical orgánico por tarjeta
- v1.49 · Reactivar bloqueado abre el paywall con comparación Free/Pro, en vez de un error rojo
- v1.48 · Límite de álbumes por identidad, no por cantidad — cierra la laguna de "rotar" archivar/reactivar
- v1.47 · "Reactivar" bloqueado: el error ahora lleva al checkout, no solo lo describe
- v1.47 · Fotolibro: miniaturas del modo Reordenar con forma real de layout
- v1.46 · Fotolibro: selector de layout forzado por página
- v1.45 · Simplificación de la card archivada: se saca la insignia PRO, el aviso proactivo y el botón "Pasar a Pro"
- v1.44 · "Reactivar" gateado igual que "Crear álbum"
- v1.43 · Bug real en producción: `sw.js` dejaba `drive.js` desincronizado de `app.html`
- v1.42 · Insignia "PRO" + botón "Pasar a Pro" en álbumes archivados por downgrade
- v1.41 · Downgrade automático
- v1.40 · Límite de 4 álbumes gratis
- v1.39 · Eliminar álbum propio + salir de álbum compartido
- PWA instalable en iOS y Android, con íconos propios (192/512/maskable + apple-touch-icon)
- Imágenes cargan correctamente en PWA (via API autenticada con fallback)
- Navegación interna sin abrir Safari
- OAuth con re-auth automático si cambia el scope
- Modo selección múltiple
- Menú ···
- Sanitización de HTML de usuario
- Eliminar borra de verdad
- Caché de días + fotolibro en paralelo
- Carga masiva concurrente
- Video/audio sin overhead de base64
- Shell offline
- UI de solo lectura en álbumes compartidos
- v1.17 · Manejo de errores de Drive
- v1.18 · Slideshow por lotes
- v1.19 · Botón de Drive pegado en "Conectar Drive" estando conectado
- v1.20 · Refresh silencioso del token de Drive
- v1.21 · Guardado parcial resiliente a interrupciones
- v1.22 · Aviso de posibles duplicados en carga masiva
- v1.23 · Orden manual del fotolibro, independiente de la fecha
- v1.24 · Modo reordenar del fotolibro (mover fotos entre páginas)
- v1.26 · Fotolibro: páginas explícitas + drawer
- `sw.js` quedaba pegado en versiones viejas de sí mismo
- Deploy automático vía GitHub Actions, probado y funcionando
- v1.32 · Rango de fechas y "días" del álbum calculados de los días reales, no del campo manual
- v1.31 · Timeout en todos los pedidos a Drive, ningún botón se quedaba colgado para siempre
- v1.38 · Feedback inmediato en la carga masiva — antes se sentía trabado por ~4s
- v1.37 · Aviso de duplicados en carga masiva: viñetas en vez de checkbox
- v1.35 · Red de seguridad si se borra `albums.json`
- v1.36 · Nomenclatura de archivos + descripción de advertencia en Drive
- v1.34 · Retoques a v1.33 tras la primera prueba real
- v1.33 · Archivar/reactivar álbum + sección "Archivados" con link a Drive
- v1.30 · Editar álbum (nombre y fechas) después de creado
- v1.29 · Red de seguridad para fotos que se quedaban invisibles para siempre
- v1.27 · Sin el ícono de "imagen rota" mientras cargan las miniaturas de Drive
- v1.28 · Orden de álbumes en Home + carga de portadas en tandas

### Pendientes conocidos
- **Notificación al invitado cuando le comparten un álbum (Lector/Co-propietario)** (anotado v2.114, pedido del usuario, sin implementar): hoy compartir por email solo da el permiso real en Drive (`shareAlbumWithUser()` manda `sendNotificationEmail: false` a propósito) y le muestra a la dueña un link de invitación para que ella se lo pase a mano (`generateShareLink()`). Si la dueña no manda el link, el invitado nunca se entera: el usuario lo vivió compartiéndose un álbum a sí mismo. Se quiere que el invitado se entere solo, idealmente dentro de la app y también por mail. Ideas evaluadas, sin decidir:
  - **Dentro de la app (barato)**: al compartir, `submitShare()` registra una invitación pendiente en una tabla nueva de Supabase (`share_invitations`: email del invitado en minúscula, `folder_drive_id`, nombre/fechas del álbum, `owner_google_sub`, rol, fecha, estado) vía una Cloud Function nueva (mismo patrón que `shared-album-register.js`). Al iniciar sesión, el invitado la consulta por su email (el servidor ya valida el email de la sesión) y Home muestra un aviso/tarjeta "Te compartieron el álbum X" con botón **Aceptar**, que llama al `joinSharedAlbum()` de siempre. Mismo cuidado que cualquier tabla nueva: `functions/schema.sql`, Exposed tables en Supabase (paso manual) y alta del invoker público de la función en Cloud Run. Sirve aunque el invitado todavía no tenga cuenta en Legado: la invitación queda esperándolo hasta que entre con ese mail.
  - **Por mail (requiere decisión de infraestructura)**: dos caminos. (a) Poner `sendNotificationEmail: true` en `shareAlbumWithUser()`: Google manda su mail estándar "X compartió una carpeta con vos" (cero infraestructura, pero apunta a la carpeta en Drive, no a la app, y con `drive.file` el invitado no ve el contenido ahí sin pasar por el proxy). (b) Mail propio de Legado con un proveedor transaccional (Resend, SendGrid, etc.): secret nuevo en Secret Manager, dominio de envío verificado (SPF/DKIM sobre `legadofamiliar.com.ar`) y plantilla con el link de invitación; el mail sale desde la misma Cloud Function de arriba. Costo: poco, pero agrega un proveedor externo y declararlo en `privacy.html`.
  - **Notificación push**: implementada en v2.145 para fotos/notas en álbumes compartidos (ver esa entrada); el aviso de "te compartieron un álbum" sigue sin push.
  - Recomendación: empezar por el aviso dentro de la app (tabla + Home) y sumar el mail propio después si hace falta. Contribuidor no aplica: su acceso nace del link/QR que la dueña genera y comparte ella.
  - **Decisión de UI acordada con el usuario (14/oct/2026)**: sin perfil propiamente dicho. Un menú (el avatar del header de Home es el punto de entrada natural) que agrupe **"Notificaciones"** (lista de álbumes compartidos pendientes de aceptar, con varios a la vez) y **"Preferencias de cookies"** (hoy escondido en el modal de Ayuda). Además, un aviso al abrir la app cuando hay álbumes compartidos pendientes. Implementado en v2.116 (aviso dentro de la app); falta decidir si el mail propio entra en una segunda etapa.
- **Importar carpetas enteras de Drive (ej. "Europa" con subcarpetas por ciudad)** (anotado v2.114): no es posible con el scope `drive.file` (ver el final de la entrada v2.114). El usuario decidió dejarlo como está. Un Apps Script "por detrás" tampoco lo resuelve: si corre como el usuario necesita el mismo scope amplio de Drive (restringido, con la misma auditoría); si corre como la dueña de la app solo ve el Drive de ella, no el del usuario. Retomar solo si se decide pedir `drive.readonly` o soportar ZIP.
- ✅ **Álbumes compartidos vía proxy (v2.61/v2.62): Libro y el slideshow — resuelto en v2.66/v2.68, esta entrada quedó desactualizada hasta que se limpió en v2.82**: el pendiente original decía que `renderBook()` y `startSlideshow()`/`openAlbum()` todavía fallaban en silencio en un álbum compartido — eso ya no es así: el slideshow/▶/"Reproducir álbum" se wireó al proxy en v2.66, y el fotolibro (uno personal por invitado, incluso para lectores) en v2.68. Nada pendiente acá.
- **✅ Mitigado en v2.123 (subida directa a Google, ver esa entrada; falta confirmar en producción) — Escritura de invitados vía proxy (v2.62): una foto o un video grande puede exceder el límite de tamaño de request de la Cloud Function** — `uploadMedia` manda el archivo en base64 dentro del body JSON (~33% más pesado que el binario real), y Cloud Run/Firebase Functions v2 tiene un techo de request de ~32MB. Riesgo más real desde v2.86 que antes: hasta esa versión las fotos siempre se comprimían a un máximo de 2400px (entraban cómodas), pero esa compresión de resolución se sacó a propósito (ver "Funcionando bien" v2.86 — decisión de producto, nunca perder calidad real) — ahora una foto de una cámara buena (o un video de celular, que la app nunca comprimió) sí puede acercarse o superar el límite al subir como Contribuidor de un álbum compartido. No confirmado en producción todavía — si llega a pasar, la solución de fondo es partir la subida en chunks (multipart resumable de Drive) en vez de un solo POST — no implementado, anotado para cuando haga falta.
- **Cloud Build: cambio de canal de actualización de las worker VMs — fecha límite 28 de marzo de 2027** (avisado por Google Cloud el 28 sept 2026, confirmado para el proyecto `family-fotos-491610`): Cloud Build suma 3 "release channels" para controlar cuándo se actualiza el software (Docker/Debian) de las worker VMs — no afecta las versiones de software dentro de los contenedores de build en sí. El **28 de marzo de 2027** el canal "regular" pasa a ser el default. Google sugiere, antes de esa fecha: correr builds de prueba en el canal "regular" para validar compatibilidad, o configurar "stable" si el pipeline necesita un ritmo de actualización más lento. Legado no usa Cloud Build para nada hoy (el deploy es `firebase deploy` corrido a mano/vía GitHub Actions, no un pipeline de Cloud Build) — hay que confirmar si esto aplica en absoluto antes de esa fecha, o si es un aviso genérico de Google sin impacto real acá. Urgencia baja, quedan ~6 meses — solo anotado para no perderlo de vista.
- **Firebase Hosting: los proyectos NUEVOS dejan de auto-crear un sitio default, desde el 15 de octubre de 2026** (avisado por Firebase el 28 sept 2026): a partir de esa fecha, un proyecto de Firebase recién creado ya no provisiona solo un sitio de Hosting default — se crea recién al primer deploy o al configurar algo que lo requiera. **Sin ningún impacto en Legado como está hoy** — el proyecto (`family-fotos-491610`) ya existe con su sitio de Hosting ya provisionado, esto no lo toca. Solo sería relevante si en el futuro se crea un proyecto de Firebase nuevo por script/CI-CD (ej. un entorno de staging separado) — en ese caso, agregar `firebase hosting:sites:create <site-id> --project=<project-id>` en el script de provisioning, antes del primer `firebase deploy`, para no toparse con un 404 "Site Not Found". Urgencia ninguna salvo que se planee crear un proyecto nuevo así.
- **✅ Resuelto en v2.86 — "Tope de compresión de fotos nuevas, decidir si conviene subirlo" (pendiente desde v2.43) ya no aplica**: se sacó el tope de resolución por completo, no solo se subió — ver "Funcionando bien" v2.86. Ninguna de las tres alternativas que estaban evaluadas (dejar el tope, subirlo a ~4000px, o una ruta separada solo para el fotolibro) terminó siendo la elegida; el usuario decidió ir derecho a "nunca perder calidad real", sin tope en absoluto, apoyado en que el espacio lo paga el Drive del propio usuario.
- **Carga masiva: no hay forma de "retomar" una carga si se recarga la página a mitad de camino** (anotado v2.86, ver esa entrada en "Funcionando bien" para el incidente real que lo disparó): la selección de archivos (`bulkGrouped`/`tasks`) vive pura y exclusivamente en memoria del navegador — si la pestaña se recarga, se cierra, o el sistema operativo mata la app en segundo plano a mitad de una subida, se pierde sin ningún registro de qué se había elegido ni qué faltaba. v2.86 ya resolvió la parte de "saber si se colgó" (progreso real por archivo) y "saber qué faltó" (lista con nombres, incluso en una corrida interrumpida se puede ver hasta dónde llegó antes de que la página se recargue) — pero no resuelve "retomar la carga después de un reload real". La solución de fondo implicaría guardar la cola pendiente en **IndexedDB** (que sí puede guardar `File`/`Blob` reales, a diferencia de `localStorage`) antes de empezar a subir, y detectar al abrir la app si queda algo pendiente para ofrecer continuarlo — evaluado como una feature bastante más grande que un parche chico, pospuesto explícitamente para cuando el dolor real lo justifique.
- **Inscribir la base de datos personal ante la AAIP (Argentina) — Ley 25.326** (anotado v2.29, sin investigar en profundidad todavía): a diferencia de GDPR, la ley argentina de protección de datos (Ley 25.326, autoridad de control: **AAIP**, Agencia de Acceso a la Información Pública) exige inscribir ante la AAIP cualquier base de datos de datos personales usada con fines comerciales (Art. 21) — un trámite administrativo, no algo que se resuelva con código. Legado guarda datos personales reales del lado del servidor (email, `google_sub`, estado de suscripción, UTM de atribución — ver "Suscripciones" → Supabase), así que probablemente califica. **Pendiente**: investigar el trámite concreto (formulario, costo si tiene, plazos) y hacerlo antes de tener usuarios reales más allá del propio dev — el usuario marcó esto como clave a tener en cuenta antes de escalar.
- **GDPR sí puede aplicar en la práctica si hay usuarios reales en la UE** (España, por amigos del usuario compartiendo la app) — aclarado en conversación: GDPR se activa por dónde están los usuarios, no por dónde está la empresa, y por targeting/oferta dirigida más que por mera accesibilidad técnica — pero una vez que hay usuarios de la UE usando la app de verdad (no solo "podrían" acceder), conviene tratarlos con las mismas protecciones ya implementadas (consentimiento de cookies, gate de Términos/Privacidad) en vez de discriminar por geografía. El modelo de consentimiento arrancó **global** en v2.29 (mismo comportamiento estricto en cualquier país) — pasó a ser geo-diferenciado recién en v2.30, y solo para la categoría Marketing (el Píxel de Meta), no para Analítica ni para el gate de Términos/Privacidad — ver esa entrada en "Funcionando bien" para el detalle completo.
- **Términos/Privacidad: una sesión ya viva/restaurada no se fuerza a re-aceptar si `TERMS_VERSION` sube** (v2.29, decisión consciente al implementar el gate — ver "Funcionando bien"): hoy `hasAcceptedTerms()` solo se chequea en `handleDriveBtn()`, el único punto de entrada real a un login NUEVO de Google — una cuenta que ya tiene sesión (Drive + suscripción) y sigue usando la app normalmente nunca vuelve a pasar por ahí, así que si el día de mañana se bumpea `TERMS_VERSION` (un cambio material a Términos/Privacidad), esa cuenta sigue usando la app sin haber vuelto a aceptar la versión nueva hasta que en algún momento reconecte Drive desde cero. Evaluado como complejidad desproporcionada para implementar ahora (con un solo usuario real, antes de salir a producción) — la solución de fondo sería un chequeo adicional en el bootstrap de una sesión restaurada (`initGoogleAuth()`/`refreshSubscriptionAndEnforceLimit()`) que bloquee la app con un modal de re-aceptación si `TERMS_VERSION` local quedó atrás. Retomar si/cuando haya un cambio material real a Términos/Privacidad que lo amerite.
- **Verificación formal de OAuth ante Google + "Incremental authorization"** (detectados junto con "Use secure flows" en v1.92, ver esa entrada en "Funcionando bien" para el fix ya resuelto de los tres) — dos avisos del mismo Project Checkup de Google Cloud Console todavía sin resolver, ambos sobre el client `travel-diary`:
  - **"OAuth app verification"**: "Your app requires verification by Google. To submit your app for verification, go to the Verification Center section." — Google exige que cualquier app que pida scopes por fuera de un puñado mínimo ("non-sensitive") pase su revisión formal antes de que cualquier cuenta que no sea de prueba pueda usarla sin ver la pantalla de advertencia "Google no verificó esta app" (la que el usuario reportó en esta entrega). Con `drive.file` + `userinfo.email` + `userinfo.profile`, es esperable que la app necesite verificación — **según CLAUDE.md, "la app ya pasó la verificación de OAuth de Google" en algún momento anterior** (ver "OAuth / Drive config"), así que hay que confirmar primero si este aviso es sobre ese mismo proceso (¿venció? ¿un scope nuevo lo reabrió?) o es una verificación distinta — no investigado en detalle todavía, no se tocó nada de Cloud Console para esto. Submission real (botón "Prepare for verification" / "Verification Center") es un proceso que corre el usuario desde su cuenta de Google Cloud — probablemente necesite la URL de política de privacidad (`privacy.html`, ya existe, servida en producción) y de términos (`terms.html`, ídem), una justificación de para qué se usa cada scope, y tiempo de revisión de Google (puede ser días). Nada de esto se puede resolver solo editando código del repo.
    - **Bloqueante concreto encontrado en la práctica (post-v2.08)**: la verificación de **Branding** del consent screen la rechazó explícitamente con "The website of your home page URL 'https://family-fotos-491610.web.app/app.html' is not registered to you" — `web.app` está en la Public Suffix List (dominio compartido de Google/Firebase, no "propiedad" de nadie en particular vía WHOIS), así que aunque la verificación de Search Console sobre ese subdominio sea válida, no alcanza para este chequeo puntual. El plan (ver "Links de campaña con slug" en "Meta Ads: funnel completo instrumentado"): una vez que `legadofamiliar.com.ar` esté sirviendo la app como dominio personalizado de Firebase Hosting, verificarlo en Search Console por **DNS (dominio completo, no prefijo de URL)** con la misma cuenta de Google dueña del proyecto, y recién ahí cambiar "Application home page"/Authorized domains en el consent screen a ese dominio y pedir la re-verificación.
  - **"Incremental authorization"**: "One or more of your OAuth clients may not properly support incremental authorization... The following OAuth clients don't support incremental authorization: • travel-diary" — causa y fix concretos sin investigar todavía. Retomar junto con lo de arriba.
- ✅ **Fotolibro: ajustar zoom/encuadre por foto — resuelto en v2.03**: pedido original del usuario junto con el orden manual del fotolibro (v1.23), retomado y cerrado en v2.03 (ícono ⛶ por foto → editor dedicado con zoom + paneo, clamping para nunca dejar huecos, aplicado igual en pantalla y en el PDF) — ver "Funcionando bien".
- ✅ **Fotolibro: la miniatura de la grilla (`applyBookFramingTransform()`) combinaba `object-fit:cover` con `transform` — resuelto en v2.28**: el riesgo dormido que dejó anotado v2.24 ("nunca se disparó en producción porque nunca hubo ningún encuadre guardado real") se activó apenas el usuario empezó a guardar encuadres de verdad con ese mismo fix — reportado como un margen/hueco gigante en los layouts de 2 y 3 fotos. Resuelto con el mismo criterio que el editor (tamaño/posición explícitos, sin `transform` ni `object-fit`), pero expresado en **porcentaje de la celda** (no en píxeles reales) usando `computeCellRectMm()` para la proporción de la celda — sin necesitar ningún `ResizeObserver` — ver "Funcionando bien".
- **Fotolibro: rediseño en un artefacto de Design (en curso, sin tocar la app)**: flujo lineal Tapa / Páginas / Revisar e imprimir, tapa con 4 diseños y color y tipografía elegibles, reordenar páginas arrastrando. Avances, decisiones y dudas abiertas en `FOTOLIBRO_DISENO.md` (raíz del repo). Implementarlo en `app.html` es una entrega aparte.
- **Fotolibro: siguientes pasos de "páginas explícitas + drawer" (v1.26)**: quedaron pendientes, en este orden acordado con el usuario — ✅ (1) **miniaturas del modo reordenar con forma real de libro — resuelto en v1.47**, ver "Funcionando bien"; ✅ (2) **botón "+" para crear una página nueva aislada — resuelto en v1.69 como "Agregar página"** (ver "Funcionando bien"): en vez de arrastrar una foto para aislarla, el usuario elige primero cuántas fotos va a tener la página nueva y después el layout — cubre el mismo caso de uso (aislar fotos puntuales en su propia página) sin depender de que ya exista una página con lugar; ✅ (3) **selector para forzar el layout de una página puntual — resuelto en v1.46**, ver "Funcionando bien"; ✅ (4) **botón para vaciar una página con confirmación — resuelto en v1.69 como "Eliminar página"** (ver "Funcionando bien"): a diferencia del "Recrear libro" original (vaciar TODAS las páginas de una), el usuario puede borrar página por página con el mismo aviso de "vuelven a Sin ubicar" — cubre el caso de "entré a mirar, ahora quiero rearmar esto" sin necesitar una acción masiva aparte; (5) adaptar toda la interacción a celular — el usuario pidió explícitamente resolver primero en PC y dejar esto para el final, sigue pendiente.
- **Fotolibro → exportación a PDF imprimible (en curso, Paso 1 ✅ ver "Funcionando bien" v1.56)**: el usuario pidió construir el export a PDF del fotolibro adaptado/customizable a cualquier imprenta (sin integrar una imprenta puntual por ahora) y que la app en sí dé "sensación de libro con páginas" — tarjeta con la proporción real de la hoja elegida (no una animación de paso de página; se evaluaron ambas y el usuario eligió la opción simple). Research hecho sobre cómo trabajan las imprentas de fotolibro en general (sin atarse a ninguna en particular): 300 DPI mínimo en el tamaño final de impresión (piso de la industria); sangrado (bleed) estándar de ~3mm en los 4 bordes (fuentes argentinas citan 2-5mm); margen de seguridad ~10mm hacia adentro de la línea de corte; CMYK es el estándar profesional pero los servicios de fotolibro para consumidor final (Blurb/Mixbook/Shutterfly) suelen aceptar sRGB igual y convertir ellos; el PDF final va sin capas/transparencias, con fuentes embebidas; tamaños de hoja habituales en Argentina: 20x20cm, 20x30cm, 30x30cm, A4/A5 vertical/horizontal; tapas: dura (cartón ~2.5mm forrado, cosido, abre 180°), blanda/perfect binding, ImageWrap (la tapa es la foto de portada impresa directo sobre el cartón forrado, sin sobrecubierta), Layflat (páginas rígidas que abren 100% planas sin perder nada en el canalón — ideal para fotos que cruzan la doble página, la opción más cara); en una doble página, una foto que cruza el canalón/lomo debería solapar ~6mm de cada lado para el corte, y evitar caras/contenido importante justo en el medio.
  - **Plan de implementación acordado, paso a paso** (mismo criterio de "un paso chico por vez, confirmar antes de seguir" que ya rigió el resto del modelo freemium): ✅ **Paso 1 (v1.56)**: registro `BOOK_LAYOUTS` (geometría de cada layout como datos — rows/cols/cells de una CSS Grid) + migrar el render actual (inmersiva, modo Reordenar, selector de layout) para leer de ahí en vez de tener 7 clases CSS escritas a mano — sin cambio visible, ver "Funcionando bien". Esto es lo que garantiza que pantalla y el futuro export a PDF **nunca puedan desincronizarse** — agregar un layout nuevo el día de mañana solo implica sumar una entrada al registro. ✅ **Paso 2 (v1.57)**: el tamaño de hoja elegido pasa a ser un campo del propio `book.json` (`pageSize`, no algo que se elige solo al exportar) + UI para elegirlo (botón "Tamaño" en el Libro) + la página en pantalla adopta esa proporción real con una sombra sutil de tarjeta — acá aparece visualmente la "sensación de libro", ver "Funcionando bien". Como toda la geometría de `BOOK_LAYOUTS` es relativa/fraccional, cambiar el tamaño de hoja no rompe la composición de ningún layout, solo cambian las proporciones visuales. ✅ **Paso 3 (v1.58, último de esta fase)**: el exportador de PDF en sí (botón "Exportar" en el Libro), leyendo `book.json` + `BOOK_LAYOUTS` + el tamaño de hoja elegido, con sangrado configurable en mm (default 3) y un aviso previo (no bloqueante) si alguna foto queda por debajo de 200 DPI para el tamaño de su celda — ver "Funcionando bien". Deliberadamente afuera: conversión real a CMYK (se mantiene sRGB) y marcas de corte. El campo "margen de seguridad" del plan original se descartó en la implementación — sin captions/texto en el PDF no hay nada que proteger de un corte, así que hubiera sido una configuración fantasma; puede retomarse si se agrega un Paso 4. ⬜ **Paso 4 (opcional, sin fecha)**: un "modo impresión" que muestre las líneas de sangrado/margen superpuestas en pantalla, a modo de guía — recién ahí "margen de seguridad" tendría un uso real. ⬜ **Paso 5 (opcional, sin fecha) — temas visuales/fondos de página**: idea que surgió mirando cómo trabaja Fábrica de Fotolibros (fabricadefotolibros.com, imprenta argentina de fotolibros) — el usuario observó que su editor deja elegir templates con **fondos y layouts predefinidos** antes de cargar las fotos, no solo una grilla de fotos pelada como la nuestra hoy. Agregar esto sería una feature nueva de verdad, no un ajuste chico sobre `BOOK_LAYOUTS` (que hoy solo resuelve geometría de fotos, sin ningún concepto de fondo/color/tipografía) — implicaría un registro de "temas" (paleta, fondo por página, quizás tipografía de captions) que tanto la pantalla como el export a PDF tendrían que leer, mismo criterio de fuente única que ya rige `BOOK_LAYOUTS`/`BOOK_PAGE_SIZES`. **Explícitamente no bloqueante para salir a producción** — el usuario lo pidió anotado como posible próximo paso, no para implementar todavía.
- **Migraciones de datos con usuarios reales**: anotado por el usuario durante la migración de `book.json` v1→v2 (que en este caso se hizo sin aviso porque el único usuario es él mismo) — cuando haya usuarios reales, un cambio de formato de datos futuro debería evaluarse caso a caso si amerita avisarles (ej. una notificación explicando qué cambió y cómo les impacta en sus fotos/libro) en vez de migrar en silencio como ahora. Sin resolver todavía — no hay mecanismo de notificación a usuarios en la app (ver `ANALYTICS_PLAN.md` para lo más cercano, que tampoco está implementado). Retomar cuando haya una base de usuarios real y un cambio de formato que lo amerite.
- **Aviso de duplicados no detecta la misma foto subida por dos personas distintas**: el aviso de v1.22 compara por nombre de archivo, así que solo pesca cuando la misma persona re-sube desde el mismo dispositivo (donde el nombre se mantiene). En un álbum compartido, si dos usuarios distintos suben la misma foto desde sus propios teléfonos, los nombres casi seguro difieren y no se marca como duplicado. Una detección real por contenido necesitaría un hash — ideal un **hash perceptual** (compara qué tan parecidas se ven dos imágenes, tolerante a recompresión/resize) en vez de un hash exacto, porque si la foto se compartió por WhatsApp antes de subirla, WhatsApp la recomprime y un hash exacto ya no coincide. Implica guardar un campo de hash por item en `day.json` (cambio de schema chico) y calcularlo client-side en cada subida. Evaluado y pospuesto a pedido del usuario — no es trivial y el caso de uso actual (1-2 usuarios) no lo justifica todavía.
- **`main` quedó atrás de lo que hay realmente en producción**: como el deploy a Firebase se hace corriendo `firebase deploy` a mano desde la rama de trabajo (no depende de mergear a `main`), el repo terminó con `main` congelado en v1.14 mientras Firebase (la producción real) ya sirve versiones más nuevas. `main` sigue siendo lo único que ve GitHub Pages, así que **no reflejan lo mismo** — no asumir que `main` = "lo que está en producción" en este repo, hay que mirar qué se deployó a Firebase específicamente. Sería bueno en algún momento mergear las ramas de trabajo pendientes a `main` para que el historial de git no siga divergiendo, pero no es urgente porque no afecta el funcionamiento de la app real (Firebase).
- **Idea evaluada: editor de fotos con borrado de objetos (candidato fuerte a feature paga, con modelo de créditos)**: surgió de una investigación de mercado del usuario sobre la competencia. Se evaluaron 3 enfoques: (1) **clone stamp manual** (estilo Photoshop clásico, el usuario elige a mano de dónde copiar píxeles) — 100% client-side con `<canvas>`, sin backend ni costo por uso, complejidad baja (es UI: pincel, tamaño, deshacer); (2) **Content-Aware Fill propio** (el algoritmo **PatchMatch** que Adobe metió en Photoshop CS5, previo a la era de IA moderna — busca y propaga parches de píxeles parecidos automáticamente) — sin costo por uso porque no depende de una API externa, pero programarlo bien (rápido en celular sin GPU dedicada, resultado prolijo en bordes/texturas) es un algoritmo de visión por computadora real, semanas de desarrollo y ajuste fino — la parte genuinamente cara de construir; (3) **borrador con IA vía API externa de inpainting** (Clipdrop, Replicate, etc., tipo Magic Eraser) — el desarrollo es comparativamente simple (una Cloud Function más, mismo patrón que `checkout-create.js`/`webhook-mercadopago.js`: validar sesión, llamar la API con un secret, devolver resultado) pero tiene **costo por imagen procesada**, a diferencia de (1) y (2). Conclusión: para esta feature puntual conviene la opción (3) — se paga con dinero (API) en vez de con tiempo de desarrollo (programar PatchMatch desde cero).
  - **Modelo de monetización acordado con el usuario** (no le cerraba cobrar por uso Y tener plan premium a la vez — "me queda raro el modelo"): no son dos cobros separados, es una sola escalera — el plan premium **incluye una cuota de créditos por mes** (ej. 20 fotos editadas) para cubrir el uso típico, y créditos extra se compran sueltos a la carta para los que se pasan de esa cuota (cubre el costo variable de la API sin que la suscripción tenga que subir de precio para todos). Usuarios free tendrían 1-2 créditos de prueba para probar la calidad antes de pagar. Mismo esquema que usan Canva (créditos de IA dentro de Canva Pro) o Adobe (créditos de Firefly dentro de Creative Cloud).
  - **Sin implementar todavía** — solo evaluado y anotado a pedido del usuario. Si se retoma: falta investigar qué API de inpainting conviene (precio por imagen, calidad, límites) para tener números concretos, y el modelo de créditos necesitaría una columna/tabla nueva en Supabase (extensión del schema de `subscriptions`, ver "Suscripciones") más una Cloud Function que decremente el crédito antes de llamar a la API externa.
- **Meta Ads — nada pendiente**: las 3 fases de `GROWTH_PLAN.md` (onboarding ✅ v1.61, métricas de producto ✅ v1.62, Pixel/Conversions API ✅ v2.04-v2.06 incluyendo el funnel completo de la Fase 3.1) están implementadas y deployadas — ver **"Meta Ads: funnel completo instrumentado"** más arriba en este archivo para la referencia viva de cada evento antes de tocar cualquiera de sus puntos de código.
- **Links de campaña (v2.08) — los 3 pasos manuales ya resueltos (dominio incluido)**: ver el detalle completo en "Links de campaña con slug" dentro de "Meta Ads: funnel completo instrumentado" más arriba. ✅ (1) `functions/schema.sql` corrido contra la base real vía Supabase MCP (Claude tiene acceso al proyecto compartido `Pluxow`, `hcngtbbjvqvfpagiieqp`) — `travel_diary.campaign_links` existe, con RLS y los `GRANT` a `service_role` ya aplicados. ✅ (2) `campaign_links` activada en Dashboard → Settings → Data API → Exposed tables — confirmado por el usuario. **Nota para el futuro**: este toggle es un ajuste interno de Supabase (PostgREST) sin ningún GUC a nivel de rol que se pueda leer/setear por SQL (confirmado consultando `pg_db_role_setting` — vacío para `pgrst.*`) — Claude no tiene ninguna herramienta de Supabase que llegue a ese panel, así que este paso siempre va a necesitar que el usuario lo haga a mano, no hay forma de automatizarlo desde acá. ✅ (3) **`legadofamiliar.com.ar`** — el usuario confirmó que ya es el dominio de la app (ver "Qué es" arriba); el registrador ya no es un bloqueo. No se volvió a verificar en detalle desde una sesión de Claude si `campaignLink`/los slugs de afiliado ya resuelven sirviendo ESE dominio en vez de (o además de) `family-fotos-491610.web.app` — si se retoma este punto, confirmar primero contra el `firebase.json`/Firebase Console actual en vez de asumir. Sigue sin haber ningún slug de afiliado real cargado en `campaign_links` todavía (eso es un dato de negocio, no un bloqueo técnico).
- **Compartir múltiples fotos**: implementado con Web Share API. En iOS funciona bien; en desktop hace descarga individual como fallback.
- **Streaming real de video**: hoy el video se descarga entero (como blob URL) antes de reproducirse — no hay range requests. La solución de fondo (un service worker que intercepte el pedido a Drive, inyecte el header `Authorization` vía postMessage desde la página, y reenvíe Range/206) quedó deliberadamente afuera de la Fase 6 del plan de auditoría por su complejidad y riesgo (reescribe el pipeline de video) sin poder probarla en un dispositivo real. Retomar cuando se pueda testear en mobile.

### Deuda técnica
- `app.html` tiene ~2400 líneas — considerar dividir en módulos JS separados cuando crezca más

---

## Convenciones importantes

1. **No usar `location.href` para navegación interna** — rompe la PWA en iOS. Usar `navigateTo()` siempre.
2. **No usar `localStorage` para datos** — solo para el token OAuth (`drive_token`) y preferencias menores. Todo el contenido va a Drive.
3. **Imágenes siempre con `setAuthImg()`** — nunca hardcodear URLs de `drive.google.com/thumbnail` directamente, no funcionan en PWA.
4. **Versión en dos lugares** (desde v1.77 — antes eran "tres", y en la práctica llegaron a ser cuatro sin que ninguna checklist lo supiera, ver el bug de v1.77 en "Funcionando bien") — al cambiar features, actualizar `const APP_VERSION` (arriba de todo del script inline de `app.html`, única fuente de verdad — el header y el modal de ayuda lo leen de ahí, no hace falta tocarlos a mano) **y `version.json`** (además del changelog corto ahí, que alimenta el banner de actualización — ver "Banner de actualización" en "Funcionando bien"). Olvidar `version.json` no rompe nada visible de inmediato, pero significa que ningún usuario se entera de que hay una versión nueva; olvidar `APP_VERSION` es peor — el banner queda en loop infinito para siempre (exactamente el bug de v1.77).
5. **Push directo a main** — el usuario prefiere mergear directo sin PRs, **salvo para cambios que dependan de infraestructura externa todavía no configurada**. Para esos casos: commitear en la rama de trabajo, avisar explícitamente qué falta configurar del lado de las cuentas externas, y esperar confirmación antes de mergear a `main`.
6. **Deployar a Firebase (la producción real) no depende de `main`** — es `firebase deploy`, corrido a mano por el usuario desde su máquina, parado en la rama que tenga el código que quiere publicar. Terminar de commitear/pushear a la rama de trabajo no implica que ya esté en producción: avisar siempre que falta ese paso manual (ver "Cómo hacer deploy"), no asumir que el usuario ya lo corrió. **Claude también puede dispararlo solo**, vía GitHub Actions — ver "Qué es" más arriba para el mecanismo exacto.
7. **CLAUDE.md es la fuente de verdad, no el historial de chat** (pedido explícito del usuario): cada sesión de Claude arranca sin memoria de las anteriores — lo único que persiste entre sesiones es este archivo. Por eso, cada vez que se termina algo que vale la pena recordar (una feature, un fix, una decisión de diseño, un dato de infraestructura como "Claude puede disparar el deploy" o "el dominio de la app es legadofamiliar.com.ar"), hay que agregarlo ACÁ antes de dar por terminada la tarea — no alcanza con haberlo discutido en el chat, porque la próxima sesión no lo va a ver. Esto aplica en particular a: (a) cada entrega de código real → la entrada completa (con todo el detalle) arriba de todo en `HISTORIAL.md`, y una sola línea `- vX.YY · Título` arriba del índice de "Funcionando bien" de este archivo (ver convención #4 para dónde más bumpear la versión). **El detalle largo nunca va en CLAUDE.md**: este archivo se carga entero en cada sesión y en cada resumen del chat, así que tiene que quedar liviano (acordado con el usuario el 22/oct/2026, cuando pesaba 816 KB y llenaba el contexto rápido); (b) cualquier decisión de producto/negocio acordada con el usuario (ver "Suscripciones", "Meta Ads", etc. — todas documentadas ahí, no solo en la conversación donde se decidieron); (c) cualquier capacidad o límite del entorno de trabajo de Claude que convenga no tener que re-descubrir cada vez (ej. qué puede y no puede hacer el proxy de salida de la sandbox, qué secrets ya están cargados, qué pasos manuales ya resolvió el usuario). Ante la duda de "¿esto amerita anotarse?", pecar de anotar de más, pero en el lugar correcto: el detalle en `HISTORIAL.md`, y en CLAUDE.md solo lo que hace falta tener a la vista en cada sesión (reglas, decisiones vigentes, pendientes, datos de infraestructura).

8. **Las novedades se redactan con el usuario, nunca solas** (pedido explícito del usuario, 21/oct/2026): cada vez que una entrega necesite texto de novedades de cara al usuario (una entrada nueva de `USER_CHANGELOG` en `app.html` y/o la frase de `changelog` en `version.json`), Claude **primero le propone la redacción al usuario y espera su confirmación** antes de escribirla en el código, bumpear la versión o deployar (mientras tanto se puede commitear y pushear el código sin novedades). El usuario dijo que el tono y las cosas que Claude cuenta no son como él las contaría. Para ir aprendiendo, después de cada entrega con novedades hay que anotar en "Registro de novedades" (abajo) qué se propuso, qué corrigió el usuario y cómo quedó el texto final. Antes de proponer una redacción nueva, releer ese registro. Si una entrega no tiene nada que contarle al usuario, no se inventa una novedad. Lo mismo vale para cualquier otro texto nuevo de cara al usuario que sea más que una etiqueta (modales, avisos): ante la duda, mostrar el texto antes de pushearlo.

---

## Registro de novedades: qué contamos y cómo

Ver convención #8. Este registro es la memoria de cómo le gusta al usuario que se cuenten las novedades. **Releerlo antes de proponer una redacción y actualizarlo en cada entrega con novedades** (qué se propuso, qué corrigió el usuario, texto final).

**Reglas fijas para las novedades** (acordadas con el usuario el 22/oct/2026, aplican siempre):
1. Solo algo nuevo que el usuario pueda usar, o que cambie algo que ya hacía. Los arreglos, retoques de diseño y cambios internos no se cuentan nunca. Ante la duda, no se cuenta.
2. Una frase por entrada. Cada entrada de `USER_CHANGELOG` lleva un `topic`; si una cuenta acumula varias del mismo tema se muestra solo la más nueva. Máximo 3 frases por modal.
3. **Nunca nombrar iPhone, Android ni ningún sistema o dispositivo** en una novedad ni en un texto que ven todos por igual: la app no guarda qué dispositivo usa cada persona (solo lo detecta al momento, para mostrar los pasos de instalar y el estado de notificaciones). Si algo depende del sistema, la aclaración va dentro de la pantalla donde se usa y se muestra solo a quien corresponde; el único lugar donde se explica cómo instalar la app es Ayuda → "Instalar la app" (v2.150).
4. Sin raya larga "—", voseo argentino, frases cortas. Antes de escribirla, mostrar la redacción al usuario (convención #8).

**Lo que el usuario ya dijo que no le gusta** (21/oct/2026): el tono y las cosas que Claude cuenta en las novedades no coinciden con cómo él las contaría. Todavía no explicó el detalle, así que en la próxima novedad hay que proponer con cautela y preguntarle qué cambiaría. Reglas ya conocidas de antes: sin raya larga "—" en texto de cara al usuario; voseo argentino; frases cortas.

**Dónde viven las novedades:** `USER_CHANGELOG` en `app.html` (lista que ve la cuenta al abrir la app, 1 a 3 frases por versión, se acumulan si se salteó varias) y la frase única de `changelog` en `version.json` (banner de "hay una versión nueva").

**Historial de lo que se contó** (texto tal como salió, sin haber sido validado por el usuario salvo que diga lo contrario):

| Versión | Texto en `USER_CHANGELOG` | Validado por el usuario |
|---|---|---|
| 2.94 | "El aviso de "Novedades" ahora te sigue a tu cuenta, no al dispositivo — si entrás desde otro celular o compu, no repite lo que ya viste." | No. Es técnica y usa raya larga. |
| 2.103 | ""Importar desde Drive" ahora funciona en iPhone: se abre el selector de archivos del teléfono y desde "Explorar" elegís Google Drive." | No |
| 2.116 | "Cuando alguien te comparta un álbum, te avisamos con un globito sobre tu foto de perfil, arriba a la derecha." + "Tocala para ver las notificaciones y aceptar el álbum con un toque." | No |
| 2.145 | "Ahora podés recibir avisos en el celular cuando alguien agrega fotos o escribe algo en un álbum que compartís." + "Se activan desde Notificaciones (tocando tu foto de perfil). En iPhone hace falta tener Legado instalada en la pantalla de inicio." | No |
| 2.146 | (cartel, luego eliminado en 2.147) Solo `version.json`: "Al entrar te preguntamos si querés recibir avisos cuando alguien suba una foto o escriba algo en un álbum compartido." | No |
| 2.147 | "Te notificamos cuando en un álbum compartido se sube contenido nuevo o se escribe algo en una foto." + "Activá las notificaciones desde el menú de notificaciones, tocando tu foto de perfil." (misma primera frase en `version.json`) | Primera frase sí, es la redacción del usuario. La segunda la agregó Claude sin confirmar, por si no se entendía dónde activarlas. |
| 2.149 | Limpieza: notificaciones queda en una sola entrada, "Te notificamos cuando en un álbum compartido se sube contenido nuevo o se escribe algo en una foto. Activalas desde Notificaciones, tocando tu foto de perfil." (versión 2.147). Se reescribió 2.103 sin iPhone y se sacó 2.94. | Sí, el usuario dijo "Dale" a este texto. |
| 2.148 | (sin novedad: el usuario pidió "Sin novedad" para el rediseño del modal en interruptores por tipo; `version.json` conserva la frase de 2.147) | n/a |
| 2.151-2.152 | (sin novedad: tapa del fotolibro e "Invitar con QR". Claude propuso no contarlo porque el fotolibro está a medio rehacer y el QR es un cambio de lugar; el usuario dijo "Ok dale". `version.json` conserva la frase de 2.147) | n/a |

**Correcciones del usuario** (completar acá a medida que las dé):
- 21/oct/2026: en los avisos push no hay que aclarar que no se notifica cuando se borra o se reordena algo. Moraleja: contar lo que sí pasa, no enumerar lo que no pasa.
- 21/oct/2026 (texto de la notificación push, no de las novedades): en lugar de "X escribió algo en "Álbum"" el usuario pidió "X comentó una foto en "Álbum"". Ojo: ese mismo aviso también sale al cambiar el título o las notas de un día, no solo el texto de una foto; el usuario lo pidió así igual. Cambio solo en `functions/push.js` (`buildMessage`), sin bump de versión porque el frontend no cambió.
- 21/oct/2026: en la notificación push el nombre del álbum pasa de ir entre comillas en el cuerpo a ir como título (las notificaciones no soportan negrita; el título se ve destacado). Quedó: título `Ama 1 año`, cuerpo `Ana comentó una foto` / `Ana agregó 5 fotos y videos`; sin nombre de álbum el título es `Legado`. Solo `functions/push.js`.
- 22/oct/2026: no hacer novedades que mencionen iPhone o Android, porque hoy no distinguimos el dispositivo del usuario. Pasó con 2.145 ("En iPhone hace falta...") y 2.103.
- 21/oct/2026: hablar de "notificaciones", no de "avisos". No quiere "comenta" si la app no tiene comentarios: usar "se escribe algo en una foto". No quiere explicar dónde cambiar la preferencia dentro del cartel. Texto propio y directo: "Te notificamos cuando en un álbum compartido..." (voz de la app en primera persona del plural, sin adornos).

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
