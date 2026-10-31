# Deployment

One container image runs three ways: the web app, the background worker, and migrations. The
target for Datacom is Azure, in Australia East, inside Datacom's tenant.

## Shape

```
          Entra ID (sign-in, Mail.Read)          Claude API → Conver (Phase 7)
                 │                                          ▲
 Seller ──HTTPS──▶ Web (Next.js)  ──queues jobs──▶ Postgres ◀── Worker (pg-boss jobs, all external fetching)
                   /api/health                     + pgvector        │
                                                                     └──▶ public sources, Graph mail
```

- **Web:** serves pages and queues jobs. It makes no outbound calls to sources.
- **Worker:** runs research, monitoring, classification, email sync, the advisor and meeting prep.
  One instance is enough to start with. Per-host rate limits are per process, so add replicas
  only with that in mind.
- **Postgres 16 with pgvector:** all state, including the job queue (pg-boss, in a `pgboss`
  schema) and the HTTP cache.

## Azure (recommended for the Datacom tenant)

| Piece | Service | Notes |
|-------|---------|-------|
| Web | Azure Container Apps (or App Service for Containers) | `npm start`, port 3000, ingress HTTPS, health probe `/api/health` |
| Worker | Azure Container Apps, same image | `npm run worker`, no ingress, 1 replica; override the image's HTTP health check |
| Migrations | Container Apps job, same image | `npm run db:migrate` before each release; concurrent runs are safe (advisory lock) |
| Database | Azure Database for PostgreSQL Flexible Server, PostgreSQL 16 | Allow-list `VECTOR` in the `azure.extensions` server parameter before the first migration |
| Secrets | Key Vault, referenced by Container Apps | Everything in the secrets list below |
| Identity | Managed identity | Key Vault access; later, Conver and Graph certificate credentials |
| Region | Australia East | Data residency for customer data (confirm against Datacom policy) |

### Secrets

`DATABASE_URL`, `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY`, `ENTRA_CLIENT_SECRET` (better: a
certificate), `ANTHROPIC_API_KEY` or `CONVER_API_KEY`, `ABN_LOOKUP_GUID`, `NZBN_API_KEY`,
`ALPHA_VANTAGE_API_KEY`, `VOYAGE_API_KEY` (if used) and `GOOGLE_CLIENT_SECRET` (if used).

### Configuration

`NODE_ENV=production`, `AUTH_DEV_BYPASS` unset (the app refuses to start with it on in
production), `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_REDIRECT_URI`, `PUBLIC_BASE_URL`,
`ORG_EMAIL_DOMAINS`, `ORG_NAME`, `APP_TIMEZONE=Australia/Melbourne`, `CRAWLER_CONTACT`,
`LLM_PROVIDER` and `EMBEDDING_PROVIDER`.

### Outbound network

Allow the hosts in `docs/connecting.md` §2, plus company websites for research (a web proxy or a
broad egress rule). Inbound: HTTPS to the web app only. Graph change notifications arrive at
`/api/graph/notifications`.

### First release

1. Create the database, allow-list `VECTOR`, and run `npm run db:migrate`.
2. Run `npm run catalogue:sync` after replacing the placeholder catalogue entries.
3. Start the web app and the worker, then check `/api/health` (`workerHealthy: true` within a minute).
4. Sign in with Entra, add a public account, and watch the brief page's research run.

## Building and running locally

```bash
docker build -t account-intelligence .
docker run --env-file .env -p 3000:3000 account-intelligence                     # web
docker run --env-file .env account-intelligence npm run worker                   # worker
docker run --env-file .env account-intelligence npm run db:migrate               # migrations
```

## Vercel?

The brief listed Vercel for development. It suits the web app, but not the worker, which is a
long-running process. If the web app goes to Vercel, the worker still needs a container host. The
Azure layout above keeps both in one place and matches where the app has to end up.
