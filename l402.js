/**
 * l402.js — L402 Protocol Module
 *
 * Spec-compliant L402 implementation for Node.js HTTP servers.
 * No framework dependency — works with raw http.createServer(), Express, Fastify, etc.
 *
 * Features:
 * - Macaroons with HMAC chaining via macaroons.js
 * - Per-resource access control via first-party caveats
 * - Payment hash as macaroon identifier (binds token to Lightning payment)
 * - Preimage verification proves payment was made
 * - Stateless — no database, no sessions, just cryptography
 * - Supports future attenuation (clients can add caveats)
 *
 * Why not Aperture?
 * Aperture is a Go reverse proxy that gates at the URL-path level.
 * This module gates at the resource level — a token for resource "abc123"
 * cannot access resource "def456". It drops into any Node.js server as a
 * require() with zero infrastructure changes.
 *
 * Dependencies: macaroons.js (pure JavaScript, no native bindings)
 */

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const { MacaroonsBuilder, MacaroonsVerifier } = require('macaroons.js');

// ===========================================
// Configuration
// ===========================================

const CONFIG = {
    // Secret key for macaroon root signature
    // Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
    secret: process.env.L402_SECRET,

    // Macaroon location identifier (your domain)
    location: process.env.L402_LOCATION || 'localhost',

    // Price in satoshis per resource access
    priceSats: parseInt(process.env.L402_PRICE_SATS || '10'),

    // Token validity in seconds (default: 30 minutes)
    expirySeconds: parseInt(process.env.L402_EXPIRY_SECONDS || '1800'),

    // LND REST API endpoint
    lndHost: process.env.LND_REST_HOST || 'https://localhost:8080',
    lndMacaroonPath: process.env.LND_MACAROON_PATH,
    lndTlsCertPath: process.env.LND_TLS_CERT_PATH,
};

let lndMacaroon = null;
let httpsAgent = null;

// ===========================================
// Initialization
// ===========================================

/**
 * Initialize the LND connection.
 * Call this once at server startup. Returns false if L402 is not configured
 * (missing secret or macaroon path), allowing the server to run without L402.
 *
 * @returns {boolean} true if L402 is ready, false if disabled
 */
function initLnd() {
    if (!CONFIG.secret) {
        console.warn('[L402] L402_SECRET not set — L402 disabled');
        return false;
    }

    if (CONFIG.secret.length < 32) {
        console.warn('[L402] L402_SECRET is too short (minimum 32 characters). Use: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
        return false;
    }

    if (!CONFIG.lndMacaroonPath) {
        console.warn('[L402] LND_MACAROON_PATH not set — L402 disabled');
        return false;
    }

    try {
        // LND REST API requires the macaroon as a hex string in the header
        lndMacaroon = fs.readFileSync(CONFIG.lndMacaroonPath).toString('hex');

        // Build HTTPS agent. LND uses a self-signed TLS certificate.
        // If a cert path is provided, trust it as a CA.
        if (CONFIG.lndTlsCertPath && fs.existsSync(CONFIG.lndTlsCertPath)) {
            const cert = fs.readFileSync(CONFIG.lndTlsCertPath);
            httpsAgent = new https.Agent({
                ca: cert,
                // Skip hostname verification for SSH tunnel setups where the
                // cert's SANs (e.g., 127.0.0.1) don't match the connection
                // hostname. Only safe because we pin the exact CA cert above.
                checkServerIdentity: () => undefined,
            });
        } else {
            console.warn('[L402] WARNING: No TLS cert provided (LND_TLS_CERT_PATH). Connection to LND is NOT verified.');
            httpsAgent = new https.Agent({ rejectUnauthorized: false });
        }

        console.log('[L402] Initialized');
        console.log(`[L402] Location: ${CONFIG.location}`);
        console.log(`[L402] Price: ${CONFIG.priceSats} sats, Expiry: ${CONFIG.expirySeconds}s`);
        return true;
    } catch (err) {
        console.error('[L402] Init failed:', err.message);
        return false;
    }
}

// ===========================================
// LND REST API
// ===========================================

/**
 * Create a Lightning invoice via LND REST API.
 * Uses native https module — no axios, no node-fetch, no dependencies.
 *
 * @param {number} amountSats - Invoice amount in satoshis
 * @param {string} memo - Human-readable invoice description
 * @returns {Promise<{paymentHash: string, paymentRequest: string}>}
 */
function createInvoice(amountSats, memo) {
    return new Promise((resolve, reject) => {
        const url = new URL(`${CONFIG.lndHost}/v1/invoices`);
        const postData = JSON.stringify({
            value: amountSats.toString(),
            memo: memo,
            expiry: '3600',
        });

        const options = {
            hostname: url.hostname,
            port: url.port || 443,
            path: url.pathname,
            method: 'POST',
            headers: {
                'Grpc-Metadata-macaroon': lndMacaroon,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData),
            },
            agent: httpsAgent,
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    if (res.statusCode !== 200) {
                        reject(new Error(`LND error ${res.statusCode}: ${data}`));
                        return;
                    }
                    const paymentHash = Buffer.from(result.r_hash, 'base64').toString('hex');
                    resolve({
                        paymentHash: paymentHash,
                        paymentRequest: result.payment_request,
                    });
                } catch (err) {
                    reject(err);
                }
            });
        });

        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

// ===========================================
// Macaroon Functions
// ===========================================

/**
 * Create a macaroon for accessing a specific resource.
 *
 * The payment hash becomes the macaroon identifier, cryptographically
 * binding this credential to a specific Lightning payment. The preimage
 * (proof of payment) is needed to use the token.
 *
 * Caveats:
 * - resource_id: restricts token to a specific resource
 * - expires_at: Unix timestamp after which the token is invalid
 * - service: identifies the service that issued the token
 *
 * @param {string} paymentHash - Lightning payment hash (hex)
 * @param {string} resourceId - Resource being purchased
 * @param {string} [service] - Service identifier (default: CONFIG.location)
 * @returns {string} Base64-encoded serialized macaroon
 */
function createMacaroon(paymentHash, resourceId, service) {
    const expiresAt = Math.floor(Date.now() / 1000) + CONFIG.expirySeconds;

    const macaroon = new MacaroonsBuilder(
        CONFIG.location,
        CONFIG.secret,
        paymentHash
    )
        .add_first_party_caveat(`resource_id = ${resourceId}`)
        .add_first_party_caveat(`expires_at = ${expiresAt}`)
        .add_first_party_caveat(`service = ${service || CONFIG.location}`)
        .getMacaroon();

    return macaroon.serialize();
}

/**
 * Verify a macaroon and all its caveats.
 *
 * Verification checks:
 * 1. SHA256(preimage) === macaroon identifier (proves payment)
 * 2. resource_id matches the requested resource
 * 3. Token has not expired
 * 4. HMAC signature chain is valid (proves token was issued by this server)
 *
 * Unknown caveats from client-side attenuation are accepted — this is by design.
 * Macaroons support delegation: a client can add caveats to restrict their own
 * token further, and the server doesn't need to know about those restrictions.
 *
 * @param {string} macaroonB64 - Base64-encoded serialized macaroon
 * @param {string} preimageHex - Payment preimage (64-char hex)
 * @param {string} requestedResourceId - Resource ID from the request
 * @returns {{valid: boolean, error?: string, resourceId?: string, expiresAt?: number}}
 */
function verifyMacaroon(macaroonB64, preimageHex, requestedResourceId) {
    try {
        const macaroon = MacaroonsBuilder.deserialize(macaroonB64);

        // Verify preimage matches payment hash (macaroon identifier).
        // This is the cryptographic proof that the Lightning invoice was paid.
        const paymentHash = macaroon.identifier;
        const computedHash = crypto
            .createHash('sha256')
            .update(Buffer.from(preimageHex, 'hex'))
            .digest('hex');

        if (computedHash !== paymentHash) {
            return { valid: false, error: 'Invalid preimage — payment not verified' };
        }

        const verifier = new MacaroonsVerifier(macaroon);

        let tokenResourceId = null;
        let tokenExpiresAt = null;

        verifier.satisfyGeneral((caveat) => {
            const eqIndex = caveat.indexOf('=');
            if (eqIndex === -1) return false;

            const key = caveat.substring(0, eqIndex).trim();
            const value = caveat.substring(eqIndex + 1).trim();

            switch (key) {
                case 'resource_id':
                    tokenResourceId = value;
                    if (value !== requestedResourceId) {
                        throw new Error(`Token for resource '${value}', but requested '${requestedResourceId}'`);
                    }
                    return true;

                case 'expires_at':
                    tokenExpiresAt = parseInt(value);
                    if (tokenExpiresAt < Date.now() / 1000) {
                        throw new Error('Token expired');
                    }
                    return true;

                case 'service':
                    // Accept any service value — allows cross-service token delegation
                    return true;

                default:
                    // Unknown caveats from client attenuation — accept them.
                    // Macaroons are designed for this: clients can add caveats
                    // to further restrict their own tokens.
                    return true;
            }
        });

        // Verify the HMAC signature chain against our secret
        verifier.assertIsValid(CONFIG.secret);

        return {
            valid: true,
            resourceId: tokenResourceId,
            expiresAt: tokenExpiresAt,
            paymentHash: paymentHash,
        };

    } catch (err) {
        return { valid: false, error: err.message };
    }
}

// ===========================================
// L402 Auth Handler
// ===========================================

/**
 * Check L402 authorization for a resource request.
 *
 * Call this in your route handler. It returns true if the request is authorized
 * (caller should serve the resource). Returns false if not authorized — in that
 * case, a 402 Payment Required response has already been sent.
 *
 * Usage:
 *   const authorized = await l402.handleL402Auth(req, res, 'my-resource-id');
 *   if (!authorized) return; // 402 already sent
 *   // Serve the resource...
 *
 * With consumption hints:
 *   const authorized = await l402.handleL402Auth(req, res, 'video-123', {
 *       consumption: { type: 'browser', action: 'Open the player URL' },
 *       player_url: 'https://example.com/player?v={resource_id}&token={token}',
 *   });
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} resourceId - Identifier for the resource being requested
 * @param {Object} [options] - Optional fields to include in 402 responses (consumption hints, etc.)
 * @returns {Promise<boolean>} true if authorized, false if 402 sent
 */
async function handleL402Auth(req, res, resourceId, options) {
    const authHeader = req.headers['authorization'];

    if (authHeader && authHeader.startsWith('L402 ')) {
        // Parse token: "L402 <macaroon>:<preimage>"
        const tokenPart = authHeader.substring(5);
        const colonIndex = tokenPart.indexOf(':');

        if (colonIndex === -1) {
            await sendL402Challenge(res, resourceId, { ...options, error: 'Invalid token format — expected macaroon:preimage' });
            return false;
        }

        const macaroonB64 = tokenPart.substring(0, colonIndex);
        const preimageHex = tokenPart.substring(colonIndex + 1);

        const result = verifyMacaroon(macaroonB64, preimageHex, resourceId);

        if (result.valid) {
            console.log(`[L402] Access granted: ${resourceId}`);
            return true;
        } else {
            console.log(`[L402] Access denied for ${resourceId}: ${result.error}`);
            await sendL402Challenge(res, resourceId, { ...options, error: result.error });
            return false;
        }
    }

    // No token provided — issue challenge
    await sendL402Challenge(res, resourceId, options);
    return false;
}

/**
 * Send HTTP 402 Payment Required with a Lightning invoice.
 *
 * The response includes:
 * - WWW-Authenticate header with macaroon and invoice (per L402 spec)
 * - JSON body with human/machine-readable payment instructions
 * - Optional consumption hints and other fields from the options object
 *
 * @param {http.ServerResponse} res
 * @param {string} resourceId
 * @param {string|Object} [errorOrOptions] - Error string (backward compat) or options object
 * @param {string} [errorOrOptions.error] - Error message for invalid token attempts
 * @param {Object} [errorOrOptions.consumption] - Consumption hints (type, action, player_url, etc.)
 * @param {string} [errorOrOptions.player_url] - URL template for browser-based consumption
 * @param {string} [errorOrOptions.player_note] - Instructions for using the player URL
 */
async function sendL402Challenge(res, resourceId, errorOrOptions) {
    // Backward compat: string arg is the error message, object arg is options
    let error, extra;
    if (typeof errorOrOptions === 'string') {
        error = errorOrOptions;
        extra = {};
    } else if (errorOrOptions && typeof errorOrOptions === 'object') {
        ({ error, ...extra } = errorOrOptions);
    } else {
        extra = {};
    }

    try {
        const memo = `L402 access: ${resourceId}`;
        const { paymentHash, paymentRequest } = await createInvoice(CONFIG.priceSats, memo);
        const macaroon = createMacaroon(paymentHash, resourceId);

        const challenge = `L402 macaroon="${macaroon}", invoice="${paymentRequest}"`;

        res.writeHead(402, {
            'Content-Type': 'application/json',
            'WWW-Authenticate': challenge,
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'Access-Control-Expose-Headers': 'WWW-Authenticate',
        });

        const body = {
            error: 'Payment Required',
            message: error || `Pay ${CONFIG.priceSats} sats to access this resource`,
            price_sats: CONFIG.priceSats,
            token_expiry_seconds: CONFIG.expirySeconds,
            resource_id: resourceId,
            macaroon: macaroon,
            invoice: paymentRequest,
            token_format: {
                header: 'Authorization: L402 <macaroon>:<preimage>',
                note: 'macaroon is the base64 string from the WWW-Authenticate header. preimage is the 64-char hex string your wallet returns after paying the invoice. Concatenate with a colon, no spaces.',
            },
        };

        // Merge optional fields (consumption hints, player_url, etc.)
        Object.assign(body, extra);

        res.end(JSON.stringify(body));

        console.log(`[L402] Challenge issued: ${resourceId} (${CONFIG.priceSats} sats)`);

    } catch (err) {
        console.error('[L402] Invoice creation failed:', err.message);
        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Payment system unavailable' }));
        }
    }
}

// ===========================================
// Exports
// ===========================================

module.exports = {
    initLnd,
    handleL402Auth,
    createInvoice,
    createMacaroon,
    verifyMacaroon,
    sendL402Challenge,
    CONFIG,
};
