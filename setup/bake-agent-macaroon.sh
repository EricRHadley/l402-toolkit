#!/bin/bash
#
# Bake a restricted LND macaroon for the agent wallet.
#
# This creates a macaroon that can ONLY:
#   - Pay invoices (SendPaymentSync)
#   - Decode invoices (DecodePayReq)
#   - Check channel balance (ChannelBalance)
#
# The agent CANNOT:
#   - Open or close channels
#   - Send on-chain funds
#   - Create invoices
#   - Access the wallet seed
#   - List or manage peers
#
# Usage:
#   ./bake-agent-macaroon.sh [output-path]
#
# Prerequisites:
#   - LND must be running and wallet unlocked
#   - lncli must be in PATH (or set LNCLI below)

set -e

LNCLI="${LNCLI:-lncli}"
OUTPUT="${1:-./mcp/credentials/agent.macaroon}"

# Verify LND is running and wallet is unlocked
if ! $LNCLI getinfo > /dev/null 2>&1; then
    echo "Error: LND is not running or wallet is locked."
    echo "Start LND and unlock the wallet first:"
    echo "  lnd        # start the daemon"
    echo "  lncli unlock  # unlock the wallet"
    exit 1
fi

# Create output directory if needed
mkdir -p "$(dirname "$OUTPUT")"

echo "Baking agent macaroon with restricted permissions..."
echo "  Allowed: SendPaymentSync, DecodePayReq, ChannelBalance"
echo "  Output:  $OUTPUT"
echo ""

$LNCLI bakemacaroon \
    uri:/lnrpc.Lightning/SendPaymentSync \
    uri:/lnrpc.Lightning/DecodePayReq \
    uri:/lnrpc.Lightning/ChannelBalance \
    --save_to "$OUTPUT"

# Restrict file permissions — this is a bearer credential
chmod 600 "$OUTPUT"

echo ""
echo "Macaroon saved to: $OUTPUT (permissions: 600)"
echo ""
echo "Next steps:"
echo "  1. Copy your LND TLS cert to ./mcp/credentials/tls.cert"
echo "     macOS: cp ~/Library/Application\\ Support/Lnd/tls.cert ./mcp/credentials/"
echo "     Linux: cp ~/.lnd/tls.cert ./mcp/credentials/"
echo ""
echo "  2. Register the MCP server in ~/.claude.json (see README.md)"
