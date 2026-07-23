import { z } from "zod";

export const registerDeviceSchema = z.object({
  token: z.string().min(1, "A device token is required."),
  platform: z.enum(["android", "ios"]).default("android"),
});
export type RegisterDeviceInput = z.infer<typeof registerDeviceSchema>;

export const unregisterDeviceSchema = z.object({
  token: z.string().min(1, "A device token is required."),
});
export type UnregisterDeviceInput = z.infer<typeof unregisterDeviceSchema>;
