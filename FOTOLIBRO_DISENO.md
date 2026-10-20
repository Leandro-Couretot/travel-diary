# Fotolibro: avances del artefacto de diseño

Estado al 20/oct/2026 (versión 11 del artefacto). Retomar desde acá.

- **Artefacto (Design):** https://claude.ai/artifact/1swSxbxYkgivRmNgRRnqwz ("Fotolibro Legado")
- **Archivo del artefacto:** `project/Main.dc.html` (un solo artboard de 390x844, `canvas.json` sin cambios). Para retomarlo: `Artifact` con `action: "read"` sobre la URL de arriba, leer `project/Main.dc.html`, editarlo y republicar en la misma URL con `root` y `file_path`.
- **Alcance:** es un mockup interactivo, no toca código de la app (`app.html`). Implementarlo en la app real sería una entrega aparte con el flujo completo de CLAUDE.md (entrada en "Funcionando bien", bump de versión en `APP_VERSION` y `version.json`, deploy).

## Flujo (3 pasos, navegación lineal)

Sin tabs adentro de tabs (la app ya tiene Galería / Calendario / Fotolibro). Arriba hay una barra de progreso con "Paso N de 3" y abajo una barra con **Atrás / Siguiente**.

1. **Tapa**
2. **Páginas** (se recorre página por página con "Página anterior / Página siguiente")
3. **Revisar e imprimir** (antes era el botón "Ver todas"; reemplaza al visor oscuro de página por página)

## Paso 1: Tapa

- La vista previa de la tapa es fija. **No se cambia al tocarla** (decisión del usuario). Hoy no hay forma de elegir la foto de portada, ver "Pendientes".
- Debajo de la vista previa: campos de **título** y **subtítulo**, y una fila de 4 botones que abren un panel justo abajo (uno a la vez, tocar de nuevo lo cierra). Cada botón muestra su valor actual.
  - **Diseño:** 4 diseños distintos entre sí.
    - *Foto:* foto a página completa con el texto sobre un degradé del color elegido. Es el único con foto.
    - *Rayado:* tela con rayas verticales (antes "Lino"), texto abajo. Subtítulo en negrita con letras separadas. Pasa el texto al centro al elegirlo.
    - *Marco:* sin foto, color liso con doble filete fino y el título centrado. Pasa el texto al centro al elegirlo.
    - *Editorial:* sin foto, título grande arriba con una rayita debajo y subtítulo chico abajo.
  - **Color:** dos pasos. 1) ocho combinaciones listas (Bosque, Noche, Bordó, Negro y oro, Crema, Lino rosado, Arena, Salvia) que cambian fondo y texto juntos. 2) dos filas grandes "Color de fondo" y "Color del texto" con selector de color libre. Los colores de ejemplo no son los del brandbook.
  - **Ubicación:** texto a izquierda, centro o derecha.
  - **Tipografía del título:** Clásica (DM Serif Display), Elegante (Cormorant Garamond), Manuscrita (Nothing You Could Do), Moderna (Montserrat, mayúsculas espaciadas). El subtítulo queda siempre en DM Sans.
- Diseño y color están separados (pedido del usuario). Se sacó el collage y la "Franja".
- Referencia de estilo que mandó el usuario: tapa de tela clara con "Lu & Lea" en letra manuscrita rosa y "2025" en negrita espaciada, abajo y centrado. Es la base del diseño Rayado.

## Paso 2: Páginas

- **La primera página va en blanco** (no repite el título de la tapa). Es fija: no se mueve ni se puede soltar otra antes de ella.
- Páginas de capacidad fija: cada layout define sus lugares y los vacíos se muestran con un "+" punteado (mismo modelo que `book.json` v3 de la app).
- Botón **Diseño** abre una hoja inferior con 7 layouts (1, 2, 2 lado a lado, 3, 3 B, 4, 4 B). Permite pasar una página de 2 fotos a una de 3: conserva las fotos que ya tenía, completa los lugares nuevos con "fotos sin usar" (o los deja vacíos) y devuelve las que sobran a "fotos sin usar".
- Otros botones: Cambiar, Encuadrar (solo simulado, apunta al editor de encuadre que ya existe en la app), Texto (fecha y caption), caption editable y bandeja de "Fotos sin usar".

## Paso 3: Revisar e imprimir

- Vista de cuadrícula con el libro completo en orden: **tapa, páginas, "+ Página", contratapa**. Tocar la tapa o una página vuelve a editarla.
- Las páginas se **reordenan arrastrando** (eventos de puntero; el toque corto sigue abriendo la página). La página 1 queda fija.
- Chequeos arriba: tapa lista, cantidad de páginas, lugares vacíos (naranja, tocable, con un puntito naranja en la miniatura de esas páginas) y fotos sin usar (no se imprimen).
- Barra inferior: "Volver a editar" y "Generar PDF" (por ahora solo un aviso).

## Pendientes y dudas abiertas

1. **Foto de portada:** al sacar el toque en la tapa no hay forma de elegirla. Opciones: un botón "Foto" dentro del panel de Diseño, o un botón aparte "Cambiar foto de tapa" junto a los otros cuatro.
2. ¿Querés **otro diseño con foto** (por ejemplo foto en recuadro con el texto debajo)? Hoy solo Foto la usa.
3. En *Foto*, "Color de fondo" es el del degradé donde va el texto, no el de toda la tapa. ¿Se entiende o se renombra según el diseño?
4. ¿Los paneles de la tapa arrancan cerrados (como ahora) o con "Diseño" abierto?
5. **Tipografía del subtítulo:** hoy fija. ¿Se puede elegir?
6. **Selector "Otro" de color:** depende del navegador (en celular abre la rueda del sistema). Una paleta propia sería más trabajo.
7. **Nombre del paso "Páginas":** ¿se queda o se renombra (Armar, Contenido)?
8. **Lugares vacíos** al subir la cantidad de fotos de una página sin fotos sin usar: hoy quedan vacíos con "+". ¿Alcanza?
9. **Reordenar páginas:** ¿botones "mover antes / después" como alternativa al arrastre cuando hay muchas páginas? ¿Se puede mover la página 1?
10. Los colores de ejemplo hay que cambiarlos por la paleta del brandbook cuando la diseñadora la defina.

## Notas técnicas del artefacto

- Formato Design: `<x-dc>` con `{{valores}}`, `<sc-if>`, `<sc-for>`, `onClick`/`onChange` (y `onPointerDown/Move/Up/Cancel` para el arrastre; hay que probarlos en el dispositivo real) y un `class Component extends DCLogic` con `renderVals()`.
- Estado: `step` (`cover` | `pages` | `review`), `cover` (`full` | `linen` | `frame` | `edit`), `coverBg`, `coverInk`, `coverAlign`, `coverFont`, `coverPanel`, `pages` (la página 0 es `{isTitle:true}` y se renderiza en blanco), `unused`, `dragFrom`/`dragOver` para el arrastre.
- Fuentes de Google cargadas en el `<head>`: DM Serif Display, DM Sans, Cormorant Garamond, Nothing You Could Do, Montserrat.
- Regla del tipo de artefacto: no verificar visualmente salvo que el usuario lo pida. Hasta ahora solo se revisó la sintaxis del script con `node --check`. **Nada se probó todavía en pantalla ni con el dedo.**
