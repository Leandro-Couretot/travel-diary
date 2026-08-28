# 旅 Travel Diary — CLAUDE.md

Contexto para Claude Code. Leer antes de tocar cualquier archivo.

---

## Qué es

App web de diario de viaje personal. El usuario registra cada día con fotos, videos, audios y notas. Todo se almacena en Google Drive del usuario. Hosteada en GitHub Pages como PWA.

**URL producción:** `https://leandro-couretot.github.io/travel-diary/app.html`
**Repo:** `https://github.com/Leandro-Couretot/travel-diary`

---

## Stack

- HTML + CSS + JS vanilla, sin frameworks ni bundler
- Google Drive API v3 para persistencia
- Google Identity Services (GSI) para OAuth
- GitHub Pages para hosting estático
- PWA instalable (manifest.json)

---

## Estructura de archivos

```
travel-diary/
├── app.html          ← SPA principal — TODO vive acá (home + diario)
├── drive.js          ← Lógica Google Drive (auth, CRUD archivos/carpetas)
├── exif.js           ← Lector EXIF liviano para fechas de fotos
├── style.css         ← Design system compartido
├── debug.js          ← Overlay de errores para debug en mobile
├── manifest.json     ← PWA manifest
├── privacy.html      ← Política de privacidad (requerida por Google OAuth)
├── terms.html        ← Términos de servicio
├── index.html        ← Redirige a app.html (legacy)
├── diary.html        ← Redirige a app.html (legacy)
└── CLAUDE.md         ← Este archivo
```

**Archivo principal: `app.html`** (~2200 líneas). Contiene todo el HTML, CSS y JS en un solo archivo. Es una SPA — no hay navegación entre páginas, todo se maneja con JS mostrando/ocultando vistas.

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
const DRIVE_SCOPE     = 'https://www.googleapis.com/auth/drive.file'; // mínimo necesario
const SCOPE_VERSION   = 3; // incrementar si cambia el scope para forzar re-auth
```

- Scope `drive.file`: solo accede a archivos que la app creó. **No tocar sin revisar el proceso de verificación OAuth.**
- El token se guarda en `localStorage` como `drive_token`
- La app está en modo **Testing** en Google Cloud Console (proyecto: `family-photos`). Enviada a verificación para pasar a producción.

---

## Features implementadas

### Home (`#view-home`)
- Grilla de álbumes propios + álbumes compartidos
- Crear álbum, compartir álbum con otro usuario por email
- Botón ▶ slideshow automático por álbum (fotos 3-7s random, videos completos)
- Carga masiva ⬆ con detección EXIF de fecha
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
- `fetchFileAsDataUrl(fileId)` — descarga como blob URL
- `groupFilesByDate(files)` — agrupa archivos por fecha EXIF

---

## Estado actual y pendientes

### Funcionando bien
- PWA instalable en iOS y Android
- Imágenes cargan correctamente en PWA (via API autenticada con fallback)
- Navegación interna sin abrir Safari
- OAuth con re-auth automático si cambia el scope
- **Modo selección múltiple**: checkbox con 2 estados (círculo vacío / tilde + marco dorado) funcionando correctamente. El bug era que `.selection-check` tenía `background`/`border` inline que pisaban la regla CSS `.media-card.selected .selection-check`, dejando el tilde blanco sobre blanco (invisible). Corregido quitando el inline y agregando el checkbox faltante en las cards de audio (v1.7).
- **Menú ···**: hubo problemas con el overlay interceptando clicks. Solución actual: `document.addEventListener('click')` para cerrar en lugar de overlay. Todos los items del menú (Seleccionar, Carga masiva, Ver álbum, Ayuda) funcionan.

### Pendientes conocidos
- **Verificación OAuth Google**: enviada. Mientras tanto la app está en modo Testing — solo usuarios en la lista de prueba pueden usarla.
- **Compartir múltiples fotos**: implementado con Web Share API. En iOS funciona bien; en desktop hace descarga individual como fallback.

### Deuda técnica
- `app.html` tiene ~2200 líneas — considerar dividir en módulos JS separados cuando crezca más
- El libro (tab Libro) elige layouts con `Math.random()` — mejorar con detección de orientación real de cada foto (ya se lee el EXIF de fecha, podría extenderse para leer dimensiones)

---

## Convenciones importantes

1. **No usar `location.href` para navegación interna** — rompe la PWA en iOS. Usar `navigateTo()` siempre.
2. **No usar `localStorage` para datos** — solo para el token OAuth (`drive_token`) y preferencias menores. Todo el contenido va a Drive.
3. **Imágenes siempre con `setAuthImg()`** — nunca hardcodear URLs de `drive.google.com/thumbnail` directamente, no funcionan en PWA.
4. **Versión en dos lugares** — al cambiar features, actualizar la versión en el header de `#view-home` y en el modal de ayuda `#modal-help`.
5. **Push directo a main** — el usuario prefiere mergear directo sin PRs.

---

## Cómo hacer deploy

```bash
git add .
git commit -m "feat/fix: descripción"
git push origin main
```

GitHub Pages despliega automáticamente en ~1 minuto. Verificar en:
`https://leandro-couretot.github.io/travel-diary/app.html`
