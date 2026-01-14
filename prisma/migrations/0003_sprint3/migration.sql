ALTER TABLE "projects"
ADD COLUMN "default_tier" TEXT NOT NULL DEFAULT 'fast',
ADD COLUMN "allowed_models" JSONB NOT NULL DEFAULT '[]'::jsonb,
ADD COLUMN "allow_all_models" BOOLEAN NOT NULL DEFAULT true;
