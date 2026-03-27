-- AlterTable: Convert images from text[] to jsonb
-- Existing data is converted: each text[] row becomes a JSON array of strings.
ALTER TABLE "Listing"
  ALTER COLUMN "images" SET DATA TYPE JSONB
  USING to_jsonb("images"),
  ALTER COLUMN "images" SET DEFAULT '[]'::jsonb;
