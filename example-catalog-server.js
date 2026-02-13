#!/usr/bin/env node

/**
 * example-catalog-server.js — L402-gated Media Catalog
 *
 * Multi-resource catalog demonstrating agent-friendly patterns:
 * - Free browsing and search (Pattern 3)
 * - Consumption hints in 402 responses (Pattern 4)
 * - Resolved URLs on every result (Pattern 7)
 * - Protocol hints before data arrays (Pattern 8)
 * - Inline flow steps (Pattern 9)
 * - Token economics in every 402 body (Pattern 10)
 *
 * Usage:
 *   export L402_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
 *   export LND_MACAROON_PATH=/path/to/invoice.macaroon
 *   export LND_TLS_CERT_PATH=/path/to/tls.cert
 *   export LND_REST_HOST=https://your-lnd-node:8080
 *   node example-catalog-server.js
 *
 * Endpoints:
 *   GET /api                 — Service info (free)
 *   GET /api/catalog         — Browse all resources (free)
 *   GET /api/search?q=       — Search resources (free)
 *   GET /api/resource/:id    — L402-protected resource (10 sats)
 */

const http = require('http');
const l402 = require('./l402');

const PORT = process.env.PORT || 3001;

const CATALOG = [
    {
        id: 'report-btc-2025',
        title: 'Bitcoin Mining Report 2025',
        type: 'report',
        description: 'Analysis of mining economics post-halving.',
        consumption: { type: 'api_response', action: 'Parse the JSON response. The report field contains the full text.' },
        content: 'Hash rate hit 800 EH/s in Q1 2025. Miners with sub-$0.04/kWh power costs remain profitable post-halving. Transaction fee revenue now accounts for 12% of miner income, up from 3% pre-halving.',
    },
    {
        id: 'clip-lightning-explainer',
        title: 'Lightning Network Explainer',
        type: 'video',
        description: '90-second animated explainer of payment channels.',
        consumption: {
            type: 'browser',
            action: 'Open the player_url in a browser to watch the video.',
            player_url: '/player.html?v=clip-lightning-explainer&token={token}',
            token_encoding: 'URL-encode the full macaroon:preimage string as the {token} parameter.',
        },
        content: 'HLS stream: /api/stream/clip-lightning-explainer/master.m3u8',
    },
    {
        id: 'dataset-node-stats',
        title: 'Lightning Node Statistics CSV',
        type: 'dataset',
        description: 'Channel counts, capacity, and uptime for top 100 nodes.',
        consumption: { type: 'download', action: 'Save the response body as a CSV file.' },
        content: 'pubkey,alias,channels,capacity_btc,uptime_pct\n03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f,ACINQ,2847,125.4,99.8\n0217890e3aad8d35bc054f43acc00084b25571f35b3f192bded3dc18e20673c7f4,Bitrefill,1523,89.2,99.6',
    },
    {
        id: 'quote-satoshi',
        title: 'Random Satoshi Quote',
        type: 'quote',
        description: 'A verified quote from Satoshi Nakamoto forum posts.',
        consumption: { type: 'display', action: 'Display the quote text directly to the user.' },
        content: 'If you don\'t believe me or don\'t understand, I don\'t have time to try to convince you, sorry. — Satoshi Nakamoto, July 29, 2010',
    },
];

const l402Enabled = l402.initLnd();

if (!l402Enabled) {
    console.log('\nL402 is disabled. Set L402_SECRET and LND_MACAROON_PATH to enable.\n');
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
        });
        res.end();
        return;
    }

    // GET /api — Service info (free, Pattern 1)
    if (pathname === '/' || pathname === '/api') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            name: 'L402 Media Catalog',
            description: 'Browse resources for free, pay per item to access. Lightning-gated via L402.',
            protocol: 'L402',
            l402_enabled: l402Enabled,
            price_sats: l402.CONFIG.priceSats,
            token_expiry_seconds: l402.CONFIG.expirySeconds,
            endpoints: {
                info: { url: '/api', method: 'GET', auth: 'none', description: 'This endpoint.' },
                catalog: { url: '/api/catalog', method: 'GET', auth: 'none', description: 'Browse all resources.' },
                search: { url: '/api/search?q=keyword', method: 'GET', auth: 'none', description: 'Search by keyword.' },
                resource: { url: '/api/resource/{id}', method: 'GET', auth: 'L402', cost_sats: l402.CONFIG.priceSats, description: 'Access a resource. Requires L402 payment.' },
            },
            l402_flow: [
                '1. GET /api/catalog or /api/search?q=keyword to browse resources (free)',
                '2. GET /api/resource/{id} for the resource you want',
                '3. Receive 402 with WWW-Authenticate: L402 macaroon="...", invoice="lnbc..."',
                '4. Pay the Lightning invoice. Your wallet returns a preimage (64-char hex).',
                '5. Re-request with header: Authorization: L402 <macaroon>:<preimage>',
                '6. Receive the resource.',
            ],
        }, null, 2));
        return;
    }

    // GET /api/catalog — Browse all resources (free, Patterns 3, 7, 8)
    if (pathname === '/api/catalog') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({
            l402: {
                price_sats: l402.CONFIG.priceSats,
                token_expiry_seconds: l402.CONFIG.expirySeconds,
                endpoint: '/api/resource/{id}',
                flow: [
                    'GET /api/resource/{id} → receive 402 with invoice',
                    'Pay the Lightning invoice',
                    'Re-request with Authorization: L402 {macaroon}:{preimage}',
                ],
            },
            results: CATALOG.map(item => ({
                id: item.id,
                title: item.title,
                type: item.type,
                description: item.description,
                l402_url: `/api/resource/${item.id}`,
                cost_sats: l402.CONFIG.priceSats,
            })),
        }, null, 2));
        return;
    }

    // GET /api/search?q= — Search resources (free, Pattern 3)
    if (pathname === '/api/search') {
        const query = (url.searchParams.get('q') || '').toLowerCase();
        const matches = CATALOG.filter(item =>
            item.title.toLowerCase().includes(query) ||
            item.description.toLowerCase().includes(query)
        );
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({
            l402: {
                price_sats: l402.CONFIG.priceSats,
                token_expiry_seconds: l402.CONFIG.expirySeconds,
                endpoint: '/api/resource/{id}',
                flow: [
                    'GET /api/resource/{id} → receive 402 with invoice',
                    'Pay the Lightning invoice',
                    'Re-request with Authorization: L402 {macaroon}:{preimage}',
                ],
            },
            query: query,
            count: matches.length,
            results: matches.map(item => ({
                id: item.id,
                title: item.title,
                type: item.type,
                description: item.description,
                l402_url: `/api/resource/${item.id}`,
                cost_sats: l402.CONFIG.priceSats,
            })),
        }, null, 2));
        return;
    }

    // GET /api/resource/:id — L402-protected resource (Pattern 4)
    const resourceMatch = pathname.match(/^\/api\/resource\/(.+)$/);
    if (resourceMatch) {
        const id = resourceMatch[1];
        const item = CATALOG.find(r => r.id === id);

        if (!item) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Resource '${id}' not found. Try GET /api/catalog` }));
            return;
        }

        if (!l402Enabled) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'L402 not configured. See /api for setup instructions.' }));
            return;
        }

        const authorized = await l402.handleL402Auth(req, res, item.id, {
            consumption: item.consumption,
        });
        if (!authorized) return;

        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({
            id: item.id,
            title: item.title,
            type: item.type,
            content: item.content,
            paid: true,
            price_sats: l402.CONFIG.priceSats,
        }, null, 2));
        return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found. Try GET /api' }));
});

server.listen(PORT, () => {
    console.log(`Media Catalog running on http://localhost:${PORT}`);
    console.log(`Service info:  http://localhost:${PORT}/api`);
    console.log(`Browse:        http://localhost:${PORT}/api/catalog`);
    if (l402Enabled) {
        console.log(`Example:       http://localhost:${PORT}/api/resource/report-btc-2025`);
    }
});
