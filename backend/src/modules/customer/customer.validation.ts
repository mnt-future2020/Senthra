import { z } from "zod";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
// UK phone (client is a UK telecom field-services business) — mirrors the user
// validation so both customers and staff share one rule.
const UK_PHONE_RE = /^(?:\+440?|0)\d{9,10}$/;
const isValidPhone = (v: string): boolean => UK_PHONE_RE.test(v.replace(/[\s()-]/g, ""));
const statusEnum = z.enum(["active", "inactive"]);

const emailField = (required = "Email is required.") =>
  z
    .string({ error: required })
    .trim()
    .min(1, required)
    .refine((v) => EMAIL_RE.test(v), "Enter a valid email address.");

const phoneField = z
  .string()
  .trim()
  .max(40)
  .refine((v) => v === "" || isValidPhone(v), "Enter a valid phone number.")
  .optional();

export const createCustomerSchema = z.object({
  name: z
    .string({ error: "Customer name is required." })
    .trim()
    .min(1, "Customer name is required.")
    .max(120),
  email: emailField(),
  contactPerson: z.string().trim().max(120).optional(),
  phone: phoneField,
  status: statusEnum.optional(),
});
export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;

export const updateCustomerSchema = z.object({
  name: z.string().trim().min(1, "Customer name can't be empty.").max(120).optional(),
  email: emailField().optional(),
  contactPerson: z.string().trim().max(120).optional(),
  phone: phoneField,
  status: statusEnum.optional(),
});
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;

// --- nested ---

export const projectSchema = z.object({
  name: z
    .string({ error: "Project name is required." })
    .trim()
    .min(1, "Project name is required.")
    .max(120),
});
export type ProjectInput = z.infer<typeof projectSchema>;

export const catalogueItemSchema = z.object({
  name: z
    .string({ error: "Item name is required." })
    .trim()
    .min(1, "Item name is required.")
    .max(160),
  sku: z.string({ error: "SKU is required." }).trim().min(1, "SKU is required.").max(80),
  category: z
    .string({ error: "Category is required." })
    .trim()
    .min(1, "Category is required.")
    .max(80),
  // Dynamic per-category custom fields (e.g. { Fibre: "Singlemode" }). String
  // values only, keeping the stored JSON simple and customer-safe (no pricing).
  attributes: z.record(z.string(), z.string().max(200)).optional(),
});
export type CatalogueItemInput = z.infer<typeof catalogueItemSchema>;

export const siteSchema = z.object({
  name: z
    .string({ error: "Site name is required." })
    .trim()
    .min(1, "Site name is required.")
    .max(120),
  postcode: z.string().trim().max(20).optional(),
});
export type SiteInput = z.infer<typeof siteSchema>;
