CREATE TABLE "merchant_knowledge" (
	"canonical_merchant" varchar(200) PRIMARY KEY NOT NULL,
	"business_type" text,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_gateway" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchant_knowledge_hints" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"canonical_merchant" varchar(200) NOT NULL,
	"category_slug" varchar(60) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "merchant_knowledge_hints" ADD CONSTRAINT "merchant_knowledge_hints_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_knowledge_hints" ADD CONSTRAINT "merchant_knowledge_hints_canonical_merchant_merchant_knowledge_canonical_merchant_fk" FOREIGN KEY ("canonical_merchant") REFERENCES "public"."merchant_knowledge"("canonical_merchant") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_knowledge_hints" ADD CONSTRAINT "merchant_knowledge_hints_user_category_fk" FOREIGN KEY ("user_id","category_slug") REFERENCES "public"."categories"("user_id","slug") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_knowledge_hints_user_merchant_unique" ON "merchant_knowledge_hints" USING btree ("user_id","canonical_merchant");