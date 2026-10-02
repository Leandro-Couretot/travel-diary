const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { getSupabaseClient } = require('./lib/supabase');
const { verifySession } = require('./lib/session');

const SESSION_JWT_SECRET = defineSecret('SESSION_JWT_SECRET');
const SUPABASE_URL = defineSecret('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = defineSecret('SUPABASE_SERVICE_ROLE_KEY');

// "Control de accesos" (v2.78, ver CLAUDE.md → "Rol Contribuidor"): le
// devuelve a la dueña los links de Contribuidor activos de un álbum suyo,
// más un total agregado de cuántas personas ya se unieron como contribuidor
// (decisión explícita con el usuario: agregado, no por link puntual — evita
// sumar una columna/migración de schema solo para trackear eso).
//
// El chequeo de dueña real es explícito (shared_album_owner.owner_google_sub
// === session.sub) antes de contar shared_album_members — sin esto, una
// cuenta autenticada pero ajena al álbum podría aprender cuánta gente se
// unió a un álbum que no es suyo con solo conocer/adivinar su
// folderDriveId. Si no es la dueña, se devuelve joinedCount:0 en vez de un
// error — mismo criterio fail-safe que el resto de este mecanismo (nunca un
// 403 que delate que el folderDriveId sí existe).
exports.sharedAlbumInviteList = onRequest(
  {
    region: 'southamerica-east1',
    secrets: [SESSION_JWT_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY],
    enforceAppCheck: true,
    maxInstances: 10,
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

    const { folderDriveId } = req.body || {};
    if (!folderDriveId || typeof folderDriveId !== 'string') {
      res.status(400).json({ error: 'bad_request', detail: 'missing_folder_drive_id' });
      return;
    }

    try {
      const supabase = getSupabaseClient(SUPABASE_URL.value(), SUPABASE_SERVICE_ROLE_KEY.value());

      const { data: invites, error: invitesErr } = await supabase
        .from('shared_album_invites')
        .select('token,active,expires_at,created_at')
        .eq('folder_drive_id', folderDriveId)
        .eq('owner_google_sub', session.sub)
        .eq('active', true)
        .order('created_at', { ascending: false });
      if (invitesErr) {
        console.error('shared-album-invite-list invites error:', invitesErr);
        res.status(500).json({ error: 'list_failed' });
        return;
      }

      const { data: ownerRow } = await supabase
        .from('shared_album_owner')
        .select('owner_google_sub')
        .eq('folder_drive_id', folderDriveId)
        .maybeSingle();
      let joinedCount = 0;
      if (ownerRow && ownerRow.owner_google_sub === session.sub) {
        const { count, error: countErr } = await supabase
          .from('shared_album_members')
          .select('guest_google_sub', { count: 'exact', head: true })
          .eq('folder_drive_id', folderDriveId)
          .eq('role', 'contributor');
        if (!countErr) joinedCount = count || 0;
      }

      res.status(200).json({
        ok: true,
        invites: (invites || []).map(i => ({ token: i.token, expiresAt: i.expires_at, createdAt: i.created_at })),
        joinedCount,
      });
    } catch (e) {
      console.error('shared-album-invite-list error:', e);
      res.status(500).json({ error: 'internal_error' });
    }
  }
);
