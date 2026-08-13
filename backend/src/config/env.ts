import "dotenv/config";
import { z } from "zod";

// Single source of truth for environment configuration. Every other module
// reads typed values from here instead of touching process.env directly, so
// misconfiguration fails fast at startup with a clear message.
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8000),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  // Auth — two SEPARATE secrets for access + refresh tokens.
  JWT_SECRET: z.string().min(1, "JWT_SECRET is required"),
  REFRESH_SECRET: z.string().min(1, "REFRESH_SECRET is required"),
  ACCESS_TOKEN_EXPIRY: z.string().default("15m"),
  REFRESH_TOKEN_EXPIRY: z.string().default("7d"),

  // AES-256-GCM key for secrets at rest — must be 32 bytes / 64 hex chars.
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "ENCRYPTION_KEY must be 64 hex characters (32 bytes)"),

  // CORS origin + optional cross-subdomain cookie domain.
  FRONTEND_URL: z.url().default("http://localhost:3000"),
  COOKIE_DOMAIN: z.string().optional(),

  // Cloudinary (image CDN) for branding logo/favicon uploads. Optional — image
  // upload is disabled until all three are set; the rest of branding still works.
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),

  // Signed upload presets, one per Cloudinary resource type. They carry the account-side
  // `allowed_formats` allowlist, which is the ONLY part of a direct upload Cloudinary can refuse at its
  // own edge — a disallowed extension fails with 400 before a byte of ours is spent. Everything else
  // (size, real content, who may attach where) is still decided by finalize, which is authoritative.
  //
  // Defaulted rather than optional on purpose. A missing variable would silently drop the edge check
  // and nothing would look wrong; a preset that does not exist in the account fails every upload
  // loudly, which is the right direction for a validation gate to break in. Set either to "" to sign
  // without a preset, which is the pre-preset behaviour.
  CLOUDINARY_UPLOAD_PRESET_IMAGE: z.string().default("senthra_image"),
  CLOUDINARY_UPLOAD_PRESET_RAW: z.string().default("senthra_raw"),

  // Firebase Cloud Messaging service-account (push notifications to the engineer
  // app). Optional — push is disabled until all three are set. The private key is
  // stored with literal \n escapes; the FCM lib un-escapes them at init.
  FIREBASE_PROJECT_ID: z.string().optional(),
  FIREBASE_CLIENT_EMAIL: z.string().optional(),
  FIREBASE_PRIVATE_KEY: z.string().optional(),

  // Initial admin seeded on first startup (optional — seed is skipped if unset).
  ADMIN_EMAIL: z.email().optional(),
  ADMIN_PASSWORD: z.string().min(1).optional(),

  // Feature flag: live customer stock dashboard (Flow 9). OFF until the
  // Stock/Inventory/Movement modules exist — while off, the customer portal shows
  // an honest "no stock data yet" state. Flip to "true" (with the inventory
  // read-model wired into customer.stock.service) to light up live data.
  FEATURE_CUSTOMER_STOCK: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
  console.error(`Invalid environment configuration:\n${details}`);
  process.exit(1);
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === "production";
