import { v2 as cloudinary } from "cloudinary";

export interface CloudinaryCreds {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}

// Upload an image (data URI or URL) to Cloudinary and return its secure URL.
// Credentials are passed in (resolved from DB settings or env by the caller),
// so this stays a pure transport with no config source of its own.
// `publicId` is stable per asset (e.g. "logo" / "favicon") so re-uploads
// overwrite; `folder` groups assets (branding vs user avatars).
export async function uploadToCloudinary(
  source: string,
  publicId: string,
  creds: CloudinaryCreds,
  folder = "senthra/branding",
): Promise<string> {
  cloudinary.config({
    cloud_name: creds.cloudName,
    api_key: creds.apiKey,
    api_secret: creds.apiSecret,
    secure: true,
  });
  const result = await cloudinary.uploader.upload(source, {
    folder,
    public_id: publicId,
    overwrite: true,
    invalidate: true,
    resource_type: "image",
  });
  return result.secure_url;
}
