// Image-upload helpers shared by the user + customer forms (avatar / company logo).

// Max upload size, enforced client-side before the data URI is built.
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2 MB

// Read a File as a base64 data URI (for an instant preview + upload to the backend).
export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Could not read the file."));
    reader.readAsDataURL(file);
  });
}
