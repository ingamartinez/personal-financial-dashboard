CREATE TABLE "insights_reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"year_month" varchar(7) NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"input_hash" varchar(64) NOT NULL,
	"markdown" text NOT NULL,
	"model" varchar(50) NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "insights_reports_year_month_unique" UNIQUE("year_month")
);
