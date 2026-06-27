# beutl-web

Beutl's marketplace web application for browsing packages, managing developer projects, user accounts, releases, checkout, and public API endpoints.

## Technology

- Next.js App Router
- Prisma with PostgreSQL-compatible database access
- Better Auth for authentication
- Stripe checkout and webhooks
- Cloudflare Workers deployment through OpenNext Cloudflare
- pnpm for package management

## Development

Use the Node major declared in `.nvmrc`, then install dependencies and start the local server:

```bash
pnpm install
pnpm dev
```

Run linting with:

```bash
pnpm lint
```

## Deployment

The deployment target is Cloudflare Workers via OpenNext Cloudflare:

```bash
pnpm run deploy
```

Use `pnpm run preview` to build and preview the Worker locally. Cloudflare bindings are declared in `wrangler.jsonc`; local environment placeholders are documented in `.env.sample`.
