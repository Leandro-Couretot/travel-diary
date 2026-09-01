const { createClient } = require('@supabase/supabase-js');

let client = null;

// Un solo cliente reusado entre invocaciones "calientes" de la function
// (Cloud Functions reusa la instancia de Node cuando puede).
//
// El proyecto Supabase (pluxow-clients) es compartido entre varios clientes
// de la agencia — cada uno vive en su propio schema aislado (ver doc de
// arquitectura Supabase de Pluxow). El de esta app es "travel_diary", nunca
// "public": mandarle db.schema acá alcanza para que TODAS las queries
// (.from('subscriptions'), etc.) apunten siempre a ese schema.
const SCHEMA = 'travel_diary';

function getSupabaseClient(url, serviceRoleKey) {
  if (!client) {
    client = createClient(url, serviceRoleKey, {
      auth: { persistSession: false },
      db: { schema: SCHEMA },
    });
  }
  return client;
}

module.exports = { getSupabaseClient };
