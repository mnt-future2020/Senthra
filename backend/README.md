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

Code is organized **by domain** under `src/modules/`, where each folder holds that
domain's full vertical slice (controller → service → repository → validation → routes).
Cross-cutting infrastructure stays at the `src/` top level.

```
src/
├── modules/                # one folder per domain (the business code)
│   ├── auth/               # auth.{controller,service,validation,routes}.ts + admin.repository.ts
│   ├── user/               # user.{controller,service,repository,validation,routes}.ts
│   ├── role/               # role.{controller,service,repository,validation,routes}.ts
│   ├── settings/           # settings.{controller,service,repository,validation,routes}.ts
│   ├── email/              # email.service + emailLog.repository + emailTemplate.defaults
│   │                       #   + emailTemplate.{controller,service,repository,validation,routes}.ts
│   └── audit/              # audit.service.ts + audit.repository.ts
├── config/                 # validated environment (env.ts) — the only place process.env is read
├── routes/                 # route aggregator (index.ts mounts each module's *.routes.ts) + health check
├── middleware/             # auth, validation runner, error handler, rate limiters
├── lib/                    # stateful third-party clients (prisma, nodemailer transport)
├── utils/                  # pure helpers (jwt, cookies, crypto, password, http-error, async-handler)
├── db/                     # startup bootstrap (seed.ts)
├── types/                  # ambient type augmentation (express.d.ts)
├── app.ts                  # express app assembly (middleware + routes)
└── server.ts               # entry point (seed → listen → graceful shutdown)
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
  `admin.repository.ts`, `auth.validation.ts`, `error.middleware.ts` — grouped in
  `modules/<domain>/`.
- ES modules with `NodeNext` resolution: relative imports include the `.js` extension
  (e.g. `import { env } from "../config/env.js"`), which `tsx` (dev) and the compiled
  output (prod) both resolve correctly.
- **`#modules/*` import alias** for cross-module (and into-module) imports —
  `import * as audit from "#modules/audit/audit.service.js";` instead of brittle
  `../../audit/...` paths. Same-module imports stay relative (`./auth.service.js`).
  It is a conditional [subpath import](https://nodejs.org/api/packages.html#subpath-imports)
  in `package.json`: the `development` condition maps to `./src/modules/*`, `default`
  to `./dist/modules/*`. So `pnpm dev` runs `tsx --conditions=development` and
  `pnpm typecheck`/`build` use `customConditions: ["development"]` in `tsconfig.json`
  to resolve against source, while `pnpm start` (plain `node dist/`) resolves to the
  compiled output via `default`.

## Environment

See [`.env.example`](./.env.example). `config/env.ts` validates every variable with
zod at startup and exits with a clear message if anything is missing or malformed
(e.g. `ENCRYPTION_KEY` must be 64 hex characters).

## Cloudinary account setup

Attachments go straight from the browser to Cloudinary, signed by this server over two **upload
presets** (`CLOUDINARY_UPLOAD_PRESET_IMAGE` / `CLOUDINARY_UPLOAD_PRESET_RAW`, default
`senthra_image` / `senthra_raw`). The app manages those presets itself, so pointing it at a fresh
Cloudinary account needs no manual preset work:

- **Saving Cloudinary credentials** (Settings → Storage) creates or repairs both presets in the
  account those credentials point at — signed, with the format allowlist derived from
  `src/modules/upload/upload.catalog.ts`. Cloudinary rejecting the key or secret refuses the save,
  which is the credentials check: nothing unusable is stored.
- **Test connection** on the same card reads the presets back and reports each as ready, missing
  or needing repair.
- **Set up upload presets** on the same card creates or repairs them on demand — the path for a
  deployment whose credentials come from the environment, where no save ever runs.

Preset changes are recorded in the audit log (`settings.cloudinary_presets_configured`).

One thing the app cannot do for you: **a new Cloudinary account blocks PDF (and ZIP) delivery by
default**, answering 401 for any URL that ends in `.pdf`. Purchase-order PDFs and PDF attachments
will not open until an account owner enables it in the Cloudinary console under Settings →
Security → "PDF and ZIP files delivery" (paid plans have it on by default). See
<https://support.cloudinary.com/hc/en-us/articles/360016480179>.
