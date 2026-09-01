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

alter table travel_diary.subscriptions enable row level security;
alter table travel_diary.subscription_events enable row level security;
-- Sin policies = solo la service_role key (usada por las Cloud Functions)
-- puede leer/escribir. Igual que en cualquier otro cliente de la agencia.
