/**
 * What the waiter's phone says when kitchen/barista tap Done.
 * "Table 5 is ready". Outdoor names skip a second "Table":
 * "Outdoor, White car is ready".
 */
export function readyPhrase(tableName: string): string {
  const cleaned = String(tableName || "the table")
    .replace(/[•·]/g, ",")
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
  const spoken = cleaned.replace(/^OUTDOOR\b/i, "Outdoor");
  if (/^(table|outdoor)\b/i.test(spoken)) return `${spoken} is ready`;
  return `Table ${spoken} is ready`;
}
