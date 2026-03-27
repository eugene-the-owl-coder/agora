-- CreateEnum
CREATE TYPE "WalletRole" AS ENUM ('operational', 'escrow_release', 'escrow_refund');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "buyerRefundWallet" TEXT,
ADD COLUMN     "sellerReleaseWallet" TEXT;

-- CreateTable
CREATE TABLE "UserWallet" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "role" "WalletRole" NOT NULL,
    "address" TEXT NOT NULL,
    "activatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changeEffectiveAt" TIMESTAMP(3),
    "changeLockedUntil" TIMESTAMP(3),
    "pendingAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserWallet_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserWallet_agentId_idx" ON "UserWallet"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "UserWallet_agentId_role_key" ON "UserWallet"("agentId", "role");

-- AddForeignKey
ALTER TABLE "UserWallet" ADD CONSTRAINT "UserWallet_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
