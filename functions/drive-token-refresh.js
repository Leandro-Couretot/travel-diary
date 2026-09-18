const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { getSupabaseClient } = require('./lib/supabase');
const { verifySession } = require('./lib/session');

const GOOGLE_CLIENT_ID = defineSecret('GOOGLE_CLIENT_ID');
const GOOGLE_CLIENT_SECRET = defineSecret('GOOGLE_CLIENT_SECRET');
const SESSION_JWT_SECRET = defineSecret('SESSION_JWT_SECRET');
const SUPABASE_URL = defineSecret('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = defineSecret('SUPABASE_SERVICE_ROLE_KEY');

// Mints un access_token de Drive nuevo a partir del refresh_token guardado
// en Supabase (ver CLAUDE.md → "Auth de Drive: de implícito a refresh_token
// real") — reemplaza al refresh silencioso basado en cookies de Google del
// navegador (trySilentRefresh()/tryEagerSilentRefresh(), v1.20/v1.90), que
// nunca fue confiable en Safari/PWA. Autenticado con el JWT de sesión propio
// (30 días de vida, mucho más robusto que el access_token de Drive que
// vence a la hora) — nunca con el propio access_token de Drive, que es
// justamente lo que puede estar vencido cuando se llega acá.
exports.driveTokenRefresh = onRequest(
  {
    region: 'southamerica-east1',
    secrets: [GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SESSION_JWT_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY],
    enforceAppCheck: true, // ver CLAUDE.md → "App Check"
    maxInstances: 10, // ver CLAUDE.md → "Techo de instancias (maxInstances)"
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method_not_allowed' });
      return;
    }

    const session = verifySession(req, SESSION_JWT_SECRET.value());
    if (!session) {
      res.status(401).json({ error: 'invalid_session' });
      return;
    }

    try {
      const supabase = getSupabaseClient(SUPABASE_URL.value(), SUPABASE_SERVICE_ROLE_KEY.value());
      const { data: row, error } = await supabase
        .from('subscriptions')
        .select('drive_refresh_token')
        .eq('google_sub', session.sub)
        .maybeSingle();

      if (error) {
        console.error('Supabase select error:', error);
        res.status(500).json({ error: 'lookup_failed' });
        return;
      }
      if (!row || !row.drive_refresh_token) {
        // Cuenta todavía no migrada al flujo nuevo (o nunca conectó) — el
        // frontend cae al mecanismo viejo (silencioso vía Google) como red
        // de seguridad, o pide reconectar si eso también falla.
        res.status(404).json({ error: 'no_refresh_token' });
        return;
      }

      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          refresh_token: row.drive_refresh_token,
          client_id: GOOGLE_CLIENT_ID.value(),
          client_secret: GOOGLE_CLIENT_SECRET.value(),
          grant_type: 'refresh_token',
        }),
      });

      if (!tokenRes.ok) {
        // El caso típico acá es invalid_grant — el usuario revocó el acceso
        // desde myaccount.google.com/permissions, o Google invalidó el
        // refresh_token por inactividad prolongada. Se borra el que
        // teníamos guardado (ya no sirve) para que la próxima vez el
        // frontend sepa de una que hace falta un reconectar real, en vez de
        // reintentar con un refresh_token muerto en cada arranque.
        await supabase.from('subscriptions').update({ drive_refresh_token: null }).eq('google_sub', session.sub);
        res.status(401).json({ error: 'refresh_token_invalid' });
        return;
      }

      const tokens = await tokenRes.json(); // { access_token, expires_in, scope, token_type }
      res.status(200).json({ access_token: tokens.access_token, expires_in: tokens.expires_in });
    } catch (e) {
      console.error('drive-token-refresh error:', e);
      res.status(500).json({ error: 'internal_error' });
    }
  }
);
