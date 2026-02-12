# How an AI Agent Used L402 End-to-End

A narrative walkthrough of a real AI agent discovering, paying for, and consuming an L402 service — with no prior configuration, no API keys, and no pre-written instructions about the service.

## The Setup

An AI agent (Claude Code) equipped with a Lightning wallet via MCP tools (`decode_invoice`, `pay_invoice`, `get_balance`, `get_budget`) was asked: "play me a video from a service on l402.directory that you would like."

The agent had never interacted with the video service before. No CLAUDE.md, no hardcoded URLs, no service-specific instructions. Just a wallet and a directory URL.

## Step 1: Discovery via Service Directory

The agent queried the directory's API:

```
GET https://l402.directory/api/services
```

Response (abbreviated):

```json
{
    "services": [
        {
            "name": "Hyperdope Video",
            "url": "https://hyperdope.com",
            "description": "Lightning-gated video streaming. Pay 10 sats per video.",
            "categories": ["Video", "Streaming", "Content"],
            "endpoints": {
                "search": "GET /api/search?q=keyword (free)",
                "stream": "GET /api/l402/videos/{hash}/master.m3u8 (10 sats)"
            },
            "status": "Live"
        }
    ]
}
```

**What worked**: The directory returned machine-readable JSON with resolved URLs and endpoint descriptions. The agent could immediately see what the service offers, what's free, and what costs money — without visiting the service itself.

**Design choices**: Pattern 11 (directory registration), Pattern 7 (resolved URLs on every result).

## Step 2: Browsing the Service

The agent searched the video catalog — free, no payment required:

```
GET https://hyperdope.com/api/search?q=bitcoin
```

Response included 23 results, each with a title, ID, duration, and description. The agent browsed freely, decided on a video ("Building Paid APIs with Bitcoin," 4m 54s), and identified the L402 endpoint URL from the search results.

**What worked**: The free browsing tier let the agent evaluate options before committing sats. It could see titles, descriptions, and durations — enough to make an informed choice. The resolved URL for each video meant the agent didn't need to construct URLs from templates.

**Design choices**: Pattern 3 (free discovery endpoints), Pattern 7 (resolved URLs), Pattern 8 (protocol hints before data arrays — the L402 flow info appeared before the results array, ensuring it wasn't lost to response truncation).

## Step 3: The 402 Challenge

The agent requested the video stream:

```
GET https://hyperdope.com/api/l402/videos/87355a4d/master.m3u8
```

Response:

```
HTTP/1.1 402 Payment Required
WWW-Authenticate: L402 macaroon="MDAxYm...", invoice="lnbc100n1p5..."
Content-Type: application/json
```

```json
{
    "error": "Payment Required",
    "message": "Pay 10 sats to stream this video",
    "price_sats": 10,
    "token_expiry_seconds": 14400,
    "video_hash": "87355a4d",
    "macaroon": "MDAxYm...",
    "invoice": "lnbc100n1p5...",
    "token_format": {
        "header": "Authorization: L402 <macaroon>:<preimage>",
        "note": "macaroon is the base64 string from the WWW-Authenticate header. preimage is the 64-char hex string your wallet returns after paying the invoice. Concatenate with a colon, no spaces."
    },
    "player_url": "https://hyperdope.com/player.html?v=87355a4d&token={macaroon}:{preimage}",
    "player_note": "For browser playback, URL-encode the full macaroon:preimage token as the {token} parameter and open this URL."
}
```

**What worked**: This single response taught the agent everything it needed:

- `price_sats` and `token_expiry_seconds` — the agent knew the cost (10 sats for 4 hours) before paying
- `token_format` — explained exactly how to construct the Authorization header, so the agent didn't need to already know the L402 spec
- `player_url` with `{macaroon}:{preimage}` template — told the agent how to consume the resource after paying
- `player_note` — explained the URL encoding requirement

Without `token_format`, the agent would need pre-existing L402 knowledge. Without `player_url`, the agent would have tried to parse HLS binary data as JSON. Without `price_sats`, the agent would need to decode the BOLT11 invoice to learn the price.

**Design choices**: Pattern 2 (informative 402 bodies), Pattern 4 (consumption hints — `player_url` and `player_note`), Pattern 10 (token economics in the 402 body).

## Step 4: Payment

The agent used its MCP wallet tools:

```
decode_invoice("lnbc100n1p5...")
→ Amount: 10 sats, Description: "Hyperdope: 87355a4d", Expiry: 3600s

pay_invoice("lnbc100n1p5...")
→ Payment successful! Preimage: 1fb994d4e399c87217af92d2fe57ade7ef8de2d8d4114995696b2e6dd12173e9
```

This is the ~20% that is pure L402 protocol:

1. HTTP 402 status code signals "payment required"
2. `WWW-Authenticate` header carries the macaroon and invoice
3. The Lightning invoice is a standard BOLT11 string any wallet can pay
4. The preimage returned by the wallet is the cryptographic proof of payment

No implementation cleverness here — just the protocol doing what it was designed to do.

## Step 5: Consumption

The agent combined the macaroon and preimage into a token, URL-encoded it, and opened the browser:

```bash
TOKEN="${MACAROON}:${PREIMAGE}"
ENCODED_TOKEN=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${TOKEN}'))")
open "https://hyperdope.com/player.html?v=87355a4d&token=${ENCODED_TOKEN}"
```

The video played in the browser. Total elapsed time from discovery to playback: under 60 seconds.

**What worked**: The `player_url` template from the 402 response told the agent exactly what to construct. The `player_note` specified URL encoding. The agent went from "I have a token" to "the video is playing" in three lines.

**Design choice**: Pattern 4 (consumption hints). Without this, the agent would need to guess how to deliver the token — as a header? A query parameter? A cookie? The hint removed all ambiguity.

## The 80/20 Split: Protocol vs. Implementation Craft

Looking back at this flow, roughly 20% of the agent's success came from the L402 protocol itself:

- HTTP 402 status code (the agent knows payment is required)
- `WWW-Authenticate` header with macaroon and invoice (standard credential format)
- Preimage as proof of payment (cryptographic binding)
- `Authorization: L402` header format (standard token presentation)

The other 80% came from implementation decisions above the spec:

- **Service directory** — the agent found the service through a machine-readable registry, not a web search or hardcoded URL
- **Free browsing tier** — the agent could search and browse before committing sats
- **Self-documenting 402 body** — `token_format` taught the agent how to construct the Authorization header in-band, no external docs needed
- **Consumption hints** — `player_url` and `player_note` told the agent to open a browser URL with the token as a query parameter
- **Resolved URLs** — every catalog item included its direct API URL, no template parsing needed
- **Token economics** — `price_sats` and `token_expiry_seconds` let the agent make a budget decision before paying
- **Protocol hints before data** — L402 flow instructions appeared before bulk content arrays, surviving response summarization

The L402 spec provides the payment rails. The patterns in [AGENT-DISCOVERY.md](AGENT-DISCOVERY.md) provide the user experience. Both are necessary; neither is sufficient alone.

## Replicating This Flow

The l402-toolkit implements all the patterns used in this walkthrough:

1. **`l402.js`** handles the 402 challenge with informative response bodies (Pattern 2), token economics (Pattern 10), and consumption hints (Pattern 4)
2. **`example-server.js`** demonstrates single-resource L402 with a free discovery endpoint
3. **`example-catalog-server.js`** demonstrates multi-resource catalog with free browsing, search, resolved URLs, and different consumption types
4. **`mcp/lnd-wallet-mcp.js`** provides the agent wallet with budget enforcement

To test the full flow yourself, run the catalog example server and point an AI agent at it. The agent should be able to discover resources, pick one, pay for it, and consume it — with zero pre-configuration beyond the wallet.
