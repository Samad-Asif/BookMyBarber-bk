-- Haircut generation pipeline: tracks Gemini analysis + Colab InstantID generation
CREATE TABLE public.haircut_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,

  -- Source photos (Cloudinary URLs from haircut-portraits bucket)
  front_image_url text NOT NULL,
  left_image_url text NOT NULL,
  right_image_url text NOT NULL,

  -- Pipeline status
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'analyzing', 'queued', 'processing', 'completed', 'failed')),

  -- Stage 1 outputs (Gemini Vision)
  face_shape text,
  hair_density text,
  hair_texture text,
  hair_color text,
  haircut_title text,
  stylist_recommendation text,
  generation_prompt text,

  -- Stage 2 outputs (Colab InstantID)
  result_image_url text,

  -- Error tracking
  error_message text,
  error_stage text,

  -- Timestamps
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_haircut_requests_user_id ON public.haircut_requests(user_id);
CREATE INDEX idx_haircut_requests_status ON public.haircut_requests(status)
  WHERE status IN ('pending', 'queued', 'processing');

-- Updated_at trigger
CREATE OR REPLACE FUNCTION public.handle_haircut_requests_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER haircut_requests_updated_at
  BEFORE UPDATE ON public.haircut_requests
  FOR EACH ROW EXECUTE FUNCTION public.handle_haircut_requests_updated_at();

-- RLS
ALTER TABLE public.haircut_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "haircut_requests_select_own"
  ON public.haircut_requests FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "haircut_requests_insert_own"
  ON public.haircut_requests FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Service-role can do everything (backend queue worker uses secret key)
CREATE POLICY "haircut_requests_service_all"
  ON public.haircut_requests FOR ALL
  USING (auth.role() = 'service_role');

-- Realtime: enable for Postgres Changes
ALTER PUBLICATION supabase_realtime ADD TABLE public.haircut_requests;
