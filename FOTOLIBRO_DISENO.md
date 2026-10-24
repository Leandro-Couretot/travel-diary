# Fotolibro: avances del artefacto de diseño

Estado al 22/oct/2026 (versión 25 del artefacto). Retomar desde acá.

- **Artefacto (Design):** https://claude.ai/artifact/1swSxbxYkgivRmNgRRnqwz ("Fotolibro Legado")
- **Archivo del artefacto:** `project/Main.dc.html` (un solo artboard de 390x844, `canvas.json` sin cambios). Para retomarlo: `Artifact` con `action: "read"` sobre la URL de arriba, leer `project/Main.dc.html`, editarlo y republicar en la misma URL con `root` y `file_path`.
- **Alcance:** es un mockup interactivo, no toca código de la app (`app.html`). Implementarlo en la app real sería una entrega aparte con el flujo completo de CLAUDE.md (entrada en "Funcionando bien", bump de versión en `APP_VERSION` y `version.json`, deploy).

## Flujo (3 pasos, navegación lineal)

Sin tabs adentro de tabs (la app ya tiene Galería / Calendario / Fotolibro). Arriba hay una barra de progreso con "Paso N de 3" y abajo una barra con **Atrás / Siguiente**.

1. **Tapa**
2. **Páginas** (se recorre página por página con "Página anterior / Página siguiente")
3. **Revisar e imprimir** (antes era el botón "Ver todas"; reemplaza al visor oscuro de página por página)

## Paso 1: Tapa

- La vista previa de la tapa es fija. **No se cambia al tocarla** (decisión del usuario). La foto de portada se elige con un quinto botón **Foto**, que aparece solo cuando el diseño es *Foto* (el único con foto; los otros tres no llevan foto). Abre una grilla para elegir la foto.
- Debajo de la vista previa: campos de **título** y **subtítulo**, y una fila de 4 botones (5 con *Foto*) que abren un panel justo abajo (uno a la vez, tocar de nuevo lo cierra). Cada botón muestra su valor actual.
  - **Diseño:** 4 diseños distintos entre sí.
    - *Rayado:* tela con rayas verticales (antes "Lino"), texto abajo. Subtítulo en negrita con letras separadas. Pasa el texto al centro al elegirlo.
    - *Marco:* sin foto, color liso con doble filete fino y el título centrado. Pasa el texto al centro al elegirlo.
    - *Editorial:* sin foto, título grande arriba con una rayita debajo y subtítulo chico abajo.
    - *Foto* (el último de la lista, decisión del usuario 22/oct): la foto va dentro de un cuadro arriba (no ocupa toda la tapa, decisión del usuario 22/oct) y el fondo es el mismo degradé que los otros diseños, con el texto abajo. Es el único con foto. Mientras no se elige ninguna, el cuadro se ve vacío y punteado, con un ícono y "Tu foto va acá" (también en la miniatura del panel Diseño). El libro arranca con el diseño *Rayado*.
  - **Color:** sin combinaciones listas (decisión del usuario, 22/oct). Tres selectores libres: "Color de arriba", "Color de abajo" y "Color del texto", con una barrita que muestra el degradé resultante. El fondo de la tapa es siempre el degradé entre arriba y abajo (si son iguales queda liso). Los colores de ejemplo no son los del brandbook.
  - **Ubicación:** texto a izquierda, centro o derecha.
  - **Tipografía del título:** Clásica (DM Serif Display), Elegante (Cormorant Garamond), Manuscrita (Nothing You Could Do), Moderna (Montserrat, mayúsculas espaciadas). El subtítulo queda siempre en DM Sans.
- Diseño y color están separados (pedido del usuario). Se sacó el collage y la "Franja".
- Referencia de estilo que mandó el usuario: tapa de tela clara con "Lu & Lea" en letra manuscrita rosa y "2025" en negrita espaciada, abajo y centrado. Es la base del diseño Rayado.

- **Contratapa:** selector "Tapa | Contratapa" arriba de la vista previa. La contratapa es siempre lisa (sin texto ni foto) y usa exactamente el mismo fondo que la tapa: el mismo degradé, y en *Rayado* también la misma tela con rayas, para que tapa y contratapa se vean del mismo color (pedido del usuario, 22/oct). Cambia sola si cambian los colores, con el lomo del lado derecho. Sin controles propios; tiene un botón "Cambiar colores de la tapa". En el paso 3, tocar la contratapa abre esta vista. Decisión del usuario (22/oct): queda siempre totalmente lisa.

- **Actualización v2.157 (23/oct/2026):** en la app la tapa quedó como la opción 2 del artefacto "Tapa del fotolibro: dos opciones" (https://claude.ai/artifact/62JG5Xue4nGDrLTMhx2S8g), elegida por el usuario: la tapa ocupa todo el alto libre y nunca se scrollea; abajo una fila fija de botones en este orden: **Diseño, Texto, Color, Ubicación, Tipografía** (y Foto en el diseño Foto). Cada botón abre una franja baja con sus opciones y la tapa se achica para seguir viéndose entera. Título y subtítulo están dentro de Texto.

## Paso 2: Páginas

- **La primera página va en blanco** (no repite el título de la tapa). Es fija: no se mueve ni se puede soltar otra antes de ella.
- Páginas de capacidad fija: cada layout define sus lugares y los vacíos se muestran con un "+" punteado (mismo modelo que `book.json` v3 de la app).
- Botón **Diseño** abre una hoja inferior con 7 layouts (1, 2, 2 lado a lado, 3, 3 B, 4, 4 B). Permite pasar una página de 2 fotos a una de 3: conserva las fotos que ya tenía, completa los lugares nuevos con "fotos sin usar" (o los deja vacíos) y devuelve las que sobran a "fotos sin usar". Los lugares vacíos muestran un "+": tocarlo suma la primera foto sin usar (decisión del usuario, 22/oct); después se puede cambiar tocando esa foto y otra de la bandeja.
- Otros botones: Encuadrar (solo simulado, apunta al editor de encuadre que ya existe en la app), Texto (abre un panel con tres cosas, todas opcionales: **Título** arriba de las fotos, grande y centrado; **Pie de página** abajo, chico y en cursiva; y un interruptor para mostrar la **fecha** a la derecha del pie. Campo vacío = no se muestra nada; ya no hay interruptor de texto aparte). Decisiones del usuario (22/oct): título, pie y fecha tienen el mismo estilo en todo el libro, y no se elige tipografía del texto de las páginas por ahora. No hay botón "Cambiar" (decisión del usuario, 22/oct): para cambiar una foto se toca la foto y después una de "Fotos sin usar", y bandeja de "Fotos sin usar".

## Paso 3: Revisar e imprimir

- Vista de cuadrícula con el libro completo en orden: **tapa, páginas, "+ Página", contratapa**. Tocar la tapa o una página vuelve a editarla.
- Las páginas se **reordenan arrastrando** (sin botones de mover; decisión del usuario: la página 1 queda fija y sin botones) (eventos de puntero; el toque corto abre la página; en celular hay que mantener apretado unos 0,4 segundos para arrastrar, así el scroll vertical no reordena nada; con mouse se arrastra directo). La página 1 queda fija.
- Chequeos arriba: tapa lista, cantidad de páginas, lugares vacíos (naranja, tocable, con un puntito naranja en la miniatura de esas páginas) y fotos sin usar (no se imprimen).
- Barra inferior: "Volver a editar" y "Generar PDF" (por ahora solo un aviso).

## Pendientes y dudas abiertas

Decididas el 22/oct/2026: foto de portada solo en el diseño Foto (botón Foto), contratapa siempre lisa, "+" suma la primera foto sin usar, página 1 fija y sin botones de mover.

Quedan como están (sin decidir cambios, el usuario los acepta por ahora): paneles de la tapa arrancan cerrados, nombre del paso "Páginas", tipografía del subtítulo fija, selector de color del navegador.

Para después del mockup:
- Pasarlo a la app real (`app.html`): entrega aparte con entrada en "Funcionando bien", bump de versión y deploy.
- Cambiar los colores de ejemplo por la paleta del brandbook cuando la diseñadora la defina.
- Otro diseño con foto (por ejemplo foto en recuadro con el texto debajo): no hace falta para cerrar.
- Probar todo en el celular (nada se probó todavía con el dedo): arrastre con pulsación larga, degradé de la tapa en los cuatro diseños, panel de texto de las páginas y botón Foto.

## Pasar a la app: plan y modelo de negocio (22/oct/2026)

**Modelo de negocio del fotolibro (decisión del usuario, 22/oct):** el libro impreso se vende. Se paga por hoja con fotos (precio todavía sin definir), el usuario Pro tiene 20% de descuento y el Free paga precio lleno. Pago único con Mercado Pago. Con el pago confirmado se manda un mail de confirmación al usuario y a la esposa del usuario; ella imprime el libro y lo envía por correo. Se saca el "1 PDF gratis por mes" (v1.59).

**Decisiones ya tomadas:**
- Todos los libros existentes suman una página en blanco adelante (la página 1 del mockup), sin mover ni perder fotos.
- En el lomo no va nada.
- Colores iniciales de la tapa: los del mockup (verde), hasta que llegue la paleta del brandbook.

**Entregas propuestas (cada una a producción por separado, probando en el celular entre una y otra):**
1. Tapa (paso 1 del mockup), guardada en el fotolibro. **Hecho en v2.151 (ver HISTORIAL.md).** La página 1 en blanco queda para la entrega 2.
2. Páginas (paso 2): página por página, bandeja de fotos sin usar, "+" que suma la primera sin usar, título, pie y fecha. **Hecho en v2.155 (ver HISTORIAL.md)**, con dos decisiones nuevas del usuario (22/oct): margen blanco fijo en los cuatro lados, con el título y el pie en el margen (las fotos no cambian de tamaño), y la fecha automática como rango ("13 al 15 de agosto de 2026") pero editable a mano. La página 1 en blanco también quedó hecha.
3. Revisar (paso 3): grilla con tapa, páginas y contratapa, chequeos y arrastre. Se saca la grilla vieja. **Hecho en v2.156 junto con el rearmado de todo el fotolibro como el mockup** (pantalla completa, progreso "Paso N de 3" y barra Atrás/Siguiente). El usuario pidió que la app se vea como el artefacto: v2.151 y v2.155 habían quedado como ventanas encima de la grilla vieja.
4. Pedido y pago: precio por hoja con 20% Pro, datos de envío, pago único con Mercado Pago, archivo para imprimir, mails al usuario y a la esposa. Se saca el PDF gratis.

**Idea del usuario para el último paso (22/oct):** en vez de "Generar PDF", el paso final es pedir el libro (el usuario lo llamó "agregar al carrito"). Ahí se piden los datos de envío y se aclara que el pedido lo revisa una persona antes de imprimirlo y que tarda unos 14 días. Después se muestra el pago con Mercado Pago.

**Mercado Envíos (investigado el 22/oct, sin confirmar):** Checkout Pro con la API de Preferencias acepta un bloque `shipments` con `mode: "me2"` y las medidas y el peso del paquete; con eso Mercado Pago pide la dirección, calcula el costo del envío y da la etiqueta. La documentación de Argentina no lo confirmó, y la cuenta de Mercado Pago tiene que tener Mercado Envíos habilitado (no siempre está disponible fuera de Mercado Libre). Además Mercado Pago recomienda la API de Orders para integraciones nuevas. Pendiente: que el usuario revise en su cuenta si tiene Mercado Envíos, o consultarlo a soporte de Mercado Pago. Plan B: envío con costo fijo (o incluido en el precio) y la esposa lo despacha por Correo Argentino o Andreani.

**Respuesta del agente de Mercado Pago (24/oct):** propuso usar las APIs de Mercado Libre (ecosistema Mercado Libre Developers, no Mercado Pago) y él mismo aclaró que usar Mercado Envíos por API "suele depender de cómo existe la venta/orden dentro de ML". La documentación oficial de envíos de Mercado Libre está pensada para publicaciones dentro de Mercado Libre; no se encontró nada oficial que permita generar envíos para una venta cobrada con Checkout Pro en una web propia. Andreani pediría unos 300 envíos por mes para dar acceso a su API (dato de un plugin de terceros, sin confirmar). Recomendación de Claude: arrancar sin integración (costo de envío fijo o por zona, cobrado en el mismo pago; la esposa despacha por MiCorreo de Correo Argentino y carga el número de seguimiento en la app, que se lo manda al usuario) e integrar un agregador o un correo por API recién cuando haya volumen. Pregunta clave para Soporte Developers de Mercado Libre, si se quiere confirmar: "¿Puedo generar envíos de Mercado Envíos para ventas cobradas con Checkout Pro en mi web, sin publicar el producto en Mercado Libre?". Pendiente la decisión del usuario.

**Idea del usuario (24/oct): vender el libro con una publicación propia en Mercado Libre** (la suscripción sigue por Mercado Pago). El libro se crea en Mercado Libre con "tiempo de fabricación" de unos 14 días y Mercado Envíos; "Pedir libro" en Legado lleva a esa publicación y la venta ocurre dentro de Mercado Libre, así el envío y la etiqueta los resuelve Mercado Libre. Lo que habría que resolver: (1) precio por hoja con una publicación de precio fijo, usando variantes por cantidad de hojas; (2) el 20% Pro (sacarlo para el libro, cupón, o alguna otra vuelta); (3) unir la compra con el libro armado: propuesta de Claude, que el usuario pegue en Legado el número de compra y la app lo verifique con la API de órdenes de Mercado Libre (pagada, variante correcta), lo que requiere una app en Mercado Libre Developers, autorizar una vez la cuenta vendedora (refresh token guardado del lado del servidor) y recibir las notificaciones de órdenes. Costos: comisión de Mercado Libre y, según el precio, envío gratis obligatorio pagado en parte por el vendedor (confirmar valores vigentes). Sin decidir.

**Dudas abiertas de la entrega 4** (preguntadas al usuario el 22/oct, sin respuesta todavía): si se cobra por página con fotos o por hoja física (dos caras); si el usuario puede seguir descargando el PDF; envío (cobro aparte o incluido, solo Argentina, qué datos pedir); qué archivo necesita la esposa para imprimir (si imprime ella o manda a una imprenta); dónde queda el archivo (propuesta: en el Drive del usuario, compartido con la esposa); proveedor de mails (propuesta: Resend, con el dominio verificado en Cloudflare). También hay que actualizar `privacy.html` y `terms.html` (venta de un producto físico, datos de envío, la esposa ve las fotos del libro) y retomar la inscripción ante la AAIP (ver "Pendientes conocidos" de CLAUDE.md).

## Notas técnicas del artefacto

- Formato Design: `<x-dc>` con `{{valores}}`, `<sc-if>`, `<sc-for>`, `onClick`/`onChange` (y `onPointerDown/Move/Up/Cancel` para el arrastre; hay que probarlos en el dispositivo real) y un `class Component extends DCLogic` con `renderVals()`.
- Estado: `step` (`cover` | `pages` | `review`), `cover` (`full` | `linen` | `frame` | `edit`), `coverBg`, `coverInk`, `coverAlign`, `coverFont`, `coverPanel`, `pages` (la página 0 es `{isTitle:true}` y se renderiza en blanco), `unused`, `dragFrom`/`dragOver` para el arrastre.
- Fuentes de Google cargadas en el `<head>`: DM Serif Display, DM Sans, Cormorant Garamond, Nothing You Could Do, Montserrat.
- Regla del tipo de artefacto: no verificar visualmente salvo que el usuario lo pida. Hasta ahora solo se revisó la sintaxis del script con `node --check`. **Nada se probó todavía en pantalla ni con el dedo.** En especial hay que probar en el celular el arrastre con pulsación larga y que el scroll de la grilla del paso 3 ya no mueva páginas.
