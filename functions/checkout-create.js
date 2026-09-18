const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret, defineString } = require('firebase-functions/params');
const { getSupabaseClient } = require('./lib/supabase');
const { verifySession } = require('./lib/session');
const { readFbCookie, sendMetaCapiEvent } = require('./lib/metaCapi');

const SESSION_JWT_SECRET = defineSecret('SESSION_JWT_SECRET');
const SUPABASE_URL = defineSecret('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = defineSecret('SUPABASE_SERVICE_ROLE_KEY');
const MP_ACCESS_TOKEN = defineSecret('MP_ACCESS_TOKEN');
// Fase 3.1 (funnel completo de Ads, ver CLAUDE.md): InitiateCheckout hybrid
// Pixel+CAPI — el cliente ya lo dispara por Pixel apenas se toca el botón
// (antes de este mismo POST), este endpoint lo refuerza por CAPI con el
// mismo event_id para que Meta los deduplique en uno solo.
const META_CAPI_ACCESS_TOKEN = defineSecret('META_CAPI_ACCESS_TOKEN');
const APP_BASE_URL = defineString('APP_BASE_URL'); // ej: https://family-fotos-491610.web.app

// Cambiar acá cuando se defina mejor el modelo de negocio — nada más en el
// código depende de estos valores.
const PRECIOS_ARS = {
  monthly: 14000,
  annual: Math.round(14000 * 12 * 0.8), // 20% off pagando anual
};

const FREQUENCY_BY_PLAN = {
  monthly: { frequency: 1, frequency_type: 'months' },
  // Mercado Pago no confirma "years" como frequency_type válido en su doc
  // de Preapproval — se arma el anual como "cada 12 meses" en vez de
  // apostar a un valor de enum no documentado.
  annual: { frequency: 12, frequency_type: 'months' },
};

exports.checkoutCreate = onRequest(
  {
    region: 'southamerica-east1',
    secrets: [SESSION_JWT_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MP_ACCESS_TOKEN, META_CAPI_ACCESS_TOKEN],
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

    const planType = req.body && req.body.planType;
    if (planType !== 'monthly' && planType !== 'annual') {
      res.status(400).json({ error: 'invalid_plan_type' });
      return;
    }

    try {
      const preapprovalBody = {
        reason: `Legado — Plan ${planType === 'monthly' ? 'mensual' : 'anual'}`,
        external_reference: session.sub,
        payer_email: session.email,
        auto_recurring: {
          ...FREQUENCY_BY_PLAN[planType],
          transaction_amount: PRECIOS_ARS[planType],
          currency_id: 'ARS',
        },
        back_url: `${APP_BASE_URL.value()}/app.html?mp_return=1`,
        status: 'pending',
      };

      const mpRes = await fetch('https://api.mercadopago.com/preapproval', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${MP_ACCESS_TOKEN.value()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(preapprovalBody),
      });
      const mpData = await mpRes.json();
      if (!mpRes.ok) {
        console.error('Mercado Pago preapproval error:', mpData);
        res.status(502).json({ error: 'mercadopago_error' });
        return;
      }

      const fbp = readFbCookie(req, '_fbp');
      const fbc = readFbCookie(req, '_fbc');

      // Fase 3.1: el cliente ya disparó InitiateCheckout por Pixel con este
      // mismo id (ver startCheckout() en billing.js) — acá se refuerza por
      // CAPI, best-effort, nunca puede frenar la creación del checkout real
      // si falla. `eventId` es opcional (un cliente viejo en caché, sin este
      // campo, simplemente no dispara el refuerzo — sigue teniendo su Pixel).
      const eventId = req.body && req.body.eventId;
      await sendMetaCapiEvent({
        eventName: 'InitiateCheckout',
        eventId,
        fbp,
        fbc,
        customData: { value: PRECIOS_ARS[planType], currency: 'ARS' },
        accessToken: META_CAPI_ACCESS_TOKEN.value(),
      });

      const supabase = getSupabaseClient(SUPABASE_URL.value(), SUPABASE_SERVICE_ROLE_KEY.value());
      const { error } = await supabase
        .from('subscriptions')
        .update({
          mp_preapproval_id: mpData.id,
          plan: planType,
          status: 'pending',
          // null si el navegador no tiene la cookie (adblocker, o nunca vino
          // de un anuncio en el caso de fbc) — el helper de 3c simplemente
          // no manda ese campo a Meta si está vacío.
          fbp: fbp || null,
          fbc: fbc || null,
        })
        .eq('google_sub', session.sub);

      if (error) {
        console.error('Supabase update error:', error);
        res.status(500).json({ error: 'subscription_update_failed' });
        return;
      }

      res.status(200).json({ init_point: mpData.init_point });
    } catch (e) {
      console.error('checkout-create error:', e);
      res.status(500).json({ error: 'internal_error' });
    }
  }
);
