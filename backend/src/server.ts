import { env } from "./config/env.js";
import { app } from "./app.js";
import { seedDatabase } from "./db/seed.js";
import { prisma } from "./lib/prisma.js";

async function start(): Promise<void> {
  // Ensure the admin + settings exist before accepting requests.
  await seedDatabase();

  const server = app.listen(env.PORT, () => {
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
