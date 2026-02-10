# Making L402 Services Agent-Friendly

How to build an L402 service that AI agents can discover and use without prior configuration.

## The Problem

An L402 server returns a 402 challenge with an invoice. But that alone doesn't tell an agent *what* it's paying for, *how much*, or *what to do* with the resource after paying. Without additional context, the agent needs a pre-written instruction file (like a CLAUDE.md) to understand the service.

The goal: make your service self-describing enough that an agent with a Lightning wallet can figure out the entire flow from the HTTP responses alone — no documentation, no pre-configuration, just the protocol.

## Pattern 1: Self-Describing Root Endpoint

Add a root endpoint (`/` or `/api`) that describes your service, its pricing, and the L402 flow in machine-readable JSON.

```javascript
// GET /api
res.writeHead(200, { 'Content-Type': 'application/json' });
res.end(JSON.stringify({
    name: 'My L402 Service',
    description: 'Pay-per-use API for weather data.',
    protocol: 'L402',
    price_sats: 10,
    endpoints: {
        forecast: {
            url: '/api/forecast/:city',
            method: 'GET',
            auth: 'L402',
            cost_sats: 10,
            description: 'Returns 7-day weather forecast. Requires L402 payment.',
        },
        cities: {
            url: '/api/cities',
            method: 'GET',
            auth: 'none',
            description: 'List available cities. No payment required.',
        },
    },
    l402_flow: [
        '1. GET /api/forecast/prague',
        '2. Receive 402 with WWW-Authenticate: L402 macaroon="...", invoice="lnbc..."',
        '3. Pay the Lightning invoice. Wallet returns a preimage (64-char hex).',
        '4. Re-request with header: Authorization: L402 <macaroon>:<preimage>',
        '5. Receive the forecast data.',
    ],
}));
```

An agent that visits `/api` gets everything it needs: what endpoints exist, which ones cost money, how much, and the exact steps to pay. The `l402_flow` array is the instruction manual embedded in the protocol.

## Pattern 2: Informative 402 Response Bodies

The L402 spec requires the `WWW-Authenticate` header. But the response body is yours to use. Make it teach the protocol:

```javascript
res.writeHead(402, {
    'Content-Type': 'application/json',
    'WWW-Authenticate': `L402 macaroon="${macaroon}", invoice="${invoice}"`,
});
res.end(JSON.stringify({
    error: 'Payment Required',
    message: 'Pay 10 sats to access this resource',
    price_sats: 10,
    resource_id: 'prague',
    token_format: {
        header: 'Authorization: L402 <macaroon>:<preimage>',
        note: 'macaroon is the base64 string from WWW-Authenticate. preimage is the 64-char hex from your wallet after paying. Concatenate with colon.',
    },
}));
```

The `token_format` field is the critical addition. Without it, an agent must already know the L402 spec to construct the Authorization header. With it, the 402 response itself teaches the agent what to do next.

## Pattern 3: Free Discovery Endpoints

Not every endpoint should cost money. Provide free endpoints that let agents browse and decide what to pay for:

```javascript
// Free — let agents discover what's available
app.get('/api/catalog', (req, res) => { /* list of resources */ });
app.get('/api/search', (req, res) => { /* search by keyword */ });
app.get('/api/health', (req, res) => { /* service status + pricing */ });

// Paid — the actual content
app.get('/api/content/:id', l402Protected);
```

The pattern: discovery is free, content is paid. An agent can browse the catalog, pick what it wants, and only pay when it commits. This mirrors how humans shop — you don't pay to see what's on the shelf.

## Pattern 4: Consumption Hints

After payment, what should the client DO with the resource? For a JSON API, it's obvious — parse the response. But for media, files, or browser-based content, the agent needs guidance:

```json
{
    "endpoints": {
        "stream": {
            "url": "/api/stream/:id",
            "auth": "L402",
            "consumption": {
                "type": "browser",
                "action": "Open the player URL with the token to play the video",
                "player_url": "https://example.com/player?id={id}&token={token}",
                "token_delivery": "query_param",
                "token_encoding": "URL-encode the full macaroon:preimage string"
            }
        },
        "report": {
            "url": "/api/report/:id",
            "auth": "L402",
            "consumption": {
                "type": "download",
                "action": "Save the response body as a PDF file"
            }
        },
        "data": {
            "url": "/api/data/:id",
            "auth": "L402",
            "consumption": {
                "type": "api_response",
                "action": "Parse the JSON response directly"
            }
        }
    }
}
```

Consumption types:
- **`api_response`** — Parse the JSON/text response directly
- **`browser`** — Open a URL in the browser (include the URL template)
- **`download`** — Save the response body as a file
- **`display`** — Show the content to the user inline
- **`stream`** — Stream media content

## Pattern 5: Consistent Error Messages

When token verification fails, tell the agent *why* and *what to do*:

```json
{
    "error": "Payment Required",
    "message": "Token expired. Pay a new invoice to continue.",
    "price_sats": 10,
    "resource_id": "prague",
    "token_format": {
        "header": "Authorization: L402 <macaroon>:<preimage>"
    }
}
```

Common failure reasons and what the agent needs to know:
- **No token** → "Pay the invoice in WWW-Authenticate to get access"
- **Expired token** → "Token expired. Request again for a new invoice."
- **Wrong resource** → "This token is for resource 'X', not 'Y'. Each resource requires its own payment."
- **Invalid preimage** → "Preimage does not match payment hash. The invoice may not have been paid."

Each of these tells the agent exactly what went wrong and implies the recovery action.

## Putting It All Together

A fully agent-friendly L402 service has:

1. **A free root endpoint** (`/api`) describing the service, endpoints, pricing, and L402 flow
2. **Free discovery endpoints** for browsing available resources
3. **Informative 402 responses** with `token_format` instructions in the body
4. **Consumption hints** telling agents what to do after payment
5. **Clear error messages** that explain failures and imply recovery actions

The test: can a fresh AI agent with a Lightning wallet — and zero prior knowledge of your service — discover what you offer, pay for a resource, and deliver it to the user? If the answer is yes, your service is agent-friendly. If the agent needs a pre-written instruction file, look at what information that file contains and embed it in your HTTP responses instead.

## Example: Complete Agent-Friendly Server

See `example-server.js` in this repo for a minimal implementation of these patterns. The `/` endpoint returns a self-describing JSON document with the full L402 flow, and the 402 responses include `token_format` instructions.
