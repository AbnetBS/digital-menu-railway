/** All inventory values are stored in the smallest supported unit. */
export type Dimension = 'mass' | 'volume' | 'count';
export const UNITS: Record<Dimension, readonly string[]> = {
  mass: ['g', 'kg'],
  volume: ['ml', 'L'],
  count: ['pcs'],
};
export const BASE_UNIT: Record<Dimension, string> = {
  mass: 'g',
  volume: 'ml',
  count: 'pcs',
};
export function isDimension(value: unknown): value is Dimension {
  return value === 'mass' || value === 'volume' || value === 'count';
}
export function toBase(
  value: unknown,
  unit: unknown,
  dimension: Dimension,
  allowZero = false,
): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || (!allowZero && n === 0) || n > 100000000)
    throw new Error('Enter a valid amount');
  if (!UNITS[dimension].includes(String(unit)))
    throw new Error('Unit does not match the item');
  const result = n * (unit === 'kg' || unit === 'L' ? 1000 : 1);
  if (dimension === 'count' && !Number.isInteger(result))
    throw new Error('Counted items must be whole pieces');
  if (
    result > 100000000000 ||
    Math.abs(result * 1000 - Math.round(result * 1000)) > 0.00001
  )
    throw new Error('Amount has too many decimal places');
  return Math.round(result * 1000) / 1000;
}
