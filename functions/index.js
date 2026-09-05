// Punto de entrada de Cloud Functions — cada archivo hermano es una sola
// responsabilidad (mismo criterio que drive.js/exif.js/debug.js del frontend).
exports.authSession = require('./auth-session').authSession;
exports.checkoutCreate = require('./checkout-create').checkoutCreate;
exports.subscriptionStatus = require('./subscription-status').subscriptionStatus;
exports.webhookMercadopago = require('./webhook-mercadopago').webhookMercadopago;
