const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { getSupabaseClient } = require('./lib/supabase');
const { signSession } = require('./lib/session');

const GOOGLE_CLIENT_ID = defineSecret('GOOGLE_CLIENT_ID');
const SESSION_JWT_SECRET = defineSecret('SESSION_JWT_SECRET');
const SUPABASE_URL = defineSecret('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = defineSecret('SUPABASE_SERVICE_ROLE_KEY');

// Recibe el access_token de Drive que ya tiene el frontend (el mismo que usa
// para hablarle a Google Drive) y lo valida del lado del servidor antes de
// confiar en la identidad que dice representar — nunca se acepta un
// email/sub que mande el cliente directamente.
exports.authSession = onRequest(
  {
    region: 'southamerica-east1',
    secrets: [GOOGLE_CLIENT_ID, SESSION_JWT_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY],
    // App Check (ver CLAUDE.md → "App Check", Fase 2): rechaza automáticamente
    // cualquier pedido sin un token válido de X-Firebase-AppCheck, antes de
    // que el handler llegue a correr — así el tráfico bot/script directo a
    // /api/* nunca dispara las llamadas caras de acá abajo (Google, Supabase).
    enforceAppCheck: true,
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method_not_allowed' });
      return;
    }

    const accessToken = req.body && req.body.access_token;
    if (!accessToken || typeof accessToken !== 'string') {
      res.status(400).json({ error: 'missing_access_token' });
      return;
    }

    try {
      // 1) El token es realmente de ESTA app (evita que alguien mande un
      //    access_token válido pero emitido para otra aplicación de Google).
      const tokenInfoRes = await fetch(
        `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`
      );
      if (!tokenInfoRes.ok) {
        res.status(401).json({ error: 'invalid_token' });
        return;
      }
      const tokenInfo = await tokenInfoRes.json();
      if (tokenInfo.aud !== GOOGLE_CLIENT_ID.value()) {
        res.status(401).json({ error: 'token_wrong_audience' });
        return;
      }

      // 2) Identidad real detrás del token.
      const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!userInfoRes.ok) {
        res.status(401).json({ error: 'userinfo_failed' });
        return;
      }
      const userInfo = await userInfoRes.json();
      const emailVerified = userInfo.email_verified === true || userInfo.email_verified === 'true';
      if (!userInfo.sub || !userInfo.email || !emailVerified) {
        res.status(401).json({ error: 'email_not_verified' });
        return;
      }

      // 3) Crea la fila si es la primera vez (plan='free' por default de la
      //    tabla) o solo refresca el email si ya existía. Se chequea ANTES
      //    del upsert si la fila ya existía — es la única forma limpia de
      //    saber "es un usuario nuevo" (un upsert no lo distingue solo), y
      //    eso es lo que dispara el evento signup_completed de la Fase 2 de
      //    GROWTH_PLAN.md.
      const supabase = getSupabaseClient(SUPABASE_URL.value(), SUPABASE_SERVICE_ROLE_KEY.value());
      const { data: existing } = await supabase
        .from('subscriptions')
        .select('google_sub')
        .eq('google_sub', userInfo.sub)
        .maybeSingle();
      const isNewUser = !existing;

      const { data, error } = await supabase
        .from('subscriptions')
        .upsert({ google_sub: userInfo.sub, email: userInfo.email }, { onConflict: 'google_sub' })
        .select('plan, status')
        .single();

      if (error) {
        console.error('Supabase upsert error:', error);
        res.status(500).json({ error: 'subscription_lookup_failed' });
        return;
      }

      if (isNewUser) {
        // Best-effort, nunca bloquea ni rompe el login real si falla —
        // mismo criterio que el resto de los gates de esta app (el
        // tracking de uso es secundario a que la persona pueda entrar).
        try {
          await supabase.from('usage_events').insert({ google_sub: userInfo.sub, event_name: 'signup_completed' });
        } catch (e) {
          console.warn('No se pudo registrar signup_completed:', e);
        }
      }

      const token = signSession(SESSION_JWT_SECRET.value(), { sub: userInfo.sub, email: userInfo.email });
      res.status(200).json({
        token,
        plan: data.plan,
        status: data.status,
        isPaid: data.status === 'authorized',
        // Email ya validado arriba contra Google (verified + mismo token que
        // usa Drive) — el frontend lo usa solo para gatear el toggle de
        // debug de v1.52 a la cuenta del propio dev, nunca para nada de
        // negocio real (eso sigue siendo status==='authorized').
        email: userInfo.email,
      });
    } catch (e) {
      console.error('auth-session error:', e);
      res.status(500).json({ error: 'internal_error' });
    }
  }
);
