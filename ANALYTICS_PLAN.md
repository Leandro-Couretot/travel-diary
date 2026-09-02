# Plan de medición / analytics — Travel Diary

**Estado: PLAN A FUTURO, NO EJECUTADO.** Nada de lo que describe este documento
está implementado — ni la tabla nueva, ni la Cloud Function, ni las llamadas
del frontend. Se guarda en el repo para poder retomarlo cuando haga falta,
revisando primero si sigue vigente (puede que para entonces se sepa más sobre
qué funciones quedan pagas, cuántos usuarios reales hay, etc.).

---

## Por qué esto no es "agregar una tabla más"

`travel_diary.subscriptions` es una **tabla de estado**: se pisa, guarda "cómo
está esto ahora". `travel_diary.subscription_events` es un **event log**:
insert-only, guarda "qué pasó y cuándo", nunca se pisa. Lo que describe este
plan es una extensión del segundo patrón — un log de eventos de producto,
separado de `subscription_events` porque ese es específicamente la auditoría
de lo que dice Mercado Pago, no un lugar para mezclar clicks de UI.

## Principio rector: privacidad primero (no negociable)

Hoy el contenido del diario — fotos, videos, audios, texto de títulos y notas
— vive **exclusivamente** en el Google Drive de cada usuario. El backend ni
siquiera tiene permiso para leerlo (scope `drive.file`, ver CLAUDE.md). Esa
separación es una promesa implícita del producto y no la vamos a romper para
tener mejores gráficos.

**Regla dura para todo lo que sigue: se mandan conteos y booleanos, nunca
contenido.**

| Se puede medir | No se manda nunca |
|---|---|
| Cantidad de fotos en un día guardado | El archivo de la foto |
| Si el día tiene título cargado (sí/no) | El texto del título |
| Si el día tiene notas cargadas (sí/no) | El texto de las notas |
| Cantidad de álbumes compartidos, y con qué rol | El email del invitado (evaluar hashear si hace falta) |
| Que ocurrió un error, en qué función | El stack trace completo si puede contener datos del usuario |

## Qué se propone medir, por etapa (AARRR)

| Etapa | Pregunta que responde | Evento propuesto |
|---|---|---|
| Activación | ¿Los usuarios nuevos llegan a crear contenido? | `album_created`, `day_saved` (primera vez) |
| Uso / Engagement | ¿Cuánto contenido cargan? ¿Usan notas/títulos? | `day_saved` (con `photo_count`, `has_title`, `has_notes`) |
| Uso / Engagement | ¿Con qué frecuencia entran? (día/semana/mes) | `login` (uno por sesión, no por request) |
| Uso / Engagement | ¿Qué tab del diario usan más (Día/Lista/Mes/Libro)? | `tab_viewed` (con `tab`) |
| Referidos | ¿Comparten álbumes? ¿Como lectores o editores? | `album_shared` (con `role`) |
| Revenue | ¿Cuántos abren el modal de pago vs. cuántos llegan a pagar? | Ya cubierto parcialmente por `subscriptions.status = 'pending'` vs `'authorized'` — ver conversación previa |
| Confiabilidad | ¿Dónde fallan las cosas? (subida de fotos, Drive API, etc.) | `error` (con `context`, `message` acotado) |

## Diseño técnico propuesto (NO ejecutar todavía)

### Tabla nueva: `usage_events`

Una sola tabla flexible (nombre del evento + propiedades en JSON) en vez de
una tabla por tipo de evento — más simple de mantener y de consultar a esta
escala.

```sql
-- PROPUESTO, NO EJECUTAR. Agregar a functions/schema.sql recién cuando
-- se decida implementar esto de verdad.
create table if not exists travel_diary.usage_events (
  id           bigserial primary key,
  google_sub   text references travel_diary.subscriptions(google_sub),
  event_name   text not null,     -- 'login' | 'day_saved' | 'album_shared' | 'error' | 'tab_viewed' | ...
  event_props  jsonb not null default '{}',
  occurred_at  timestamptz not null default now()
);

alter table travel_diary.usage_events enable row level security;
-- Mismo patrón que las otras dos tablas: sin policies, solo service_role.

grant usage on schema travel_diary to service_role; -- ya deberia existir
grant all on all tables in schema travel_diary to service_role;
grant all on all sequences in schema travel_diary to service_role;
```

### Cloud Function nueva: `track-event.js`

- `POST /api/track`, mismo patrón de auth que `checkout-create.js` /
  `subscription-status.js`: valida el JWT de `td_session` (nunca acepta un
  `google_sub` que mande el cliente sin validar).
- Body: `{ event_name, event_props }`. Inserta en `usage_events` con el
  `google_sub` que sale del JWT, nunca del body.
- Responde rápido y no bloquea — el frontend lo llama "fire and forget"
  (no espera la respuesta ni bloquea la UI si falla).
- A este volumen (una app chica) el costo extra en Cloud Run es
  insignificante; si en el futuro esto crece mucho, ahí sí conviene evaluar
  agrupar eventos en batches en vez de un request por evento.

### Puntos de instrumentación en el frontend (`app.html` / `drive.js`)

- Login exitoso (dentro de `establishSession()` en `billing.js`, después de
  que responde OK) → `login`.
- Después de un `saveDayToDrive()` exitoso → `day_saved` con
  `{ photo_count, has_title: !!title, has_notes: !!notes }`.
- Al cambiar de tab en el diario (Día/Lista/Mes/Libro) → `tab_viewed` con
  `{ tab }`.
- Dentro de `shareAlbumWithUser()`, tras compartir con éxito → `album_shared`
  con `{ role }` (nunca el email del invitado, o hasheado si se necesita
  contar invitados únicos).
- En los `catch` ya existentes de operaciones críticas (subida de media,
  llamadas a Drive API que fallan) → `error` con `{ context, message }`
  (mensaje acotado, sin volcar objetos completos que puedan traer datos
  personales).

## Cómo se analizaría (sin herramientas nuevas, al menos al principio)

A esta escala no hace falta conectar un BI — alcanza con el SQL Editor de
Supabase. Ejemplos ilustrativos (para cuando exista la tabla):

```sql
-- Logins por semana (para ver estacionalidad de uso)
select date_trunc('week', occurred_at) as semana, count(*) 
from travel_diary.usage_events 
where event_name = 'login' 
group by 1 order by 1;

-- % de usuarios nuevos que guardaron al menos un día en sus primeros 7 días
-- (métrica de activación real, no de vanidad)
```

## Explícitamente fuera de este plan

- No se manda contenido real (fotos, texto de notas/títulos) a Supabase, nunca — ver "Principio rector" arriba.
- No se arma ningún dashboard ni se conecta ninguna herramienta externa de analytics todavía.
- No se define todavía una cadencia fija de revisión (semanal/mensual) — se decide cuando se retome esto, junto con cuáles de las métricas de arriba siguen importando.

## Cuándo retomarlo

Cuando exista una decena de usuarios reales, o una pregunta de negocio
concreta que hoy no se pueda responder sin esto (ej: "¿el fotolibro hace que
la gente pague más?"). Antes de eso, con 1-2 usuarios de prueba, cualquier
número acá sería ruido, no señal.
