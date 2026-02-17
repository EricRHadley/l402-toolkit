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

## Pattern 6: `<noscript>` Fallback for Non-JS Clients

AI agents using tools like WebFetch don't execute JavaScript. If your homepage is a single-page app, agents see an empty shell. Add a `<noscript>` block near the top of your HTML with direct API pointers:

```html
<noscript>
    <div>
        <h2>API Access</h2>
        <p>This service provides a machine-readable API.</p>
        <ul>
            <li>Service info: GET /api</li>
            <li>Search resources: GET /api/search?q=keyword</li>
            <li>L402 payment docs: GET /api/l402/docs</li>
        </ul>
    </div>
</noscript>
```

The agent immediately sees the API entry points without needing to execute JavaScript or resort to web searching for documentation.

## Pattern 7: Resolved URLs on Every Result Object

When your search or listing endpoints return many results, template URLs at the bottom of the response get lost. AI tools that summarize large responses (210KB+) often truncate the end, dropping your URL templates entirely.

Fix: include the fully resolved URL on each individual result object:

```javascript
// Instead of just a template at the top:
// "url_template": "/api/resource/{id}"

// Include resolved URLs on each result:
results.map(item => ({
    id: item.id,
    title: item.title,
    description: item.description,
    l402_url: `/api/resource/${item.id}`,  // Resolved, right next to the title
}))
```

The agent sees the exact URL to request right next to each item's title — it can't miss it, even if the response gets truncated.

## Pattern 8: Response Key Ordering

JSON key order equals insertion order in Node.js (and most JavaScript runtimes). When an AI tool summarizes a large JSON response, it processes keys in order and may truncate. Put machine-readable protocol hints **before** bulk data arrays:

```javascript
// Good: agent sees L402 info in the first few hundred bytes
res.end(JSON.stringify({
    l402: {
        enabled: true,
        price_sats: 10,
        endpoint: '/api/resource/{id}',
        flow: ['GET resource', '402 with invoice', 'Pay', 'Re-request with token']
    },
    results: [ /* potentially hundreds of KB of data */ ]
}));

// Bad: L402 info comes after 200KB of results — invisible to summarizers
res.end(JSON.stringify({
    results: [ /* 200KB */ ],
    l402: { /* never seen */ }
}));
```

A 244-byte `l402` object after a 230KB `results` array is invisible. The same object before the array is the first thing any client reads.

## Pattern 9: Inline Protocol Flow Steps

Don't rely on agents fetching a separate documentation endpoint. Most agents won't make a second request to `/docs` — they'll try to figure it out from whatever response they already have. Embed the protocol flow directly in every L402-relevant response:

```javascript
l402: {
    price_sats: 10,
    flow: [
        'GET /api/resource/{id} → receive 402 with WWW-Authenticate header',
        'Pay the Lightning invoice from the response',
        'Re-request with Authorization: L402 {macaroon}:{preimage}',
        'Receive the resource'
    ]
}
```

Include this `flow` array in search responses, detail pages, health endpoints — anywhere an agent might land. The redundancy is intentional: the agent should encounter the flow steps no matter which endpoint it hits first.

## Pattern 10: Token Economics in the 402 Body

Agents make economic decisions before paying. If the 402 response only contains the invoice, the agent must decode the BOLT11 to learn the price and has no idea how long the token lasts. Include both upfront:

```javascript
res.end(JSON.stringify({
    error: 'Payment Required',
    price_sats: CONFIG.priceSats,
    token_expiry_seconds: CONFIG.expirySeconds,
    resource_id: resourceId,
    macaroon: macaroon,
    invoice: paymentRequest,
    token_format: {
        header: 'Authorization: L402 <macaroon>:<preimage>',
    },
}));
```

`price_sats` and `token_expiry_seconds` together tell the agent the full cost: "10 sats for 4 hours of access." Without `token_expiry_seconds`, an agent might assume a token is single-use or permanent — both wrong. The agent needs this for budget calculations (e.g., "I have 500 sats, can I afford to explore 10 resources at 10 sats each with 4-hour windows?").

These fields should also appear in your root endpoint (`/api`) so agents can evaluate economics before triggering a 402:

```javascript
{
    "protocol": "L402",
    "price_sats": 10,
    "token_expiry_seconds": 14400,
    "endpoints": { ... }
}
```

## Pattern 11: Service Directory Registration

The patterns above make your service self-describing *once an agent finds it*. But how does the agent find your service in the first place?

Service directories are machine-readable registries that list L402 services with their API endpoints, pricing, and capabilities. They solve the cold-start problem: an agent with a Lightning wallet and no bookmarks can query a directory to discover services matching a need.

### What a Directory Entry Looks Like

A directory entry is essentially your Pattern 1 self-describing endpoint, submitted to a registry:

```json
{
    "name": "Weather Data API",
    "description": "Pay-per-query weather forecasts. 10 sats per city.",
    "api_url": "https://weather.example.com/api",
    "protocol": "L402",
    "price_sats": 10,
    "capabilities": ["forecast", "historical", "alerts"]
}
```

The `api_url` points to your free root endpoint. An agent that discovers your service through the directory hits that URL first, reads the self-describing response, and proceeds through the normal L402 flow.

### Why This Matters for Agents

Without directories, an agent needs one of:
- A hardcoded URL in its instructions
- A web search that returns your service (unreliable for API discovery)
- A human telling it where to go

Directories provide programmatic discovery: the agent queries an API, gets a list of services matching criteria, and picks one. This is the machine-to-machine equivalent of a search engine — structured data instead of HTML pages.

### Existing Implementations

[l402.directory](https://l402.directory) is one implementation of this concept, providing a searchable registry of L402 services with a JSON API. The pattern itself is generic — any service that maintains a machine-readable list of L402 endpoints with their capabilities and pricing serves as a directory.

### Design Considerations

- **Directories should be free to query.** If the directory itself requires payment to browse, agents can't discover services without already having a service relationship — a chicken-and-egg problem.
- **Use resolved URLs.** The `api_url` field should be a complete, directly-requestable URL (Pattern 7 applies here too).
- **Keep entries minimal.** A directory entry is a pointer, not documentation. The service's own `/api` endpoint provides the full description.

## Pattern 12: Token Lifecycle Management

An agent paid for a token. Now what? How does it know when the token expires? How does it avoid wasting a round-trip on an expired token? How does it re-authenticate?

### Checking Token Expiry

If the service uses this toolkit's `l402.js`, tokens include an `expires_at` caveat. Use `getTokenInfo()` to read it without making a network request:

```javascript
const l402 = require('./l402');

const info = l402.getTokenInfo(savedMacaroon);
if (info && info.expiresAt) {
    const secondsLeft = info.expiresAt - Math.floor(Date.now() / 1000);
    if (secondsLeft <= 0) {
        // Token expired — need to re-authenticate
    } else if (secondsLeft < 60) {
        // Expiring soon — re-authenticate proactively
    }
}
```

**Important**: `expires_at` is a caveat added by this toolkit, not part of the L402 spec. Third-party L402 services may not include it. If the field is missing, the only way to check expiry is to make a request and see if you get a 402 back.

### Client-Side Token Cache

Agents that interact with multiple L402 services should cache tokens by resource ID:

```javascript
// Store after each successful payment
tokenCache[resourceId] = {
    macaroon: macaroonBase64,
    preimage: preimageHex,
    expiresAt: info.expiresAt,  // may be null for non-toolkit services
};

// Before each request, check for a valid cached token
const cached = tokenCache[resourceId];
if (cached && cached.expiresAt && cached.expiresAt > Date.now() / 1000) {
    // Use cached token — skip the 402 round-trip
    headers['Authorization'] = `L402 ${cached.macaroon}:${cached.preimage}`;
}
```

### Re-Authentication Flow

L402 tokens are stateless — the server has no session to extend or renew. When a token expires, the flow is identical to the first time:

1. Request the resource (no token or expired token)
2. Get 402 with a new invoice
3. Pay the new invoice
4. Use the new macaroon:preimage token

There is no "refresh" endpoint. No "renew" API. You just pay again. This is by design — the server doesn't track sessions, so it can't extend one. The simplicity is the feature.

## Putting It All Together

A fully agent-friendly L402 service has:

1. **A free root endpoint** (`/api`) describing the service, endpoints, pricing, and L402 flow
2. **Free discovery endpoints** for browsing available resources
3. **Informative 402 responses** with `token_format` instructions in the body
4. **Consumption hints** telling agents what to do after payment
5. **Clear error messages** that explain failures and imply recovery actions
6. **`<noscript>` fallbacks** so non-JS clients can find your API
7. **Resolved URLs** on every result object (not just templates)
8. **Protocol hints before data** in response key ordering
9. **Inline flow steps** in every L402-relevant response
10. **Token economics** (`price_sats` + `token_expiry_seconds`) in every 402 body
11. **Directory registration** so agents can discover your service programmatically
12. **Token lifecycle management** — expiry checking, client-side caching, re-authentication

The test: can a fresh AI agent with a Lightning wallet — and zero prior knowledge of your service or its URL — discover what you offer, pay for a resource, and deliver it to the user? If the answer is yes, your service is agent-friendly. If the agent needs a pre-written instruction file, look at what information that file contains and embed it in your HTTP responses instead.

In practice, roughly 20% of an agent's success comes from the L402 protocol itself (402 status code, `WWW-Authenticate` header, preimage verification). The other 80% comes from implementation decisions above the spec — free browsing tiers, self-documenting 402 bodies, consumption hints, resolved URLs, token economics, lifecycle management. The protocol provides the payment rails; these patterns provide the user experience.

## Examples

See `example-server.js` for a minimal single-resource implementation of these patterns. See `example-catalog-server.js` for a multi-resource catalog demonstrating free browsing, search, consumption hints in 402 responses, and different consumption types.
