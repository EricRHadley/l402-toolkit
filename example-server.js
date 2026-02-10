#!/usr/bin/env node

/**
 * example-server.js — Minimal L402-protected HTTP server
 *
 * Demonstrates how to integrate l402.js into a Node.js server.
 * Protects a simple JSON API endpoint behind a Lightning paywall.
 *
 * Usage:
 *   # Set required environment variables
 *   export L402_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
 *   export LND_MACAROON_PATH=/path/to/admin.macaroon
 *   export LND_TLS_CERT_PATH=/path/to/tls.cert
 *   export LND_REST_HOST=https://localhost:8080
 *
 *   # Optional configuration
 *   export L402_PRICE_SATS=10          # Price per access (default: 10)
 *   export L402_LOCATION=example.com   # Your domain (default: localhost)
 *
 *   node example-server.js
 *
 * Endpoints:
 *   GET /                    — Service info (free)
 *   GET /api/protected       — L402-protected resource (requires payment)
 *   GET /api/protected/:id   — L402-protected resource by ID
 */

const http = require('http');
const l402 = require('./l402');

const PORT = process.env.PORT || 3000;

// ── Initialize L402 ──────────────────────────────────────

const l402Enabled = l402.initLnd();

if (!l402Enabled) {
    console.log('');
    console.log('L402 is disabled. To enable, set these environment variables:');
    console.log('  L402_SECRET          — 32-byte hex secret for macaroon signing');
    console.log('  LND_MACAROON_PATH    — Path to LND macaroon file');
    console.log('  LND_TLS_CERT_PATH    — Path to LND TLS certificate (optional)');
    console.log('  LND_REST_HOST        — LND REST endpoint (default: https://localhost:8080)');
    console.log('');
    console.log('Generate a secret: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    console.log('');
}

// ── Request Handler ──────────────────────────────────────

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
        });
        res.end();
        return;
    }

    // ── GET / — Service info (free) ──

    if (pathname === '/' || pathname === '/api') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            name: 'L402 Example Server',
            l402_enabled: l402Enabled,
            price_sats: l402.CONFIG.priceSats,
            endpoints: {
                info: { url: '/', method: 'GET', auth: 'none' },
                protected: {
                    url: '/api/protected/:id',
                    method: 'GET',
                    auth: 'L402',
                    cost_sats: l402.CONFIG.priceSats,
                    description: 'Returns 402 with Lightning invoice. Pay and re-request with L402 token.',
                },
            },
            l402_flow: [
                '1. GET /api/protected/my-resource',
                '2. Receive 402 with WWW-Authenticate: L402 macaroon="...", invoice="..."',
                '3. Pay the Lightning invoice. Wallet returns a preimage (64-char hex).',
                '4. Re-request with header: Authorization: L402 <macaroon>:<preimage>',
                '5. Receive the protected resource.',
            ],
        }, null, 2));
        return;
    }

    // ── GET /api/protected/:id — L402-gated resource ──

    if (l402Enabled && pathname.startsWith('/api/protected')) {
        // Extract resource ID from path, default to "default"
        const parts = pathname.split('/').filter(Boolean);
        const resourceId = parts[2] || 'default';

        // This is the key integration point:
        // handleL402Auth returns true if authorized, false if 402 was sent.
        const authorized = await l402.handleL402Auth(req, res, resourceId);
        if (!authorized) return; // 402 challenge already sent

        // ── Authorized — serve the resource ──
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({
            resource_id: resourceId,
            message: 'Access granted. You paid for this resource with Lightning.',
            data: {
                content: `This is the protected content for resource "${resourceId}".`,
                timestamp: new Date().toISOString(),
            },
        }, null, 2));
        return;
    }

    // ── 404 ──

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
    console.log(`Example L402 server running on http://localhost:${PORT}`);
    if (l402Enabled) {
        console.log(`Protected endpoint: http://localhost:${PORT}/api/protected/my-resource`);
    }
});
