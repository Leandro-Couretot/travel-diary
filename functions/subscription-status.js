const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { getSupabaseClient } = require('./lib/supabase');
const { verifySession } = require('./lib/session');

const SESSION_JWT_SECRET = defineSecret('SESSION_JWT_SECRET');
const SUPABASE_URL = defineSecret('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = defineSecret('SUPABASE_SERVICE_ROLE_KEY');
const MP_ACCESS_TOKEN = defineSecret('MP_ACCESS_TOKEN');

exports.subscriptionStatus = onRequest(
  {
    region: 'southamerica-east1',
    secrets: [SESSION_JWT_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MP_ACCESS_TOKEN],
  },
  async (req, res) => {
    if (req.method !== 'GET') {
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
      let { data: row, error } = await supabase
        .from('subscriptions')
        .select('plan, status, mp_preapproval_id')
        .eq('google_sub', session.sub)
        .single();

      if (error) {
        console.error('Supabase select error:', error);
        res.status(500).json({ error: 'subscription_lookup_failed' });
        return;
      }

      // Red de seguridad: justo después de pagar, el webhook puede tardar
      // unos segundos más que el redirect de vuelta a la app. Si seguimos
      // en "pending" y ya hay un preapproval, se consulta en vivo antes de
      // responder en vez de hacer esperar al usuario a que llegue el webhook.
      if (row.status === 'pending' && row.mp_preapproval_id) {
        const mpRes = await fetch(`https://api.mercadopago.com/preapproval/${row.mp_preapproval_id}`, {
          headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN.value()}` },
        });
        if (mpRes.ok) {
          const mpData = await mpRes.json();
          if (mpData.status && mpData.status !== row.status) {
            await supabase
              .from('subscriptions')
              .update({ status: mpData.status })
              .eq('google_sub', session.sub);
            row = { ...row, status: mpData.status };
          }
        }
      }

      res.status(200).json({
        plan: row.plan,
        status: row.status,
        isPaid: row.status === 'authorized',
      });
    } catch (e) {
      console.error('subscription-status error:', e);
      res.status(500).json({ error: 'internal_error' });
    }
  }
);
