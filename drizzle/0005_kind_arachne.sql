CREATE TABLE "fx_rates" (
	"id" serial PRIMARY KEY NOT NULL,
	"base" varchar(3) NOT NULL,
	"quote" varchar(3) NOT NULL,
	"rate_micros" bigint NOT NULL,
	"as_of" date NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" varchar(40) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "fx_rates_pair_asof_unique" ON "fx_rates" USING btree ("base","quote","as_of");--> statement-breakpoint
CREATE INDEX "fx_rates_pair_fetched_idx" ON "fx_rates" USING btree ("base","quote","fetched_at");