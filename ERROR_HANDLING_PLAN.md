# Plan de manejo de errores (Google Drive)

**Estado: PLAN A FUTURO, NO EJECUTADO.** Nada de lo descripto acá está
implementado — se guarda en el repo para poder retomarlo y ejecutarlo
cuando se decida, revisando primero si sigue vigente.

---

## Contexto

Surge de dos conversaciones: (1) qué pasa si alguien paga por más álbumes y
se queda sin espacio en Drive justo al subir, y (2) el miedo a que un
usuario borre archivos a mano desde su propio Drive (fuera de la app) y eso
rompa el diario. La decisión tomada en ambos casos fue **no cambiar la
arquitectura** (Drive sigue siendo la única fuente de verdad, no se
centraliza storage ni se mueve `day.json` a Supabase) — el problema real es
que hoy la app **no distingue estas fallas de un error genérico**, así que
en vez de mensajes claros el usuario ve un ícono roto o un día que
desaparece sin explicación.

### Por qué pasa esto hoy

`driveReq()` (`drive.js:54`) solo distingue dos casos: `401` (token
vencido, fuerza reconexión) y `429`/`5xx` (reintenta con backoff). Todo lo
demás — incluido un `403` por cuota excedida o un `404` porque el archivo
ya no existe — se devuelve tal cual, sin que la mayoría de los llamadores
(`uploadFile`, `fetchAuthImgUrl`, `fetchFileAsDataUrl`) chequeen `res.ok`
antes de asumir que la respuesta es válida. El resultado es que la falla
ocurre igual, pero en silencio.

## Principio: fallar visible, no fallar silencioso

Ya existe parcialmente este criterio (la carga masiva guarda lo que sí subió
y ofrece "reintentar los que faltan") — la idea es extenderlo: toda
operación que puede fallar por una causa externa identificable (cuota,
archivo borrado) tiene que distinguir esa causa y mostrar un mensaje
específico, no un error genérico ni fallar callada.

---

## Caso 1: cuota de Google Drive excedida al subir

**Síntoma hoy:** `uploadFile()` (`drive.js:132`) no chequea `res.ok`. Si
Drive devuelve `403` por falta de espacio, `file.id` sale `undefined`, y
ese archivo queda con `driveFileId: null` en `day.json` — desaparece sin
que nadie se entere de por qué.

**Propuesto:**
- Detectar el `403` con `reason: "storageQuotaExceeded"` en el body del
  error de Drive y lanzar un error identificable (ej.
  `DriveQuotaExceededError`) en vez de dejar pasar la respuesta.
  - **Antes de implementar:** confirmar el shape exacto de ese error 403
    contra la API real (probando con una cuenta sin espacio, o la
    referencia de errores de Drive v3) — no asumirlo de memoria.
- En el frontend (dentro del flujo de `saveDayToDrive` en `app.html`, y en
  `runBulkUpload`): capturar ese error puntual y mostrar *"Tu Google Drive
  se quedó sin espacio — liberá lugar o ampliá tu almacenamiento en Google,
  y volvé a intentar"*, distinto del mensaje de error genérico.
- Alcance: subida individual (foto/video/audio de un día), carga masiva
  (Home y dentro de álbum), grabación de audio.
- Nota: esto no es un riesgo nuevo de la suscripción — ya existe hoy, gratis,
  para cualquiera. Vale la pena arreglarlo en general.

## Caso 2: archivo de media borrado a mano desde Drive

**Síntoma hoy:** `setAuthImg` (`drive.js:420`) deja el ícono roto del
navegador si tanto la thumbnail pública como la API autenticada fallan.
`fetchAuthImgUrl`/`fetchFileAsDataUrl` tampoco chequean `res.ok` — un `404`
se trata como si fuera contenido válido, lo que puede generar un blob
corrupto en vez de fallar de forma clara.

**Propuesto:**
- `fetchAuthImgUrl` y `fetchFileAsDataUrl`: chequear `res.ok` antes de
  devolver el blob; si no, devolver/lanzar algo que el llamador pueda
  distinguir de un éxito real.
- `setAuthImg`: si no se puede resolver el archivo, mostrar un placeholder
  visual (ícono + "Archivo no disponible") en vez de dejar el ícono roto
  del navegador.
- Mismo criterio para el reproductor de video/audio y el lightbox.
- **Fuera del alcance inicial** (evaluar después de ver si el Caso 3 ya
  cubre la mayoría de los casos reales): ofrecer un botón para "quitar esta
  referencia rota" y limpiar `day.json`.

## Caso 3: `day.json` borrado pero la carpeta del día sigue con archivos

**Síntoma hoy:** `loadDayFromDrive` (`drive.js:284`) devuelve `null` si no
encuentra `day.json`, sin mirar si la carpeta tiene archivos igual. El día
completo desaparece de Lista/Mes/Libro aunque las fotos sigan en Drive.

**Propuesto:**
- Si `day.json` no existe, listar los archivos que sí están en esa carpeta
  y reconstruir un `day.json` básico en memoria: `{ title: '', notes: '',
  media: [...archivos encontrados, sin caption] }`.
- **No** escribirlo de vuelta a Drive automáticamente — evitar sorprender
  generando un archivo que nadie pidió. Se persiste recién si el usuario
  edita y guarda ese día desde la app.
- Comunicarlo con un aviso sutil en la UI (ej. "Este día se reconstruyó a
  partir de archivos encontrados — el título y las notas no se pudieron
  recuperar") — limitación real, no hay forma de recuperar texto que ya no
  existe en ningún lado.

---

## Explícitamente fuera de este plan

- No cambia el modelo de "el usuario es dueño y puede borrar lo que
  quiera" — esto es manejo de errores, no una restricción nueva.
- No implementa recuperación de título/notas si se borró `day.json` (no es
  técnicamente posible).
- No toca la papelera de Drive ni su ventana de recuperación de 30 días
  (ya existe, es de Google, ver CLAUDE.md → "Eliminar borra de verdad").

## Cuándo ejecutarlo

A diferencia del plan de analytics, esto no depende de tener más usuarios
— es una mejora de robustez que beneficia a cualquiera desde el día 1.
Si se prioriza algo primero, el Caso 1 (cuota) es el más directamente
ligado a la conversación de monetización.
