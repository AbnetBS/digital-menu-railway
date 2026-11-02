'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeftRight,
  Boxes,
  LogOut,
  Palette,
  Plus,
  Sun,
  Trash2,
} from 'lucide-react';
import { BASE_UNIT, UNITS, toBase, type Dimension } from '@/lib/store/units';
import { compressImage } from '@/lib/image-utils';

type StoreTheme = 'brown' | 'white';
const STORE_THEME_KEY = 'fana-store-theme';
const KDS_STATIONS = new Set(['kitchen', 'barista', 'juice', 'buna']);

type Accepter = {
  id: number;
  name: string;
  station: string;
};
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
  who: { id: number; station: string; name: string };
  stations: string[];
  items: Item[];
  history: Event[];
};
type TransferLine = {
  itemId: number;
  amount: string;
  unit: string;
};

function show(amount: string | number, dimension: Dimension) {
  const n = Number(amount);
  return dimension === 'volume' && Math.abs(n) >= 1000
    ? `${Number((n / 1000).toFixed(3))} L`
    : dimension === 'mass' && Math.abs(n) >= 1000
      ? `${Number((n / 1000).toFixed(3))} kg`
      : `${Number(n.toFixed(3))} ${BASE_UNIT[dimension]}`;
}

export default function StationStockPage() {
  const [theme, setTheme] = useState<StoreTheme>('brown');
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORE_THEME_KEY);
      if (saved === 'white' || saved === 'brown') {
        void Promise.resolve().then(() => setTheme(saved));
      }
    } catch {
      /* Keep chosen theme in memory for this visit. */
    }
  }, []);
  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next: StoreTheme = prev === 'brown' ? 'white' : 'brown';
      try {
        window.localStorage.setItem(STORE_THEME_KEY, next);
      } catch {
        /* Keep chosen theme in memory for this visit. */
      }
      return next;
    });
  }, []);

  const isBrown = theme === 'brown';
  const input = isBrown
    ? 'w-full rounded-xl border border-[#C9A227]/35 bg-[#150D0B] px-3 py-2.5 text-sm text-amber-50 placeholder:text-amber-200/40 outline-none focus:border-[#C9A227]'
    : 'w-full rounded-xl border border-stone-300 bg-white px-3 py-2.5 text-sm text-stone-900 outline-none focus:border-amber-500';
  const button = isBrown
    ? 'inline-flex items-center justify-center gap-2 rounded-xl bg-[#C9A227] px-4 py-2.5 text-sm font-bold text-[#2C1B17] hover:bg-[#DFB735] disabled:opacity-50'
    : 'inline-flex items-center justify-center gap-2 rounded-xl bg-amber-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-amber-700 disabled:opacity-50';
  const secondary = isBrown
    ? 'inline-flex items-center justify-center gap-2 rounded-xl border border-[#C9A227]/35 bg-[#2C1B17] px-4 py-2.5 text-sm font-semibold text-amber-100 hover:border-[#C9A227]/70 hover:bg-[#3A241E]'
    : 'inline-flex items-center justify-center gap-2 rounded-xl border border-stone-300 bg-white px-4 py-2.5 text-sm font-semibold text-stone-700 hover:bg-stone-50';
  const card = isBrown
    ? 'rounded-2xl border border-[#C9A227]/25 bg-[#261814] p-5'
    : 'rounded-2xl border border-stone-200 bg-white p-5';
  const muted = isBrown ? 'text-amber-200/70' : 'text-stone-500';
  const accent = isBrown ? 'text-[#E5BE42]' : 'text-amber-700';
  const borderLine = isBrown ? 'border-[#C9A227]/15' : 'border-stone-200';

  const [requestedStation, setRequestedStation] = useState('');
  const [showAllStations, setShowAllStations] = useState(false);
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<Data | null>(null);
  const [accepters, setAccepters] = useState<Accepter[]>([]);
  const [selectedAccepterId, setSelectedAccepterId] = useState('');
  const [pin, setPin] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);

  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'import' | 'new' | 'waste' | 'transfer'>(
    'import',
  );

  // Single-item fields (import / new / waste)
  const [id, setId] = useState(0);
  const [name, setName] = useState('');
  const [dim, setDim] = useState<Dimension>('volume');
  const [amount, setAmount] = useState('');
  const [unit, setUnit] = useState('ml');
  const [reason, setReason] = useState('');
  const [image, setImage] = useState('');
  const [photoBusy, setPhotoBusy] = useState(false);
  const [key, setKey] = useState('');

  // Multi-item Transfer fields ("To -" station + 1 line default + "+ Add another stock")
  const [toStation, setToStation] = useState('');
  const [transferLines, setTransferLines] = useState<TransferLine[]>([
    { itemId: 0, amount: '', unit: '' },
  ]);

  const stationQueryRef = useRef('');

  const load = useCallback(async (stationOverride?: string) => {
    const target =
      stationOverride !== undefined ? stationOverride : stationQueryRef.current;
    try {
      const qs = target ? `?station=${encodeURIComponent(target)}` : '';
      const r = await fetch(`/api/store/station${qs}`, { cache: 'no-store' });
      const d = await r.json();
      if (!r.ok) {
        setData(null);
        if (Array.isArray(d.accepters)) setAccepters(d.accepters);
        if (r.status !== 401) setErr(d.error || 'Could not load station stock');
        return;
      }
      setErr('');
      setData(d);
    } catch {
      setErr('Could not load station stock');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let fromUrl = '';
    try {
      fromUrl =
        new URLSearchParams(window.location.search).get('station')?.trim() ||
        '';
    } catch {
      fromUrl = '';
    }
    stationQueryRef.current = fromUrl;
    setRequestedStation(fromUrl);
    void load(fromUrl);
  }, [load]);

  const signedIn = Boolean(data);
  useEffect(() => {
    if (!signedIn) return;
    const events = new EventSource('/api/realtime?channel=store');
    events.onmessage = () => {
      void load();
    };
    return () => {
      events.close();
    };
  }, [signedIn, load]);

  async function loadAllStationAccepters() {
    setShowAllStations(true);
    stationQueryRef.current = '';
    setSelectedAccepterId('');
    await load('');
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    const chosen = accepters.find((a) => String(a.id) === selectedAccepterId);
    if (!chosen) {
      setErr('Select your Stock Accepter account');
      return;
    }
    setLoginBusy(true);
    try {
      const r = await fetch('/api/staff/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: chosen.name,
          role: 'stock_accepter',
          pin,
          stationStock: true,
          expectedStation:
            !showAllStations && requestedStation ? requestedStation : '',
        }),
      });
      const d = await r.json();
      if (!r.ok) {
        setErr(d.error || 'Invalid name or PIN');
        return;
      }
      setPin('');
      stationQueryRef.current = d.staff?.station || chosen.station;
      await load(stationQueryRef.current);
    } catch {
      setErr('Could not sign in. Check the connection and try again.');
    } finally {
      setLoginBusy(false);
    }
  }

  async function handleSignOut() {
    setErr('');
    setMsg('');
    try {
      await fetch('/api/staff/login?scope=station_stock', { method: 'DELETE' });
    } catch {
      /* Reload below reflects cookie state. */
    }
    setData(null);
    setPin('');
    setSelectedAccepterId('');
    const filter = showAllStations ? '' : requestedStation;
    stationQueryRef.current = filter;
    await load(filter);
  }

  function changeItem(value: number) {
    setId(value);
    const it = data?.items.find((x) => x.id === value);
    if (it) {
      setDim(it.dimension);
      setUnit(BASE_UNIT[it.dimension]);
    }
  }

  function resetKeyBeforeEdit() {
    if (!key) return true;
    if (
      !window.confirm(
        'Check the recent history first. Editing after a failed connection can create a duplicate if the previous send succeeded. Start a new entry?',
      )
    ) {
      return false;
    }
    setKey('');
    return true;
  }

  function changeMode(value: 'import' | 'new' | 'waste' | 'transfer') {
    setMode(value);
    setAmount('');
    setReason('');
    setKey('');
    setErr('');
    setMsg('');
    if (value === 'transfer') {
      const otherStations = data?.stations || [];
      if (!toStation || toStation === data?.who.station) {
        setToStation(otherStations[0] || '');
      }
      if (!transferLines.length) {
        setTransferLines([{ itemId: 0, amount: '', unit: '' }]);
      }
    }
  }

  function updateTransferLine(index: number, patch: Partial<TransferLine>) {
    if (!resetKeyBeforeEdit()) return;
    setTransferLines((prev) =>
      prev.map((line, i) => (i === index ? { ...line, ...patch } : line)),
    );
  }

  function selectTransferItem(index: number, itemId: number) {
    const it = data?.items.find((x) => x.id === itemId);
    updateTransferLine(index, {
      itemId,
      unit: it ? BASE_UNIT[it.dimension] : '',
      amount: '',
    });
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
      const payload =
        mode === 'transfer'
          ? {
              action: 'transfer',
              toStation,
              lines: transferLines,
              key: k,
            }
          : {
              action: mode === 'new' ? 'new_import' : mode,
              itemId: id,
              name,
              dimension: dim,
              amount,
              unit,
              reason,
              image,
              key: k,
            };

      const r = await fetch('/api/store/station', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (!r.ok) {
        if (r.status === 401) {
          setData(null);
          await load();
        }
        setErr(d.error || 'Could not save');
        return;
      }
      setMsg(
        mode === 'transfer'
          ? `Stock transferred to ${toStation}`
          : mode === 'waste'
            ? 'Waste recorded'
            : 'Stock added to your station',
      );
      setKey('');
      setAmount('');
      setReason('');
      setName('');
      setImage('');
      if (mode === 'transfer') {
        setTransferLines([{ itemId: 0, amount: '', unit: '' }]);
      }
      await load();
    } catch {
      setErr('Connection failed. Retry the same form to avoid a duplicate.');
    } finally {
      setBusy(false);
    }
  }

  const themeToggleBtn = (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label="Switch station stock theme"
      className={secondary}
    >
      {isBrown ? <Sun size={15} /> : <Palette size={15} />}
      {isBrown ? 'White theme' : 'Brown & yellow'}
    </button>
  );

  const backHref = data
    ? KDS_STATIONS.has(data.who.station)
      ? `/${data.who.station}`
      : '/store'
    : requestedStation && KDS_STATIONS.has(requestedStation)
      ? `/${requestedStation}`
      : '/store';

  if (loading) {
    return (
      <main
        className={
          isBrown
            ? 'min-h-screen bg-[#1C120F] p-10 text-amber-200/80'
            : 'min-h-screen bg-stone-100 p-10 text-stone-600'
        }
      >
        Opening station stock...
      </main>
    );
  }

  // Stock Accepter Login Page (opened when tapping each station's Import button)
  if (!data) {
    const activeFilter = !showAllStations ? requestedStation : '';
    return (
      <main
        className={
          isBrown
            ? 'flex min-h-screen flex-col items-center justify-center bg-[#1C120F] p-5 text-amber-50'
            : 'flex min-h-screen flex-col items-center justify-center bg-[#f7f6f3] p-5 text-stone-900'
        }
      >
        <div className="mb-4 flex w-full max-w-md items-center justify-between gap-2">
          <Link href={backHref} className={secondary}>
            Back to station
          </Link>
          {themeToggleBtn}
        </div>
        <form
          onSubmit={handleLogin}
          className={
            isBrown
              ? 'w-full max-w-md rounded-3xl border border-[#C9A227]/30 bg-[#261814] p-8 shadow-xl'
              : 'w-full max-w-md rounded-3xl border border-stone-200 bg-white p-8 shadow-xl'
          }
        >
          <div
            className={
              isBrown
                ? 'mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-[#C9A227] text-[#2C1B17]'
                : 'mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-100 text-amber-700'
            }
          >
            <Boxes size={28} />
          </div>
          <p
            className={`text-xs font-bold uppercase tracking-[.18em] ${accent}`}
          >
            Fana · {activeFilter ? `${activeFilter} import` : 'station stock'}
          </p>
          <h1 className="mt-2 text-2xl font-black capitalize">
            {activeFilter
              ? `${activeFilter} Stock Accepter Login`
              : 'Stock Accepter Login'}
          </h1>
          <p className={`mt-2 text-sm ${muted}`}>
            Sign in with the Stock Accepter account created in Store → Stock
            accepters to add imports, record wastage, or transfer stock.
          </p>

          {err && (
            <p
              role="alert"
              className={
                isBrown
                  ? 'mt-4 rounded-xl border border-red-500/40 bg-red-950/60 p-3 text-sm text-red-200'
                  : 'mt-4 rounded-xl bg-red-50 p-3 text-sm text-red-700'
              }
            >
              {err}
            </p>
          )}

          <label className="mt-6 block text-sm font-semibold">
            Stock Accepter account
            <select
              required
              className={input + ' mt-2'}
              value={selectedAccepterId}
              onChange={(e) => setSelectedAccepterId(e.target.value)}
            >
              <option value="">Select your name</option>
              {accepters.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {a.station}
                </option>
              ))}
            </select>
          </label>

          {!accepters.length && (
            <p className={`mt-2 text-xs ${muted}`}>
              No Stock Accepter account found
              {activeFilter ? ` for ${activeFilter}` : ''}. Create one in{' '}
              <Link href="/store" className={`font-bold underline ${accent}`}>
                Store → Stock accepters
              </Link>
              .
            </p>
          )}

          {activeFilter && (
            <button
              type="button"
              onClick={loadAllStationAccepters}
              className={`mt-2 text-xs font-semibold underline ${muted}`}
            >
              Show Stock Accepters from all stations
            </button>
          )}

          <label className="mt-4 block text-sm font-semibold">
            PIN
            <input
              required
              className={input + ' mt-2'}
              type="password"
              inputMode="numeric"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
            />
          </label>

          <button disabled={loginBusy} className={button + ' mt-6 w-full'}>
            {loginBusy ? 'Signing in...' : 'Sign in'}
          </button>
        </form>
      </main>
    );
  }

  const destinationStations = (data.stations || []).length
    ? data.stations
    : ['kitchen', 'barista', 'buna', 'juice', 'cleaning'].filter(
        (s) => s !== data.who.station,
      );

  return (
    <main
      className={
        isBrown
          ? 'min-h-screen bg-[#1C120F] px-4 py-8 text-amber-50'
          : 'min-h-screen bg-stone-100 px-4 py-8 text-stone-900'
      }
    >
      <div className="mx-auto max-w-4xl space-y-5">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p
              className={`text-sm font-bold uppercase tracking-wider ${accent}`}
            >
              Fana · station stock
            </p>
            <h1 className="text-3xl font-black capitalize">
              {data.who.station} stock
            </h1>
            <p className={`text-sm ${muted}`}>
              {data.who.name} · Stock accepter
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {themeToggleBtn}
            <button
              type="button"
              onClick={handleSignOut}
              className={secondary}
            >
              <LogOut size={15} /> Sign out
            </button>
            <Link className={button} href={backHref}>
              Back to station
            </Link>
          </div>
        </header>

        {err && (
          <p
            role="alert"
            className={
              isBrown
                ? 'rounded-xl border border-red-500/40 bg-red-950/60 p-3 text-sm font-semibold text-red-200'
                : 'rounded-xl bg-red-100 p-3 text-sm font-semibold text-red-800'
            }
          >
            {err}
          </p>
        )}
        {msg && (
          <p
            role="status"
            className={
              isBrown
                ? 'rounded-xl border border-emerald-500/35 bg-emerald-950/60 p-3 text-sm font-semibold text-emerald-200'
                : 'rounded-xl bg-green-100 p-3 text-sm font-semibold text-green-800'
            }
          >
            {msg}
          </p>
        )}

        <div className={card}>
          <h2 className="text-xl font-black">New import items</h2>
          <p className={`mt-1 text-sm ${muted}`}>
            {mode === 'transfer'
              ? `Transfer stock from ${data.who.station} to another station.`
              : 'For purchases delivered directly to this station, wastage, or station-to-station transfers.'}
          </p>

          <div className="mt-4 flex flex-wrap gap-2">
            {(
              [
                ['import', 'Add stock'],
                ['new', 'New item'],
                ['waste', 'Record waste'],
                ['transfer', 'Transfer'],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                type="button"
                onClick={() => changeMode(v)}
                className={mode === v ? button : secondary}
              >
                {v === 'transfer' && <ArrowLeftRight size={15} />}
                {label}
              </button>
            ))}
          </div>

          {mode === 'transfer' ? (
            <form onSubmit={save} className="mt-5 space-y-4">
              <div>
                <p className="text-sm font-black">To -</p>
                <p className={`text-xs ${muted}`}>
                  Click the station receiving these items:
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {destinationStations.map((st) => {
                    const selected = toStation === st;
                    return (
                      <button
                        key={st}
                        type="button"
                        onClick={() => {
                          if (!resetKeyBeforeEdit()) return;
                          setToStation(st);
                        }}
                        className={`${selected ? button : secondary} capitalize`}
                      >
                        {st}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-3">
                {transferLines.map((line, index) => {
                  const selectedItem = data.items.find(
                    (x) => x.id === line.itemId,
                  );
                  let overBalance = false;
                  if (selectedItem && line.amount) {
                    try {
                      overBalance =
                        toBase(
                          line.amount,
                          line.unit,
                          selectedItem.dimension,
                        ) > Number(selectedItem.station_balance);
                    } catch {
                      overBalance = false;
                    }
                  }
                  return (
                    <div
                      key={index}
                      className={`grid gap-3 rounded-xl p-3 sm:grid-cols-12 ${
                        isBrown
                          ? 'border border-[#C9A227]/20 bg-[#1B110E]'
                          : 'border border-stone-200 bg-stone-50'
                      }`}
                    >
                      <label className="text-xs font-bold sm:col-span-6">
                        Stock item
                        <select
                          required
                          value={line.itemId || ''}
                          className={input + ' mt-1'}
                          onChange={(e) =>
                            selectTransferItem(index, Number(e.target.value))
                          }
                        >
                          <option value="">Select item</option>
                          {data.items.map((i) => (
                            <option
                              key={i.id}
                              value={i.id}
                              disabled={transferLines.some(
                                (other, idx) =>
                                  idx !== index && other.itemId === i.id,
                              )}
                            >
                              {i.name} · {show(i.station_balance, i.dimension)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="text-xs font-bold sm:col-span-3">
                        Amount
                        <input
                          required
                          type="number"
                          min="0.001"
                          step="any"
                          value={line.amount}
                          onChange={(e) =>
                            updateTransferLine(index, {
                              amount: e.target.value,
                            })
                          }
                          className={input + ' mt-1'}
                        />
                      </label>
                      <label className="text-xs font-bold sm:col-span-2">
                        Unit
                        <select
                          className={input + ' mt-1'}
                          value={line.unit}
                          onChange={(e) =>
                            updateTransferLine(index, { unit: e.target.value })
                          }
                        >
                          {selectedItem &&
                            UNITS[selectedItem.dimension].map((u) => (
                              <option key={u} value={u}>
                                {u}
                              </option>
                            ))}
                        </select>
                      </label>
                      <div className="flex items-end justify-end sm:col-span-1">
                        {transferLines.length > 1 && (
                          <button
                            type="button"
                            aria-label="Remove stock line"
                            onClick={() => {
                              if (!resetKeyBeforeEdit()) return;
                              setTransferLines((prev) =>
                                prev.filter((_, idx) => idx !== index),
                              );
                            }}
                            className={`rounded-xl p-2.5 ${
                              isBrown
                                ? 'text-red-300 hover:bg-red-950/50'
                                : 'text-red-600 hover:bg-red-50'
                            }`}
                          >
                            <Trash2 size={17} />
                          </button>
                        )}
                      </div>
                      {overBalance && selectedItem && (
                        <p
                          className={`text-xs font-bold sm:col-span-12 ${
                            isBrown ? 'text-red-300' : 'text-red-700'
                          }`}
                        >
                          Not enough in {data.who.station} stock. Available:{' '}
                          {show(
                            selectedItem.station_balance,
                            selectedItem.dimension,
                          )}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  className={secondary}
                  onClick={() => {
                    if (!resetKeyBeforeEdit()) return;
                    setTransferLines((prev) => [
                      ...prev,
                      { itemId: 0, amount: '', unit: '' },
                    ]);
                  }}
                >
                  <Plus size={15} /> Add another stock
                </button>

                <button
                  disabled={busy || !toStation || !transferLines.length}
                  className={button}
                >
                  <ArrowLeftRight size={15} />
                  {busy ? 'Transferring...' : 'Transfer'}
                </button>

                {key && (
                  <button
                    type="button"
                    disabled={busy}
                    className={secondary}
                    onClick={() => {
                      if (
                        window.confirm(
                          'Check recent activity first. Starting a new entry can create a duplicate if the previous transfer was saved. Continue?',
                        )
                      ) {
                        setKey('');
                        setTransferLines([
                          { itemId: 0, amount: '', unit: '' },
                        ]);
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
          ) : (
            <form onSubmit={save} className="mt-4 grid gap-3 sm:grid-cols-2">
              {mode === 'new' ? (
                <>
                  <label className="text-sm font-semibold">
                    Name
                    <input
                      required
                      className={input + ' mt-1'}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </label>
                  <label className="text-sm font-semibold">
                    Measurement
                    <select
                      className={input + ' mt-1'}
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
                  <label className="text-sm font-semibold">
                    Photo (optional)
                    <input
                      className={input + ' mt-1'}
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (!f) {
                          setImage('');
                          return;
                        }
                        setPhotoBusy(true);
                        void compressImage(f, 480, 0.68)
                          .then(setImage)
                          .catch(() => setErr('Could not read photo'))
                          .finally(() => setPhotoBusy(false));
                      }}
                    />
                  </label>
                </>
              ) : (
                <label className="text-sm font-semibold">
                  Item
                  <select
                    required
                    value={id || ''}
                    className={input + ' mt-1'}
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
              <label className="text-sm font-semibold">
                Amount
                <input
                  required
                  type="number"
                  min="0"
                  step="any"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className={input + ' mt-1'}
                />
              </label>
              <label className="text-sm font-semibold">
                Unit
                <select
                  className={input + ' mt-1'}
                  value={unit}
                  onChange={(e) => setUnit(e.target.value)}
                >
                  {UNITS[dim].map((u) => (
                    <option key={u}>{u}</option>
                  ))}
                </select>
              </label>
              {mode === 'waste' && (
                <label className="text-sm font-semibold">
                  Reason
                  <input
                    required
                    className={input + ' mt-1'}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </label>
              )}
              <div className="flex flex-wrap items-center gap-3 pt-1 sm:col-span-2">
                <button disabled={busy || photoBusy} className={button}>
                  {photoBusy
                    ? 'Preparing photo...'
                    : busy
                      ? 'Saving...'
                      : mode === 'waste'
                        ? 'Record waste'
                        : 'Add stock'}
                </button>
                {key && (
                  <button
                    type="button"
                    disabled={busy}
                    className={secondary}
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
          )}
        </div>

        <section className={card}>
          <h2 className="text-xl font-black">Expected stock at this station</h2>
          <p className={`text-sm ${muted}`}>
            Includes direct imports, accepted store requests, and transfers in,
            less transfers out, recipe usage, and waste. Check physically.
          </p>
          <div className={`mt-3 divide-y ${isBrown ? 'divide-[#C9A227]/15' : 'divide-stone-200'}`}>
            {data.items
              .filter((i) => Number(i.station_balance) !== 0)
              .map((i) => (
                <div key={i.id} className="flex justify-between gap-3 py-3">
                  <span>{i.name}</span>
                  <b
                    className={
                      Number(i.station_balance) < 0
                        ? isBrown
                          ? 'text-red-400'
                          : 'text-red-600'
                        : ''
                    }
                  >
                    {show(i.station_balance, i.dimension)}
                  </b>
                </div>
              ))}
            {!data.items.some((i) => Number(i.station_balance) !== 0) && (
              <p className={`py-3 text-sm ${muted}`}>Nothing recorded yet.</p>
            )}
          </div>
        </section>

        <section className={card}>
          <h2 className="text-xl font-black">
            Recent imports, transfers and waste
          </h2>
          {data.history.map((h) => {
            const eventLabel =
              h.kind === 'transfer_out'
                ? `Transfer to ${h.reason}`
                : h.kind === 'transfer_in'
                  ? `Transfer from ${h.reason}`
                  : h.kind === 'waste'
                    ? `Waste: ${h.reason}`
                    : 'Direct import';
            return (
              <div
                key={h.id}
                className={`border-b py-3 text-sm ${borderLine}`}
              >
                <b>
                  {h.name} · {show(h.amount, h.dimension)}
                </b>
                <p className={muted}>
                  {eventLabel} · {h.actor} ·{' '}
                  {new Date(h.created_at).toLocaleString('en-GB', {
                    timeZone: 'Africa/Addis_Ababa',
                  })}
                </p>
              </div>
            );
          })}
          {!data.history.length && (
            <p className={`mt-2 text-sm ${muted}`}>No recent activity yet.</p>
          )}
        </section>
      </div>
    </main>
  );
}
