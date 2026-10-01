-- Travel Diary — schema de Supabase
--
-- Fuente de verdad del schema `travel_diary` dentro del proyecto compartido
-- de la agencia (pluxow-clients). Travel Diary vive ahí como un cliente más,
-- aislado en su propio schema (ver CLAUDE.md → "Suscripciones" para el porqué).
--
-- Cómo usar este archivo:
--   - Correrlo entero en el SQL Editor de Supabase la primera vez.
--   - A partir de ahí, cuando se agregue una tabla/columna/índice nuevo,
--     agregar el `create table` / `alter table` correspondiente ACÁ ABAJO
--     (no solo ejecutarlo a mano en Supabase) y commitear el cambio, para
--     que el repo siempre refleje el estado real de la base.
--   - Todo escrito de forma idempotente (`if not exists`) para poder
--     volver a correr el archivo completo sin romper nada.
--
-- PASOS EXTRA QUE NO SON SQL (fáciles de olvidar): crear el schema y las
-- tablas acá no alcanza para que las Cloud Functions las puedan usar.
-- Por default, Supabase (PostgREST) solo expone `public` a través de su
-- API — en Dashboard → Settings → Data API hay que:
--   1. "Exposed schemas": agregar `travel_diary`.
--   2. "Exposed tables": activar `travel_diary.subscriptions` y
--      `travel_diary.subscription_events` (el schema expuesto no alcanza
--      solo, cada tabla se activa aparte).
-- Sin esto, cualquier query de `functions/lib/supabase.js` falla en
-- silencio del lado del servidor aunque el schema y las tablas existan
-- perfectamente bien.

create schema if not exists travel_diary;

-- Una fila por usuario de Google (google_sub), con el estado de su
-- suscripción. plan/status reflejan el `preapproval` de Mercado Pago —
-- nunca se confía en el cuerpo de un webhook individual sin re-consultar.
create table if not exists travel_diary.subscriptions (
  google_sub          text primary key,
  email                text not null,
  mp_preapproval_id    text unique,
  plan                 text not null default 'free' check (plan in ('free','monthly','annual')),
  status               text not null default 'none' check (status in ('none','pending','authorized','paused','canceled')),
  current_period_end   timestamptz,
  last_payment_at      timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- v1.91 — refresh_token real de Google Drive (flujo authorization code, ver
-- CLAUDE.md → "Suscripciones" → "Auth de Drive: de implícito a refresh_token
-- real"), guardado acá para que una Cloud Function pueda pedir un
-- access_token nuevo sin depender de que el navegador todavía tenga sesión
-- de Google viva (el problema real de fondo del flujo implícito viejo).
-- Mismo nivel de confianza que el resto de esta tabla — RLS sin policies,
-- solo accesible con la service_role_key que usan las Cloud Functions,
-- nunca expuesto al cliente. Null hasta que la cuenta se conecta una vez
-- con el flujo nuevo (migración lazy, no se fuerza a nadie de una).
alter table travel_diary.subscriptions add column if not exists drive_refresh_token text;

-- Fase 3b de GROWTH_PLAN.md (Meta Pixel + Conversions API): `_fbp`/`_fbc`,
-- las cookies de primera parte que pone el Pixel (`fbp` siempre que carga en
-- cualquier visita, `fbc` solo si vino de un clic real en un anuncio con
-- `fbclid`) — capturadas por checkout-create.js al crear el `preapproval` y
-- guardadas acá para que el webhook (3c) las tenga a mano cuando Mercado
-- Pago confirma el pago, sin depender de ningún dato del usuario (nunca
-- email/teléfono — decisión explícita, ver CLAUDE.md → "Suscripciones").
alter table travel_diary.subscriptions add column if not exists fbp text;
alter table travel_diary.subscriptions add column if not exists fbc text;

-- Atribución de campaña (UTM), primer touch — capturados por app.html en la
-- primera visita (localStorage, ver captureUtmFirstTouch()) y persistidos
-- acá recién en el signup real, vía auth-session.js, SOLO si la cuenta es
-- nueva de verdad (mismo criterio que fbp/fbc arriba: un login posterior
-- nunca pisa el primer touch ya guardado). Sirve tanto para campañas de Meta
-- como, el día de mañana, de Google Ads — de ahí el nombre genérico
-- utm_adsetname/utm_adsetid/utm_adname/utm_adid en vez de algo específico de
-- una sola plataforma.
-- Términos de Servicio / Política de Privacidad (GDPR) — timestamp real de
-- consentimiento, no solo el flag de localStorage del cliente (ver
-- TERMS_VERSION/hasAcceptedTerms() en app.html). auth-session.js solo
-- escribe estos dos campos cuando es un signup nuevo o cuando la versión
-- aceptada por el cliente es más nueva que la ya guardada — un re-login
-- en la misma versión nunca pisa la fecha real de aceptación.
alter table travel_diary.subscriptions add column if not exists terms_accepted_at timestamptz;
alter table travel_diary.subscriptions add column if not exists terms_version integer;

alter table travel_diary.subscriptions add column if not exists utm_source text;
alter table travel_diary.subscriptions add column if not exists utm_medium text;
alter table travel_diary.subscriptions add column if not exists utm_campaign text;
alter table travel_diary.subscriptions add column if not exists utm_adsetname text;
alter table travel_diary.subscriptions add column if not exists utm_adsetid text;
alter table travel_diary.subscriptions add column if not exists utm_adname text;
alter table travel_diary.subscriptions add column if not exists utm_adid text;

-- Log crudo de cada notificación de Mercado Pago, para poder auditar pagos
-- después. Nunca se borra ni se actualiza, solo se inserta.
create table if not exists travel_diary.subscription_events (
  id             bigserial primary key,
  google_sub     text references travel_diary.subscriptions(google_sub),
  mp_topic       text,
  mp_resource_id text,
  raw_payload    jsonb,
  received_at    timestamptz not null default now()
);

-- Log de eventos de producto (Fase 2 de GROWTH_PLAN.md) — insert-only, nunca
-- se pisa, a diferencia de `subscriptions`. Separado de `subscription_events`
-- porque esa es específicamente la auditoría de lo que dice Mercado Pago, no
-- un lugar para mezclar clicks de UI. google_sub queda null para los pocos
-- eventos que se pueden mandar sin sesión todavía (ver track-event.js,
-- ANON_ALLOWED_EVENTS) — el arranque del embudo de registro, antes de que
-- exista ningún login. Nunca se manda contenido del diario acá, solo
-- conteos/booleanos (ver ANALYTICS_PLAN.md, "Principio rector").
create table if not exists travel_diary.usage_events (
  id           bigserial primary key,
  google_sub   text references travel_diary.subscriptions(google_sub),
  event_name   text not null,
  event_props  jsonb not null default '{}',
  occurred_at  timestamptz not null default now()
);
create index if not exists usage_events_google_sub_idx on travel_diary.usage_events (google_sub);
create index if not exists usage_events_event_name_idx on travel_diary.usage_events (event_name);

-- Links de campaña con slug corto (legadofamiliar.com.ar/{slug}) — mecanismo
-- genérico para afiliados (.../christian) y puntos de reparto en la calle
-- (.../feria), ver CLAUDE.md → "Atribución de campaña (UTM) → Supabase,
-- primer touch". campaign-link.js resuelve el slug acá y redirige a
-- app.html con estos UTMs baked-in — agregar/editar/desactivar un link es
-- un insert/update en esta tabla, sin ningún deploy. slug siempre en
-- minúscula (así lo normaliza campaign-link.js antes de buscar).
create table if not exists travel_diary.campaign_links (
  slug         text primary key,
  utm_source   text not null,
  utm_medium   text not null,
  utm_campaign text,
  active       boolean not null default true,
  notes        text,
  created_at   timestamptz not null default now()
);

-- Proxy de lectura para álbumes compartidos (v2.61) — mapea la carpeta de un
-- álbum a quién es el dueño real, para que shared-album-proxy.js sepa de
-- quién usar el refresh_token al leer contenido en nombre de un invitado.
-- Ver CLAUDE.md → "El scope drive.file no da acceso al contenido de una
-- carpeta compartida, ni siquiera con el Picker" — descubierto DESPUÉS de
-- que el picker de re-consentimiento (v2.58-v2.60) resultó no alcanzar: ese
-- scope simplemente nunca da acceso al contenido existente de una carpeta
-- que el invitado no creó, confirmado por la documentación/comunidad de
-- Google, no algo resoluble con más JS del lado del cliente. La única
-- autorización real por invitado se chequea EN VIVO contra los permisos
-- reales de Drive en cada pedido (mismo patrón que checkFolderShareApplied,
-- v2.53) — esta tabla NO guarda por-invitado, solo qué cuenta es la dueña.
create table if not exists travel_diary.shared_album_owner (
  folder_drive_id  text primary key,
  owner_google_sub text not null references travel_diary.subscriptions(google_sub),
  created_at       timestamptz not null default now()
);

-- Rol "Contribuidor" — álbumes compartidos sin pedir mail, por link/QR (ver
-- CLAUDE.md → "Álbumes compartidos: rol Contribuidor (QR, sin mail)"). Un
-- casamiento no tiene una lista cerrada de mails para pre-compartir de
-- antemano como exige permissions.create de Drive — acá la dueña genera un
-- token (no atado a ninguna cuenta puntual) y cualquiera que lo abre,
-- logueado con Google, se une con el rol indicado. `active` (toggle manual
-- de la dueña) + `expires_at` (automático) cortan NUEVAS uniones a partir de
-- ese momento — ninguno de los dos revoca retroactivamente a quien ya se
-- unió, son mecanismos independientes para el mismo corte.
create table if not exists travel_diary.shared_album_invites (
  token            text primary key,
  folder_drive_id  text not null,
  role             text not null check (role in ('contributor')),
  owner_google_sub text not null references travel_diary.subscriptions(google_sub),
  active           boolean not null default true,
  expires_at       timestamptz,
  created_at       timestamptz not null default now()
);
create index if not exists shared_album_invites_folder_idx on travel_diary.shared_album_invites (folder_drive_id);

-- Quién tiene qué rol sobre qué álbum — reemplaza, para Contribuidor, la
-- consulta en vivo a los permisos reales de Drive que usa
-- shared-album-proxy.js para lector/editor (ver guestRole() ahí): un
-- Contribuidor nunca tiene un permiso real de Drive, no hay nada que mirar
-- ahí. `role` guardado (no un simple flag) para que lector/co-propietario
-- puedan migrar acá el día de mañana sin cambiar el shape de la tabla.
create table if not exists travel_diary.shared_album_members (
  folder_drive_id  text not null,
  guest_google_sub text not null references travel_diary.subscriptions(google_sub),
  role             text not null check (role in ('contributor')),
  joined_via       text not null default 'link' check (joined_via in ('link','qr')),
  joined_at        timestamptz not null default now(),
  primary key (folder_drive_id, guest_google_sub)
);

alter table travel_diary.subscriptions enable row level security;
alter table travel_diary.subscription_events enable row level security;
alter table travel_diary.usage_events enable row level security;
alter table travel_diary.campaign_links enable row level security;
alter table travel_diary.shared_album_owner enable row level security;
alter table travel_diary.shared_album_invites enable row level security;
alter table travel_diary.shared_album_members enable row level security;
-- Sin policies = solo la service_role key (usada por las Cloud Functions)
-- puede leer/escribir. Igual que en cualquier otro cliente de la agencia.

-- Un schema creado a mano por SQL (a diferencia de uno creado con el botón
-- de la interfaz de Supabase) no le hereda estos GRANT a ningún rol —
-- "exponer" el schema en Settings > Data API solo le dice a PostgREST que
-- lo rutee, pero Postgres igual devuelve "permission denied for schema"
-- hasta que el rol tenga USAGE explícito. anon/authenticated no lo
-- necesitan (nunca tocan esta tabla, y RLS sin policies ya los bloquea
-- igual) — solo service_role, que es el que usan las Cloud Functions.
grant usage on schema travel_diary to service_role;
grant all on all tables in schema travel_diary to service_role;
grant all on all sequences in schema travel_diary to service_role;
alter default privileges in schema travel_diary grant all on tables to service_role;
alter default privileges in schema travel_diary grant all on sequences to service_role;
