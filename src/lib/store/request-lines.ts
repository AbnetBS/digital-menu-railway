import type { PoolClient } from 'pg';
import { toBase, type Dimension } from '@/lib/store/units';

export class StoreUserError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export function requiredId(value: unknown): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new StoreUserError('Invalid ID');
  return n;
}

export function checkedAmount(value: unknown, unit: unknown, dimension: Dimension, allowZero = false): number {
  try {
    return toBase(value, unit, dimension, allowZero);
  } catch (e) {
    throw new StoreUserError(e instanceof Error ? e.message : 'Invalid amount');
  }
}

export type RequestItem = { id: number; name: string; dimension: Dimension; balance: string };
export type RequestLine = { id: number; amount: number };
type RawLine = { itemId?: unknown; amount?: unknown; unit?: unknown };

function readLines(raw: unknown): RawLine[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > 100)
    throw new StoreUserError('Add at least one item (maximum 100)');
  if (raw.some((line) => !line || typeof line !== 'object' || Array.isArray(line)))
    throw new StoreUserError('Invalid request line');
  return raw as RawLine[];
}

/** One catalog query for the whole submission, even across several stations. */
export async function loadRequestItems(client: PoolClient, raw: unknown): Promise<Map<number, RequestItem>> {
  const ids = [...new Set(readLines(raw).map((line) => requiredId(line.itemId)))];
  const result = await client.query(
    'SELECT id,name,dimension,balance FROM store_items WHERE id=ANY($1::int[])',
    [ids],
  );
  return new Map(result.rows.map((row) => [Number(row.id), row as RequestItem]));
}

/** Validate each station separately so an item can go to different stations. */
export function validateRequestLines(raw: unknown, items: Map<number, RequestItem>): RequestLine[] {
  const seen = new Set<number>();
  return readLines(raw).map((line) => {
    const id = requiredId(line.itemId);
    const item = items.get(id);
    if (!item) throw new StoreUserError('Stock item not found', 404);
    if (seen.has(id)) throw new StoreUserError('Each item may appear only once');
    seen.add(id);
    const amount = checkedAmount(line.amount, line.unit, item.dimension);
    if (amount > Number(item.balance))
      throw new StoreUserError(
        `${item.name}: not enough in store. Available: ${item.balance} ${item.dimension === 'mass' ? 'g' : item.dimension === 'volume' ? 'ml' : 'pcs'}`,
        409,
      );
    return { id, amount };
  });
}

/** A single statement instead of one database round-trip per line. */
export async function insertRequestLines(
  client: PoolClient,
  entries: Array<{ requestId: number; id: number; amount: number }>,
): Promise<void> {
  if (!entries.length) return;
  await client.query(
    `INSERT INTO store_request_lines(request_id,item_id,amount)
     SELECT * FROM unnest($1::int[], $2::int[], $3::numeric[])`,
    [entries.map((e) => e.requestId), entries.map((e) => e.id), entries.map((e) => e.amount)],
  );
}
