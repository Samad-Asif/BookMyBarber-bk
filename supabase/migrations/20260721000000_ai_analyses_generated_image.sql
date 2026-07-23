-- Add generated image and richer analysis fields to ai_analyses
alter table public.ai_analyses
  add column if not exists generated_image_url text,
  add column if not exists styling_reason text;
