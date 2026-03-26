-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "buyerCollateralUsdc" BIGINT,
ADD COLUMN     "collateralRatio" DOUBLE PRECISION DEFAULT 1.0,
ADD COLUMN     "sellerCollateralUsdc" BIGINT;
