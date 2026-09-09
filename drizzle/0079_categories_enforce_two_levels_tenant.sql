-- #810: Scope the 2-level category depth check to the same tenant and to
-- live rows. The original function (0006) looked up parent/children by slug
-- alone, so one user's taxonomy could block (or incorrectly allow) another
-- user's inserts. Soft-deleted rows in any tenant also constrained inserts.
CREATE OR REPLACE FUNCTION categories_enforce_two_levels() RETURNS trigger AS $$
BEGIN
  IF NEW.parent_slug IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM categories
      WHERE user_id = NEW.user_id
        AND slug = NEW.parent_slug
        AND parent_slug IS NOT NULL
        AND deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION 'categories supports only 2 levels: parent % is itself a child', NEW.parent_slug;
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM categories
    WHERE user_id = NEW.user_id
      AND parent_slug = NEW.slug
      AND deleted_at IS NULL
  ) THEN
    IF NEW.parent_slug IS NOT NULL THEN
      RAISE EXCEPTION 'categories supports only 2 levels: % already has children and cannot become a child', NEW.slug;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
