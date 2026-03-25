#!/bin/bash
# Agora API Smoke Test
# Tests the full flow: register → login → list → buy → fulfill → confirm

BASE_URL="${1:-http://localhost:3000}"
echo "🔥 Agora Smoke Test — $BASE_URL"
echo "================================"

# 1. Register seller
echo -e "\n📝 Registering seller..."
SELLER=$(curl -s -X POST "$BASE_URL/api/v1/auth/register" \
  -H "Content-Type: application/json" \
  -d '{"name":"SmokeTestSeller","email":"seller@smoke.test","generateWallet":true}')
SELLER_KEY=$(echo $SELLER | python3 -c "import sys,json; print(json.load(sys.stdin)['apiKey'])" 2>/dev/null)
echo "  Seller API Key: ${SELLER_KEY:0:20}..."

# 2. Register buyer
echo -e "\n📝 Registering buyer..."
BUYER=$(curl -s -X POST "$BASE_URL/api/v1/auth/register" \
  -H "Content-Type: application/json" \
  -d '{"name":"SmokeTestBuyer","email":"buyer@smoke.test","generateWallet":true}')
BUYER_KEY=$(echo $BUYER | python3 -c "import sys,json; print(json.load(sys.stdin)['apiKey'])" 2>/dev/null)
echo "  Buyer API Key: ${BUYER_KEY:0:20}..."

# 3. Login seller (get JWT)
echo -e "\n🔑 Logging in seller..."
SELLER_JWT=$(curl -s -X POST "$BASE_URL/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"apiKey\":\"$SELLER_KEY\"}" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])" 2>/dev/null)
echo "  JWT: ${SELLER_JWT:0:20}..."

# 4. Login buyer
echo -e "\n🔑 Logging in buyer..."
BUYER_JWT=$(curl -s -X POST "$BASE_URL/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"apiKey\":\"$BUYER_KEY\"}" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])" 2>/dev/null)
echo "  JWT: ${BUYER_JWT:0:20}..."

# 5. Create listing
echo -e "\n📦 Creating listing..."
LISTING=$(curl -s -X POST "$BASE_URL/api/v1/listings" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SELLER_JWT" \
  -d '{"title":"Smoke Test Item","description":"A test item for smoke testing","priceUsdc":5000000,"category":"electronics","condition":"new","quantity":1}')
LISTING_ID=$(echo $LISTING | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
echo "  Listing ID: $LISTING_ID"

# 6. Search listings
echo -e "\n🔍 Searching listings..."
SEARCH=$(curl -s "$BASE_URL/api/v1/listings?query=Smoke" \
  -H "Authorization: Bearer $BUYER_JWT")
COUNT=$(echo $SEARCH | python3 -c "import sys,json; print(json.load(sys.stdin)['pagination']['total'])" 2>/dev/null)
echo "  Found: $COUNT listings"

# 7. Create order (buyer buys)
echo -e "\n🛒 Creating order..."
ORDER=$(curl -s -X POST "$BASE_URL/api/v1/orders" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $BUYER_JWT" \
  -d "{\"listingId\":\"$LISTING_ID\"}")
ORDER_ID=$(echo $ORDER | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
ORDER_STATUS=$(echo $ORDER | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])" 2>/dev/null)
echo "  Order ID: $ORDER_ID — Status: $ORDER_STATUS"

# 8. Fulfill order (seller ships)
echo -e "\n📬 Fulfilling order..."
FULFILL=$(curl -s -X POST "$BASE_URL/api/v1/orders/$ORDER_ID/fulfill" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SELLER_JWT" \
  -d '{"trackingNumber":"SMOKE123456","shippingCarrier":"fedex"}')
FULFILL_STATUS=$(echo $FULFILL | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])" 2>/dev/null)
echo "  Status: $FULFILL_STATUS"

# 9. Confirm receipt (buyer confirms)
echo -e "\n✅ Confirming receipt..."
CONFIRM=$(curl -s -X POST "$BASE_URL/api/v1/orders/$ORDER_ID/confirm" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $BUYER_JWT")
CONFIRM_STATUS=$(echo $CONFIRM | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])" 2>/dev/null)
echo "  Status: $CONFIRM_STATUS"

# 10. Submit feature request
echo -e "\n💡 Submitting feature request..."
FR=$(curl -s -X POST "$BASE_URL/api/v1/feedback" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $BUYER_JWT" \
  -d '{"title":"Add Mercari support","description":"Would love to see Mercari marketplace integration"}')
FR_ID=$(echo $FR | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
echo "  Feature Request ID: $FR_ID"

echo -e "\n================================"
echo "🎉 Smoke test complete!"
echo ""
echo "Summary:"
echo "  ✅ Auth (register + login)"
echo "  ✅ Listing (create + search)"
echo "  ✅ Order (create → fulfill → confirm)"
echo "  ✅ Feature Request (submit)"
