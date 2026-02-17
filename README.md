# l402-toolkit

JavaScript L402 implementation for Node.js servers and AI agent wallets.

**L402** combines Lightning payments with macaroon credentials — the payment *is* the authentication token. No accounts, no sessions, no cookies. Pay once, access the resource. This toolkit provides both sides: a server module to gate resources behind Lightning paywalls, and an MCP server to give AI agents a budget-limited wallet for paying them.

## What's Inside

### `l402.js` — Server-Side L402 Module

Drop-in L402 protocol for any Node.js HTTP server. One dependency (`macaroons.js`), no framework opinion.

- Creates Lightning invoices via LND REST API
- Mints macaroons with per-resource caveats (not just URL-path gating)
- Verifies tokens statelessly — no database, just cryptography
- Inspects tokens client-side — `getTokenInfo()` reads expiry and resource without verification
- Works with `http.createServer()`, Express, Fastify, or anything else

```javascript
const l402 = require('./l402');
l402.initLnd();

// In your route handler:
const authorized = await l402.handleL402Auth(req, res, 'resource-id');
if (!authorized) return; // 402 challenge already sent
// Serve the resource...
```

### `mcp/lnd-wallet-mcp.js` — AI Agent Wallet

[MCP](https://modelcontextprotocol.io/) server that gives AI agents (Claude Code, Cursor, etc.) a sovereign Lightning wallet. 6 tools, budget enforcement, connects directly to a local LND node.

| Tool | Description |
|------|-------------|
| `decode_invoice` | Inspect a BOLT11 invoice before paying |
| `pay_invoice` | Pay an invoice (budget-enforced), returns preimage |
| `create_invoice` | Create an invoice to receive payment |
| `check_invoice` | Check if an invoice has been paid |
| `get_balance` | Check Lightning channel balance |
| `get_budget` | Check remaining spending budget |

The agent runs its own LND neutrino node — no custodial service, no API keys, no platform fees. The macaroon is baked with restricted permissions: pay, decode, balance, and invoice. The agent cannot open channels, send on-chain, or access the seed.

### `example-server.js` — Fortune Cookie API

L402-gated fortune cookie server. Pay 10 sats, get a fortune. Demonstrates agent-friendly discovery patterns: free `/api` endpoint with service description, consumption hints, and step-by-step `l402_flow` instructions embedded in the response.

### `example-catalog-server.js` — Multi-Resource Catalog

L402-gated catalog with multiple resource types. Demonstrates the full agent discovery pattern: free browsing, search, consumption hints in 402 responses, resolved URLs on every result, and different consumption types (API response, browser, download, display).

```bash
export L402_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
export LND_MACAROON_PATH=/path/to/invoice.macaroon
node example-server.js
# → http://localhost:3000/api/fortune
```

## Quick Start

### Server (gate a resource)

```bash
git clone https://github.com/EricRHadley/l402-toolkit.git
cd l402-toolkit
npm install

# Configure (see docs/ARCHITECTURE.md for full setup)
export L402_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
export LND_MACAROON_PATH=/path/to/your/invoice.macaroon
export LND_TLS_CERT_PATH=/path/to/your/tls.cert
export LND_REST_HOST=https://your-lnd-node:8080

node example-server.js
# → http://localhost:3000/api (service info)
# → http://localhost:3000/api/fortune (L402-gated, 10 sats)
```

### Agent (pay for resources)

```bash
cd l402-toolkit/mcp
npm install

# Bake a restricted macaroon (LND must be running)
../setup/bake-agent-macaroon.sh

# Copy TLS cert
cp ~/.lnd/tls.cert credentials/

# Register in Claude Code (~/.claude.json)
```

```json
{
  "mcpServers": {
    "lnd-wallet": {
      "command": "node",
      "args": ["/absolute/path/to/l402-toolkit/mcp/lnd-wallet-mcp.js"],
      "env": {
        "LND_REST_HOST": "https://localhost:8080",
        "BUDGET_SATS": "1000"
      }
    }
  }
}
```

Restart Claude Code. The agent now has wallet tools and can pay L402 invoices.

## How L402 Works

```
1. Client requests a resource
2. Server returns 402 with WWW-Authenticate: L402 macaroon="...", invoice="lnbc..."
3. Client pays the Lightning invoice → receives preimage
4. Client re-requests with: Authorization: L402 <macaroon>:<preimage>
5. Server verifies: SHA256(preimage) == payment_hash, caveats valid, HMAC valid
6. Resource served
```

The macaroon's identifier is the Lightning payment hash. The preimage is the only value whose SHA256 matches that hash. This cryptographically binds the credential to the payment — you can't forge a token without paying the invoice.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full protocol walkthrough, design decisions, and agent wallet setup guide.

## Agent-to-Agent Payments

The wallet is bidirectional. An agent can pay for services AND get paid for work.

```
Agent A (buyer)                          Agent B (seller)
─────────────                            ─────────────
                    "Do this task"
                  ─────────────────►
                                         create_invoice(500, "research task")
                    "lnbc5u1pn..."
                  ◄─────────────────
decode_invoice(...)
pay_invoice("lnbc5u1pn...")
                    preimage
                  ─────────────────►
                                         check_invoice(payment_hash)
                                         → SETTLED
                    [delivers work]
                  ◄─────────────────
```

No marketplace platform. No escrow service. No accounts. The BOLT11 invoice is just a string — pass it over HTTP, email, Nostr, a chat message, anything. The Lightning Network settles the payment regardless of how the invoice traveled.

Each paid invoice is a cryptographic receipt: the preimage proves payment happened, the payment hash links it to a specific request, the amount and timestamp are baked in. Agents accumulate transaction history as a natural byproduct of doing business — no separate reputation system required.

### Use Cases

- **Bounties** — Agent posts a task with a sat budget. Another agent does the work, invoices for it, gets paid on delivery.
- **Resource sharing** — An agent with a Claude Max subscription sells research capacity to agents without one. 500 sats for a deep analysis, 50 sats for a quick lookup.
- **Data feeds** — An agent monitoring on-chain data creates invoices for real-time alerts. Other agents subscribe by paying per-alert.
- **Compute markets** — Agent with GPU access invoices for inference jobs. Pay per token, settle on Lightning.

The protocol is the same whether a human pays 10 sats for a video or an agent pays 500 sats for a research task. `create_invoice` + `pay_invoice` + `check_invoice` — three tools, any use case.

## Making Your Service Agent-Friendly

Want AI agents to discover and pay for your L402 service without needing pre-written instructions? See [docs/AGENT-DISCOVERY.md](docs/AGENT-DISCOVERY.md) for 12 patterns that make your 402 responses self-describing — informative response bodies, consumption hints, free discovery endpoints, service directory registration, and token lifecycle management.

## Repository Structure

```
l402-toolkit/
├── l402.js                  # L402 protocol module (server-side)
├── example-server.js        # Fortune cookie API (single-resource demo)
├── example-catalog-server.js # Media catalog (multi-resource demo)
├── package.json             # macaroons.js dependency
├── mcp/
│   ├── lnd-wallet-mcp.js   # MCP agent wallet server
│   ├── package.json         # @modelcontextprotocol/sdk, zod
│   └── CLAUDE.md            # Agent instructions for L402 flow
├── setup/
│   ├── neutrino-lnd.conf   # LND neutrino config (copy to ~/.lnd/)
│   └── bake-agent-macaroon.sh  # Creates restricted macaroon
├── docs/
│   ├── ARCHITECTURE.md      # Protocol docs, design decisions, setup guide
│   └── AGENT-DISCOVERY.md   # 11 patterns for agent-friendly L402 services
└── LICENSE                  # MIT
```

## Why This Exists

The L402 spec has existed since 2019 (originally as LSAT), but the implementation landscape is sparse:

- **[Aperture](https://github.com/lightninglabs/aperture)** is a Go reverse proxy — great for gating APIs at the infrastructure level, but it operates at the URL-path level and requires deploying a separate process
- **[boltwall](https://github.com/tierion/boltwall)** is Express middleware — locked to Express, uses deprecated dependencies, hasn't been updated in 3 years, still uses the old "LSAT" header format
- **[LangChainBitcoin](https://github.com/lightninglabs/LangChainBitcoin)** showed that AI agents can pay for APIs — but it's locked to LangChain/Python, has no budget enforcement, and pays invoices without verifying amounts

This toolkit is:
- **Framework-free** — vanilla Node.js, works with any HTTP server
- **Resource-level gating** — per-resource caveats, not just URL paths
- **Agent-ready** — MCP wallet works with any MCP-compatible AI tool
- **Sovereign** — agent runs its own LND node, no custodial service
- **Minimal** — l402.js has 1 dependency, MCP server has 2
- **Maintained** — current L402 spec terminology, actively developed

## Live in Production

This toolkit powers real, mainnet L402 services:

- **[l402.directory](https://l402.directory)** — Open service registry for L402-enabled APIs. Discovers services, verifies they accept real Lightning payments, and tracks uptime. Free discovery API at `GET /api`.
- **[hyperdope.com](https://hyperdope.com)** — Lightning-gated video content. Pay 10 sats per video via L402, streamed over HLS with token-authenticated segments.

Both services run `l402.js` from this toolkit for invoice creation, macaroon minting, and token verification. The directory's health checker uses the MCP agent wallet to pay real invoices and verify services end-to-end.

## License

MIT
