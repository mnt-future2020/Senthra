import bcrypt from "bcryptjs";

import { prisma } from "./prisma.js";

// Ensure a Settings singleton and the initial Admin (from .env) exist.
// Runs on startup; safe to run repeatedly (only creates when missing).
export async function seedDatabase() {
  const settingsCount = await prisma.settings.count();
  if (settingsCount === 0) {
    await prisma.settings.create({ data: {} });
    console.log("Seeded default settings.");
  }

  const adminCount = await prisma.admin.count();
  if (adminCount === 0) {
    const email = process.env.ADMIN_EMAIL;
    const password = process.env.ADMIN_PASSWORD;
    if (!email || !password) {
      console.warn(
        "No admin exists and ADMIN_EMAIL/ADMIN_PASSWORD are not set — skipping admin seed.",
      );
      return;
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const normalized = email.toLowerCase();
    await prisma.admin.create({
      data: { email: normalized, passwordHash, googleEmail: normalized },
    });
    console.log(`Seeded admin account: ${normalized}`);
  }
}
