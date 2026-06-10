// Vercel serverless entry point.
//
// On Vercel the API runs as a serverless function, not a long-lived server, so
// we export the Express app as the request handler instead of calling
// `app.listen()`. The listen()/seed flow stays in `server.ts` for local dev
// (`pnpm dev`) and traditional hosts (`pnpm start`).
//
// The compiled app is imported from `dist/` — `vercel-build` (`prisma generate
// && tsc`) produces it before this function is bundled.
import { app } from "../dist/app.js";

export default app;
