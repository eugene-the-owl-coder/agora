-- CreateEnum
CREATE TYPE "ListingCondition" AS ENUM ('new', 'like_new', 'good', 'fair', 'poor');

-- CreateEnum
CREATE TYPE "ListingStatus" AS ENUM ('draft', 'active', 'sold', 'delisted', 'disputed');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('created', 'funded', 'fulfilled', 'completed', 'disputed', 'cancelled', 'refunded');

-- CreateEnum
CREATE TYPE "TxType" AS ENUM ('escrow_fund', 'escrow_release', 'refund', 'withdrawal', 'deposit');

-- CreateEnum
CREATE TYPE "TxStatus" AS ENUM ('pending', 'confirmed', 'failed');

-- CreateEnum
CREATE TYPE "FeatureRequestStatus" AS ENUM ('open', 'planned', 'building', 'shipped', 'rejected');

-- CreateEnum
CREATE TYPE "BuyOrderStatus" AS ENUM ('active', 'paused', 'fulfilled', 'expired');

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "apiKeyHash" TEXT NOT NULL,
    "apiKeyPrefix" TEXT NOT NULL,
    "walletAddress" TEXT,
    "walletEncryptedKey" TEXT,
    "profileDescription" TEXT,
    "avatarUrl" TEXT,
    "reputation" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalSales" INTEGER NOT NULL DEFAULT 0,
    "totalPurchases" INTEGER NOT NULL DEFAULT 0,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "operatorId" TEXT,
    "permissions" JSONB NOT NULL DEFAULT '["list", "buy", "sell"]',
    "spendingLimits" JSONB NOT NULL DEFAULT '{"maxPerTx": 1000000000, "dailyCap": 10000000000}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Listing" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "images" TEXT[],
    "priceUsdc" BIGINT NOT NULL,
    "priceSol" BIGINT,
    "category" TEXT NOT NULL,
    "condition" "ListingCondition" NOT NULL DEFAULT 'new',
    "status" "ListingStatus" NOT NULL DEFAULT 'draft',
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "externalListings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Listing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "buyerAgentId" TEXT NOT NULL,
    "sellerAgentId" TEXT NOT NULL,
    "amountUsdc" BIGINT NOT NULL,
    "escrowAddress" TEXT,
    "escrowSignature" TEXT,
    "status" "OrderStatus" NOT NULL DEFAULT 'created',
    "shippingInfo" JSONB,
    "trackingNumber" TEXT,
    "disputeReason" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL,
    "orderId" TEXT,
    "fromAgentId" TEXT,
    "toAgentId" TEXT,
    "amountUsdc" BIGINT,
    "amountSol" BIGINT,
    "txSignature" TEXT,
    "txType" "TxType" NOT NULL,
    "status" "TxStatus" NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Webhook" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "events" TEXT[],
    "secret" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Webhook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeatureRequest" (
    "id" TEXT NOT NULL,
    "agentId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "votes" INTEGER NOT NULL DEFAULT 0,
    "status" "FeatureRequestStatus" NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeatureRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuyOrder" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "searchQuery" TEXT NOT NULL,
    "maxPriceUsdc" BIGINT NOT NULL,
    "category" TEXT,
    "condition" "ListingCondition",
    "minSellerReputation" DOUBLE PRECISION,
    "autoBuy" BOOLEAN NOT NULL DEFAULT false,
    "autoBuyMaxUsdc" BIGINT,
    "status" "BuyOrderStatus" NOT NULL DEFAULT 'active',
    "matchedListingId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "BuyOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Agent_email_key" ON "Agent"("email");

-- CreateIndex
CREATE INDEX "Agent_apiKeyPrefix_idx" ON "Agent"("apiKeyPrefix");

-- CreateIndex
CREATE INDEX "Agent_walletAddress_idx" ON "Agent"("walletAddress");

-- CreateIndex
CREATE INDEX "Agent_email_idx" ON "Agent"("email");

-- CreateIndex
CREATE INDEX "Listing_agentId_idx" ON "Listing"("agentId");

-- CreateIndex
CREATE INDEX "Listing_category_idx" ON "Listing"("category");

-- CreateIndex
CREATE INDEX "Listing_status_idx" ON "Listing"("status");

-- CreateIndex
CREATE INDEX "Listing_priceUsdc_idx" ON "Listing"("priceUsdc");

-- CreateIndex
CREATE INDEX "Order_buyerAgentId_idx" ON "Order"("buyerAgentId");

-- CreateIndex
CREATE INDEX "Order_sellerAgentId_idx" ON "Order"("sellerAgentId");

-- CreateIndex
CREATE INDEX "Order_status_idx" ON "Order"("status");

-- CreateIndex
CREATE INDEX "Transaction_orderId_idx" ON "Transaction"("orderId");

-- CreateIndex
CREATE INDEX "Transaction_txSignature_idx" ON "Transaction"("txSignature");

-- CreateIndex
CREATE INDEX "Webhook_agentId_idx" ON "Webhook"("agentId");

-- CreateIndex
CREATE INDEX "FeatureRequest_votes_idx" ON "FeatureRequest"("votes");

-- CreateIndex
CREATE INDEX "FeatureRequest_status_idx" ON "FeatureRequest"("status");

-- CreateIndex
CREATE INDEX "BuyOrder_agentId_idx" ON "BuyOrder"("agentId");

-- CreateIndex
CREATE INDEX "BuyOrder_status_idx" ON "BuyOrder"("status");

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_buyerAgentId_fkey" FOREIGN KEY ("buyerAgentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_sellerAgentId_fkey" FOREIGN KEY ("sellerAgentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_fromAgentId_fkey" FOREIGN KEY ("fromAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_toAgentId_fkey" FOREIGN KEY ("toAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Webhook" ADD CONSTRAINT "Webhook_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeatureRequest" ADD CONSTRAINT "FeatureRequest_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyOrder" ADD CONSTRAINT "BuyOrder_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyOrder" ADD CONSTRAINT "BuyOrder_matchedListingId_fkey" FOREIGN KEY ("matchedListingId") REFERENCES "Listing"("id") ON DELETE SET NULL ON UPDATE CASCADE;
