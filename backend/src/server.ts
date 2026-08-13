import { createServer } from "node:http";

import { env } from "./config/env.js";
import { app } from "./app.js";
import { seedDatabase } from "./db/seed.js";
import { initRealtime } from "./lib/realtime.js";
import { prisma } from "./lib/prisma.js";
import { startUploadReaper } from "#modules/upload/upload.reaper.js";

async function start(): Promise<void> {
  // Ensure the admin + settings exist before accepting requests.
  await seedDatabase();

  // Wrap the Express app in a raw http.Server so socket.io can attach to the
  // same server/port; then bring realtime up before we start listening.
  const httpServer = createServer(app);
  initRealtime(httpServer);

  const server = httpServer.listen(env.PORT, () => {
    console.log(`Server listening on http://localhost:${env.PORT}`);
  });

  // Sweep uploads the browser started and never came back for. An in-process timer rather than a
  // worker or a queue: one abandoned-upload sweep an hour is not a reason to run more infrastructure,
  // and every row is claimed through a conditional update, so several instances sweeping at once is
  // safe — one simply skips what another took.
  const stopReaper = startUploadReaper();

  const shutdown = async (): Promise<void> => {
    stopReaper();
    await prisma.$disconnect();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
