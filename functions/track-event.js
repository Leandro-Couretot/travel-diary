const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { getAppCheck } = require('firebase-admin/app-check');
const { getSupabaseClient } = require('./lib/supabase');
const { verifySession } = require('./lib/session');

const SESSION_JWT_SECRET = defineSecret('SESSION_JWT_SECRET');
const SUPABASE_URL = defineSecret('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = defineSecret('SUPABASE_SERVICE_ROLE_KEY');

// Únicos eventos que se aceptan sin sesión — el arranque del embudo de
// registro (ver el modal de onboarding, GROWTH_PLAN.md Fase 1) ocurre antes
// de que exista ningún login, así que no hay JWT todavía para validar quién
// es. Cualquier otro nombre sin sesión válida se descarta — nunca se inserta
// con un google_sub que mande el cliente sin pasar por verifySession().
const ANON_ALLOWED_EVENTS = new Set(['onboarding_viewed', 'signup_started']);

// Tope defensivo — un flush normal del buffer del frontend trae unos pocos
// eventos (ver trackEvent()/flushTrackEvents() en billing.js), esto solo
// evita que un body gigante le pegue una carga rara a Supabase.
const MAX_EVENTS_PER_REQUEST = 50;

// Registro técnico de fallas (v2.110, tabla error_log). Viaja en el mismo
// endpoint pero en un campo aparte (`issues`) porque tiene reglas distintas:
// no depende del consentimiento de analítica y acepta pedidos SIN sesión
// (la identidad, si hay, la decide el cliente al mandar o no el JWT). Todo
// se recorta acá: el cliente no es de fiar en cuanto a tamaños.
const MAX_ISSUES_PER_REQUEST = 20;
const ISSUE_CODE_RE = /^ERR-[A-Z0-9]{4,8}$/;
const ANON_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const cut = (v, n) => (typeof v === 'string' && v ? v.slice(0, n) : null);
function sanitizeIssue(raw, googleSub) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = cut(raw.kind, 40);
  if (!kind) return null;
  let props = {};
  if (raw.props && typeof raw.props === 'object' && !Array.isArray(raw.props)) {
    try { if (JSON.stringify(raw.props).length <= 4000) props = raw.props; } catch (e) { /* props inválidas: se ignoran */ }
  }
  return {
    error_code: typeof raw.error_code === 'string' && ISSUE_CODE_RE.test(raw.error_code) ? raw.error_code : null,
    kind,
    context: cut(raw.context, 80),
    message: cut(raw.message, 1000),
    stack: cut(raw.stack, 3000),
    app_version: cut(raw.app_version, 20),
    anon_id: typeof raw.anon_id === 'string' && ANON_ID_RE.test(raw.anon_id) ? raw.anon_id : null,
    google_sub: googleSub,
    props,
  };
}

exports.trackEvent = onRequest(
  {
    region: 'southamerica-east1',
    secrets: [SESSION_JWT_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY],
    maxInstances: 10, // ver CLAUDE.md → "Techo de instancias (maxInstances)"
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method_not_allowed' });
      return;
    }

    const body = req.body || {};

    // No se puede usar enforceAppCheck (como en authSession/checkoutCreate/
    // subscriptionStatus, ver CLAUDE.md → "App Check") porque solo mira el
    // header X-Firebase-AppCheck, y navigator.sendBeacon() (el flush al
    // ocultar/cerrar la pestaña, ver flushTrackEvents() en billing.js) no
    // puede mandar headers custom — ese camino manda el token en el body
    // (app_check_token) en su lugar. Se valida a mano acá para cubrir los
    // dos caminos con la misma API que usa enforceAppCheck por dentro.
    const appCheckToken = req.header('X-Firebase-AppCheck') || (typeof body.app_check_token === 'string' ? body.app_check_token : null);
    if (!appCheckToken) {
      res.status(401).json({ error: 'missing_app_check_token' });
      return;
    }
    try {
      await getAppCheck().verifyToken(appCheckToken);
    } catch (e) {
      res.status(401).json({ error: 'invalid_app_check_token' });
      return;
    }

    const events = Array.isArray(body.events) ? body.events : [];
    const issues = Array.isArray(body.issues) ? body.issues : [];
    if (!events.length && !issues.length) {
      res.status(200).json({ ok: true, inserted: 0 });
      return;
    }

    // navigator.sendBeacon() (usado para el flush del buffer al
    // ocultar/cerrar la pestaña, ver billing.js) no permite mandar headers
    // custom — para ese caso puntual el token viaja en el body como
    // fallback. El header Authorization normal sigue siendo el camino
    // principal para el resto de los flushes (el periódico cada
    // TRACK_FLUSH_MS).
    let session = verifySession(req, SESSION_JWT_SECRET.value());
    if (!session && typeof body.session_token === 'string') {
      session = verifySession(
        { get: (h) => (h === 'Authorization' ? `Bearer ${body.session_token}` : null) },
        SESSION_JWT_SECRET.value()
      );
    }
    const googleSub = session ? session.sub : null;

    const rows = events
      .slice(0, MAX_EVENTS_PER_REQUEST)
      .filter((e) => e && typeof e.event_name === 'string' && (googleSub || ANON_ALLOWED_EVENTS.has(e.event_name)))
      .map((e) => ({
        google_sub: googleSub,
        event_name: e.event_name,
        event_props: e.event_props && typeof e.event_props === 'object' ? e.event_props : {},
      }));

    try {
      const supabase = getSupabaseClient(SUPABASE_URL.value(), SUPABASE_SERVICE_ROLE_KEY.value());
      let inserted = 0;
      if (rows.length) {
        // Un solo insert para todo el lote (no uno por evento) — mismo
        // criterio de eficiencia que llevó a batchear el POST en sí, ver
        // GROWTH_PLAN.md Fase 2.
        const { error } = await supabase.from('usage_events').insert(rows);
        if (error) {
          console.error('usage_events insert error:', error);
          res.status(500).json({ error: 'insert_failed' });
          return;
        }
        inserted = rows.length;
      }
      // Fallas técnicas: tabla propia, con su propio manejo de error — que
      // falle acá nunca debe tirar abajo los eventos de analítica de arriba.
      let issuesInserted = 0;
      if (issues.length) {
        const issueRows = issues.slice(0, MAX_ISSUES_PER_REQUEST).map((i) => sanitizeIssue(i, googleSub)).filter(Boolean);
        if (issueRows.length) {
          const { error: issueErr } = await supabase.from('error_log').insert(issueRows);
          if (issueErr) {
            console.error('error_log insert error:', issueErr);
            res.status(500).json({ error: 'issue_insert_failed', inserted });
            return;
          }
          issuesInserted = issueRows.length;
          // Retención: no hay pg_cron en el proyecto de Supabase, así que la
          // limpieza de filas con más de 90 días corre acá, de vez en cuando
          // (~2% de los pedidos que guardan fallas). Best-effort: si falla no
          // afecta nada.
          if (Math.random() < 0.02) {
            try {
              const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
              await supabase.from('error_log').delete().lt('occurred_at', cutoff);
            } catch (e) { /* best-effort */ }
          }
        }
      }
      res.status(200).json({ ok: true, inserted, issuesInserted });
    } catch (e) {
      console.error('track-event error:', e);
      res.status(500).json({ error: 'internal_error' });
    }
  }
);
