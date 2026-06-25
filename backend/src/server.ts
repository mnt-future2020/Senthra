import { createServer } from "node:http";

import { env } from "./config/env.js";
import { app } from "./app.js";
import { seedDatabase } from "./db/seed.js";
import { initRealtime } from "./lib/realtime.js";
import { prisma } from "./lib/prisma.js";

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

  const shutdown = async (): Promise<void> => {
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
