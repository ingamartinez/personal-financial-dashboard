ALTER TABLE "users" ADD COLUMN "role" varchar(20) DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_check" CHECK ("users"."role" IN ('admin', 'user'));--> statement-breakpoint
UPDATE "users" SET "role" = 'admin' WHERE "id" = 1;