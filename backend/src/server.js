import "dotenv/config";

import { app } from "./app.js";
import { prisma } from "./lib/prisma.js";
import { seedDatabase } from "./lib/seed.js";

const PORT = process.env.PORT || 8000;

async function start() {
  // Ensure the admin + settings exist before accepting requests.
  await seedDatabase();

  const server = app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });

  const shutdown = async () => {
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
