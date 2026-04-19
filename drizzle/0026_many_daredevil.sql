ALTER TABLE "users" ADD COLUMN "subscription_status" varchar(20);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "plan_id" varchar(40);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "trial_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mercadopago_customer_id" varchar(80);