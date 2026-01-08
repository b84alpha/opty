# Optyx MVP Monorepo

Sprint 1: gateway proxy with API-key auth + OpenAI chat completions endpoint, dashboard for projects/keys/logs, Prisma/Postgres, Redis scaffold, pnpm workspaces, Turbo.

## Prerequisites
- Node 20+
- pnpm 8+
- Docker (for Postgres + Redis)

## Local setup
1) Copy envs and start infra
```
cp .env.example .env
docker-compose up -d
```
2) Install and generate Prisma client
```
pnpm install
pnpm prisma:generate
```
3) Apply migrations and seed
```
pnpm prisma:migrate:dev
pnpm prisma:seed
```
4) Run both apps
```
pnpm dev
```
Gateway: http://localhost:4000/health  
Dashboard: http://localhost:3000 (shows “Gateway OK” when the health call succeeds)

## Package scripts
- `pnpm dev` – run gateway + dashboard via Turbo
- `pnpm prisma:migrate:dev` / `pnpm prisma:migrate` – apply Prisma migrations (dev vs deploy)
- `pnpm prisma:seed` – seed 1 org + 1 user + 1 project (plus sample provider + billing rows)

## Project structure
- `apps/gateway` – Fastify service with `/health` + `/v1/chat/completions` proxy
- `apps/dashboard` – Next.js App Router dashboard (projects, keys, logs)
- `packages/shared` – shared TypeScript constants
- `prisma` – schema, migrations (`0001_init`, `0002_sprint1`), and seed script
- `docker-compose.yml` – Postgres + Redis for local dev

## Environment
Key variables (see `.env.example`):
- `DATABASE_URL` – Postgres connection (matches docker-compose)
- `GATEWAY_PORT` / `GATEWAY_HOST`
- `DASHBOARD_ORIGIN` – allowed origin for CORS
- `NEXT_PUBLIC_GATEWAY_URL` – used by the dashboard health check
- `OPENAI_API_KEY` – required for the gateway proxy
- `REDIS_URL` – future use

## Sprint 1 usage
- Create a project and API key in the dashboard (`/projects` → create → open project → Generate key). Copy the key when shown; it is displayed once.
- Disable keys from `/projects/[id]/keys` when needed.
- View request activity in `/logs` (last 100 per project).
- Example gateway call (non-stream):
```
curl http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer <KEY>" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"hi"}],"stream":false}'
```
- Streaming example (SSE):
```
curl -N http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer <KEY>" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"hi"}],"stream":true}'
```

## CI
Basic GitHub Actions workflow at `.github/workflows/ci.yml` runs install, Prisma generate, and build.
