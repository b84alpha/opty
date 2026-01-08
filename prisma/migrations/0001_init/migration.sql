-- Create Enums
CREATE TYPE "MembershipRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');
CREATE TYPE "ApiKeyStatus" AS ENUM ('ACTIVE', 'DISABLED');
CREATE TYPE "LedgerEntryType" AS ENUM ('DEPOSIT', 'CHARGE', 'ADJUSTMENT');

-- Orgs
CREATE TABLE "orgs" (
    "id" TEXT PRIMARY KEY,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Users
CREATE TABLE "users" (
    "id" TEXT PRIMARY KEY,
    "email" TEXT NOT NULL UNIQUE,
    "name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Memberships
CREATE TABLE "memberships" (
    "id" TEXT PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "role" "MembershipRole" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "memberships_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "memberships_user_id_org_id_key" UNIQUE ("user_id", "org_id")
);

-- Projects
CREATE TABLE "projects" (
    "id" TEXT PRIMARY KEY,
    "org_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "projects_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "projects_org_id_idx" ON "projects" ("org_id");

-- API Keys
CREATE TABLE "api_keys" (
    "id" TEXT PRIMARY KEY,
    "project_id" TEXT NOT NULL,
    "hashed_key" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "status" "ApiKeyStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "api_keys_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "api_keys_project_id_idx" ON "api_keys" ("project_id");

-- Providers
CREATE TABLE "providers" (
    "id" TEXT PRIMARY KEY,
    "provider" TEXT NOT NULL UNIQUE,
    "display_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Provider Credentials
CREATE TABLE "provider_credentials" (
    "id" TEXT PRIMARY KEY,
    "provider_id" TEXT NOT NULL,
    "org_id" TEXT,
    "project_id" TEXT,
    "encrypted_config" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'org',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "provider_credentials_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "provider_credentials_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "provider_credentials_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "provider_credentials_provider_id_idx" ON "provider_credentials" ("provider_id");
CREATE INDEX "provider_credentials_org_id_idx" ON "provider_credentials" ("org_id");
CREATE INDEX "provider_credentials_project_id_idx" ON "provider_credentials" ("project_id");

-- Routes
CREATE TABLE "routes" (
    "id" TEXT PRIMARY KEY,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tag" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "routes_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "routes_project_id_idx" ON "routes" ("project_id");

-- Route Versions
CREATE TABLE "route_versions" (
    "id" TEXT PRIMARY KEY,
    "route_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "config" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "route_versions_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "routes"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "route_versions_route_id_version_key" UNIQUE ("route_id", "version")
);

-- Policies
CREATE TABLE "policies" (
    "id" TEXT PRIMARY KEY,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "definition_json" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "policies_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "policies_project_id_idx" ON "policies" ("project_id");

-- Requests Log
CREATE TABLE "requests_log" (
    "id" TEXT PRIMARY KEY,
    "project_id" TEXT NOT NULL,
    "route_id" TEXT,
    "status" TEXT,
    "metadata_json" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "requests_log_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "requests_log_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "routes"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "requests_log_project_id_idx" ON "requests_log" ("project_id");
CREATE INDEX "requests_log_route_id_idx" ON "requests_log" ("route_id");

-- Aggregates Daily
CREATE TABLE "aggregates_daily" (
    "id" TEXT PRIMARY KEY,
    "project_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "rollup_json" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "aggregates_daily_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "aggregates_daily_project_id_date_key" UNIQUE ("project_id", "date")
);

-- Provider Model Prices
CREATE TABLE "provider_model_prices" (
    "id" TEXT PRIMARY KEY,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "input_per_mtok" DECIMAL(18,6) NOT NULL,
    "output_per_mtok" DECIMAL(18,6) NOT NULL,
    "cache_hit_per_mtok" DECIMAL(18,6),
    "effective_from" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT TRUE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "provider_model_prices_provider_model_is_active_idx" ON "provider_model_prices" ("provider", "model", "is_active");

-- Project Wallets
CREATE TABLE "project_wallets" (
    "id" TEXT PRIMARY KEY,
    "project_id" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "deposit_address" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "project_wallets_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "project_wallets_project_id_idx" ON "project_wallets" ("project_id");

-- Ledger Entries
CREATE TABLE "ledger_entries" (
    "id" TEXT PRIMARY KEY,
    "project_id" TEXT NOT NULL,
    "type" "LedgerEntryType" NOT NULL,
    "amount" DECIMAL(18,6) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USDC',
    "reference" TEXT NOT NULL,
    "metadata_json" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ledger_entries_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ledger_entries_project_id_idx" ON "ledger_entries" ("project_id");

-- Onchain Deposits
CREATE TABLE "onchain_deposits" (
    "id" TEXT PRIMARY KEY,
    "project_id" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "tx_hash" TEXT NOT NULL UNIQUE,
    "amount" DECIMAL(18,6) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USDC',
    "confirmed_at" TIMESTAMP(3),
    "raw_json" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "onchain_deposits_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "onchain_deposits_project_id_idx" ON "onchain_deposits" ("project_id");
