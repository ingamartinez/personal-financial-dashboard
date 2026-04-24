CREATE TABLE "user_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" varchar(200) NOT NULL,
	"schema_version" varchar(128) NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_bytes" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_snapshots" ADD CONSTRAINT "user_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_snapshots_user_created_idx" ON "user_snapshots" USING btree ("user_id","created_at" DESC NULLS LAST);