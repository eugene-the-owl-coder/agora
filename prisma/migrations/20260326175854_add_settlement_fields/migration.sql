-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "errorMessage" TEXT,
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "lastAttemptAt" TIMESTAMP(3),
ADD COLUMN     "retryCount" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_idempotencyKey_key" ON "Transaction"("idempotencyKey");
