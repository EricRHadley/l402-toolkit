# Architecture

How L402 works, why this implementation exists, and how to set it up yourself.

## The L402 Protocol

L402 uses HTTP 402 Payment Required — a status code that has existed since HTTP/1.1 (1997) but was never widely adopted because there was no internet-native payment system to back it. Lightning Network changes that.

The protocol combines two primitives:
- **Lightning invoices** for payment
- **Macaroons** for authentication

The result: a single credential that proves you paid AND grants access. No accounts, no sessions, no cookies. The payment *is* the credential.

### Flow

```
Client                          Server                          LND
  │                               │                               │
  │  GET /api/resource            │                               │
  │──────────────────────────────>│                               │
  │                               │  Create invoice (10 sats)     │
  │                               │──────────────────────────────>│
  │                               │  payment_hash, bolt11         │
  │                               │<──────────────────────────────│
  │                               │                               │
  │                               │  Mint macaroon                │
  │                               │  (identifier = payment_hash)  │
  │                               │                               │
  │  402 Payment Required         │                               │
  │  WWW-Authenticate: L402       │                               │
  │    macaroon="...",            │                               │
  │    invoice="lnbc..."          │                               │
  │<──────────────────────────────│                               │
  │                               │                               │
  │  Pay invoice ────────────────────────────────────────────────>│
  │  preimage <──────────────────────────────────────────────────│
  │                               │                               │
  │  GET /api/resource            │                               │
  │  Authorization: L402          │                               │
  │    <macaroon>:<preimage>      │                               │
  │──────────────────────────────>│                               │
  │                               │  Verify:                      │
  │                               │  1. SHA256(preimage) == id?   │
  │                               │  2. Caveats valid?            │
  │                               │  3. HMAC chain valid?         │
  │                               │                               │
  │  200 OK + resource            │                               │
  │<──────────────────────────────│                               │
```

### Why This Works

**Payment hash as identifier**: The macaroon's identifier is the Lightning payment hash. The preimage (proof of payment) is the only value whose SHA256 equals that hash. This cryptographically binds the credential to the payment — you can't forge a token without paying.

**Stateless verification**: The server doesn't store tokens in a database. It verifies the HMAC signature chain (proves the server issued this macaroon), checks the preimage (proves payment was made), and validates caveats (proves the token is valid for this resource and hasn't expired). All math, no state.

**Per-resource caveats**: Unlike Aperture (which gates at the URL-path level), this implementation embeds the resource ID as a first-party caveat. A token for resource "abc" cannot access resource "def". Each resource gets its own payment and its own token.

## Why Not Aperture?

[Aperture](https://github.com/lightninglabs/aperture) is Lightning Labs' L402 reverse proxy. It's good for what it does — gating entire API paths without modifying application code. But it has limitations:

| | Aperture | l402.js |
|--|----------|---------|
| Language | Go binary | Node.js module |
| Integration | Separate proxy process | `require('./l402')` |
| Gating level | URL path regex | Per-resource caveats |
| Custom logic | Configuration only | Full application control |
| Infrastructure | Deploy + configure proxy | Drop into existing server |

**Use Aperture** when you want to gate an existing API without touching the application code.

**Use l402.js** when you need per-resource access control, custom caveat logic, or want the L402 logic in your application where you can see it.

They're complementary — you could run Aperture for coarse API gating and l402.js for fine-grained resource control within the application.

## The Server Side: l402.js

`l402.js` is the L402 protocol module. One dependency (`macaroons.js`), no framework opinion.

### What It Does

1. **`initLnd()`** — Connects to your LND node's REST API. Reads the macaroon file and TLS cert. Returns `false` if not configured, so your server can run with or without L402.

2. **`handleL402Auth(req, res, resourceId)`** — The main entry point. Call this in your route handler:
   - If the request has a valid L402 token → returns `true` (serve the resource)
   - If the request has no token or an invalid token → sends 402 challenge and returns `false`

3. **`createInvoice(amountSats, memo)`** — Creates a Lightning invoice via LND REST. Uses native `https` module — no HTTP client library needed.

4. **`createMacaroon(paymentHash, resourceId)`** — Mints a macaroon with three first-party caveats:
   - `resource_id` — which resource this token grants access to
   - `expires_at` — Unix timestamp expiration
   - `service` — identifies the issuing service

5. **`verifyMacaroon(macaroonB64, preimageHex, requestedResourceId)`** — Full verification:
   - SHA256(preimage) must equal the macaroon identifier (payment proof)
   - `resource_id` caveat must match the requested resource
   - `expires_at` must be in the future
   - HMAC signature chain must be valid (server-issued)

### Integration Pattern

```javascript
const l402 = require('./l402');

// Initialize once at startup (returns false if not configured)
const l402Enabled = l402.initLnd();

// In your route handler:
if (l402Enabled) {
    const authorized = await l402.handleL402Auth(req, res, resourceId);
    if (!authorized) return; // 402 already sent
}
// Serve the resource...
```

That's it. Two lines in your route handler.

### Configuration

All via environment variables:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `L402_SECRET` | Yes | — | 32-byte hex secret for macaroon signing |
| `LND_MACAROON_PATH` | Yes | — | Path to LND macaroon file |
| `LND_TLS_CERT_PATH` | No | — | Path to LND TLS certificate |
| `LND_REST_HOST` | No | `https://localhost:8080` | LND REST API endpoint |
| `L402_LOCATION` | No | `localhost` | Macaroon location (your domain) |
| `L402_PRICE_SATS` | No | `10` | Price per resource access |
| `L402_EXPIRY_SECONDS` | No | `1800` | Token validity (30 minutes) |

## The Agent Side: MCP Wallet

The MCP server (`mcp/lnd-wallet-mcp.js`) gives an AI agent a budget-limited Lightning wallet. It provides 4 tools over the Model Context Protocol:

| Tool | What It Does |
|------|-------------|
| `decode_invoice` | Inspect a BOLT11 invoice (amount, description, expiry) |
| `pay_invoice` | Pay an invoice, returns preimage. Budget-enforced. |
| `get_balance` | Check Lightning channel balance |
| `get_budget` | Check remaining spending budget |

### Security Model

The MCP server connects to LND with a **baked macaroon** restricted to three RPC methods:

```bash
lncli bakemacaroon \
    uri:/lnrpc.Lightning/SendPaymentSync \
    uri:/lnrpc.Lightning/DecodePayReq \
    uri:/lnrpc.Lightning/ChannelBalance
```

The agent **can**: pay invoices, decode invoices, check balance.
The agent **cannot**: open channels, send on-chain funds, create invoices, access the seed, manage peers.

### Budget Enforcement

LND has no per-session spending limits. Budget enforcement is application-level in the MCP server:

1. Before every payment, the server checks the spending log
2. If `totalSpentSats + invoiceAmount > budgetSats`, the payment is refused
3. After payment, the amount is recorded in `spending-log.json`
4. Delete the log file to reset the budget

### Why Sovereign?

The agent runs its own LND neutrino node. There is no third-party API, no custodial service, no 2% platform fee. The agent's private keys exist on the same machine where it runs. Every sat that leaves the wallet goes directly to the destination over the Lightning Network.

This matters because the properties that make "the payment was the credential" interesting — no custodian, no counterparty risk, no permission required — only hold when the wallet is sovereign. A custodial wallet introduces the exact trust dependencies that L402 was designed to eliminate.

## Setting Up an Agent Wallet

### 1. Install LND

Download LND v0.18+ from [GitHub releases](https://github.com/lightningnetwork/lnd/releases). No Bitcoin Core required — neutrino mode syncs in minutes with ~100MB of storage.

### 2. Configure for Neutrino

Copy `setup/neutrino-lnd.conf` to your LND data directory:

```bash
# macOS
cp setup/neutrino-lnd.conf ~/Library/Application\ Support/Lnd/lnd.conf

# Linux
cp setup/neutrino-lnd.conf ~/.lnd/lnd.conf
```

### 3. Start LND and Create Wallet

```bash
lnd

# In another terminal:
lncli create
# Follow prompts to create a new wallet (save the seed!)
```

### 4. Fund the Wallet and Open a Channel

Send a small amount of Bitcoin on-chain to your LND wallet, then open a channel to a well-connected node:

```bash
# Get a deposit address
lncli newaddress p2wkh

# After funds confirm, open a channel (example: 50,000 sats)
lncli openchannel --node_key <peer_pubkey> --local_amt 50000
```

### 5. Bake a Restricted Macaroon

```bash
./setup/bake-agent-macaroon.sh
# Creates mcp/credentials/agent.macaroon

# Copy TLS cert
cp ~/Library/Application\ Support/Lnd/tls.cert mcp/credentials/
```

### 6. Register the MCP Server

Add to `~/.claude.json` (or your AI tool's MCP configuration):

```json
{
  "mcpServers": {
    "lnd-wallet": {
      "command": "node",
      "args": ["/path/to/l402-toolkit/mcp/lnd-wallet-mcp.js"],
      "env": {
        "LND_REST_HOST": "https://localhost:8080",
        "BUDGET_SATS": "1000"
      }
    }
  }
}
```

### 7. Verify

Restart your AI tool and check that the wallet tools are available:

```
> get_balance
Local balance: 45000 sats (spendable)
Remote balance: 5000 sats (receivable)
```

## Lightning Backend

The L402 server needs an LND node (or any Lightning implementation with a REST/gRPC API) that can create invoices. When a client hits a protected endpoint, `l402.js` calls your node to generate a real Lightning invoice. When the client pays, your node receives the sats.

**What you need:**
- A Lightning node that can create invoices (LND, CLN, Eclair, etc.)
- A macaroon or credential with invoice-creation permissions
- TLS certificate for secure API access
- At least one channel with inbound liquidity (so you can receive payments)

**What you don't need:**
- A static IP (SSH tunnels or Tailscale work fine)
- A lot of capital (a 50,000 sat channel is enough to start)

**Important: service nodes need a full Bitcoin backend.** Neutrino (compact block filters) is fine for an agent wallet that only *pays* invoices. But a service node that *creates* invoices and *receives* payments should run with Bitcoin Core or btcd as its backend. This gives you reliable chain state, proper fee estimation, and the ability to open/manage channels. A pruned Bitcoin Core node (~10GB) is sufficient — you don't need the full ~600GB unpruned chain.

Setting up a sovereign Lightning node is outside the scope of this toolkit — it's a separate infrastructure concern. If you need a guide, [sovereign-app-architecture](https://github.com/EricRHadley/sovereign-app-architecture) covers the full stack: LND setup, BTCPay Server, VPS hosting, channel management, UPS protection, and graceful shutdown scripts.

The key point: `l402.js` talks to LND via REST API. If your node has a REST endpoint and can create invoices, the toolkit works.

## Streaming Resources

The `handleL402Auth()` function works the same way for a single API response and for each segment of a streaming resource. For video, audio, or any chunked content delivery, the pattern is the same: validate the L402 token on every request.

### Why Per-Segment Validation

When a client streams an HLS video, it makes dozens of HTTP requests — one for the playlist (`.m3u8`) and one for each media segment (`.ts`). Each request independently validates the L402 token:

```javascript
// Every segment request goes through the same auth check
async function handleStreamRequest(req, res, pathname) {
    // Extract resource ID from URL path
    const resourceId = pathname.split('/')[3]; // e.g., /api/stream/{id}/segment_001.ts

    const authorized = await l402.handleL402Auth(req, res, resourceId);
    if (!authorized) return; // 402 challenge sent

    // Serve the segment file
    serveFile(res, pathname);
}
```

This gives you continuous enforcement:
- **Expiration**: A token that expires mid-stream stops working on the next segment request — no need to revoke anything
- **Scope**: A token for resource "abc" can't be used to stream resource "def", even within the same session
- **Sharing**: A token passed to another client still works (stateless), but only for the specific resource and only until it expires

### Client-Side Integration

For HLS playback, the client injects the L402 token into every segment request via the `Authorization` header. With hls.js:

```javascript
const config = {
    xhrSetup: function(xhr, url) {
        xhr.setRequestHeader('Authorization', `L402 ${macaroon}:${preimage}`);
    }
};
const hls = new Hls(config);
```

The client pays once, receives a token, and reuses that token for every segment until it expires. No per-segment payment — just per-segment validation of the same credential.

### No Additional Code Required

The toolkit's `l402.js` already supports this pattern. `handleL402Auth()` doesn't care whether it's gating a JSON API response or a video segment — it validates the token against the resource ID and expiration, then returns `true` or `false`. The streaming use case is just calling the same function in a different route handler.

## Design Decisions

**No Aperture**: Custom L402 in application code because we need per-resource caveats. Aperture only does URL-path-level gating.

**Neutrino, not Bitcoin Core**: ~100MB vs ~600GB. Same LND REST API. Zero code changes.

**Private channel**: The agent wallet doesn't need to route for others. A private channel keeps it off the public network graph.

**Baked macaroon with 3 URIs**: Minimal permissions. The agent cannot do anything it doesn't need to do.

**Budget in MCP, not LND**: LND doesn't have per-session spending limits. Budget enforcement is application-level.

**REST API, not gRPC**: Works from Node.js without proto compilation. Same functionality for wallet operations. Zero additional dependencies.

**macaroons.js, not libmacaroons**: Pure JavaScript, runs anywhere, no native bindings.

**No framework dependency**: `l402.js` uses raw Node.js `http`/`https`. Works with Express, Fastify, Hono, Next.js, or `http.createServer()`. The choice of web framework is yours.
