"use client";

export const FALLBACK_FOOD_IMAGE = "/images/placeholder-food.svg";
export const FALLBACK_DRINK_IMAGE = "/images/placeholder-drink.svg";

/**
 * Adds `?w=&h=` to an application-served photo (`/api/images/{id}`) so the
 * endpoint downscales it to the size actually being rendered instead of sending
 * the stored ~900px original. A menu-card photo drops from ~150-250KB to
 * ~15-30KB (WebP), which is what lets a whole screen of dishes arrive together
 * on a phone that has never visited before.
 *
 * Only a bare `/api/images/{id}` ref is rewritten: anything that already carries
 * a query string is returned untouched, so calling this twice is safe and no
 * other local asset (`/logo.png`, `/images/placeholder-*.svg`) is affected.
 */
function withDisplaySize(ref: string, maxWidth: number, maxHeight: number): string {
  if (!/^\/api\/images\/\d+\/?$/.test(ref)) return ref;
  const width = Math.max(1, Math.round(maxWidth));
  const height = Math.max(1, Math.round(maxHeight));
  return `${ref.replace(/\/$/, "")}?w=${width}&h=${height}`;
}

/**
 * Optimizes image URLs for the size they are rendered at:
 *   - `/api/images/{id}` → same URL + `?w=&h=` (server-side downscale, see above)
 *   - Pexels hotlinks    → strict crop, dimensions and compression parameters
 *   - local static files (`/images/...`, `/logo.png`) and inline `data:` URLs
 *     are returned as-is.
 */
export function optimizeImageUrl(
  url: string | null | undefined,
  maxWidth = 480,
  maxHeight = 320
): string {
  if (!url || typeof url !== "string") return FALLBACK_FOOD_IMAGE;
  const trimmed = url.trim();
  if (!trimmed) return FALLBACK_FOOD_IMAGE;

  // Inline data URLs are already the final bytes — never touch them.
  if (trimmed.startsWith("data:")) {
    return trimmed;
  }

  // Application photos: ask the endpoint for the rendered size.
  if (trimmed.startsWith("/api/images/")) {
    return withDisplaySize(trimmed, maxWidth, maxHeight);
  }

  // Any other local static file stays untouched.
  if (trimmed.startsWith("/")) {
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
