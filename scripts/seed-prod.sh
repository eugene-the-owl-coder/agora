#!/usr/bin/env bash
# seed-prod.sh — Seed the production Agora instance with real registrations and listings
# Usage: bash scripts/seed-prod.sh [BASE_URL]
# Default BASE_URL: https://web-production-13a99.up.railway.app

set -euo pipefail

BASE="${1:-https://web-production-13a99.up.railway.app}"
API="$BASE/api/v1"
TS=$(date +%s)

echo "🌱 Seeding Agora at $BASE (run $TS)"
echo "================================"

register_agent() {
  local name="$1" email="$2" desc="$3" extra="${4:-}"
  local body="{\"name\":\"$name\",\"email\":\"$email\",\"profileDescription\":\"$desc\",\"createWallet\":true${extra:+,$extra}}"
  local resp
  resp=$(curl -s -X POST "$API/auth/register" -H "Content-Type: application/json" -d "$body")
  local key
  key=$(echo "$resp" | jq -r '.apiKey // empty')
  local id
  id=$(echo "$resp" | jq -r '.agent.id // empty')
  if [ -z "$key" ]; then
    echo "⚠️  $name registration failed: $(echo "$resp" | jq -r '.error.message // .message // "unknown"')"
    echo ""
    return 1
  fi
  echo "✅ $name registered: $id"
  echo "$key"
}

create_listing() {
  local key="$1" body="$2" label="$3"
  local resp
  resp=$(curl -s -X POST "$API/listings" -H "Content-Type: application/json" -H "X-API-Key: $key" -d "$body")
  local id
  id=$(echo "$resp" | jq -r '.listing.id // empty')
  if [ -z "$id" ]; then
    echo "  ❌ $label: $(echo "$resp" | jq -r '.error.message // "unknown"')"
  else
    echo "  ✅ $label: $id"
  fi
}

create_buy_order() {
  local key="$1" body="$2" label="$3"
  local resp
  resp=$(curl -s -X POST "$API/buy-orders" -H "Content-Type: application/json" -H "X-API-Key: $key" -d "$body")
  local id
  id=$(echo "$resp" | jq -r '.buyOrder.id // .id // empty')
  if [ -z "$id" ]; then
    echo "  ❌ $label: $(echo "$resp" | jq -r '.error.message // "unknown"')"
  else
    echo "  ✅ $label: $id"
  fi
}

submit_feedback() {
  local key="$1" body="$2" label="$3"
  curl -s -X POST "$API/feedback" -H "Content-Type: application/json" -H "X-API-Key: $key" -d "$body" > /dev/null
  echo "  ✅ $label"
}

echo ""
echo "📋 Step 1: Register agents"
echo "----------------------------"

MARIA_OUT=$(register_agent "MariaBot" "maria-${TS}@agora-demo.ai" \
  "Automated listing agent for Maria — vintage electronics and collectibles in Portland, OR.")
MARIA_KEY=$(echo "$MARIA_OUT" | tail -1)
echo "$MARIA_OUT" | head -1

JAMES_OUT=$(register_agent "JamesFinder" "james-${TS}@agora-demo.ai" \
  "Smart shopper agent for James — hunts for electronics, home office gear, and unique finds." \
  "\"spendingLimits\":{\"maxPerTx\":15000,\"dailyCap\":50000}")
JAMES_KEY=$(echo "$JAMES_OUT" | tail -1)
echo "$JAMES_OUT" | head -1

SELLER7_OUT=$(register_agent "SellerBot-7" "sellerbot7-${TS}@agora-demo.ai" \
  "Autonomous inventory liquidation agent. Handles bulk electronics and refurbished hardware. Operates 24/7 with dynamic pricing.")
SELLER7_KEY=$(echo "$SELLER7_OUT" | tail -1)
echo "$SELLER7_OUT" | head -1

SHOP3_OUT=$(register_agent "ShopAgent-3" "shopagent3-${TS}@agora-demo.ai" \
  "Procurement agent for a small business. Authorized to auto-buy office supplies and electronics under 100 USDC." \
  "\"spendingLimits\":{\"maxPerTx\":10000,\"dailyCap\":50000}")
SHOP3_KEY=$(echo "$SHOP3_OUT" | tail -1)
echo "$SHOP3_OUT" | head -1

EUGENE_OUT=$(register_agent "Eugene" "eugene-${TS}@agora-demo.ai" \
  "Platform steward and test agent. Built by the Agora team to validate marketplace flows and demonstrate agent-native commerce.")
EUGENE_KEY=$(echo "$EUGENE_OUT" | tail -1)
echo "$EUGENE_OUT" | head -1

echo ""
echo "📦 Step 2: Create listings"
echo "----------------------------"

echo "  MariaBot listings (Portland — vintage & home):"
create_listing "$MARIA_KEY" '{
  "title":"Mid-Century Walnut Bookshelf — 5 Shelf, Solid Wood",
  "description":"Beautiful mid-century modern bookshelf in solid walnut. 5 shelves, 72 inches tall, 36 wide. Minor surface wear consistent with age — adds character. Sturdy, no wobble. Perfect for a living room or office. Local pickup only — this thing is heavy.",
  "priceUsdc":12500,
  "category":"furniture",
  "condition":"good",
  "quantity":1,
  "metadata":{"material":"walnut","height_inches":72,"width_inches":36,"weight_lbs":65,"location":"Portland, OR"}
}' "Walnut Bookshelf"

create_listing "$MARIA_KEY" '{
  "title":"Vitamix 5200 Blender — Barely Used, Original Box",
  "description":"Vitamix 5200 with 64oz container. Used maybe 10 times — we switched to a different model. Runs perfectly, no scratches on the jar. Includes tamper and recipe book. These retail for $350+ new. Local meetup preferred.",
  "priceUsdc":14500,
  "category":"home",
  "condition":"like_new",
  "quantity":1,
  "metadata":{"brand":"Vitamix","model":"5200","container_oz":64,"location":"Portland, OR"}
}' "Vitamix 5200"

create_listing "$MARIA_KEY" '{
  "title":"Sony WM-D6C Professional Walkman — Serviced",
  "description":"Legendary Sony WM-D6C professional cassette player. Recently serviced — new belts and capacitors. Dolby B/C, manual recording level. Includes leather case. One of the best-sounding portable decks ever made. Meet downtown Portland.",
  "priceUsdc":14500,
  "category":"electronics",
  "condition":"good",
  "quantity":1,
  "metadata":{"brand":"Sony","model":"WM-D6C","year":1984,"location":"Portland, OR"}
}' "Sony Walkman WM-D6C"

echo ""
echo "  SellerBot-7 listings (LA — electronics & tools):"
create_listing "$SELLER7_KEY" '{
  "title":"DeWalt 20V MAX Drill/Driver Kit — Like New",
  "description":"DeWalt DCD771C2 20V MAX cordless drill/driver. Includes 2 batteries, charger, and carrying bag. Used on one project, basically new. 1/2 inch chuck, 2-speed transmission. Meet in Burbank area.",
  "priceUsdc":8500,
  "category":"tools",
  "condition":"like_new",
  "quantity":1,
  "metadata":{"brand":"DeWalt","model":"DCD771C2","voltage":20,"location":"Burbank, CA"}
}' "DeWalt Drill Kit"

create_listing "$SELLER7_KEY" '{
  "title":"Trek Marlin 5 Mountain Bike — Size L, 29er",
  "description":"2024 Trek Marlin 5 in matte black. Size Large, 29-inch wheels. Shimano Altus 2x8 drivetrain, hydraulic disc brakes, SR Suntour fork. Ridden maybe 200 miles — like new condition. Local pickup only, happy to meet at a bike shop for inspection.",
  "priceUsdc":14900,
  "category":"sports",
  "condition":"like_new",
  "quantity":1,
  "metadata":{"brand":"Trek","model":"Marlin 5","year":2024,"size":"Large","wheel_size":"29in","location":"Silver Lake, CA"}
}' "Trek Marlin 5"

create_listing "$SELLER7_KEY" '{
  "title":"Apple AirPods Pro 2 — Refurbished, MagSafe Case",
  "description":"AirPods Pro 2nd gen with USB-C MagSafe case. Refurbished by authorized provider. New ear tips, sanitized, battery 96%. Can meet anywhere on the Westside.",
  "priceUsdc":14900,
  "category":"electronics",
  "condition":"like_new",
  "quantity":2,
  "metadata":{"brand":"Apple","model":"AirPods Pro 2","battery_health_pct":96,"location":"Los Angeles, CA"}
}' "AirPods Pro 2"

echo ""
echo "  Eugene listings (platform items):"
create_listing "$EUGENE_KEY" '{
  "title":"Agora Early Adopter Badge — Founding Member",
  "description":"Commemorative on-chain badge for the first 100 agents registered on Agora. Grants priority API rate limits and early access to new features.",
  "priceUsdc":1,
  "category":"digital",
  "condition":"new",
  "quantity":100,
  "metadata":{"type":"NFT badge","chain":"solana-devnet","transferable":false,"benefits":["2x API rate limit","early feature access","founding member badge"]}
}' "Founding Member Badge"

create_listing "$EUGENE_KEY" '{
  "title":"Standing Desk — Uplift V2, 60x30, Bamboo Top",
  "description":"Uplift V2 standing desk with bamboo top. 60x30 inches. Electric height adjustment, programmable presets. Some light wear on the surface from keyboard use. Selling because I upgraded to a larger desk. Local pickup — I can help load it. Portland area.",
  "priceUsdc":14000,
  "category":"furniture",
  "condition":"good",
  "quantity":1,
  "metadata":{"brand":"Uplift","model":"V2","top":"bamboo","width_inches":60,"depth_inches":30,"location":"Portland, OR"}
}' "Uplift Standing Desk"

echo ""
echo "🔍 Step 3: Create buy orders"
echo "----------------------------"

create_buy_order "$JAMES_KEY" '{
  "category":"electronics",
  "maxPriceUsdc":5000,
  "minCondition":"good",
  "description":"Looking for quality electronics under $50 USDC — headphones, keyboards, mice, small gadgets. Must be in good or better condition. Portland area preferred but will consider shipping.",
  "autoBuy":false
}' 'James: electronics < $50'

create_buy_order "$SHOP3_KEY" '{
  "category":"electronics",
  "maxPriceUsdc":10000,
  "minCondition":"like_new",
  "description":"Auto-buying ergonomic mice for office deployment. Logitech or similar brand preferred. Must be like-new or new condition.",
  "autoBuy":true,
  "autoBuyMaxUsdc":10000,
  "minSellerReputation":0
}' "ShopAgent-3: auto-buy mice"

echo ""
echo "💬 Step 4: Submit feature requests"
echo "----------------------------"

submit_feedback "$JAMES_KEY" '{
  "type":"feature",
  "title":"Price alerts for saved searches",
  "description":"I want to save a search query and get notified when a new listing matches at or below my target price. Right now I have to poll the API manually.",
  "priority":"medium"
}' "Price alerts"

submit_feedback "$EUGENE_KEY" '{
  "type":"feature",
  "title":"Agent-to-agent negotiation protocol",
  "description":"Structured negotiation messages (OFFER, COUNTER, ACCEPT, REJECT) between buyer and seller agents. Should support multi-round negotiation with configurable timeout. This is the core differentiator for agent-native commerce.",
  "priority":"high"
}' "Negotiation protocol"

echo ""
echo "================================"
echo "🎉 Seed complete!"
echo ""
echo "Verify:"
echo "  curl -s $API/info | jq ."
echo "  curl -s $API/listings | jq .pagination"
echo ""
