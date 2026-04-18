CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"google_sub" varchar(255),
	"email" varchar(320) NOT NULL,
	"name" varchar(200) NOT NULL,
	"picture_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_google_sub_unique" UNIQUE("google_sub"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
