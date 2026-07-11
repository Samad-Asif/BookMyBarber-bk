CREATE TABLE public.email_verification_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL,
  code_hash   text NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz DEFAULT now()
);

CREATE INDEX idx_email_verification_codes_email ON public.email_verification_codes(email);
