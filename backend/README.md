# Senthra — Backend

Express 5 + Prisma (MongoDB) REST API, written in **TypeScript** with a layered,
production-grade architecture.

## Quick start

```bash
pnpm install
cp .env.example .env      # then fill in real values
pnpm prisma:generate      # generate the Prisma client
pnpm dev                  # start with hot reload (tsx watch)
```

| Script | Description |
| --- | --- |
| `pnpm dev` | Run in watch mode via `tsx` (no build step). |
| `pnpm build` | Compile TypeScript to `dist/` with `tsc`. |
| `pnpm start` | Run the compiled server (`node dist/server.js`). |
| `pnpm typecheck` | Type-check without emitting. |
| `pnpm prisma:generate` | Regenerate the Prisma client. |

## Folder structure

```
src/
├── config/         # validated environment (env.ts) — the only place process.env is read
├── controllers/    # thin HTTP layer: parse request → call service → send response
├── services/       # business logic (auth, settings, email)
├── repositories/   # the ONLY place Prisma is touched (one module per model)
├── routes/         # express routers + the health check (index.ts mounts them)
├── middleware/     # auth, validation runner, error handler, rate limiters
├── validations/    # zod schemas (request shape + normalization)
├── lib/            # stateful third-party clients (prisma, nodemailer transport)
├── utils/          # pure helpers (jwt, cookies, crypto, password, http-error, async-handler)
├── db/             # startup bootstrap (seed.ts)
├── types/          # ambient type augmentation (express.d.ts)
├── app.ts          # express app assembly (middleware + routes)
└── server.ts       # entry point (seed → listen → graceful shutdown)
```

## Request lifecycle

```
route → rateLimit → requireAuth (protected) → validateBody(zodSchema)
      → controller → service → repository → Prisma
```

- **Controllers** never contain business logic; they translate between HTTP and services.
- **Services** return plain data or `throw new HttpError(status, message)`.
- **Repositories** are the single boundary to the database.
- The **error middleware** converts thrown errors into JSON; only 5xx are logged.
- **Auth tokens** are generated in the service and returned; cookies are set in the
  controller, keeping the HTTP concern at the edge.

## Conventions

- Files are named `domain.layer.ts` — e.g. `auth.controller.ts`, `auth.service.ts`,
  `admin.repository.ts`, `auth.validation.ts`, `error.middleware.ts`.
- ES modules with `NodeNext` resolution: relative imports include the `.js` extension
  (e.g. `import { env } from "../config/env.js"`), which `tsx` (dev) and the compiled
  output (prod) both resolve correctly.

## Environment

See [`.env.example`](./.env.example). `config/env.ts` validates every variable with
zod at startup and exits with a clear message if anything is missing or malformed
(e.g. `ENCRYPTION_KEY` must be 64 hex characters).
