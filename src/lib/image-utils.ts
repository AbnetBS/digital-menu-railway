"use client";

export const FALLBACK_FOOD_IMAGE = "/images/placeholder-food.svg";
export const FALLBACK_DRINK_IMAGE = "/images/placeholder-drink.svg";

/**
 * Optimizes remote image URLs (specifically Pexels hotlinks) by applying
 * strict crop, dimensions, and compression query parameters.
 * Application-controlled image references (/api/images/{id}, local /images/..., data:)
 * are returned as-is.
 */
export function optimizeImageUrl(
  url: string | null | undefined,
  maxWidth = 480,
  maxHeight = 320
): string {
  if (!url || typeof url !== "string") return FALLBACK_FOOD_IMAGE;
  const trimmed = url.trim();
  if (!trimmed) return FALLBACK_FOOD_IMAGE;

  // Local /api/images/{id} or local static files / data URLs stay untouched
  if (trimmed.startsWith("/") || trimmed.startsWith("data:")) {
    return trimmed;
  }

  // Dynamic Pexels CDN optimization
  if (trimmed.includes("images.pexels.com")) {
    try {
      const parsed = new URL(trimmed);
      parsed.searchParams.set("auto", "compress");
      parsed.searchParams.set("cs", "tinysrgb");
      parsed.searchParams.set("fit", "crop");
      parsed.searchParams.set("w", String(maxWidth));
      parsed.searchParams.set("h", String(maxHeight));
      return parsed.toString();
    } catch {
      return trimmed;
    }
  }

  return trimmed;
}

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
