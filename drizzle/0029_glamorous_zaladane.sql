CREATE TYPE "public"."institution_slug" AS ENUM('bancolombia', 'davivienda', 'nequi', 'bbva', 'scotiabank', 'bancogalicia', 'rappipay', 'cash', 'other');--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "institution_slug" "institution_slug" DEFAULT 'other' NOT NULL;--> statement-breakpoint
UPDATE "accounts" SET "institution_slug" = CASE lower(trim("institution"))
  WHEN 'bancolombia' THEN 'bancolombia'::"institution_slug"
  WHEN 'davivienda' THEN 'davivienda'::"institution_slug"
  WHEN 'nequi' THEN 'nequi'::"institution_slug"
  WHEN 'bbva' THEN 'bbva'::"institution_slug"
  WHEN 'scotiabank' THEN 'scotiabank'::"institution_slug"
  WHEN 'banco galicia' THEN 'bancogalicia'::"institution_slug"
  WHEN 'bancogalicia' THEN 'bancogalicia'::"institution_slug"
  WHEN 'rappipay' THEN 'rappipay'::"institution_slug"
  WHEN 'rappi pay' THEN 'rappipay'::"institution_slug"
  WHEN 'cash' THEN 'cash'::"institution_slug"
  WHEN 'efectivo' THEN 'cash'::"institution_slug"
  ELSE 'other'::"institution_slug"
END;