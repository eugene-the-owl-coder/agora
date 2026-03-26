-- AlterEnum
ALTER TYPE "OrderStatus" ADD VALUE 'pending_approval';

-- CreateTable
CREATE TABLE "SpendingPolicy" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "monthlyLimitUsdc" INTEGER,
    "perTransactionMax" INTEGER,
    "autoApproveBelow" INTEGER,
    "requireHumanAbove" INTEGER,
    "allowedCategories" TEXT[],
    "blockedSellers" TEXT[],
    "cooldownMinutes" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SpendingPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SpendingPolicy_agentId_key" ON "SpendingPolicy"("agentId");

-- AddForeignKey
ALTER TABLE "SpendingPolicy" ADD CONSTRAINT "SpendingPolicy_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
