const crypto = require('crypto');
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { getSupabaseClient } = require('./lib/supabase');

const SUPABASE_URL = defineSecret('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = defineSecret('SUPABASE_SERVICE_ROLE_KEY');
const MP_ACCESS_TOKEN = defineSecret('MP_ACCESS_TOKEN');
const MP_WEBHOOK_SECRET = defineSecret('MP_WEBHOOK_SECRET');

// Formato de x-signature: "ts=<timestamp_ms>,v1=<hmac_hex>"
// Manifest a firmar: "id:<data.id>;request-id:<x-request-id>;ts:<ts>;"
// (id en minúsculas; se omite el segmento si el dato no vino).
function isValidSignature(req, secret) {
  const xSignature = req.get('x-signature') || '';
  const xRequestId = req.get('x-request-id') || '';
  const dataId = String(req.query['data.id'] || '').toLowerCase();

  const parts = {};
  xSignature.split(',').forEach((p) => {
    const [k, v] = p.split('=').map((s) => (s || '').trim());
    if (k) parts[k] = v;
  });
  const { ts, v1 } = parts;
  if (!ts || !v1) return false;

  let manifest = '';
  if (dataId) manifest += `id:${dataId};`;
  if (xRequestId) manifest += `request-id:${xRequestId};`;
  manifest += `ts:${ts};`;

  const computed = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  const a = Buffer.from(computed, 'hex');
  const b = Buffer.from(v1, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function logEvent(supabase, { googleSub, topic, resourceId, payload }) {
  await supabase.from('subscription_events').insert({
    google_sub: googleSub || null,
    mp_topic: topic || null,
    mp_resource_id: resourceId || null,
    raw_payload: payload,
  });
}

exports.webhookMercadopago = onRequest(
  {
    region: 'southamerica-east1',
    secrets: [SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MP_ACCESS_TOKEN, MP_WEBHOOK_SECRET],
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).send('method_not_allowed');
      return;
    }

    if (!isValidSignature(req, MP_WEBHOOK_SECRET.value())) {
      console.warn('Webhook con firma inválida, se descarta');
      res.status(401).send('invalid_signature');
      return;
    }

    const topic = req.query.type || req.query.topic || (req.body && req.body.type) || null;
    const dataId = req.query['data.id'] || (req.body && req.body.data && req.body.data.id) || null;
    const supabase = getSupabaseClient(SUPABASE_URL.value(), SUPABASE_SERVICE_ROLE_KEY.value());

    // Responder rápido: Mercado Pago espera ~22s y reintenta cada 15min si
    // no le llega un 200. Confirmamos primero, procesamos, y logueamos
    // cualquier error sin poder devolvérselo a MP (ya se le respondió 200).
    res.status(200).send('ok');

    try {
      if (topic === 'subscription_preapproval' && dataId) {
        // Acá data.id ES el preapproval_id directamente (confirmado en la doc).
        const mpRes = await fetch(`https://api.mercadopago.com/preapproval/${dataId}`, {
          headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN.value()}` },
        });
        if (mpRes.ok) {
          const mpData = await mpRes.json();
          await supabase
            .from('subscriptions')
            .update({ status: mpData.status })
            .eq('mp_preapproval_id', dataId);
          await logEvent(supabase, { googleSub: mpData.external_reference, topic, resourceId: dataId, payload: mpData });
        } else {
          await logEvent(supabase, { topic, resourceId: dataId, payload: { error: 'preapproval_fetch_failed' } });
        }
      } else if ((topic === 'subscription_authorized_payment' || topic === 'payment') && dataId) {
        // Best-effort: no está 100% confirmado el campo exacto que linkea
        // este recurso de vuelta al preapproval, así que esto NUNCA es la
        // fuente de verdad de isPaidUser — solo se usa para refrescar
        // last_payment_at cuando se puede resolver, y siempre se guarda el
        // payload crudo para poder auditar después.
        const endpoint =
          topic === 'subscription_authorized_payment'
            ? `https://api.mercadopago.com/authorized_payments/${dataId}`
            : `https://api.mercadopago.com/v1/payments/${dataId}`;
        const mpRes = await fetch(endpoint, {
          headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN.value()}` },
        });
        const mpData = mpRes.ok ? await mpRes.json() : { error: 'payment_fetch_failed' };
        const preapprovalId = mpData.preapproval_id || null;
        if (preapprovalId) {
          await supabase
            .from('subscriptions')
            .update({ last_payment_at: new Date().toISOString() })
            .eq('mp_preapproval_id', preapprovalId);
        }
        await logEvent(supabase, { topic, resourceId: dataId, payload: mpData });
      } else {
        await logEvent(supabase, { topic, resourceId: dataId, payload: req.body });
      }
    } catch (e) {
      console.error('webhook-mercadopago processing error (ya se respondió 200 a MP):', e);
    }
  }
);
