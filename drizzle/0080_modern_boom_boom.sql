CREATE OR REPLACE FUNCTION __wrap_classification_reason(t text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF t IS NULL THEN
    RETURN NULL;
  END IF;
  BEGIN
    RETURN t::jsonb;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN jsonb_build_object('text', t);
  END;
END;
$$;
--> statement-breakpoint
ALTER TABLE "transactions" ALTER COLUMN "classification_reason" SET DATA TYPE jsonb USING __wrap_classification_reason("classification_reason");
--> statement-breakpoint
DROP FUNCTION __wrap_classification_reason(text);
