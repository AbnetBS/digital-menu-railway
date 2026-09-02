"use client";

/**
 * Browser-side image helpers.
 *
 * The pure URL rules (`optimizeImageUrl`, the placeholder constants) moved to
 * `src/lib/image-url.ts` so the SERVER can build the exact same first-screen
 * photo URLs for its `<link rel="preload">` tags — a `"use client"` module
 * cannot be called from a server component. They are re-exported here, so every
 * existing `from "@/lib/image-utils"` import keeps working untouched.
 */
export {
  FALLBACK_FOOD_IMAGE,
  FALLBACK_DRINK_IMAGE,
  MENU_CARD_IMG_W,
  MENU_CARD_IMG_H,
  FIRST_SCREEN_PHOTOS,
  optimizeImageUrl,
} from "@/lib/image-url";

/**
 * Compresses a photo on the device before upload.
 * A 4MB phone-camera photo becomes ~50-120KB (JPEG) —
 * saving ~95% of database storage while staying perfectly readable.
 */
export function compressImage(
  file: File,
  maxWidth = 900,
  quality = 0.7
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (file.size > 10 * 1024 * 1024) {
      reject(new Error("Image too large (max 10MB)"));
      return;
    }

    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxWidth / img.width);
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);

      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Canvas not supported"));
        return;
      }
      ctx.drawImage(img, 0, 0, w, h);
      const compressed = canvas.toDataURL("image/jpeg", quality);
      resolve(compressed);
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read image"));
    };

    img.src = url;
  });
}
