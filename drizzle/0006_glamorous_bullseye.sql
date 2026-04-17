ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_slug_categories_slug_fk" FOREIGN KEY ("parent_slug") REFERENCES "public"."categories"("slug") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_slug_not_self" CHECK ("parent_slug" IS NULL OR "parent_slug" <> "slug");--> statement-breakpoint

CREATE OR REPLACE FUNCTION categories_enforce_two_levels() RETURNS trigger AS $$
BEGIN
  IF NEW.parent_slug IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM categories WHERE slug = NEW.parent_slug AND parent_slug IS NOT NULL) THEN
      RAISE EXCEPTION 'categories supports only 2 levels: parent % is itself a child', NEW.parent_slug;
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM categories WHERE parent_slug = NEW.slug) THEN
    IF NEW.parent_slug IS NOT NULL THEN
      RAISE EXCEPTION 'categories supports only 2 levels: % already has children and cannot become a child', NEW.slug;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER categories_enforce_two_levels_trigger
  BEFORE INSERT OR UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION categories_enforce_two_levels();
