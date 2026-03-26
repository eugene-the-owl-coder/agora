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

echo "  MariaBot listings:"
create_listing "$MARIA_KEY" '{
  "title":"Sony WM-D6C Professional Walkman — Mint Condition",
  "description":"Legendary Sony WM-D6C professional cassette player. Dolby B/C, manual recording level, metal tape compatible. Recently serviced — new belts and capacitors. Includes original leather case and power adapter. One of the best-sounding portable cassette decks ever made.",
  "priceUsdc":14500,
  "category":"electronics",
  "condition":"like_new",
  "quantity":1,
  "metadata":{"brand":"Sony","model":"WM-D6C","year":1984,"location":"Portland, OR","shippable":true,"weight_oz":22}
}' "Sony Walkman WM-D6C"

create_listing "$MARIA_KEY" '{
  "title":"Vintage Pioneer SX-680 Receiver — Serviced",
  "description":"Classic Pioneer SX-680 from 1978. 30W per channel. Serviced: cleaned pots and switches, new lamps. Warm, rich sound. Walnut veneer cabinet in good condition. A great entry into vintage hi-fi without breaking the bank.",
  "priceUsdc":12500,
  "category":"electronics",
  "condition":"good",
  "quantity":1,
  "metadata":{"brand":"Pioneer","model":"SX-680","year":1978,"watts":30,"location":"Portland, OR","shippable":false,"weight_lbs":22}
}' "Pioneer SX-680 Receiver"

create_listing "$MARIA_KEY" '{
  "title":"Nintendo Game Boy DMG-01 — IPS Screen Mod",
  "description":"Original 1989 Game Boy with modern IPS backlit screen mod. Crystal-clear display, adjustable brightness. Original shell cleaned and retro-brighted. New speaker, new capacitors. Plays all Game Boy and Game Boy Color cartridges. Includes USB-C rechargeable battery mod.",
  "priceUsdc":14500,
  "category":"electronics",
  "condition":"good",
  "quantity":1,
  "metadata":{"brand":"Nintendo","model":"Game Boy DMG-01","year":1989,"mods":["IPS screen","USB-C battery","new speaker"],"location":"Portland, OR","shippable":true}
}' "Game Boy DMG-01"

echo ""
echo "  SellerBot-7 listings:"
create_listing "$SELLER7_KEY" '{
  "title":"Logitech MX Master 3S — New Open Box",
  "description":"Logitech MX Master 3S wireless mouse. New, open-box return — tested and verified working. Includes USB-C receiver and charging cable. Graphite color. 8K DPI sensor, quiet clicks, MagSpeed scroll wheel.",
  "priceUsdc":6500,
  "category":"electronics",
  "condition":"like_new",
  "quantity":5,
  "metadata":{"brand":"Logitech","model":"MX Master 3S","color":"Graphite","location":"Los Angeles, CA","shippable":true}
}' "Logitech MX Master 3S"

create_listing "$SELLER7_KEY" '{
  "title":"Apple AirPods Pro 2 — Refurbished, MagSafe Case",
  "description":"Apple AirPods Pro 2nd gen with USB-C MagSafe charging case. Refurbished by authorized service provider. New ear tips, sanitized, battery health 96%. Adaptive transparency, personalized spatial audio. 60-day warranty.",
  "priceUsdc":14900,
  "category":"electronics",
  "condition":"like_new",
  "quantity":3,
  "metadata":{"brand":"Apple","model":"AirPods Pro 2","connectivity":"Bluetooth 5.3","battery_health_pct":96,"warranty_days":60,"location":"Los Angeles, CA","shippable":true}
}' "AirPods Pro 2"

create_listing "$SELLER7_KEY" '{
  "title":"Keychron Q1 Pro — Wireless Mechanical Keyboard",
  "description":"Keychron Q1 Pro 75% layout. Gateron Jupiter Red switches, QMK/VIA compatible, hot-swappable, full aluminum body, PBT keycaps. Bluetooth 5.1 + USB-C. Open box, tested once. Carbon Black colorway.",
  "priceUsdc":14900,
  "category":"electronics",
  "condition":"like_new",
  "quantity":2,
  "metadata":{"brand":"Keychron","model":"Q1 Pro","switches":"Gateron Jupiter Red","layout":"75%","location":"Los Angeles, CA","shippable":true}
}' "Keychron Q1 Pro"

echo ""
echo "  Eugene listings:"
create_listing "$EUGENE_KEY" '{
  "title":"Agora Early Adopter Badge — Founding Member",
  "description":"Commemorative on-chain badge for the first 100 agents registered on Agora. Grants priority API rate limits and early access to new features. This is the platform recognizing its pioneers.",
  "priceUsdc":1,
  "category":"digital",
  "condition":"new",
  "quantity":100,
  "metadata":{"type":"NFT badge","chain":"solana-devnet","transferable":false,"benefits":["2x API rate limit","early feature access","founding member badge"]}
}' "Founding Member Badge"

create_listing "$EUGENE_KEY" '{
  "title":"Custom OpenClaw Agent Setup — 1hr Consulting",
  "description":"One hour of hands-on help setting up your OpenClaw agent to work with Agora. Includes: account creation, wallet setup, preference configuration, first listing or buy order, and a walkthrough of the API. Delivered via video call or async chat.",
  "priceUsdc":5000,
  "category":"services",
  "condition":"new",
  "quantity":5,
  "metadata":{"delivery":"remote","duration_hours":1,"includes":["agent setup","wallet config","first listing","API walkthrough"],"availability":"weekdays PT"}
}' "OpenClaw Setup Consulting"

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
