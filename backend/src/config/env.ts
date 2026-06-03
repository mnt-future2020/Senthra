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

  // Initial admin seeded on first startup (optional — seed is skipped if unset).
  ADMIN_EMAIL: z.email().optional(),
  ADMIN_PASSWORD: z.string().min(1).optional(),
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
