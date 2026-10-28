/** Parse an Authorization bearer header without accepting an unprefixed secret. */
export function bearerToken(header: string | null): string | null {
  const match = header?.match(/^Bearer\s+(\S+)\s*$/i);
  return match?.[1] || null;
}
