#!/usr/bin/env node

/**
 * LND Wallet MCP Server
 *
 * Gives an AI agent (Claude Code, Cursor, etc.) a budget-limited Lightning wallet
 * for paying L402 invoices. Connects directly to an LND node via REST API using
 * a baked macaroon with restricted permissions.
 *
 * Tools provided:
 *   - decode_invoice  — Inspect a BOLT11 invoice before paying
 *   - pay_invoice     — Pay an invoice (budget-enforced)
 *   - create_invoice  — Create a BOLT11 invoice to receive payment
 *   - check_invoice   — Check if an invoice has been paid
 *   - get_balance     — Check channel balance
 *   - get_budget      — Check remaining spending budget
 *
 * Security model:
 *   The LND macaroon should be baked with minimal permissions:
 *     lncli bakemacaroon offchain:write offchain:read info:read \
 *                        invoices:write invoices:read
 *   This prevents the agent from opening channels, sending on-chain funds,
 *   or accessing the wallet seed.
 *
 * Budget enforcement:
 *   The MCP server tracks spending in a local JSON file and refuses to pay
 *   invoices that would exceed the configured budget. LND itself has no
 *   per-session spending limits — this is application-level protection.
 *
 * Why REST instead of gRPC?
 *   Works from Node.js without proto compilation or native bindings.
 *   Same functionality for wallet operations. Zero additional dependencies.
 *
 * CRITICAL: All logging uses stderr (console.error). Stdout is reserved
 * for MCP protocol messages only.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ===========================================
// Configuration
// ===========================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONFIG = {
    // LND REST API endpoint. Default: local neutrino node.
    lndHost: process.env.LND_REST_HOST || "https://localhost:8080",

    // Path to baked LND macaroon (binary file, read as hex)
    macaroonPath: process.env.LND_MACAROON_PATH
        || path.join(__dirname, "credentials", "agent.macaroon"),

    // Path to LND's TLS certificate
    tlsCertPath: process.env.LND_TLS_CERT_PATH
        || path.join(__dirname, "credentials", "tls.cert"),

    // Maximum sats the agent can spend per session.
    // Delete spending-log.json to reset.
    budgetSats: parseInt(process.env.BUDGET_SATS || "1000"),

    // Persistent spending log
    spendingLogPath: process.env.SPENDING_LOG_PATH
        || path.join(__dirname, "spending-log.json"),
};

// ===========================================
// LND Connection Setup
// ===========================================

// Read macaroon as hex (LND REST API requires this in Grpc-Metadata-macaroon header)
let macaroonHex;
try {
    macaroonHex = fs.readFileSync(CONFIG.macaroonPath).toString("hex");
} catch (err) {
    console.error(`[lnd-wallet] ERROR: Cannot read macaroon at ${CONFIG.macaroonPath}`);
    console.error("[lnd-wallet] Run setup/bake-agent-macaroon.sh to create one, or set LND_MACAROON_PATH");
    process.exit(1);
}

// Trust LND's self-signed cert. The checkServerIdentity override handles
// connections through SSH tunnels where the hostname doesn't match the
// cert's SANs (e.g., cert for 127.0.0.1 but connecting via tunnel IP).
// Safe because we pin the exact CA cert.
let httpsAgent;
try {
    const tlsCert = fs.readFileSync(CONFIG.tlsCertPath);
    httpsAgent = new https.Agent({
        ca: tlsCert,
        checkServerIdentity: () => undefined,
    });
} catch (err) {
    console.error(`[lnd-wallet] ERROR: Cannot read TLS cert at ${CONFIG.tlsCertPath}`);
    console.error("[lnd-wallet] Copy your LND tls.cert to mcp/credentials/, or set LND_TLS_CERT_PATH");
    process.exit(1);
}

console.error("[lnd-wallet] Connected to", CONFIG.lndHost);
console.error("[lnd-wallet] Budget:", CONFIG.budgetSats, "sats");

// ===========================================
// Budget Tracking
// ===========================================

function loadSpendingLog() {
    try {
        return JSON.parse(fs.readFileSync(CONFIG.spendingLogPath, "utf8"));
    } catch {
        return { totalSpentSats: 0, payments: [] };
    }
}

function saveSpendingLog(log) {
    fs.writeFileSync(CONFIG.spendingLogPath, JSON.stringify(log, null, 2));
}

// ===========================================
// LND REST Client
// ===========================================

function lndRequest(method, apiPath, body = null) {
    return new Promise((resolve, reject) => {
        const url = new URL(CONFIG.lndHost + apiPath);
        const options = {
            hostname: url.hostname,
            port: url.port || 443,
            path: url.pathname + url.search,
            method,
            headers: {
                "Grpc-Metadata-macaroon": macaroonHex,
                "Content-Type": "application/json",
            },
            agent: httpsAgent,
        };

        const req = https.request(options, (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => {
                try {
                    const parsed = JSON.parse(data);
                    if (res.statusCode !== 200) {
                        reject(new Error(`LND ${res.statusCode}: ${data}`));
                    } else {
                        resolve(parsed);
                    }
                } catch (err) {
                    reject(new Error(`LND response parse error: ${err.message}`));
                }
            });
        });

        req.on("error", (err) => reject(new Error(`LND connection error: ${err.message}`)));
        if (body) {
            const postData = JSON.stringify(body);
            req.setHeader("Content-Length", Buffer.byteLength(postData));
            req.write(postData);
        }
        req.end();
    });
}

// ===========================================
// MCP Server
// ===========================================

const server = new McpServer({
    name: "lnd-wallet",
    version: "1.0.0",
});

// --- Tool: decode_invoice ---
server.registerTool(
    "decode_invoice",
    {
        description: "Decode a BOLT11 Lightning invoice to see amount, description, and expiry before paying.",
        inputSchema: {
            invoice: z.string().describe("BOLT11 invoice string (starts with lnbc...)"),
        },
    },
    async ({ invoice }) => {
        try {
            const result = await lndRequest("GET", `/v1/payreq/${encodeURIComponent(invoice)}`);
            const amountSats = parseInt(result.num_satoshis || "0");
            const text = [
                `Amount: ${amountSats} sats`,
                `Description: ${result.description || "(none)"}`,
                `Destination: ${result.destination}`,
                `Payment Hash: ${result.payment_hash}`,
                `Expiry: ${result.expiry} seconds`,
                `Timestamp: ${new Date(parseInt(result.timestamp) * 1000).toISOString()}`,
            ].join("\n");
            return { content: [{ type: "text", text }] };
        } catch (err) {
            return { content: [{ type: "text", text: `Error decoding invoice: ${err.message}` }] };
        }
    }
);

// --- Tool: pay_invoice ---
server.registerTool(
    "pay_invoice",
    {
        description: "Pay a BOLT11 Lightning invoice. Returns the payment preimage (hex). Checks budget before paying. Routing fees are tracked and counted against the budget. Use decode_invoice first to verify the amount.",
        inputSchema: {
            invoice: z.string().describe("BOLT11 invoice string to pay"),
        },
    },
    async ({ invoice }) => {
        try {
            // 1. Decode first to know amount
            const decoded = await lndRequest("GET", `/v1/payreq/${encodeURIComponent(invoice)}`);
            const amountSats = parseInt(decoded.num_satoshis || "0");

            if (amountSats <= 0) {
                return { content: [{ type: "text", text: "Error: Invoice has no amount or zero amount." }] };
            }

            // 2. Check budget
            const log = loadSpendingLog();
            const remaining = CONFIG.budgetSats - log.totalSpentSats;
            if (amountSats > remaining) {
                return { content: [{ type: "text", text:
                    `BUDGET EXCEEDED. Invoice: ${amountSats} sats. Remaining budget: ${remaining} sats (limit: ${CONFIG.budgetSats}).` }] };
            }

            // 3. Pay via LND REST
            console.error(`[lnd-wallet] Paying ${amountSats} sats...`);
            const result = await lndRequest("POST", "/v1/channels/transactions", {
                payment_request: invoice,
            });

            if (result.payment_error) {
                return { content: [{ type: "text", text: `Payment failed: ${result.payment_error}` }] };
            }

            // 4. Extract preimage (LND returns base64, L402 needs hex)
            const preimageHex = Buffer.from(result.payment_preimage, "base64").toString("hex");

            // 5. Extract routing fees from payment route (msat precision)
            const feeMsat = parseInt(result.payment_route?.total_fees_msat || "0");
            const feeSats = Math.ceil(feeMsat / 1000);
            const totalCostSats = amountSats + feeSats;

            // 6. Record in spending log (total cost = invoice + routing fees)
            log.totalSpentSats += totalCostSats;
            log.payments.push({
                invoice: invoice.substring(0, 40) + "...",
                amountSats,
                feeMsat,
                feeSats,
                totalCostSats,
                preimage: preimageHex,
                description: decoded.description || "",
                timestamp: new Date().toISOString(),
            });
            saveSpendingLog(log);

            console.error(`[lnd-wallet] Paid ${amountSats} sats + ${feeMsat} msat fee = ${totalCostSats} total sats. Budget: ${log.totalSpentSats}/${CONFIG.budgetSats}`);

            const text = [
                `Payment successful!`,
                `Preimage: ${preimageHex}`,
                `Amount: ${amountSats} sats`,
                feeMsat > 0 ? `Routing fee: ${feeMsat} msat (${feeSats} sat${feeSats !== 1 ? 's' : ''})` : null,
                feeMsat > 0 ? `Total cost: ${totalCostSats} sats` : null,
                `Remaining budget: ${CONFIG.budgetSats - log.totalSpentSats} sats`,
            ].filter(Boolean).join("\n");
            return { content: [{ type: "text", text }] };
        } catch (err) {
            return { content: [{ type: "text", text: `Payment error: ${err.message}` }] };
        }
    }
);

// --- Tool: create_invoice ---
server.registerTool(
    "create_invoice",
    {
        description: "Create a BOLT11 Lightning invoice to receive payment. Returns the payment request (invoice string) and the payment hash for tracking. The invoice is payable by anyone on the Lightning Network.",
        inputSchema: {
            amount_sats: z.number().int().positive().describe("Amount in satoshis to request"),
            memo: z.string().optional().describe("Description attached to the invoice (visible to payer)"),
            expiry_seconds: z.number().int().optional().describe("Invoice expiry in seconds (default: 3600 = 1 hour)"),
        },
    },
    async ({ amount_sats, memo, expiry_seconds }) => {
        try {
            const body = {
                value: String(amount_sats),
            };
            if (memo) body.memo = memo;
            if (expiry_seconds) body.expiry = String(expiry_seconds);

            const result = await lndRequest("POST", "/v1/invoices", body);

            const paymentRequest = result.payment_request;
            const rHashHex = Buffer.from(result.r_hash, "base64").toString("hex");

            console.error(`[lnd-wallet] Created invoice: ${amount_sats} sats, r_hash=${rHashHex.substring(0, 16)}...`);

            const text = [
                `Invoice created!`,
                `Amount: ${amount_sats} sats`,
                memo ? `Memo: ${memo}` : null,
                `Payment request: ${paymentRequest}`,
                `Payment hash: ${rHashHex}`,
                `Expiry: ${expiry_seconds || 3600} seconds`,
                ``,
                `Share the payment request (lnbc...) with the payer.`,
                `Use check_invoice with the payment hash to verify settlement.`,
            ].filter(Boolean).join("\n");
            return { content: [{ type: "text", text }] };
        } catch (err) {
            return { content: [{ type: "text", text: `Error creating invoice: ${err.message}` }] };
        }
    }
);

// --- Tool: check_invoice ---
server.registerTool(
    "check_invoice",
    {
        description: "Check whether a Lightning invoice has been paid. Returns settlement status, amount, and settle timestamp. Use the payment hash from create_invoice.",
        inputSchema: {
            payment_hash: z.string().describe("Payment hash (hex) from create_invoice"),
        },
    },
    async ({ payment_hash }) => {
        try {
            // LND v2 lookup expects standard base64 payment_hash as query param (with padding)
            const rHashBase64 = Buffer.from(payment_hash, "hex").toString("base64");
            const result = await lndRequest("GET", `/v2/invoices/lookup?payment_hash=${encodeURIComponent(rHashBase64)}`);

            const settled = result.state === "SETTLED" || result.settled === true;
            const amountSats = parseInt(result.value || "0");
            const amountPaidSats = parseInt(result.amt_paid_sat || "0");

            const text = [
                `Status: ${settled ? "SETTLED (paid)" : result.state || "OPEN (unpaid)"}`,
                `Amount requested: ${amountSats} sats`,
                settled ? `Amount received: ${amountPaidSats} sats` : null,
                result.memo ? `Memo: ${result.memo}` : null,
                settled && result.settle_date !== "0" ? `Settled at: ${new Date(parseInt(result.settle_date) * 1000).toISOString()}` : null,
                `Created: ${new Date(parseInt(result.creation_date) * 1000).toISOString()}`,
                !settled ? `Payment hash: ${payment_hash}` : null,
                !settled ? `\nInvoice is still waiting for payment.` : null,
            ].filter(Boolean).join("\n");
            return { content: [{ type: "text", text }] };
        } catch (err) {
            return { content: [{ type: "text", text: `Error checking invoice: ${err.message}` }] };
        }
    }
);

// --- Tool: get_balance ---
server.registerTool(
    "get_balance",
    {
        description: "Check Lightning channel balance (local/remote/pending).",
        inputSchema: {},
    },
    async () => {
        try {
            const result = await lndRequest("GET", "/v1/balance/channels");
            const text = [
                `Local balance: ${result.local_balance?.sat || 0} sats (spendable)`,
                `Remote balance: ${result.remote_balance?.sat || 0} sats (receivable)`,
                `Pending open: ${result.pending_open_local_balance?.sat || 0} sats`,
                `Unsettled: ${result.unsettled_local_balance?.sat || 0} sats`,
            ].join("\n");
            return { content: [{ type: "text", text }] };
        } catch (err) {
            return { content: [{ type: "text", text: `Error checking balance: ${err.message}` }] };
        }
    }
);

// --- Tool: get_budget ---
server.registerTool(
    "get_budget",
    {
        description: "Check remaining spending budget and payment history.",
        inputSchema: {},
    },
    async () => {
        const log = loadSpendingLog();
        const remaining = CONFIG.budgetSats - log.totalSpentSats;
        const lines = [
            `Budget limit: ${CONFIG.budgetSats} sats`,
            `Total spent: ${log.totalSpentSats} sats`,
            `Remaining: ${remaining} sats`,
            `Payments: ${log.payments.length}`,
        ];
        if (log.payments.length > 0) {
            lines.push("", "Recent payments:");
            for (const p of log.payments.slice(-5)) {
                const fee = p.feeMsat ? ` + ${p.feeMsat} msat fee` : (p.feeSats ? ` + ${p.feeSats} sat fee` : "");
                lines.push(`  ${p.timestamp} - ${p.amountSats} sats${fee} - ${p.description}`);
            }
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
    }
);

// ===========================================
// Start
// ===========================================

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[lnd-wallet] MCP server running on stdio");
