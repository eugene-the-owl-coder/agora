-- CreateTable
CREATE TABLE "MarketplaceCredential" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "encryptedTokens" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketplaceCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyndicationRecord" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "externalUrl" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyndicationRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MarketplaceCredential_agentId_idx" ON "MarketplaceCredential"("agentId");

-- CreateIndex
CREATE INDEX "MarketplaceCredential_marketplace_idx" ON "MarketplaceCredential"("marketplace");

-- CreateIndex
CREATE UNIQUE INDEX "MarketplaceCredential_agentId_marketplace_key" ON "MarketplaceCredential"("agentId", "marketplace");

-- CreateIndex
CREATE INDEX "SyndicationRecord_listingId_idx" ON "SyndicationRecord"("listingId");

-- CreateIndex
CREATE INDEX "SyndicationRecord_marketplace_idx" ON "SyndicationRecord"("marketplace");

-- CreateIndex
CREATE INDEX "SyndicationRecord_externalId_idx" ON "SyndicationRecord"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "SyndicationRecord_listingId_marketplace_key" ON "SyndicationRecord"("listingId", "marketplace");

-- AddForeignKey
ALTER TABLE "MarketplaceCredential" ADD CONSTRAINT "MarketplaceCredential_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyndicationRecord" ADD CONSTRAINT "SyndicationRecord_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
