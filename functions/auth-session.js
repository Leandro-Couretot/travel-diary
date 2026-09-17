const crypto = require('crypto');
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { getSupabaseClient } = require('./lib/supabase');
const { signSession } = require('./lib/session');
const { readFbCookie, sendMetaCapiEvent } = require('./lib/metaCapi');

const GOOGLE_CLIENT_ID = defineSecret('GOOGLE_CLIENT_ID');
const GOOGLE_CLIENT_SECRET = defineSecret('GOOGLE_CLIENT_SECRET');
const SESSION_JWT_SECRET = defineSecret('SESSION_JWT_SECRET');
const SUPABASE_URL = defineSecret('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = defineSecret('SUPABASE_SERVICE_ROLE_KEY');
// Fase 3.1 (funnel completo de Ads, ver CLAUDE.md): CompleteRegistration
// hybrid Pixel+CAPI — este endpoint ya sabe en el momento exacto si es un
// signup genuino (isNewUser, ver más abajo), así que es el lugar natural
// para reforzar por CAPI el mismo Pixel que dispara el cliente.
const META_CAPI_ACCESS_TOKEN = defineSecret('META_CAPI_ACCESS_TOKEN');

// Error tipado con el status HTTP que corresponde devolver — así el catch
// general de abajo no tiene que adivinar 401 vs 500 mirando el mensaje.
class AuthError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

// Intercambia el código de autorización (flujo `initCodeClient`, ver
// CLAUDE.md → "Auth de Drive: de implícito a refresh_token real") por un
// access_token + refresh_token reales de Google. `redirect_uri: 'postmessage'`
// es el valor especial documentado por Google para códigos obtenidos con
// `ux_mode: 'popup'` de Google Identity Services — no es una URL real, es
// el literal que hay que mandar.
async function exchangeCodeForTokens(code) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID.value(),
      client_secret: GOOGLE_CLIENT_SECRET.value(),
      redirect_uri: 'postmessage',
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) throw new AuthError(401, 'code_exchange_failed');
  return res.json(); // { access_token, expires_in, refresh_token?, scope, token_type, id_token }
}

// Valida que el access_token sea realmente de esta app y resuelve la
// identidad real detrás — mismo chequeo sin importar si el token vino de un
// intercambio de código (nuevo) o lo mandó el frontend directo (legacy, ver
// más abajo).
async function resolveGoogleIdentity(accessToken) {
  const tokenInfoRes = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`
  );
  if (!tokenInfoRes.ok) throw new AuthError(401, 'invalid_token');
  const tokenInfo = await tokenInfoRes.json();
  if (tokenInfo.aud !== GOOGLE_CLIENT_ID.value()) throw new AuthError(401, 'token_wrong_audience');

  const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!userInfoRes.ok) throw new AuthError(401, 'userinfo_failed');
  const userInfo = await userInfoRes.json();
  const emailVerified = userInfo.email_verified === true || userInfo.email_verified === 'true';
  if (!userInfo.sub || !userInfo.email || !emailVerified) throw new AuthError(401, 'email_not_verified');
  return userInfo;
}

// Recibe, según el caller: `code` (flujo nuevo — authorization code, ver
// CLAUDE.md) o `access_token` (flujo viejo/implícito, se mantiene mientras
// conviven las dos generaciones de sesión, mismo criterio de migración lazy
// que ya usa esta app en Drive — nunca un big-bang). En ambos casos termina
// validando la identidad del lado del servidor antes de confiar en ella —
// nunca se acepta un email/sub que mande el cliente directamente.
exports.authSession = onRequest(
  {
    region: 'southamerica-east1',
    secrets: [GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SESSION_JWT_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, META_CAPI_ACCESS_TOKEN],
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

    const code = req.body && req.body.code;
    const legacyAccessToken = req.body && req.body.access_token;
    if ((!code || typeof code !== 'string') && (!legacyAccessToken || typeof legacyAccessToken !== 'string')) {
      res.status(400).json({ error: 'missing_code_or_access_token' });
      return;
    }

    try {
      let driveAccessToken = legacyAccessToken;
      let driveExpiresIn = null;
      let refreshToken = null;

      if (code) {
        const tokens = await exchangeCodeForTokens(code);
        driveAccessToken = tokens.access_token;
        driveExpiresIn = tokens.expires_in;
        // Google solo devuelve refresh_token en el primer consentimiento (o
        // si se fuerza prompt=consent) — si esta vez no vino, no se pisa el
        // que ya podría haber guardado de una conexión anterior.
        refreshToken = tokens.refresh_token || null;
      }

      // 1-2) Identidad real detrás del token, validada contra Google.
      const userInfo = await resolveGoogleIdentity(driveAccessToken);

      // 3) Crea la fila si es la primera vez (plan='free' por default de la
      //    tabla) o solo refresca el email/refresh_token si ya existía. Se
      //    chequea ANTES del upsert si la fila ya existía — es la única
      //    forma limpia de saber "es un usuario nuevo" (un upsert no lo
      //    distingue solo), y eso es lo que dispara el evento
      //    signup_completed de la Fase 2 de GROWTH_PLAN.md.
      const supabase = getSupabaseClient(SUPABASE_URL.value(), SUPABASE_SERVICE_ROLE_KEY.value());
      const { data: existing } = await supabase
        .from('subscriptions')
        .select('google_sub')
        .eq('google_sub', userInfo.sub)
        .maybeSingle();
      const isNewUser = !existing;

      const upsertRow = { google_sub: userInfo.sub, email: userInfo.email };
      if (refreshToken) upsertRow.drive_refresh_token = refreshToken;

      const { data, error } = await supabase
        .from('subscriptions')
        .upsert(upsertRow, { onConflict: 'google_sub' })
        .select('plan, status, drive_refresh_token')
        .single();

      if (error) {
        console.error('Supabase upsert error:', error);
        res.status(500).json({ error: 'subscription_lookup_failed' });
        return;
      }

      // Se genera ANTES de saber si es nuevo porque el ID en sí no es
      // sensible ni depende de nada — más simple que meterlo dentro del if.
      // Solo se usa (y se manda al cliente) cuando isNewUser es true.
      const metaEventId = crypto.randomUUID();

      if (isNewUser) {
        // Best-effort, nunca bloquea ni rompe el login real si falla —
        // mismo criterio que el resto de los gates de esta app (el
        // tracking de uso es secundario a que la persona pueda entrar).
        try {
          await supabase.from('usage_events').insert({ google_sub: userInfo.sub, event_name: 'signup_completed' });
        } catch (e) {
          console.warn('No se pudo registrar signup_completed:', e);
        }
        // Fase 3.1: refuerzo CAPI del mismo CompleteRegistration que el
        // cliente dispara por Pixel con este mismo metaEventId (ver
        // applySessionResponse() en billing.js) — best-effort, best-effort
        // real porque sendMetaCapiEvent() ya traga cualquier error adentro.
        await sendMetaCapiEvent({
          eventName: 'CompleteRegistration',
          eventId: metaEventId,
          fbp: readFbCookie(req, '_fbp'),
          fbc: readFbCookie(req, '_fbc'),
          accessToken: META_CAPI_ACCESS_TOKEN.value(),
        });
      }

      const token = signSession(SESSION_JWT_SECRET.value(), {
        sub: userInfo.sub, email: userInfo.email, picture: userInfo.picture, name: userInfo.name,
      });
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
        // picture/name (v1.81): solo existen si la cuenta otorgó el scope
        // userinfo.profile — pueden venir undefined para una sesión vieja
        // que todavía no re-autenticó. Se usan únicamente para el avatar
        // del header, nunca para nada de negocio.
        picture: userInfo.picture,
        name: userInfo.name,
        // Nuevo (flujo authorization code): el frontend necesita el
        // access_token de Drive en sí — con el flujo viejo lo obtenía
        // directo de Google en el navegador, con este lo obtiene acá
        // porque el intercambio de código requiere el client_secret, que
        // nunca puede vivir en el cliente. Solo vienen seteados cuando el
        // pedido llegó con `code`; con `access_token` (legacy) el frontend
        // ya tiene el token, no hace falta devolvérselo.
        driveAccessToken: code ? driveAccessToken : undefined,
        driveExpiresIn: code ? driveExpiresIn : undefined,
        // Le dice al frontend si esta cuenta ya tiene un refresh_token real
        // guardado (recién obtenido ahora, o de una conexión anterior) —
        // así sabe si puede empezar a preferir el refresh server-side
        // (drive-token-refresh.js) en vez del silencioso basado en cookies
        // de Google en el navegador.
        hasRefreshToken: !!data.drive_refresh_token,
        // Fase 3d de GROWTH_PLAN.md (Meta Pixel): le dice al frontend si
        // esta conexión es un registro genuino (no una sesión restaurada
        // ni un re-login) para disparar CompleteRegistration una sola vez
        // por cuenta real — mismo booleano que ya se usa arriba para
        // signup_completed, ahora también expuesto al cliente.
        isNewUser,
        // Fase 3.1: mismo id que usó el refuerzo CAPI de arriba — el
        // cliente lo pasa a su propio fbq('track', 'CompleteRegistration', ...)
        // para que Meta deduplique las dos llegadas en una sola conversión.
        // Solo tiene sentido cuando isNewUser es true (billing.js lo ignora
        // en cualquier otro caso).
        metaEventId: isNewUser ? metaEventId : undefined,
      });
    } catch (e) {
      if (e instanceof AuthError) {
        res.status(e.status).json({ error: e.code });
        return;
      }
      console.error('auth-session error:', e);
      res.status(500).json({ error: 'internal_error' });
    }
  }
);
