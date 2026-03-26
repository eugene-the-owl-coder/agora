-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "buyerRating" DOUBLE PRECISION,
ADD COLUMN     "buyerTxCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastTransactionAt" TIMESTAMP(3),
ADD COLUMN     "sellerRating" DOUBLE PRECISION,
ADD COLUMN     "sellerTxCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Listing" ADD COLUMN     "minimumBuyerRating" DOUBLE PRECISION;
