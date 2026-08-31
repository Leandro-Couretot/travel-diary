const { createClient } = require('@supabase/supabase-js');

let client = null;

// Un solo cliente reusado entre invocaciones "calientes" de la function
// (Cloud Functions reusa la instancia de Node cuando puede).
function getSupabaseClient(url, serviceRoleKey) {
  if (!client) {
    client = createClient(url, serviceRoleKey, {
      auth: { persistSession: false },
    });
  }
  return client;
}

module.exports = { getSupabaseClient };
