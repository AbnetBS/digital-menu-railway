'use client';
/* eslint-disable @next/next/no-img-element -- User-uploaded data URLs. */

import { useState } from 'react';
import { Boxes, Pencil, Search, Trash2 } from 'lucide-react';
import { BASE_UNIT, UNITS, toBase, type Dimension } from '@/lib/store/units';

type Item = {
  id: number;
  name: string;
  dimension: Dimension;
  balance: string;
  image: string;
};
type Line = { itemId: number; amount: string; unit: string; station: string };
const fields =
  'w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-stone-900';
const button =
  'rounded-xl bg-amber-600 px-4 py-3 font-bold text-white disabled:opacity-50';
const stations = ['kitchen', 'barista', 'juice', 'buna'];
function available(i: Item) {
  const n = Number(i.balance);
  return i.dimension === 'mass' && n >= 1000
    ? `${n / 1000} kg`
    : i.dimension === 'volume' && n >= 1000
      ? `${n / 1000} L`
      : `${n} ${BASE_UNIT[i.dimension]}`;
}
export default function StoreRequestBuilder({
  items,
  busy,
  onSend,
  serverError,
}: {
  items: Item[];
  busy: boolean;
  serverError: string;
  onSend: (lines: Line[], key: string) => Promise<boolean>;
}) {
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<Line[]>([]);
  const [editing, setEditing] = useState<Line | null>(null);
  const [editIndex, setEditIndex] = useState(-1);
  const [review, setReview] = useState(false);
  const [error, setError] = useState('');
  const [key, setKey] = useState('');
  const selected = items.find((i) => i.id === editing?.itemId);
  function startNew(item: Item) {
    setEditIndex(-1);
    setEditing({
      itemId: item.id,
      amount: '',
      unit: BASE_UNIT[item.dimension],
      station: 'kitchen',
    });
    setError('');
  }
  function editLine(index: number) {
    setEditIndex(index);
    setEditing({ ...draft[index] });
    setReview(false);
    setError('');
  }
  function resetKeyBeforeChange() {
    if (!key) return true;
    if (
      !window.confirm(
        'A previous send may have succeeded. Check My requests before changing this draft to avoid a duplicate. Start a new send?',
      )
    )
      return false;
    setKey('');
    return true;
  }
  function save(e: React.FormEvent) {
    e.preventDefault();
    if (!editing || !selected) return;
    try {
      const requested = toBase(
        editing.amount,
        editing.unit,
        selected.dimension,
      );
      const others = draft.filter(
        (_, idx) => idx !== editIndex && _.itemId === editing.itemId,
      );
      const total = others.reduce(
        (sum, l) => sum + toBase(l.amount, l.unit, selected.dimension),
        requested,
      );
      if (total > Number(selected.balance) + 0.0000001)
        throw new Error(
          `Not enough ${selected.name} in store for all selected stations.`,
        );
      if (others.some((l) => l.station === editing.station))
        throw new Error(
          'This item is already selected for that station. Edit the existing line instead.',
        );
      if (!resetKeyBeforeChange()) return;
      setDraft((old) =>
        editIndex < 0
          ? [...old, editing]
          : old.map((l, i) => (i === editIndex ? editing : l)),
      );
      setEditing(null);
      if (editIndex >= 0) setReview(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Check the amount');
    }
  }
  return (
    <section>
      <h2 className="text-2xl font-black">Store stock</h2>
      <p className="mt-1 text-sm text-stone-500">
        Tap an item to choose an amount, unit and destination.
      </p>
      <div className="relative my-4">
        <Search className="absolute left-3 top-3 text-stone-400" size={18} />
        <input
          className={fields + ' pl-10'}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search stock items"
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {items
          .filter((i) => i.name.toLowerCase().includes(search.toLowerCase()))
          .map((i) => (
            <button
              type="button"
              key={i.id}
              onClick={() => startNew(i)}
              className="overflow-hidden rounded-2xl border border-stone-200 bg-white text-left hover:border-amber-500 focus:outline-2 focus:outline-amber-600"
            >
              <div className="flex h-36 items-center justify-center bg-stone-100">
                {i.image ? (
                  <img
                    src={i.image}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <Boxes size={44} className="text-stone-300" />
                )}
              </div>
              <div className="p-4">
                <h3 className="font-black">{i.name}</h3>
                <p className="mt-1 text-sm text-stone-500">
                  Available: {available(i)}
                </p>
                <p className="mt-2 text-xs font-bold text-amber-700">
                  + Add to request
                </p>
              </div>
            </button>
          ))}
      </div>
      {!items.length && (
        <p className="rounded-xl bg-white p-6 text-stone-500">
          No store items yet. Ask the manager to add stock.
        </p>
      )}
      {draft.length > 0 && (
        <div className="sticky bottom-3 mt-5 rounded-2xl bg-white p-3 shadow-lg">
          <button
            type="button"
            className={button + ' w-full'}
            onClick={() => setReview(true)}
          >
            Review and send · {draft.length} item{draft.length === 1 ? '' : 's'}
          </button>
        </div>
      )}
      {editing && selected && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={`Request ${selected.name}`}
        >
          <form
            onSubmit={save}
            className="w-full max-w-md space-y-4 rounded-2xl bg-white p-6 shadow-xl"
          >
            <h3 className="text-xl font-black">{selected.name}</h3>
            <p className="text-sm text-stone-500">
              Available in store: {available(selected)}
            </p>
            <label className="block text-sm font-bold">
              Amount
              <input
                className={fields + ' mt-1'}
                required
                type="number"
                min="0.001"
                step="any"
                value={editing.amount}
                onChange={(e) =>
                  setEditing({ ...editing, amount: e.target.value })
                }
              />
            </label>
            <label className="block text-sm font-bold">
              Unit
              <select
                className={fields + ' mt-1'}
                value={editing.unit}
                onChange={(e) =>
                  setEditing({ ...editing, unit: e.target.value })
                }
              >
                {UNITS[selected.dimension].map((u) => (
                  <option key={u}>{u}</option>
                ))}
              </select>
            </label>
            <label className="block text-sm font-bold">
              Destination
              <select
                className={fields + ' mt-1 capitalize'}
                value={editing.station}
                onChange={(e) =>
                  setEditing({ ...editing, station: e.target.value })
                }
              >
                {stations.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            {error && (
              <p role="alert" className="text-sm text-red-700">
                {error}
              </p>
            )}
            <div className="flex gap-2">
              <button className={button}>Done</button>
              <button
                type="button"
                className="rounded-xl border px-4 py-3"
                onClick={() => {
                  setEditing(null);
                  if (editIndex >= 0) setReview(true);
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}
      {review && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Review request"
        >
          <div className="max-h-[85vh] w-full max-w-lg overflow-auto rounded-2xl bg-white p-6 shadow-xl">
            <h3 className="text-xl font-black">Review and send</h3>
            <p className="mt-1 text-sm text-stone-500">
              Check each amount and destination. Different destinations are sent
              as separate station requests.
            </p>
            <div className="my-4 space-y-2">
              {draft.map((l, index) => {
                const item = items.find((i) => i.id === l.itemId);
                return (
                  <div
                    key={`${l.itemId}-${l.station}-${index}`}
                    className="flex items-center gap-2 rounded-xl bg-stone-50 p-3"
                  >
                    <div className="flex-1">
                      <b>{item?.name || 'Item unavailable'}</b>
                      <p className="text-sm capitalize">
                        {l.amount} {l.unit} · {l.station}
                      </p>
                    </div>
                    <button
                      type="button"
                      aria-label={`Edit ${item?.name || 'item'}`}
                      className="rounded-lg border bg-white p-2"
                      onClick={() => editLine(index)}
                    >
                      <Pencil size={18} />
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove ${item?.name || 'item'}`}
                      className="rounded-lg border bg-white p-2"
                      onClick={() => {
                        if (resetKeyBeforeChange())
                          setDraft((old) => old.filter((_, i) => i !== index));
                      }}
                    >
                      <Trash2 size={18} />
                    </button>
                  </div>
                );
              })}
            </div>
            {serverError && (
              <p
                role="alert"
                className="mb-3 rounded-xl bg-red-50 p-3 text-sm text-red-800"
              >
                {serverError}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy || !draft.length}
                className={button}
                onClick={async () => {
                  const current = key || crypto.randomUUID();
                  if (!key) setKey(current);
                  if (await onSend(draft, current)) {
                    setDraft([]);
                    setKey('');
                    setReview(false);
                  }
                }}
              >
                {busy ? 'Sending…' : 'Send request'}
              </button>
              <button
                type="button"
                className="rounded-xl border px-4 py-3"
                onClick={() => setReview(false)}
              >
                Add more items
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
