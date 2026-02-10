#!/usr/bin/env node

/**
 * example-server.js — L402-gated Fortune Cookie API
 *
 * Pay 10 sats, get a fortune. No accounts, no sessions.
 * Demonstrates how to integrate l402.js into a Node.js server,
 * including agent-friendly discovery patterns (free /api endpoint,
 * consumption hints, l402_flow instructions).
 *
 * Usage:
 *   export L402_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
 *   export LND_MACAROON_PATH=/path/to/invoice.macaroon
 *   export LND_TLS_CERT_PATH=/path/to/tls.cert
 *   export LND_REST_HOST=https://your-lnd-node:8080
 *   export L402_PRICE_SATS=10
 *   export L402_LOCATION=fortune-demo
 *   node example-server.js
 *
 * Endpoints:
 *   GET /api          — Service info (free)
 *   GET /api/fortune  — L402-protected fortune (10 sats)
 */

const http = require('http');
const l402 = require('./l402');

const PORT = process.env.PORT || 3000;

const FORTUNES = [
    "The best time to plant a tree was 20 years ago. The second best time is now.",
    "A ship in harbor is safe, but that is not what ships are built for.",
    "The obstacle is the way.",
    "What you do speaks so loudly I cannot hear what you say.",
    "The only way to do great work is to love what you do.",
    "Fortune favors the bold.",
    "A smooth sea never made a skilled sailor.",
    "The harder you work, the luckier you get.",
    "In the middle of difficulty lies opportunity.",
    "Not your keys, not your coins.",
    "Stay humble, stack sats.",
    "The best Lightning channel is one you never have to think about.",
    "Patience is not the ability to wait, but the ability to keep a good attitude while waiting.",
    "A penny saved is a penny earned. A sat stacked is sovereignty earned.",
    "The quieter you become, the more you can hear.",
    "Do not wait for leaders; do it alone, person to person.",
];

// Initialize L402
const l402Enabled = l402.initLnd();

if (!l402Enabled) {
    console.log('');
    console.log('L402 is disabled. To enable, set these environment variables:');
    console.log('  L402_SECRET          — 32-byte hex secret for macaroon signing');
    console.log('  LND_MACAROON_PATH    — Path to LND macaroon file (needs invoice creation perms)');
    console.log('  LND_TLS_CERT_PATH    — Path to LND TLS certificate');
    console.log('  LND_REST_HOST        — LND REST endpoint (default: https://localhost:8080)');
    console.log('');
}

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

    // GET / or /api — Service info (free)
    if (pathname === '/' || pathname === '/api') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            name: 'Fortune Cookie API',
            description: 'Pay 10 sats, get a fortune. Lightning-gated via L402.',
            protocol: 'L402',
            l402_enabled: l402Enabled,
            price_sats: l402.CONFIG.priceSats,
            endpoints: {
                info: { url: '/api', method: 'GET', auth: 'none', description: 'This endpoint. Service info and L402 flow.' },
                fortune: {
                    url: '/api/fortune',
                    method: 'GET',
                    auth: 'L402',
                    cost_sats: l402.CONFIG.priceSats,
                    description: 'Returns a random fortune. Requires L402 payment.',
                    consumption: {
                        type: 'api_response',
                        action: 'Read the fortune field from the JSON response.',
                    },
                },
            },
            l402_flow: [
                '1. GET /api/fortune',
                '2. Receive 402 with WWW-Authenticate: L402 macaroon="...", invoice="lnbc..."',
                '3. Pay the Lightning invoice. Your wallet returns a preimage (64-char hex).',
                '4. Re-request with header: Authorization: L402 <macaroon>:<preimage>',
                '5. Receive your fortune.',
            ],
        }, null, 2));
        return;
    }

    // GET /api/fortune — L402-protected fortune
    if (pathname === '/api/fortune') {
        if (!l402Enabled) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'L402 not configured. See /api for setup instructions.' }));
            return;
        }

        const authorized = await l402.handleL402Auth(req, res, 'fortune');
        if (!authorized) return;

        const fortune = FORTUNES[Math.floor(Math.random() * FORTUNES.length)];

        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({
            fortune: fortune,
            paid: true,
            price_sats: l402.CONFIG.priceSats,
        }, null, 2));
        return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found. Try GET /api' }));
});

server.listen(PORT, () => {
    console.log(`Fortune Cookie API running on http://localhost:${PORT}`);
    console.log(`Service info: http://localhost:${PORT}/api`);
    if (l402Enabled) {
        console.log(`Protected endpoint: http://localhost:${PORT}/api/fortune`);
    }
});
