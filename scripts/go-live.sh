#!/bin/sh
# Flip DataBoard out of demo mode, once SES has production access.
#
# Refuses to run while the SES account is sandboxed, because live mode with a
# sandboxed sender bounces every signup from an unverified address. Then:
# sets BLIND_TENDER_DEMO=false in the production env, redeploys, and proves
# the live path: request-code on prod must come back demo-less and delivered
# (the SES mailbox simulator address exercises real DKIM-signed sending
# without needing an inbox).
set -e
cd "$(dirname "$0")/.."

REGION="${SES_REGION:-us-west-2}"
OK=$(aws sesv2 get-account --region "$REGION" --query ProductionAccessEnabled --output text)
if [ "$OK" != "True" ] && [ "$OK" != "true" ]; then
  echo "SES is still sandboxed (ProductionAccessEnabled=$OK). Not flipping." >&2
  exit 1
fi

echo "SES has production access. Flipping BLIND_TENDER_DEMO=false ..."
vercel env rm BLIND_TENDER_DEMO production --yes >/dev/null 2>&1 || true
printf 'false' | vercel env add BLIND_TENDER_DEMO production >/dev/null
vercel deploy --prod --yes >/dev/null

echo "Verifying the live path against production ..."
BODY=$(curl -s -X POST https://getdataboard.vercel.app/api/auth/request-code \
  -H 'content-type: application/json' \
  -d '{"contact":"success@simulator.amazonses.com","realName":"Go Live Probe","affiliation":"independent individual"}')
echo "$BODY" | grep -q '"demo":false' || { echo "FAIL: response still in demo mode: $BODY" >&2; exit 1; }
echo "$BODY" | grep -q 'demoCode' && { echo "FAIL: a demo code leaked into the live response: $BODY" >&2; exit 1; }
echo "$BODY" | grep -q '"delivered":true' || { echo "FAIL: delivery not confirmed: $BODY" >&2; exit 1; }
echo "LIVE. Codes are delivered by email; nothing shows on screen."
echo "Next signup with a real address is the final human check."
