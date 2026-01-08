-- API keys additions
ALTER TABLE "api_keys"
ADD COLUMN "last_used_at" TIMESTAMP(3);

CREATE UNIQUE INDEX "api_keys_hashed_key_key" ON "api_keys" ("hashed_key");
CREATE INDEX "api_keys_prefix_idx" ON "api_keys" ("prefix");

-- Request log expansion
ALTER TABLE "requests_log"
ADD COLUMN "api_key_id" TEXT,
ADD COLUMN "route_tag" TEXT,
ADD COLUMN "tier" TEXT,
ADD COLUMN "provider" TEXT,
ADD COLUMN "model" TEXT,
ADD COLUMN "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "finished_at" TIMESTAMP(3),
ADD COLUMN "latency_ms" INTEGER,
ADD COLUMN "http_status" INTEGER,
ADD COLUMN "error_class" TEXT,
ADD COLUMN "tokens_in" INTEGER,
ADD COLUMN "tokens_out" INTEGER,
ADD COLUMN "estimated_cost_usdc" DECIMAL(18,6),
ADD COLUMN "fallback_used" BOOLEAN NOT NULL DEFAULT FALSE,
ADD COLUMN "retry_count" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "requests_log"
ADD CONSTRAINT "requests_log_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "requests_log_api_key_id_idx" ON "requests_log" ("api_key_id");
