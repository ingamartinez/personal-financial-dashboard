CREATE TABLE "fiat_partners" (
	"id" serial PRIMARY KEY NOT NULL,
	"source_system" varchar(40) NOT NULL,
	"partner_name" varchar(200) NOT NULL,
	"description" text,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_aliases" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"alias" varchar(200) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_aliases" ADD CONSTRAINT "user_aliases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fiat_partners_system_name_unique" ON "fiat_partners" USING btree ("source_system","partner_name");--> statement-breakpoint
CREATE INDEX "fiat_partners_source_active_idx" ON "fiat_partners" USING btree ("source_system") WHERE "fiat_partners"."active" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "user_aliases_user_alias_unique" ON "user_aliases" USING btree ("user_id","alias");--> statement-breakpoint
CREATE INDEX "user_aliases_user_idx" ON "user_aliases" USING btree ("user_id");--> statement-breakpoint
INSERT INTO "fiat_partners" ("source_system", "partner_name", "description", "active")
VALUES ('arq', 'PEXTO COLOMBIA', 'Fiat partner ARQ para dispersiones COP en Colombia', true)
ON CONFLICT ("source_system", "partner_name") DO NOTHING;