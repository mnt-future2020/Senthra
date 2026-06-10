// Vercel serverless entry point.
//
// On Vercel the API runs as a serverless function, not a long-lived server, so
// we export the Express app as the request handler instead of calling
// `app.listen()`. The listen()/seed flow stays in `server.ts` for local dev
// (`pnpm dev`) and traditional hosts (`pnpm start`).
//
// This is intentionally plain JavaScript: it imports the already-compiled app
// from `dist/` (produced by `vercel-build` = `prisma generate && tsc`). Keeping
// it as .js means Vercel does NOT type-check it against the strict tsconfig,
// which avoids needing declaration files for the compiled output.
import { app } from "../dist/app.js";

export default app;
