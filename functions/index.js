// Punto de entrada de Cloud Functions — cada archivo hermano es una sola
// responsabilidad (mismo criterio que drive.js/exif.js/debug.js del frontend).
//
// admin.initializeApp() sin argumentos se autoconfigura solo corriendo
// dentro de Cloud Functions — necesario para que enforceAppCheck (ver
// CLAUDE.md → "App Check") pueda verificar tokens de App Check. Se llama
// acá, una sola vez, antes de cargar cualquier función.
const admin = require('firebase-admin');
admin.initializeApp();

exports.authSession = require('./auth-session').authSession;
exports.checkoutCreate = require('./checkout-create').checkoutCreate;
exports.subscriptionStatus = require('./subscription-status').subscriptionStatus;
exports.webhookMercadopago = require('./webhook-mercadopago').webhookMercadopago;
exports.trackEvent = require('./track-event').trackEvent;
exports.driveTokenRefresh = require('./drive-token-refresh').driveTokenRefresh;
exports.campaignLink = require('./campaign-link').campaignLink;
exports.sharedAlbumRegister = require('./shared-album-register').sharedAlbumRegister;
exports.sharedAlbumProxy = require('./shared-album-proxy').sharedAlbumProxy;
exports.sharedAlbumInviteCreate = require('./shared-album-invite-create').sharedAlbumInviteCreate;
exports.sharedAlbumInviteJoin = require('./shared-album-invite-join').sharedAlbumInviteJoin;
exports.sharedAlbumInviteRevoke = require('./shared-album-invite-revoke').sharedAlbumInviteRevoke;
exports.sharedAlbumInviteList = require('./shared-album-invite-list').sharedAlbumInviteList;
