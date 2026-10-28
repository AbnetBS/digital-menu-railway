'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { BASE_UNIT, UNITS, type Dimension } from '@/lib/store/units';
import { compressImage } from '@/lib/image-utils';
type Item = {
  id: number;
  name: string;
  dimension: Dimension;
  station_balance: string;
  image: string;
};
type Event = {
  id: number;
  name: string;
  dimension: Dimension;
  kind: string;
  amount: string;
  reason: string;
  actor: string;
  created_at: string;
};
type Data = {
  who: { station: string; name: string };
  items: Item[];
  history: Event[];
};
const input =
  'w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-stone-900';
const button =
  'rounded-xl bg-amber-600 px-4 py-2 font-bold text-white disabled:opacity-50';
function show(amount: string, dimension: Dimension) {
  const n = Number(amount);
  return dimension === 'volume' && Math.abs(n) >= 1000
    ? `${n / 1000} L`
    : dimension === 'mass' && Math.abs(n) >= 1000
      ? `${n / 1000} kg`
      : `${n} ${BASE_UNIT[dimension]}`;
}
export default function StationStockPage() {
  const [data, setData] = useState<Data | null>(null),
    [err, setErr] = useState(''),
    [msg, setMsg] = useState(''),
    [busy, setBusy] = useState(false),
    [mode, setMode] = useState<'new' | 'import' | 'waste'>('import');
  const [id, setId] = useState(0),
    [name, setName] = useState(''),
    [dim, setDim] = useState<Dimension>('volume'),
    [amount, setAmount] = useState(''),
    [unit, setUnit] = useState('ml'),
    [reason, setReason] = useState(''),
    [image, setImage] = useState(''),
    [key, setKey] = useState('');
  async function load() {
    try {
      const r = await fetch('/api/store/station', { cache: 'no-store' });
      const d = await r.json();
      if (!r.ok) {
        setErr(d.error || 'Please sign in at your station first');
        return;
      }
      setData(d);
    } catch {
      setErr('Could not load station stock');
    }
  }
  useEffect(() => {
    void Promise.resolve().then(load);
  }, []);
  function changeItem(value: number) {
    setId(value);
    const it = data?.items.find((x) => x.id === value);
    if (it) {
      setDim(it.dimension);
      setUnit(BASE_UNIT[it.dimension]);
    }
  }
  function changeMode(value: 'new' | 'import' | 'waste') {
    setMode(value);
    setAmount('');
    setReason('');
    setKey('');
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    setMsg('');
    let k = key;
    if (!k) {
      k = crypto.randomUUID();
      setKey(k);
    }
    try {
      const r = await fetch('/api/store/station', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: mode === 'new' ? 'new_import' : mode,
          itemId: id,
          name,
          dimension: dim,
          amount,
          unit,
          reason,
          image,
          key: k,
        }),
      });
      const d = await r.json();
      if (!r.ok) {
        setErr(d.error || 'Could not save');
        return;
      }
      setMsg(
        mode === 'waste' ? 'Waste recorded' : 'Stock added to your station',
      );
      setKey('');
      setAmount('');
      setReason('');
      setName('');
      setImage('');
      await load();
    } catch {
      setErr('Connection failed. Retry the same form to avoid a duplicate.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="min-h-screen bg-stone-100 px-4 py-8 text-stone-900">
      <div className="mx-auto max-w-4xl space-y-5">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-bold uppercase tracking-wider text-amber-700">
              Fana · station stock
            </p>
            <h1 className="text-3xl font-black capitalize">
              {data?.who.station || 'Station'} stock
            </h1>
            <p className="text-sm text-stone-500">{data?.who.name}</p>
          </div>
          <Link
            className="rounded-xl bg-stone-900 px-4 py-2 font-bold text-white"
            href={data ? `/${data.who.station}` : '/'}
          >
            Back to station
          </Link>
        </header>
        {err && (
          <p role="alert" className="rounded-xl bg-red-100 p-3 text-red-800">
            {err}
          </p>
        )}
        {msg && (
          <p
            role="status"
            className="rounded-xl bg-green-100 p-3 text-green-800"
          >
            {msg}
          </p>
        )}
        {!data ? (
          <p>Sign in to the kitchen, barista or juice dashboard first.</p>
        ) : (
          <>
            <div className="rounded-2xl bg-white p-5">
              <h2 className="text-xl font-black">New import items</h2>
              <p className="mt-1 text-sm text-stone-500">
                For purchases delivered directly to this station. They do not
                reduce the main store balance.
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                {(
                  [
                    ['import', 'Add stock'],
                    ['new', 'New item'],
                    ['waste', 'Record waste'],
                  ] as const
                ).map(([v, label]) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => changeMode(v)}
                    className={
                      mode === v
                        ? button
                        : 'rounded-xl border border-stone-300 px-4 py-2 font-bold'
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
              <form onSubmit={save} className="mt-4 grid gap-3 sm:grid-cols-2">
                {mode === 'new' ? (
                  <>
                    <label>
                      Name
                      <input
                        required
                        className={input}
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                      />
                    </label>
                    <label>
                      Measurement
                      <select
                        className={input}
                        value={dim}
                        onChange={(e) => {
                          const d = e.target.value as Dimension;
                          setDim(d);
                          setUnit(BASE_UNIT[d]);
                        }}
                      >
                        <option value="volume">Liquid</option>
                        <option value="mass">Weight</option>
                        <option value="count">Pieces</option>
                      </select>
                    </label>
                    <label>
                      Photo (optional)
                      <input
                        className={input}
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f)
                            void compressImage(f, 500, 0.7)
                              .then(setImage)
                              .catch(() => setErr('Could not read photo'));
                        }}
                      />
                    </label>
                  </>
                ) : (
                  <label>
                    Item
                    <select
                      required
                      value={id || ''}
                      className={input}
                      onChange={(e) => changeItem(Number(e.target.value))}
                    >
                      <option value="">Select item</option>
                      {data.items.map((i) => (
                        <option key={i.id} value={i.id}>
                          {i.name} · {show(i.station_balance, i.dimension)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label>
                  Amount
                  <input
                    required
                    type="number"
                    min="0"
                    step="any"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className={input}
                  />
                </label>
                <label>
                  Unit
                  <select
                    className={input}
                    value={unit}
                    onChange={(e) => setUnit(e.target.value)}
                  >
                    {UNITS[dim].map((u) => (
                      <option key={u}>{u}</option>
                    ))}
                  </select>
                </label>
                {mode === 'waste' && (
                  <label>
                    Reason
                    <input
                      required
                      className={input}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    />
                  </label>
                )}
                <div className="sm:col-span-2">
                  <button disabled={busy} className={button}>
                    {busy
                      ? 'Saving...'
                      : mode === 'waste'
                        ? 'Record waste'
                        : 'Add stock'}
                  </button>
                  {key && (
                    <button
                      type="button"
                      disabled={busy}
                      className="ml-3 rounded-xl border border-stone-300 px-4 py-2 font-bold"
                      onClick={() => {
                        if (
                          window.confirm(
                            'Check the recent history first. Starting a new entry can create a duplicate if the previous one was saved. Continue?',
                          )
                        ) {
                          setKey('');
                          setAmount('');
                          setReason('');
                          setErr('');
                          void load();
                        }
                      }}
                    >
                      Start a new entry
                    </button>
                  )}
                </div>
              </form>
            </div>
            <section className="rounded-2xl bg-white p-5">
              <h2 className="text-xl font-black">
                Expected stock at this station
              </h2>
              <p className="text-sm text-stone-500">
                Includes direct imports and accepted store requests, less
                recorded recipe usage and waste. Check physically.
              </p>
              <div className="mt-3 divide-y">
                {data.items
                  .filter((i) => Number(i.station_balance) !== 0)
                  .map((i) => (
                    <div key={i.id} className="flex justify-between gap-3 py-3">
                      <span>{i.name}</span>
                      <b
                        className={
                          Number(i.station_balance) < 0 ? 'text-red-600' : ''
                        }
                      >
                        {show(i.station_balance, i.dimension)}
                      </b>
                    </div>
                  ))}
              </div>
            </section>
            <section className="rounded-2xl bg-white p-5">
              <h2 className="text-xl font-black">Recent imports and waste</h2>
              {data.history.map((h) => (
                <div key={h.id} className="border-b py-3 text-sm">
                  <b>
                    {h.name} · {show(h.amount, h.dimension)}
                  </b>
                  <p className="text-stone-500">
                    {h.kind === 'waste'
                      ? `Waste: ${h.reason}`
                      : 'Direct import'}{' '}
                    · {h.actor} ·{' '}
                    {new Date(h.created_at).toLocaleString('en-GB', {
                      timeZone: 'Africa/Addis_Ababa',
                    })}
                  </p>
                </div>
              ))}
            </section>
          </>
        )}
      </div>
    </main>
  );
}
