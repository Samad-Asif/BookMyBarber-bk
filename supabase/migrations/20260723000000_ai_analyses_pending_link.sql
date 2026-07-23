-- Add status + error columns to ai_analyses for async pending state
ALTER TABLE public.ai_analyses
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'completed';

ALTER TABLE public.ai_analyses
  ADD COLUMN IF NOT EXISTS error_message text;

-- Index for fast status lookups
CREATE INDEX IF NOT EXISTS idx_ai_analyses_customer_status
  ON public.ai_analyses(customer_id, status);

-- Link haircut_requests → ai_analyses
ALTER TABLE public.haircut_requests
  ADD COLUMN IF NOT EXISTS ai_analysis_id uuid
  REFERENCES public.ai_analyses(id) ON DELETE SET NULL;
