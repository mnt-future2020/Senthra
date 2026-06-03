import { env } from "../config/env.js";
import * as adminRepo from "../repositories/admin.repository.js";
import * as settingsRepo from "../repositories/settings.repository.js";
import { hashPassword } from "../utils/password.js";

// Ensure a Settings singleton and the initial Admin (from env) exist.
// Runs on startup; safe to run repeatedly (only creates when missing).
export async function seedDatabase(): Promise<void> {
  if ((await settingsRepo.count()) === 0) {
    await settingsRepo.create({});
    console.log("Seeded default settings.");
  }

  if ((await adminRepo.count()) === 0) {
    if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) {
      console.warn(
        "No admin exists and ADMIN_EMAIL/ADMIN_PASSWORD are not set — skipping admin seed.",
      );
      return;
    }
    const email = env.ADMIN_EMAIL.toLowerCase();
    const passwordHash = await hashPassword(env.ADMIN_PASSWORD);
    await adminRepo.create({ email, passwordHash, googleEmail: email });
    console.log(`Seeded admin account: ${email}`);
  }
}
