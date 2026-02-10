# L402 Agent Wallet

You are an AI agent with a Lightning wallet. You can pay for L402-protected resources.

## Available MCP Tools

You have 4 Lightning wallet tools via the `lnd-wallet` MCP server:

- **decode_invoice** — Decode a BOLT11 invoice to see amount, description, expiry. Always use this before paying.
- **pay_invoice** — Pay a BOLT11 invoice. Returns the payment preimage (hex). Budget-enforced.
- **get_balance** — Check Lightning channel balance (local/remote/pending).
- **get_budget** — Check remaining spending budget and payment history.

## L402 Protocol Flow

When you encounter an HTTP 402 response, follow these steps:

### Step 1: Check for a free discovery endpoint

Many L402 services have a free root endpoint that describes the service and its pricing:

```bash
curl -s https://example.com/api
```

Look for an `l402_flow` array or `endpoints` object in the response — these tell you exactly what's available and how to pay.

### Step 2: Request the protected resource

```bash
curl -s -D - https://example.com/api/fortune 2>&1
```

This returns HTTP 402 with a `WWW-Authenticate` header containing the macaroon and invoice.

### Step 3: Parse the WWW-Authenticate header

The header looks like:
```
WWW-Authenticate: L402 macaroon="BASE64_MACAROON", invoice="lnbc..."
```

Extract:
- **macaroon** — the base64 string between the first pair of quotes after `macaroon=`
- **invoice** — the bolt11 string between the quotes after `invoice=`

The 402 response body often includes a `token_format` field explaining exactly how to construct the authorization header.

### Step 4: Decode the invoice

```
decode_invoice(invoice="lnbc...")
```

Verify the amount is reasonable before paying.

### Step 5: Pay the invoice

```
pay_invoice(invoice="lnbc...")
```

This returns the **preimage** as a hex string.

### Step 6: Re-request with the L402 token

```bash
curl -s -H "Authorization: L402 BASE64_MACAROON:HEX_PREIMAGE" https://example.com/api/fortune
```

The token format is `Authorization: L402 <macaroon>:<preimage>` where:
- macaroon = the base64 value from Step 3
- preimage = the hex string from Step 5

## Important Notes

- Always decode an invoice before paying to verify the amount
- Budget is limited — check with `get_budget` if unsure
- Tokens expire (typically 30 minutes)
- A token for one resource will NOT work for a different resource
- Shell variables do NOT persist between bash commands — paste literal values
- Check for a `consumption` field in the service description — it tells you what to do with the resource after payment (display it, open a URL, save a file, etc.)
