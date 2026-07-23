-- Fix: allow pending ai_analyses inserts without analysis fields
-- (filled later by queue worker after Gemini analysis)
ALTER TABLE public.ai_analyses
  ALTER COLUMN suggested_haircut DROP NOT NULL,
  ALTER COLUMN face_shape DROP NOT NULL,
  ALTER COLUMN analysis_details DROP NOT NULL;
