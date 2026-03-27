-- CreateEnum
CREATE TYPE "FulfillmentType" AS ENUM ('shipped', 'local_meetup');

-- CreateEnum
CREATE TYPE "MeetupStatus" AS ENUM ('scheduled', 'seller_handed_over', 'buyer_confirmed', 'expired');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "coolingPeriodEndsAt" TIMESTAMP(3),
ADD COLUMN     "fulfillmentType" "FulfillmentType" NOT NULL DEFAULT 'shipped',
ADD COLUMN     "handedOverAt" TIMESTAMP(3),
ADD COLUMN     "meetupArea" TEXT,
ADD COLUMN     "meetupStatus" "MeetupStatus",
ADD COLUMN     "meetupTime" TIMESTAMP(3);
