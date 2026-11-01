'use client';

/* eslint-disable @next/next/no-img-element -- Store uploads are data URLs and menu images use existing external sources. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  Boxes,
  ClipboardList,
  CookingPot,
  History,
  LogOut,
  PackageCheck,
  Palette,
  Plus,
  Search,
  Sun,
  Trash2,
  Users,
} from 'lucide-react';
import { BASE_UNIT, UNITS, toBase, type Dimension } from '@/lib/store/units';
import { compressImage } from '@/lib/image-utils';
import { optimizeImageUrl } from '@/lib/image-url';
import StoreExamples from '@/components/rms/StoreExamples';
import StoreRequestBuilder from '@/components/rms/StoreRequestBuilder';
import { onPushAlert } from '@/lib/push-client';
import {
  enableStoreAlerts,
  disableStoreAlerts,
  storeAlertsEnabledLocally,
} from '@/lib/store/alerts-client';
import {
  armAudioOnFirstGesture,
  setStationBell,
  unlockAudio,
  playAlarm,
} from '@/lib/sound';

export type StoreTheme = 'brown' | 'white';
const STORE_THEME_KEY = 'fana-store-theme';

type Item = {
  id: number;
  name: string;
  dimension: Dimension;
  balance: string;
  low_at: string;
  image: string;
};
type Row = {
  item_id: number;
  name: string;
  dimension: Dimension;
  amount: string;
};
type RequestRow = {
  id: number;
  station: string;
  requester_name: string;
  status: string;
  created_at: string;
  accepted_at: string | null;
  accepted_by: string | null;
  lines: Row[];
};
type Balance = {
  station: string;
  item_id: number;
  name: string;
  dimension: Dimension;
  balance: string;
};
type Menu = { id: number; name: string; category: string; image_url: string };
type Recipe = { menu_item_id: number; item_id: number; amount: string };
type Movement = {
  item_id: number;
  name: string;
  dimension: Dimension;
  station: string;
  kind: string;
  amount: string;
};
type Waste = {
  id: number;
  name: string;
  station: string;
  amount: string;
  dimension: Dimension;
  reason: string;
  actor: string;
  created_at: string;
};
type Done = {
  item_name: string;
  category: string;
  station: string;
  quantity: number;
  missing_recipe: boolean;
};
type Account = { id: number; name: string; role: string; station: string };
type Breakage = {
  id: number;
  member_id: number;
  member_name: string | null;
  item_type: string;
  amount: string;
  period_key: string;
  recorded_by: string;
  created_at: string;
  voided_at: string | null;
  voided_by: string | null;
};
type Member = { id: number; name: string; active: boolean };
type Data = {
  who: {
    name: string;
    role: string;
    station: string;
    manager: boolean;
    admin: boolean;
  };
  items: Item[];
  requests: RequestRow[];
  balances?: Balance[];
  menu?: Menu[];
  recipes?: Recipe[];
  accounts?: Account[];
  members?: Member[];
  breakages?: Breakage[];
  movements?: Movement[];
  done?: Done[];
};
type Line = { itemId: number; amount: string; unit: string };
const stations = ['kitchen', 'barista', 'buna', 'juice', 'cleaning'];
const tabs = [
  { id: 'stock', label: 'Store stock', icon: Boxes },
  { id: 'requests', label: 'Requests', icon: ClipboardList },
  { id: 'history', label: 'History', icon: History },
  { id: 'recipes', label: 'Ingredients', icon: CookingPot },
  { id: 'stations', label: 'Station stock', icon: PackageCheck },
  { id: 'reports', label: 'Reports', icon: BarChart3 },
  { id: 'breakage', label: 'Breakage & shortage', icon: AlertTriangle },
  { id: 'accounts', label: 'Stock accepters', icon: Users },
];

const base = (d: Dimension) => BASE_UNIT[d];
function display(n: string | number, dim: Dimension) {
  const x = Number(n);
  if (dim === 'volume' && Math.abs(x) >= 1000)
    return `${Number((x / 1000).toFixed(3))} L`;
  if (dim === 'mass' && Math.abs(x) >= 1000)
    return `${Number((x / 1000).toFixed(3))} kg`;
  return `${Number(x.toFixed(3))} ${base(dim)}`;
}
function day(value: string) {
  return new Date(value).toLocaleString('en-GB', {
    timeZone: 'Africa/Addis_Ababa',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function StorePage() {
  const [theme, setTheme] = useState<StoreTheme>('brown');
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORE_THEME_KEY);
      if (saved === 'white' || saved === 'brown') {
        void Promise.resolve().then(() => setTheme(saved));
      }
    } catch {
      /* Theme still switches for this visit when storage is restricted. */
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
  const clsInput = isBrown
    ? 'w-full rounded-xl border border-[#C9A227]/35 bg-[#150D0B] px-3 py-2.5 text-sm text-amber-50 placeholder:text-amber-200/40 outline-none focus:border-[#C9A227]'
    : 'w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 outline-none focus:border-amber-500';
  const btn = isBrown
    ? 'inline-flex items-center justify-center gap-2 rounded-xl bg-[#C9A227] px-4 py-2.5 text-sm font-bold text-[#2C1B17] hover:bg-[#DFB735] disabled:opacity-50'
    : 'inline-flex items-center justify-center gap-2 rounded-xl bg-amber-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-amber-700 disabled:opacity-50';
  const secondary = isBrown
    ? 'inline-flex items-center justify-center gap-2 rounded-xl border border-[#C9A227]/35 bg-[#2C1B17] px-4 py-2.5 text-sm font-semibold text-amber-100 hover:border-[#C9A227]/70 hover:bg-[#3A241E]'
    : 'inline-flex items-center justify-center gap-2 rounded-xl border border-stone-200 bg-white px-4 py-2.5 text-sm font-semibold text-stone-700 hover:bg-stone-50';
  const card = isBrown
    ? 'border border-[#C9A227]/25 bg-[#261814]'
    : 'border border-stone-200 bg-white';
  const subRow = isBrown
    ? 'border border-[#C9A227]/15 bg-[#1B110E]'
    : 'bg-stone-50';
  const muted = isBrown ? 'text-amber-200/70' : 'text-stone-500';
  const subtle = isBrown ? 'text-amber-200/50' : 'text-stone-400';
  const accent = isBrown ? 'text-[#E5BE42]' : 'text-amber-700';
  const divideLine = isBrown ? 'divide-[#C9A227]/15' : 'divide-stone-100';
  const borderLine = isBrown ? 'border-[#C9A227]/15' : 'border-stone-100';

  const [data, setData] = useState<Data | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [names, setNames] = useState<Account[]>([]),
    [loginName, setLoginName] = useState(''),
    [pin, setPin] = useState('');
  const refreshNames = useCallback(async () => {
    try {
      const r = await fetch('/api/staff?public=1');
      const v = await r.json();
      if (Array.isArray(v))
        setNames(
          v.filter(
            (a: Account) =>
              a.role === 'stock_accepter' || a.role === 'store_manager',
          ),
        );
    } catch {
      /* login will remain available on retry */
    }
  }, []);
  const [tab, setTab] = useState('stock'),
    [search, setSearch] = useState(''),
    [busy, setBusy] = useState(false);
  const [examplesHidden, setExamplesHidden] = useState(false);
  useEffect(() => {
    try {
      if (window.localStorage.getItem('fana-store-hide-examples') === '1') {
        void Promise.resolve().then(() => setExamplesHidden(true));
      }
    } catch {
      /* Examples can still be dismissed for this visit. */
    }
  }, []);
  const [newOpen, setNewOpen] = useState(false),
    [name, setName] = useState(''),
    [dimension, setDimension] = useState<Dimension>('volume'),
    [amount, setAmount] = useState(''),
    [unit, setUnit] = useState('L'),
    [low, setLow] = useState(''),
    [lowUnit, setLowUnit] = useState('L'),
    [image, setImage] = useState(''),
    [photoBusy, setPhotoBusy] = useState(false);
  const [addItem, setAddItem] = useState<Item | null>(null),
    [addAmount, setAddAmount] = useState(''),
    [addUnit, setAddUnit] = useState('');
  const [breakMember, setBreakMember] = useState(0),
    [breakItem, setBreakItem] = useState(''),
    [breakPrice, setBreakPrice] = useState(''),
    [breakKey, setBreakKey] = useState('');
  const [stationFilter, setStationFilter] = useState('all');
  const [requestStation, setRequestStation] = useState('kitchen');
  const [draft, setDraft] = useState<Line[]>([]),
    [editId, setEditId] = useState<number | null>(null);
  const [menuId, setMenuId] = useState<number | null>(null),
    [recipeDraft, setRecipeDraft] = useState<Line[]>([]),
    [ingredientSearch, setIngredientSearch] = useState('');
  const [accName, setAccName] = useState(''),
    [accPin, setAccPin] = useState(''),
    [accRole, setAccRole] = useState('stock_accepter'),
    [accStation, setAccStation] = useState('kitchen');
  const [wasteItem, setWasteItem] = useState<number>(0),
    [wasteStation, setWasteStation] = useState('kitchen'),
    [wasteAmount, setWasteAmount] = useState(''),
    [wasteUnit, setWasteUnit] = useState(''),
    [reason, setReason] = useState('');
  const [period, setPeriod] = useState('today'),
    [chosenDate, setChosenDate] = useState('');
  const [report, setReport] = useState<{
      done: Done[];
      movements: Movement[];
      waste: Waste[];
    } | null>(null),
    [reportError, setReportError] = useState('');
  const pendingSeen = useRef<Set<number> | null>(null);
  const loadInFlight = useRef<Promise<void> | null>(null);
  const loadEpoch = useRef(0);
  const loadController = useRef<AbortController | null>(null);
  const lastLoadedAt = useRef(0);
  const signingOut = useRef(false);
  const refreshAgain = useRef(false);
  const sendInFlight = useRef(false);
  const load = useCallback(async (silent = false) => {
    if (signingOut.current) return;
    if (!silent) setError('');
    // SSE, push, a save and a visibility change can arrive together. Do not
    // run multiple expensive snapshots at once. If an event arrived during a
    // read, take one more snapshot afterwards so a committed change is not lost.
    if (loadInFlight.current) {
      refreshAgain.current = true;
      return loadInFlight.current;
    }
    const work = (async () => {
      do {
        refreshAgain.current = false;
        const epoch = loadEpoch.current;
        const controller = new AbortController();
        loadController.current = controller;
        try {
          const res = await fetch('/api/store', {
            cache: 'no-store',
            signal: controller.signal,
          });
          const payload = await res.json();
          // A response started before sign-out must not restore the old session.
          if (epoch !== loadEpoch.current) continue;
          if (res.ok) {
            lastLoadedAt.current = Date.now();
            if (payload.who?.manager && Array.isArray(payload.requests)) {
              const current = new Set<number>(
                payload.requests
                  .filter((r: RequestRow) => r.status === 'pending')
                  .map((r: RequestRow) => Number(r.id)),
              );
              if (
                pendingSeen.current &&
                [...current].some((id) => !pendingSeen.current!.has(id))
              )
                playAlarm();
              pendingSeen.current = current;
            } else pendingSeen.current = null;
            setData(payload);
          } else if (res.status === 401) {
            pendingSeen.current = null;
            setData(null);
            setError(
              payload.error || 'Your session ended. Please sign in again.',
            );
          } else setError(payload.error || 'Could not load store');
        } catch {
          if (epoch === loadEpoch.current)
            setError('Could not connect to the store');
        } finally {
          if (loadController.current === controller)
            loadController.current = null;
          if (epoch === loadEpoch.current) setLoading(false);
        }
      } while (refreshAgain.current && !signingOut.current);
    })();
    loadInFlight.current = work;
    try {
      await work;
    } finally {
      loadInFlight.current = null;
    }
  }, []);
  useEffect(() => {
    void Promise.resolve().then(() => load());
    void Promise.resolve().then(() => refreshNames());
  }, [load, refreshNames]);
  const signedIn = Boolean(data);
  const isManager = Boolean(data?.who.manager);
  useEffect(() => {
    if (!isManager || !signedIn || !storeAlertsEnabledLocally()) return;
    const heal = () => {
      void enableStoreAlerts(false);
    };
    heal();
    const interval = window.setInterval(heal, 5 * 60 * 1000);
    const visible = () => {
      if (!document.hidden) heal();
    };
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('online', heal);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('online', heal);
    };
  }, [isManager, signedIn]);
  useEffect(
    () =>
      onPushAlert((msg) => {
        if (signedIn && msg.tag === 'fana-store-request') void load(true);
      }),
    [signedIn, load],
  );
  useEffect(() => {
    setStationBell('kitchen');
    armAudioOnFirstGesture();
  }, []);
  useEffect(() => {
    if (!signedIn) return;
    // Live events are the normal path. Poll every 10 s only when disconnected;
    // a 60 s visible-page safety refresh also covers missed events or replicas.
    // Background tabs keep receiving events/alerts but do not poll needlessly.
    let connected = false;
    let hadDisconnect = false;
    let lastRefresh = lastLoadedAt.current || Date.now();
    const refresh = () => {
      lastRefresh = Date.now();
      void load(true);
    };
    const events = new EventSource('/api/realtime?channel=store');
    events.onopen = () => {
      connected = true;
      // Only re-fetch on open if we are recovering from a drop or the initial
      // snapshot is older than 3 s, avoiding a duplicate fetch on page open.
      if (hadDisconnect || Date.now() - lastLoadedAt.current > 3000) {
        hadDisconnect = false;
        refresh();
      }
    };
    events.onmessage = refresh;
    events.onerror = () => {
      if (connected) {
        connected = false;
        hadDisconnect = true;
        refresh();
      }
    };
    const timer = window.setInterval(() => {
      if (!document.hidden && (!connected || Date.now() - lastRefresh >= 60000))
        refresh();
    }, 10000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      events.close();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [signedIn, load]);

  const applyOptimisticCommit = useCallback(
    (action: string, payload: Record<string, unknown>) => {
      setData((prev) => {
        if (!prev) return prev;
        try {
          if (action === 'add_stock') {
            const id = Number(payload.itemId);
            const target = prev.items.find((i) => i.id === id);
            if (!target) return prev;
            const delta = toBase(
              payload.amount,
              payload.unit,
              target.dimension,
            );
            return {
              ...prev,
              items: prev.items.map((i) =>
                i.id === id
                  ? { ...i, balance: String(Number(i.balance) + delta) }
                  : i,
              ),
            };
          }
          if (action === 'threshold') {
            const id = Number(payload.itemId);
            const target = prev.items.find((i) => i.id === id);
            if (!target) return prev;
            const nextLow = toBase(
              payload.amount,
              payload.unit,
              target.dimension,
            );
            return {
              ...prev,
              items: prev.items.map((i) =>
                i.id === id ? { ...i, low_at: String(nextLow) } : i,
              ),
            };
          }
          if (action === 'accept') {
            const reqId = Number(payload.requestId);
            const req = prev.requests.find((r) => r.id === reqId);
            if (!req || req.status !== 'pending') return prev;
            const lineDelta = new Map<number, Row>();
            for (const l of req.lines) lineDelta.set(l.item_id, l);
            const nextBalances = [...(prev.balances || [])];
            for (const l of req.lines) {
              const idx = nextBalances.findIndex(
                (b) => b.station === req.station && b.item_id === l.item_id,
              );
              if (idx >= 0) {
                nextBalances[idx] = {
                  ...nextBalances[idx],
                  balance: String(
                    Number(nextBalances[idx].balance) + Number(l.amount),
                  ),
                };
              } else {
                nextBalances.push({
                  station: req.station,
                  item_id: l.item_id,
                  name: l.name,
                  dimension: l.dimension,
                  balance: String(l.amount),
                });
              }
            }
            const nowIso = new Date().toISOString();
            return {
              ...prev,
              items: prev.items.map((i) => {
                const l = lineDelta.get(i.id);
                return l
                  ? {
                      ...i,
                      balance: String(Number(i.balance) - Number(l.amount)),
                    }
                  : i;
              }),
              balances: nextBalances,
              requests: prev.requests.map((r) =>
                r.id === reqId
                  ? {
                      ...r,
                      status: 'accepted',
                      accepted_by: prev.who.name,
                      accepted_at: nowIso,
                    }
                  : r,
              ),
            };
          }
          if (action === 'waste') {
            const id = Number(payload.itemId);
            const target = prev.items.find((i) => i.id === id);
            if (!target) return prev;
            const delta = toBase(
              payload.amount,
              payload.unit,
              target.dimension,
            );
            const station = String(payload.station || '');
            if (station === 'store') {
              return {
                ...prev,
                items: prev.items.map((i) =>
                  i.id === id
                    ? { ...i, balance: String(Number(i.balance) - delta) }
                    : i,
                ),
              };
            }
            return {
              ...prev,
              balances: (prev.balances || []).map((b) =>
                b.station === station && b.item_id === id
                  ? { ...b, balance: String(Number(b.balance) - delta) }
                  : b,
              ),
            };
          }
          if (action === 'recipe') {
            const mId = Number(payload.menuId);
            const rawLines = Array.isArray(payload.lines)
              ? (payload.lines as Line[])
              : [];
            const nextForMenu: Recipe[] = rawLines
              .map((l) => {
                const it = prev.items.find((i) => i.id === Number(l.itemId));
                if (!it) return null;
                return {
                  menu_item_id: mId,
                  item_id: it.id,
                  amount: String(toBase(l.amount, l.unit, it.dimension)),
                };
              })
              .filter((r): r is Recipe => r !== null);
            return {
              ...prev,
              recipes: [
                ...(prev.recipes || []).filter((r) => r.menu_item_id !== mId),
                ...nextForMenu,
              ],
            };
          }
          if (action === 'void_breakage') {
            const bId = Number(payload.id);
            const nowIso = new Date().toISOString();
            return {
              ...prev,
              breakages: (prev.breakages || []).map((b) =>
                b.id === bId
                  ? { ...b, voided_at: nowIso, voided_by: prev.who.name }
                  : b,
              ),
            };
          }
          if (action === 'remove_account') {
            const sId = Number(payload.staffId);
            return {
              ...prev,
              accounts: (prev.accounts || []).filter((a) => a.id !== sId),
            };
          }
        } catch {
          /* Background snapshot reconciles full state immediately after. */
        }
        return prev;
      });
    },
    [],
  );

  async function login(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    unlockAudio();
    const a = names.find((x) => String(x.id) === loginName);
    if (!a) {
      setError('Choose your name');
      return;
    }
    try {
      const r = await fetch('/api/staff/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: a.name, role: a.role, pin }),
      });
      const d = await r.json();
      if (!r.ok) {
        setError(d.error || 'Sign-in failed');
        return;
      }
      setPin('');
      await load();
    } catch {
      setError('Could not sign in');
    }
  }
  async function send(
    action: string,
    payload: Record<string, unknown> = {},
    success = 'Saved',
  ) {
    if (sendInFlight.current) return false;
    sendInFlight.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const r = await fetch('/api/store', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...payload }),
      });
      const d = await r.json();
      if (!r.ok) {
        setError(d.error || 'Could not save');
        void load(true);
        return false;
      }
      applyOptimisticCommit(action, payload);
      // The server has committed. Confirm immediately instead of keeping the
      // Send button busy for a second, full Store snapshot over a slow link.
      setNotice(success);
      void load(true);
      if (['account', 'remove_account'].includes(action)) void refreshNames();
      return true;
    } catch {
      setError('Could not connect. Check the connection and try again.');
      return false;
    } finally {
      sendInFlight.current = false;
      setBusy(false);
    }
  }
  const itemById = (id: number) => data?.items.find((i) => i.id === id);
  const changeLine = (
    which: 'request' | 'recipe',
    index: number,
    patch: Partial<Line>,
  ) => {
    const setter = which === 'request' ? setDraft : setRecipeDraft;
    setter((old) => old.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  };
  function selectLine(which: 'request' | 'recipe', index: number, id: number) {
    const i = itemById(id);
    changeLine(which, index, {
      itemId: id,
      unit: i ? base(i.dimension) : '',
      amount: '',
    });
  }
  function lineEditor(which: 'request' | 'recipe', line: Line, index: number) {
    const it = itemById(line.itemId);
    let shortage = false;
    if (which === 'request' && it && line.amount) {
      try {
        shortage =
          toBase(line.amount, line.unit, it.dimension) > Number(it.balance);
      } catch {
        /* server explains invalid input */
      }
    }
    return (
      <div
        key={index}
        className={`flex flex-wrap items-end gap-2 rounded-xl p-3 ${subRow}`}
      >
        <label className={`min-w-[180px] flex-1 text-xs font-bold ${muted}`}>
          Ingredient / item
          <select
            className={clsInput + ' mt-1'}
            value={line.itemId || ''}
            onChange={(e) => selectLine(which, index, Number(e.target.value))}
          >
            <option value="">Choose stock item</option>
            {data?.items
              .filter(
                (i) =>
                  which !== 'recipe' ||
                  i.name
                    .toLowerCase()
                    .includes(ingredientSearch.toLowerCase()) ||
                  i.id === line.itemId,
              )
              .map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name} ({display(i.balance, i.dimension)} in store)
                </option>
              ))}
          </select>
        </label>
        <label className={`w-28 text-xs font-bold ${muted}`}>
          Amount
          <input
            className={clsInput + ' mt-1'}
            type="number"
            min="0"
            step="any"
            value={line.amount}
            onChange={(e) =>
              changeLine(which, index, { amount: e.target.value })
            }
          />
        </label>
        <label className={`w-24 text-xs font-bold ${muted}`}>
          Unit
          <select
            className={clsInput + ' mt-1'}
            value={line.unit}
            onChange={(e) => changeLine(which, index, { unit: e.target.value })}
          >
            {it && UNITS[it.dimension].map((u) => <option key={u}>{u}</option>)}
          </select>
        </label>
        {shortage && (
          <p
            className={`w-full text-xs font-bold ${isBrown ? 'text-red-300' : 'text-red-700'}`}
          >
            Not enough in store. Available:{' '}
            {it && display(it.balance, it.dimension)}
          </p>
        )}
        <button
          type="button"
          aria-label="Remove line"
          className={`rounded-lg p-3 ${isBrown ? 'text-red-300 hover:bg-red-950/50' : 'text-red-600 hover:bg-red-50'}`}
          onClick={() =>
            which === 'request'
              ? setDraft((a) => a.filter((_, i) => i !== index))
              : setRecipeDraft((a) => a.filter((_, i) => i !== index))
          }
        >
          <Trash2 size={17} />
        </button>
      </div>
    );
  }
  const selectedMenu = data?.menu?.find((m) => m.id === menuId);
  const recipeCountByMenu = useMemo(() => {
    const counts = new Map<number, number>();
    for (const r of data?.recipes || []) {
      counts.set(r.menu_item_id, (counts.get(r.menu_item_id) || 0) + 1);
    }
    return counts;
  }, [data?.recipes]);

  function openRecipe(m: Menu) {
    setMenuId(m.id);
    setIngredientSearch('');
    setRecipeDraft(
      (data?.recipes || [])
        .filter((r) => r.menu_item_id === m.id)
        .map((r) => ({
          itemId: r.item_id,
          amount: String(r.amount),
          unit: base(itemById(r.item_id)?.dimension || 'count'),
        })),
    );
  }
  function editRequest(r: RequestRow) {
    setDraft(
      r.lines.map((l) => ({
        itemId: l.item_id,
        amount: String(l.amount),
        unit: base(l.dimension),
      })),
    );
    setEditId(r.id);
    setRequestStation(r.station);
    setTab('requests');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  async function accept(r: RequestRow) {
    const inStation = (data?.balances || []).filter(
      (b) =>
        b.station === r.station &&
        r.lines.some((l) => l.item_id === b.item_id) &&
        Number(b.balance) > 0,
    );
    if (
      inStation.length &&
      !window.confirm(
        `Please check existing ${r.station} stock before giving more:\n${inStation.map((b) => `${b.name}: ${display(b.balance, b.dimension)}`).join('\n')}\n\nHave you checked and still want to accept?`,
      )
    )
      return;
    await send(
      'accept',
      {
        requestId: r.id,
        confirmExisting: inStation.length > 0,
        checkedBalances: inStation.map((b) => ({
          itemId: b.item_id,
          balance: b.balance,
        })),
      },
      'Request accepted and stock transferred',
    );
  }
  const recent = useMemo(() => {
    const now = new Date().toLocaleDateString('en-CA', {
      timeZone: 'Africa/Addis_Ababa',
    });
    const end = chosenDate && period === 'date' ? chosenDate : now;
    const d = new Date(`${end}T00:00:00Z`);
    let start = end;
    if (period === 'yesterday' || period === 'before') {
      d.setUTCDate(d.getUTCDate() - (period === 'yesterday' ? 1 : 2));
      start = d.toISOString().slice(0, 10);
      return { from: start, to: start };
    }
    if (period === 'week' || period === 'month') {
      d.setUTCDate(d.getUTCDate() - (period === 'week' ? 6 : 29));
      start = d.toISOString().slice(0, 10);
    }
    return { from: start, to: end };
  }, [period, chosenDate]);
  useEffect(() => {
    if (tab !== 'reports' || !data?.who.manager) return;
    const abort = new AbortController();
    let running = false;
    const refresh = () => {
      if (document.hidden || running) return;
      running = true;
      void fetch(`/api/store/report?from=${recent.from}&to=${recent.to}`, {
        signal: abort.signal,
        cache: 'no-store',
      })
        .then(async (r) => {
          const d = await r.json();
          if (!r.ok) throw new Error(d.error || 'Could not load report');
          setReportError('');
          setReport(d);
        })
        .catch((e) => {
          if (e.name !== 'AbortError') setReportError(e.message);
        })
        .finally(() => {
          running = false;
        });
    };
    refresh();
    const timer = window.setInterval(refresh, 10000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
      abort.abort();
    };
  }, [tab, data?.who.manager, recent.from, recent.to]);
  const reportMoves = report?.movements || [];
  const groupedDone = (report?.done || []).map((r) => ({
    station: r.station,
    category: r.category,
    name: r.item_name,
    quantity: r.quantity,
    missing: r.missing_recipe,
  }));

  const themeToggleButton = (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label="Switch store theme"
      title={
        isBrown
          ? 'Switch to white background'
          : 'Switch to Fana brown & yellow theme'
      }
      className={secondary}
    >
      {isBrown ? <Sun size={15} /> : <Palette size={15} />}
      {isBrown ? 'White theme' : 'Brown & yellow'}
    </button>
  );

  if (loading)
    return (
      <main
        className={
          isBrown
            ? 'min-h-screen bg-[#1C120F] p-10 text-amber-200/80'
            : 'min-h-screen bg-stone-50 p-10 text-stone-600'
        }
      >
        Opening store...
      </main>
    );
  if (!data)
    return (
      <main
        className={
          isBrown
            ? 'flex min-h-screen flex-col items-center justify-center bg-[#1C120F] p-5'
            : 'flex min-h-screen flex-col items-center justify-center bg-[#f7f6f3] p-5'
        }
      >
        <div className="mb-4 flex w-full max-w-md justify-end">
          {themeToggleButton}
        </div>
        <form
          onSubmit={login}
          className={
            isBrown
              ? 'w-full max-w-md rounded-3xl border border-[#C9A227]/30 bg-[#261814] p-8 text-amber-50 shadow-xl'
              : 'w-full max-w-md rounded-3xl border border-stone-200 bg-white p-8 text-stone-900 shadow-xl'
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
            Fana · stock management
          </p>
          <h1
            className={`mt-2 text-3xl font-black ${isBrown ? 'text-amber-50' : 'text-stone-900'}`}
          >
            Welcome to Store
          </h1>
          <p className={`mt-2 text-sm ${muted}`}>
            Sign in as a stock accepter or store manager. The owner can sign in
            through Admin first.
          </p>
          {error && (
            <p
              role="alert"
              className={
                isBrown
                  ? 'mt-4 rounded-xl border border-red-500/40 bg-red-950/60 p-3 text-sm text-red-200'
                  : 'mt-4 rounded-xl bg-red-50 p-3 text-sm text-red-700'
              }
            >
              {error}
            </p>
          )}
          <label className="mt-6 block text-sm font-semibold">
            Your account
            <select
              className={clsInput + ' mt-2'}
              value={loginName}
              onChange={(e) => setLoginName(e.target.value)}
            >
              <option value="">Select your name</option>
              {names.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ·{' '}
                  {a.role === 'store_manager'
                    ? 'Store manager'
                    : 'Stock accepter'}
                </option>
              ))}
            </select>
          </label>
          <label className="mt-4 block text-sm font-semibold">
            PIN
            <input
              className={clsInput + ' mt-2'}
              type="password"
              inputMode="numeric"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
            />
          </label>
          <button className={btn + ' mt-6 w-full'}>Sign in</button>
          <Link
            className={`mt-5 block text-center text-sm underline ${muted}`}
            href="/admin"
          >
            Owner sign in
          </Link>
        </form>
      </main>
    );
  const visibleTabs = tabs.filter(
    (t) => data.who.manager || ['stock', 'requests', 'history'].includes(t.id),
  );
  const pendingCount = data.requests.filter(
    (r) => r.status === 'pending',
  ).length;
  return (
    <div
      className={
        isBrown
          ? 'min-h-screen bg-[#1C120F] text-amber-50'
          : 'min-h-screen bg-[#f7f6f3] text-stone-900'
      }
    >
      <header
        className={
          isBrown
            ? 'border-b border-[#C9A227]/30 bg-[#261814]'
            : 'border-b border-stone-200 bg-white'
        }
      >
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center justify-between gap-4 px-5 py-5">
          <div className="flex items-center gap-3">
            <div
              className={
                isBrown
                  ? 'rounded-2xl bg-[#C9A227] p-3 text-[#2C1B17]'
                  : 'rounded-2xl bg-amber-100 p-3 text-amber-700'
              }
            >
              <Boxes size={24} />
            </div>
            <div>
              <p
                className={`text-[10px] font-black uppercase tracking-[.22em] ${accent}`}
              >
                Fana · inventory
              </p>
              <h1
                className={`text-2xl font-black tracking-tight ${isBrown ? 'text-amber-100' : ''}`}
              >
                Store management
              </h1>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span
              className={
                isBrown
                  ? 'rounded-full border border-[#C9A227]/35 bg-[#33201B] px-3 py-2 text-xs font-bold text-amber-100'
                  : 'rounded-full bg-stone-100 px-3 py-2 text-xs font-bold'
              }
            >
              {data.who.name} ·{' '}
              {data.who.manager ? 'Manager' : data.who.station}
            </span>
            {themeToggleButton}
            {data.who.manager && (
              <button
                type="button"
                className={secondary}
                onClick={() => {
                  unlockAudio();
                  playAlarm();
                }}
              >
                Test request alarm
              </button>
            )}
            {data.who.manager && (
              <button
                type="button"
                className={secondary}
                onClick={async () => {
                  unlockAudio();
                  const problem = await enableStoreAlerts(true);
                  if (problem) setError(problem);
                  else
                    setNotice(
                      'Background Store notifications enabled on this device.',
                    );
                }}
              >
                Enable background alerts
              </button>
            )}
            {data.who.manager && (
              <button
                type="button"
                className={secondary}
                onClick={async () => {
                  const problem = await disableStoreAlerts();
                  if (problem) setError(problem);
                  else
                    setNotice(
                      'Background Store notifications disabled on this device.',
                    );
                }}
              >
                Turn off background alerts
              </button>
            )}
            {!data.who.admin && (
              <button
                className={secondary}
                onClick={async () => {
                  if (data.who.manager) {
                    const problem = await disableStoreAlerts();
                    if (problem) {
                      setError(problem);
                      return;
                    }
                  }
                  signingOut.current = true;
                  loadEpoch.current++;
                  refreshAgain.current = false;
                  // A late Store GET also refreshes the session cookie. Abort it
                  // before clearing the cookie, so it cannot sign us back in.
                  loadController.current?.abort();
                  try {
                    const response = await fetch('/api/staff/login', {
                      method: 'DELETE',
                    });
                    if (!response.ok) throw new Error('Sign-out failed');
                    pendingSeen.current = null;
                    setData(null);
                    setLoading(false);
                    await refreshNames();
                  } catch {
                    setError(
                      'Could not sign out. Check the connection and try again.',
                    );
                  } finally {
                    signingOut.current = false;
                  }
                }}
              >
                <LogOut size={15} /> Sign out
              </button>
            )}
            <Link href="/admin" className={secondary}>
              <ArrowLeft size={15} /> Admin
            </Link>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1500px] px-5 py-7">
        {data.who.manager && (
          <p className={`mb-3 text-xs ${muted}`}>
            For alerts when another tab is open, use Test request alarm and
            enable background alerts on this device. Allow browser notifications
            and keep the volume on.
          </p>
        )}
        <div className="mb-6 flex flex-wrap gap-2">
          {visibleTabs.map((t) => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => {
                  setTab(t.id);
                  setSearch('');
                  if (t.id === 'reports' && tab !== 'reports') {
                    setReport(null);
                    setReportError('');
                  }
                }}
                className={`flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-bold transition ${
                  active
                    ? isBrown
                      ? 'bg-[#C9A227] text-[#2C1B17]'
                      : 'bg-stone-900 text-white'
                    : isBrown
                      ? 'border border-[#C9A227]/25 bg-[#261814] text-amber-100/80 hover:border-[#C9A227]/60 hover:bg-[#32201A] hover:text-amber-50'
                      : 'bg-white text-stone-600 hover:bg-stone-100'
                }`}
              >
                <t.icon size={16} />
                {t.label}
                {t.id === 'requests' && pendingCount > 0 && (
                  <span
                    className={`rounded-full px-2 text-xs ${
                      isBrown
                        ? active
                          ? 'bg-[#2C1B17] text-[#F5D061]'
                          : 'bg-[#C9A227] text-[#2C1B17]'
                        : 'bg-amber-500 text-white'
                    }`}
                  >
                    {pendingCount}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {error && (
          <div
            role="alert"
            className={
              isBrown
                ? 'mb-4 rounded-xl border border-red-500/40 bg-red-950/60 p-4 text-sm font-semibold text-red-200'
                : 'mb-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-semibold text-red-800'
            }
          >
            {error}
          </div>
        )}
        {notice && (
          <div
            role="status"
            className={
              isBrown
                ? 'mb-4 rounded-xl border border-emerald-500/35 bg-emerald-950/60 p-4 text-sm font-semibold text-emerald-200'
                : 'mb-4 rounded-xl bg-emerald-50 p-4 text-sm font-semibold text-emerald-800'
            }
          >
            {notice}
          </div>
        )}
        {tab === 'stock' &&
          (data.who.manager ? (
            <section>
              {data.items.some(
                (i) => Number(i.balance) <= Number(i.low_at),
              ) && (
                <div
                  className={
                    isBrown
                      ? 'mb-5 flex items-center gap-3 rounded-2xl border border-red-500/40 bg-red-950/60 p-4 text-sm font-bold text-red-200'
                      : 'mb-5 flex items-center gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-bold text-red-800'
                  }
                >
                  <AlertTriangle size={18} />
                  {
                    data.items.filter(
                      (i) => Number(i.balance) <= Number(i.low_at),
                    ).length
                  }{' '}
                  stock item(s) at or below their warning level. Check the red
                  LOW labels.
                </div>
              )}
              <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
                <div>
                  <h2 className="text-2xl font-black">Store stock</h2>
                  <p className={`mt-1 text-sm ${muted}`}>
                    What is available in the storeroom, before it is issued to a
                    station.
                  </p>
                </div>
                {data.who.manager && (
                  <button className={btn} onClick={() => setNewOpen(!newOpen)}>
                    <Plus size={16} /> New stock item
                  </button>
                )}
              </div>
              {data.who.manager &&
                data.items.length === 0 &&
                !examplesHidden && (
                  <StoreExamples
                    theme={theme}
                    onDismiss={() => {
                      setExamplesHidden(true);
                      try {
                        window.localStorage.setItem(
                          'fana-store-hide-examples',
                          '1',
                        );
                      } catch {
                        /* Keep hidden for this visit. */
                      }
                    }}
                  />
                )}
              {newOpen && data.who.manager && (
                <form
                  className={`mb-5 grid gap-4 rounded-2xl p-5 md:grid-cols-3 ${card}`}
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (
                      await send(
                        'new_item',
                        {
                          name,
                          dimension,
                          amount: amount || 0,
                          unit,
                          low: low || 0,
                          lowUnit,
                          image,
                        },
                        'Stock item added',
                      )
                    ) {
                      setNewOpen(false);
                      setName('');
                      setAmount('');
                      setLow('');
                      setImage('');
                    }
                  }}
                >
                  <h3 className="font-black md:col-span-3">New stock item</h3>
                  <label className="text-sm font-semibold">
                    Name
                    <input
                      required
                      className={clsInput + ' mt-1'}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </label>
                  <label className="text-sm font-semibold">
                    Measurement
                    <select
                      className={clsInput + ' mt-1'}
                      value={dimension}
                      onChange={(e) => {
                        const d = e.target.value as Dimension;
                        setDimension(d);
                        setUnit(base(d));
                        setLowUnit(base(d));
                      }}
                    >
                      <option value="volume">Measurable · liquid</option>
                      <option value="mass">Measurable · weight</option>
                      <option value="count">Not measurable · pieces</option>
                    </select>
                  </label>
                  <label className="text-sm font-semibold">
                    Photo (optional)
                    <input
                      className={clsInput + ' mt-1'}
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
                          .catch((err: Error) =>
                            setError(err.message || 'Could not read photo'),
                          )
                          .finally(() => setPhotoBusy(false));
                      }}
                    />
                    {photoBusy && (
                      <span className={`mt-1 block text-xs ${accent}`}>
                        Preparing photo...
                      </span>
                    )}
                  </label>
                  <label className="text-sm font-semibold">
                    Opening amount
                    <input
                      className={clsInput + ' mt-1'}
                      type="number"
                      min="0"
                      step="any"
                      required
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                    />
                  </label>
                  <label className="text-sm font-semibold">
                    Unit
                    <select
                      className={clsInput + ' mt-1'}
                      value={unit}
                      onChange={(e) => setUnit(e.target.value)}
                    >
                      {UNITS[dimension].map((u) => (
                        <option key={u}>{u}</option>
                      ))}
                    </select>
                  </label>
                  <div />
                  <label className="text-sm font-semibold">
                    Low-stock warning at or below
                    <input
                      className={clsInput + ' mt-1'}
                      type="number"
                      min="0"
                      step="any"
                      value={low}
                      onChange={(e) => setLow(e.target.value)}
                    />
                  </label>
                  <label className="text-sm font-semibold">
                    Warning unit
                    <select
                      className={clsInput + ' mt-1'}
                      value={lowUnit}
                      onChange={(e) => setLowUnit(e.target.value)}
                    >
                      {UNITS[dimension].map((u) => (
                        <option key={u}>{u}</option>
                      ))}
                    </select>
                  </label>
                  <div className="flex items-end gap-2">
                    <button disabled={busy || photoBusy} className={btn}>
                      {photoBusy ? 'Preparing photo...' : 'Add stock item'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setNewOpen(false)}
                      className={secondary}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              )}
              <div className="relative mb-4">
                <Search
                  size={17}
                  className={`absolute left-3 top-3 ${isBrown ? 'text-[#C9A227]/70' : 'text-stone-400'}`}
                />
                <input
                  className={clsInput + ' pl-10'}
                  placeholder="Search stock items"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {data.items
                  .filter((i) =>
                    i.name.toLowerCase().includes(search.toLowerCase()),
                  )
                  .map((i) => (
                    <article
                      key={i.id}
                      className={`overflow-hidden rounded-2xl ${card}`}
                    >
                      <div
                        className={`flex h-36 items-center justify-center ${isBrown ? 'bg-[#160E0B]' : 'bg-stone-100'}`}
                      >
                        {i.image ? (
                          <img
                            src={i.image}
                            alt=""
                            loading="lazy"
                            decoding="async"
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <Boxes
                            className={
                              isBrown ? 'text-[#C9A227]/35' : 'text-stone-300'
                            }
                            size={44}
                          />
                        )}
                      </div>
                      <div className="p-5">
                        <div className="flex items-start justify-between gap-2">
                          <h3 className="font-black">{i.name}</h3>
                          {Number(i.balance) <= Number(i.low_at) && (
                            <span
                              className={`flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-bold ${
                                isBrown
                                  ? 'border border-red-500/40 bg-red-950/70 text-red-200'
                                  : 'bg-red-50 text-red-700'
                              }`}
                            >
                              <AlertTriangle size={12} /> LOW
                            </span>
                          )}
                        </div>
                        <p className={`mt-1 text-xs ${muted}`}>
                          Available in store
                        </p>
                        <p className="mt-1 text-xl font-black">
                          {display(i.balance, i.dimension)}
                        </p>
                        <p className={`mt-1 text-xs ${subtle}`}>
                          Warning at {display(i.low_at, i.dimension)}
                        </p>
                        {data.who.manager && (
                          <div className="mt-4 flex gap-2">
                            <button
                              className={secondary + ' flex-1'}
                              onClick={() => {
                                setAddItem(i);
                                setAddAmount('');
                                setAddUnit(base(i.dimension));
                              }}
                            >
                              + Add stock
                            </button>
                            <button
                              className={secondary}
                              onClick={async () => {
                                const v = window.prompt(
                                  `Low-stock warning in ${base(i.dimension)}:`,
                                  String(i.low_at),
                                );
                                if (v !== null)
                                  await send(
                                    'threshold',
                                    {
                                      itemId: i.id,
                                      amount: v,
                                      unit: base(i.dimension),
                                    },
                                    'Warning threshold updated',
                                  );
                              }}
                            >
                              Warning
                            </button>
                          </div>
                        )}
                      </div>
                    </article>
                  ))}
              </div>
              {!data.items.length && (
                <p className={`rounded-2xl p-8 text-center ${card} ${muted}`}>
                  No stock items yet. The manager can add the first item.
                </p>
              )}
              {addItem && (
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (
                      await send(
                        'add_stock',
                        {
                          itemId: addItem.id,
                          amount: addAmount,
                          unit: addUnit,
                        },
                        'Stock added',
                      )
                    )
                      setAddItem(null);
                  }}
                  className="fixed inset-0 z-20 flex items-center justify-center bg-black/60 p-4"
                >
                  <div className={`w-full max-w-md rounded-2xl p-6 ${card}`}>
                    <h3 className="text-xl font-black">Add {addItem.name}</h3>
                    <p className={`mt-1 text-sm ${muted}`}>
                      Currently {display(addItem.balance, addItem.dimension)}
                    </p>
                    <div className="mt-5 flex gap-2">
                      <input
                        required
                        className={clsInput}
                        type="number"
                        step="any"
                        min="0"
                        placeholder="Amount bought"
                        value={addAmount}
                        onChange={(e) => setAddAmount(e.target.value)}
                      />
                      <select
                        className={clsInput + ' max-w-28'}
                        value={addUnit}
                        onChange={(e) => setAddUnit(e.target.value)}
                      >
                        {UNITS[addItem.dimension].map((u) => (
                          <option key={u}>{u}</option>
                        ))}
                      </select>
                    </div>
                    <div className="mt-5 flex gap-2">
                      <button disabled={busy} className={btn}>
                        Add to store
                      </button>
                      <button
                        type="button"
                        className={secondary}
                        onClick={() => setAddItem(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                </form>
              )}
            </section>
          ) : (
            <StoreRequestBuilder
              items={data.items}
              busy={busy}
              serverError={error}
              theme={theme}
              onSend={(lines, key) =>
                send('request_batch', { lines, key }, 'Request sent')
              }
            />
          ))}
        {tab === 'requests' && (
          <section>
            <h2 className="text-2xl font-black">Stock requests</h2>
            <p className={`mt-1 text-sm ${muted}`}>
              Requests remain editable until the store manager accepts them.
            </p>
            {editId !== null && (
              <div className={`my-5 rounded-2xl p-5 ${card}`}>
                <h3 className="font-black">
                  {editId ? `Edit request #${editId}` : 'New request'}
                </h3>
                <p className={`mt-1 text-xs ${muted}`}>
                  Availability is checked now and again at acceptance.
                </p>
                <div className="mt-4 space-y-2">
                  {draft.map((l, i) => lineEditor('request', l, i))}
                </div>
                <label className="mt-4 block max-w-xs text-sm font-bold">
                  Destination station
                  <select
                    className={clsInput + ' mt-1'}
                    value={requestStation}
                    onChange={(e) => setRequestStation(e.target.value)}
                  >
                    {['kitchen', 'barista', 'juice', 'buna'].map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    className={secondary}
                    onClick={() =>
                      setDraft((a) => [
                        ...a,
                        { itemId: 0, amount: '', unit: '' },
                      ])
                    }
                  >
                    <Plus size={15} /> Add item
                  </button>
                  <button
                    className={btn}
                    disabled={busy || !draft.length}
                    onClick={async () => {
                      if (
                        await send(
                          editId ? 'edit_request' : 'request',
                          {
                            requestId: editId,
                            station: requestStation,
                            lines: draft,
                          },
                          editId ? 'Request updated' : 'Request sent',
                        )
                      ) {
                        setDraft([]);
                        setEditId(null);
                      }
                    }}
                  >
                    {editId ? 'Save changes' : 'Send request'}
                  </button>
                  {editId && (
                    <button
                      className={secondary}
                      onClick={() => {
                        setDraft([]);
                        setEditId(null);
                      }}
                    >
                      Cancel edit
                    </button>
                  )}
                </div>
              </div>
            )}
            <div className="mt-5 space-y-3">
              {data.requests
                .filter((r) => r.status === 'pending')
                .map((r) => (
                  <article key={r.id} className={`rounded-2xl p-5 ${card}`}>
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p
                          className={`text-xs font-bold uppercase tracking-wider ${accent}`}
                        >
                          Pending · #{r.id} · {r.station}
                        </p>
                        <h3 className="mt-1 font-black">{r.requester_name}</h3>
                        <p className={`text-xs ${subtle}`}>
                          {day(r.created_at)}
                        </p>
                      </div>
                      {data.who.manager ? (
                        <div className="flex flex-wrap gap-2">
                          <button
                            className={secondary}
                            onClick={() => editRequest(r)}
                          >
                            Edit request
                          </button>
                          <button
                            disabled={busy}
                            className={btn}
                            onClick={() => accept(r)}
                          >
                            Accept &amp; issue
                          </button>
                        </div>
                      ) : (
                        <button
                          className={secondary}
                          onClick={() => editRequest(r)}
                        >
                          Edit request
                        </button>
                      )}
                    </div>
                    <ul className="mt-4 grid gap-2 sm:grid-cols-2">
                      {r.lines.map((l) => (
                        <li
                          key={l.item_id}
                          className={`flex justify-between rounded-lg px-3 py-2 text-sm ${subRow}`}
                        >
                          <span>{l.name}</span>
                          <strong>{display(l.amount, l.dimension)}</strong>
                        </li>
                      ))}
                    </ul>
                  </article>
                ))}
              {!data.requests.some((r) => r.status === 'pending') && (
                <p className={`rounded-2xl p-8 text-center ${card} ${muted}`}>
                  No pending requests.
                </p>
              )}
            </div>
          </section>
        )}
        {tab === 'history' && (
          <section>
            <h2 className="text-2xl font-black">Request history</h2>
            <p className={`mt-1 text-sm ${muted}`}>
              Accepted requests show who took what and who issued it.
            </p>
            <div className="mt-5 space-y-3">
              {data.requests
                .filter((r) => r.status === 'accepted')
                .map((r) => (
                  <article key={r.id} className={`rounded-2xl p-5 ${card}`}>
                    <p
                      className={`text-xs font-bold uppercase tracking-wider ${isBrown ? 'text-emerald-400' : 'text-emerald-700'}`}
                    >
                      Accepted · #{r.id} · {r.station}
                    </p>
                    <h3 className="mt-1 font-black">{r.requester_name}</h3>
                    <p className={`text-xs ${muted}`}>
                      Issued by {r.accepted_by}{' '}
                      {r.accepted_at && `· ${day(r.accepted_at)}`}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {r.lines.map((l) => (
                        <span
                          key={l.item_id}
                          className={`rounded-lg px-3 py-2 text-sm ${
                            isBrown
                              ? 'border border-[#C9A227]/15 bg-[#1B110E]'
                              : 'bg-stone-100'
                          }`}
                        >
                          {l.name} <b>{display(l.amount, l.dimension)}</b>
                        </span>
                      ))}
                    </div>
                  </article>
                ))}
              {!data.requests.some((r) => r.status === 'accepted') && (
                <p className={`rounded-2xl p-8 text-center ${card} ${muted}`}>
                  No accepted requests yet.
                </p>
              )}
            </div>
          </section>
        )}
        {tab === 'recipes' && data.who.manager && (
          <section>
            <div className="mb-5">
              <h2 className="text-2xl font-black">Ingredients & recipes</h2>
              <p className={`mt-1 text-sm ${muted}`}>
                Choose a menu item and enter the ingredients for one portion.
                Changes apply to future Done actions.
              </p>
            </div>
            {selectedMenu ? (
              <div className={`rounded-2xl p-5 ${card}`}>
                <button
                  className={`text-sm font-bold ${accent}`}
                  onClick={() => setMenuId(null)}
                >
                  ← All menu items
                </button>
                <h3 className="mt-3 text-xl font-black">{selectedMenu.name}</h3>
                <p className={`mt-1 text-sm ${muted}`}>
                  Ingredients per one portion
                </p>
                <label className={`mt-4 block text-xs font-bold ${muted}`}>
                  Search ingredients
                  <input
                    className={clsInput + ' mt-1'}
                    value={ingredientSearch}
                    onChange={(e) => setIngredientSearch(e.target.value)}
                    placeholder="Type a stock item name"
                  />
                </label>
                <label className={`mt-3 block text-xs font-bold ${muted}`}>
                  Select an ingredient
                  <select
                    className={clsInput + ' mt-1'}
                    value=""
                    onChange={(e) => {
                      const id = Number(e.target.value);
                      const ingredient = itemById(id);
                      if (
                        ingredient &&
                        !recipeDraft.some((l) => l.itemId === id)
                      )
                        setRecipeDraft((old) => [
                          ...old,
                          {
                            itemId: id,
                            amount: '',
                            unit: base(ingredient.dimension),
                          },
                        ]);
                    }}
                  >
                    <option value="">Choose from all stock items</option>
                    {data.items
                      .filter((i) =>
                        i.name
                          .toLowerCase()
                          .includes(ingredientSearch.toLowerCase()),
                      )
                      .map((i) => (
                        <option
                          key={i.id}
                          value={i.id}
                          disabled={recipeDraft.some((l) => l.itemId === i.id)}
                        >
                          {i.name}
                        </option>
                      ))}
                  </select>
                </label>
                <div className="mt-3 space-y-2">
                  {recipeDraft.map((l, i) => lineEditor('recipe', l, i))}
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    className={secondary}
                    onClick={() =>
                      setRecipeDraft((a) => [
                        ...a,
                        { itemId: 0, amount: '', unit: '' },
                      ])
                    }
                  >
                    <Plus size={15} /> Add ingredient
                  </button>
                  <button
                    className={btn}
                    disabled={busy}
                    onClick={async () => {
                      if (
                        await send(
                          'recipe',
                          { menuId, lines: recipeDraft },
                          'Recipe saved for future completed orders',
                        )
                      )
                        setMenuId(null);
                    }}
                  >
                    Save recipe
                  </button>
                </div>
                <p className={`mt-3 text-xs ${muted}`}>
                  An empty recipe is treated as missing, not as zero
                  consumption.
                </p>
              </div>
            ) : (
              <>
                <div className="relative mb-4">
                  <Search
                    size={17}
                    className={`absolute left-3 top-3 ${isBrown ? 'text-[#C9A227]/70' : 'text-stone-400'}`}
                  />
                  <input
                    className={clsInput + ' pl-10'}
                    placeholder="Search menu items or category"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  {(data.menu || [])
                    .filter((m) =>
                      `${m.name} ${m.category}`
                        .toLowerCase()
                        .includes(search.toLowerCase()),
                    )
                    .map((m) => (
                      <button
                        key={m.id}
                        onClick={() => openRecipe(m)}
                        className={`overflow-hidden rounded-2xl text-left transition ${card} ${
                          isBrown
                            ? 'hover:border-[#C9A227]'
                            : 'hover:border-amber-400'
                        }`}
                      >
                        <div
                          className={`h-36 ${isBrown ? 'bg-[#160E0B]' : 'bg-stone-100'}`}
                        >
                          {m.image_url && (
                            <img
                              src={optimizeImageUrl(m.image_url, 400, 256)}
                              alt=""
                              loading="lazy"
                              decoding="async"
                              className="h-full w-full object-cover"
                            />
                          )}
                        </div>
                        <div className="p-4">
                          <p
                            className={`text-xs font-bold uppercase ${subtle}`}
                          >
                            {m.category}
                          </p>
                          <h3 className="mt-1 font-black">{m.name}</h3>
                          <p className={`mt-2 text-xs font-bold ${accent}`}>
                            {recipeCountByMenu.get(m.id) || 0} ingredients ·
                            Edit recipe →
                          </p>
                        </div>
                      </button>
                    ))}
                </div>
              </>
            )}
          </section>
        )}
        {tab === 'stations' && data.who.manager && (
          <section>
            <h2 className="text-2xl font-black">Station stock</h2>
            <p className={`mt-1 text-sm ${muted}`}>
              Expected balances: accepted issues minus recipe usage and recorded
              waste. Verify physical stock; missing recipes and negative
              balances need attention.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {['all', 'kitchen', 'barista', 'juice', 'buna', 'cleaning'].map(
                (s) => (
                  <button
                    key={s}
                    className={stationFilter === s ? btn : secondary}
                    onClick={() => setStationFilter(s)}
                  >
                    {s === 'all' ? 'All stations' : `${s} stock`}
                  </button>
                ),
              )}
            </div>
            <div className="mt-5 grid gap-4 lg:grid-cols-2">
              {stations
                .filter((s) => stationFilter === 'all' || stationFilter === s)
                .map((s) => (
                  <article key={s} className={`rounded-2xl p-5 ${card}`}>
                    <h3 className="font-black capitalize">{s}</h3>
                    <div className={`mt-3 divide-y ${divideLine}`}>
                      {(data.balances || [])
                        .filter((b) => b.station === s)
                        .map((b) => (
                          <div
                            key={b.item_id}
                            className="flex justify-between py-2 text-sm"
                          >
                            <span>{b.name}</span>
                            <b
                              className={
                                Number(b.balance) < 0
                                  ? isBrown
                                    ? 'text-red-400'
                                    : 'text-red-600'
                                  : ''
                              }
                            >
                              {display(b.balance, b.dimension)}
                            </b>
                          </div>
                        ))}
                      {!(data.balances || []).some((b) => b.station === s) && (
                        <p className={`py-3 text-sm ${subtle}`}>
                          Nothing recorded yet.
                        </p>
                      )}
                    </div>
                  </article>
                ))}
            </div>
            <form
              className={`mt-5 grid gap-3 rounded-2xl p-5 md:grid-cols-5 ${card}`}
              onSubmit={async (e) => {
                e.preventDefault();
                if (
                  await send(
                    'waste',
                    {
                      itemId: wasteItem,
                      station: wasteStation,
                      amount: wasteAmount,
                      unit: wasteUnit,
                      reason,
                    },
                    'Waste recorded',
                  )
                ) {
                  setWasteAmount('');
                  setReason('');
                }
              }}
            >
              <h3 className="font-black md:col-span-5">
                Record spoilage, damage or other waste
              </h3>
              <select
                className={clsInput}
                value={wasteStation}
                onChange={(e) => setWasteStation(e.target.value)}
              >
                {['store', ...stations].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
              <select
                required
                className={clsInput}
                value={wasteItem || ''}
                onChange={(e) => {
                  const id = Number(e.target.value);
                  setWasteItem(id);
                  setWasteUnit(
                    itemById(id) ? base(itemById(id)!.dimension) : '',
                  );
                }}
              >
                <option value="">Choose item</option>
                {data.items.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
              <input
                required
                className={clsInput}
                type="number"
                min="0"
                step="any"
                placeholder="Amount"
                value={wasteAmount}
                onChange={(e) => setWasteAmount(e.target.value)}
              />
              <select
                className={clsInput}
                value={wasteUnit}
                onChange={(e) => setWasteUnit(e.target.value)}
              >
                {itemById(wasteItem) &&
                  UNITS[itemById(wasteItem)!.dimension].map((u) => (
                    <option key={u}>{u}</option>
                  ))}
              </select>
              <input
                required
                className={clsInput}
                placeholder="Reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <button disabled={busy} className={btn}>
                Record waste
              </button>
            </form>
          </section>
        )}
        {tab === 'reports' && data.who.manager && (
          <section>
            <h2 className="text-2xl font-black">Store reports</h2>
            <p className={`mt-1 text-sm ${muted}`}>
              Completed items and recorded ingredient movements, separate from
              the admin sales report.
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              {[
                ['today', 'Today'],
                ['yesterday', 'Yesterday'],
                ['before', 'Day before'],
                ['week', '7 days'],
                ['month', '30 days'],
                ['date', 'Choose date'],
              ].map(([v, label]) => (
                <button
                  key={v}
                  className={period === v ? btn : secondary}
                  onClick={() => {
                    if (v !== period) {
                      setPeriod(v);
                      setReport(null);
                      setReportError('');
                    }
                  }}
                >
                  {label}
                </button>
              ))}
              {period === 'date' && (
                <input
                  className={clsInput + ' max-w-48'}
                  type="date"
                  value={chosenDate}
                  onChange={(e) => {
                    if (e.target.value !== chosenDate) {
                      setChosenDate(e.target.value);
                      setReport(null);
                      setReportError('');
                    }
                  }}
                />
              )}
            </div>
            <p className={`mt-3 text-xs ${muted}`}>
              {recent.from} to {recent.to} · Addis Ababa time
            </p>
            <div
              className={
                isBrown
                  ? 'mt-4 rounded-2xl border border-[#C9A227]/40 bg-[#332211] p-4 text-sm text-amber-100'
                  : 'mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900'
              }
            >
              Completed is not necessarily paid. Missing recipes cannot be
              deducted; station balances are estimates, not a physical count.
            </div>
            {reportError && (
              <p
                role="alert"
                className={`mt-3 text-sm ${isBrown ? 'text-red-300' : 'text-red-700'}`}
              >
                {reportError}
              </p>
            )}
            {!report && !reportError && (
              <p className={`mt-3 text-sm ${muted}`}>Loading report...</p>
            )}
            <div className="mt-5 grid gap-5 lg:grid-cols-2">
              <article className={`rounded-2xl p-5 ${card}`}>
                <h3 className="font-black">Completed menu items</h3>
                <div className={`mt-3 divide-y ${divideLine}`}>
                  {groupedDone.map((g, i) => (
                    <div
                      key={i}
                      className="flex justify-between gap-2 py-3 text-sm"
                    >
                      <span>
                        <b>{g.name}</b>
                        <small className={`block ${muted}`}>
                          {g.station} · {g.category}
                          {g.missing ? ' · Missing recipe' : ''}
                        </small>
                      </span>
                      <b>{g.quantity}</b>
                    </div>
                  ))}
                  {!groupedDone.length && (
                    <p className={`py-4 text-sm ${subtle}`}>
                      No completed items in this period.
                    </p>
                  )}
                </div>
              </article>
              <article className={`rounded-2xl p-5 ${card}`}>
                <h3 className="font-black">Ingredient usage & waste</h3>
                <div className={`mt-3 divide-y ${divideLine}`}>
                  {reportMoves
                    .filter((m) => m.kind === 'usage' || m.kind === 'waste')
                    .map((m) => (
                      <div
                        key={`${m.station}-${m.kind}-${m.item_id}`}
                        className="flex justify-between gap-2 py-3 text-sm"
                      >
                        <span>
                          <b>{m.name}</b>
                          <small className={`block ${muted}`}>
                            {m.station} · {m.kind}
                          </small>
                        </span>
                        <b>{display(m.amount, m.dimension)}</b>
                      </div>
                    ))}
                  {!reportMoves.some(
                    (m) => m.kind === 'usage' || m.kind === 'waste',
                  ) && (
                    <p className={`py-4 text-sm ${subtle}`}>
                      No usage or waste recorded in this period.
                    </p>
                  )}
                </div>
              </article>
            </div>
            <article className={`mt-5 rounded-2xl p-5 ${card}`}>
              <h3 className="font-black">Direct station imports</h3>
              {reportMoves
                .filter((m) => m.kind === 'purchase')
                .map((m) => (
                  <div
                    key={`${m.station}-${m.item_id}`}
                    className={`flex justify-between border-b py-3 text-sm ${borderLine}`}
                  >
                    <span>
                      {m.name} · {m.station}
                    </span>
                    <b>{display(m.amount, m.dimension)}</b>
                  </div>
                ))}
              {!reportMoves.some((m) => m.kind === 'purchase') && (
                <p className={`py-3 text-sm ${subtle}`}>
                  No direct imports in this period.
                </p>
              )}
            </article>
            <article className={`mt-5 rounded-2xl p-5 ${card}`}>
              <h3 className="font-black">Waste details</h3>
              <p className={`mt-1 text-xs ${muted}`}>
                Reasons recorded by the store manager.
              </p>
              {(report?.waste || []).map((w) => (
                <div
                  key={w.id}
                  className={`border-b py-3 text-sm ${borderLine}`}
                >
                  <b>
                    {w.name} · {display(w.amount, w.dimension)}
                  </b>
                  <p className={muted}>
                    {w.station} · {w.reason} · {w.actor} · {day(w.created_at)}
                  </p>
                </div>
              ))}
              {report && !report.waste.length && (
                <p className={`py-3 text-sm ${subtle}`}>
                  No waste recorded in this period.
                </p>
              )}
            </article>
            <article className={`mt-5 rounded-2xl p-5 ${card}`}>
              <h3 className="font-black">Recorded usage efficiency</h3>
              <p className={`mt-1 text-xs ${muted}`}>
                Recipe usage ÷ (recipe usage + recorded waste), for each station
                and item. This is an estimate and does not include unreported
                loss.
              </p>
              <div className={`mt-3 divide-y ${divideLine}`}>
                {Object.values(
                  reportMoves.reduce<
                    Record<
                      string,
                      {
                        name: string;
                        station: string;
                        usage: number;
                        waste: number;
                      }
                    >
                  >((a, m) => {
                    const key = `${m.station}-${m.item_id}`;
                    const row = a[key] || {
                      name: m.name,
                      station: m.station,
                      usage: 0,
                      waste: 0,
                    };
                    if (m.kind === 'usage') row.usage += Number(m.amount);
                    else if (m.kind === 'waste') row.waste += Number(m.amount);
                    a[key] = row;
                    return a;
                  }, {}),
                ).map((r, i) => (
                  <div key={i} className="flex justify-between py-3 text-sm">
                    <span>
                      {r.name} · {r.station}
                    </span>
                    <b>
                      {r.usage + r.waste > 0
                        ? `${((r.usage / (r.usage + r.waste)) * 100).toFixed(1)}%`
                        : 'N/A'}
                    </b>
                  </div>
                ))}
              </div>
            </article>
            <p className={`mt-4 text-xs ${muted}`}>
              Reports begin when the store is first opened. Older sales are not
              imported. Usage is theoretical from recipes, not a measured
              efficiency score.
            </p>
          </section>
        )}
        {tab === 'breakage' && data.who.manager && (
          <section>
            <h2 className="text-2xl font-black">Breakage &amp; shortage</h2>
            <p className={`mt-1 text-sm ${muted}`}>
              Records made here are deducted from the employee&apos;s current
              Ethiopian payroll month. Paid or approved months are locked.
            </p>
            <form
              className={`mt-5 grid gap-3 rounded-2xl p-5 md:grid-cols-3 ${card}`}
              onSubmit={async (e) => {
                e.preventDefault();
                const key = breakKey || crypto.randomUUID();
                if (!breakKey) setBreakKey(key);
                if (
                  await send(
                    'breakage',
                    {
                      memberId: breakMember,
                      itemType: breakItem,
                      amount: breakPrice,
                      key,
                    },
                    'Breakage recorded for payroll',
                  )
                ) {
                  setBreakKey('');
                  setBreakItem('');
                  setBreakPrice('');
                }
              }}
            >
              <label className="text-sm font-bold">
                Employee
                <select
                  required
                  className={clsInput + ' mt-1'}
                  value={breakMember || ''}
                  onChange={(e) => setBreakMember(Number(e.target.value))}
                >
                  <option value="">Select employee</option>
                  {(data.members || []).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                      {m.active === false ? ' (inactive)' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm font-bold">
                Item or shortage
                <input
                  required
                  className={clsInput + ' mt-1'}
                  value={breakItem}
                  onChange={(e) => setBreakItem(e.target.value)}
                />
              </label>
              <label className="text-sm font-bold">
                Price (ETB)
                <input
                  required
                  type="number"
                  min="0.01"
                  step="0.01"
                  className={clsInput + ' mt-1'}
                  value={breakPrice}
                  onChange={(e) => setBreakPrice(e.target.value)}
                />
              </label>
              <div className="flex items-end">
                <button className={btn} disabled={busy}>
                  Record deduction
                </button>
                {breakKey && (
                  <button
                    type="button"
                    disabled={busy}
                    className={secondary + ' ml-2'}
                    onClick={() => {
                      if (
                        window.confirm(
                          'Check the deduction history first. Starting a new entry can duplicate a saved deduction. Continue?',
                        )
                      ) {
                        setBreakKey('');
                        setBreakItem('');
                        setBreakPrice('');
                        void load();
                      }
                    }}
                  >
                    Start a new entry
                  </button>
                )}
              </div>
            </form>
            <h3 className="mt-6 text-lg font-black">Deduction history</h3>
            <p className={`text-xs ${muted}`}>
              Void a mistake instead of deleting it. Existing paid payroll
              remains locked.
            </p>
            <div className="mt-3 space-y-2">
              {(data.breakages || []).map((b) => (
                <article
                  key={b.id}
                  className={`flex flex-wrap items-center justify-between gap-3 rounded-xl p-4 ${card}`}
                >
                  <div>
                    <b>
                      {b.member_name || `Employee #${b.member_id}`} ·{' '}
                      {b.item_type}
                    </b>
                    <p className={`text-sm ${muted}`}>
                      {Number(b.amount).toFixed(2)} ETB · Payroll {b.period_key}{' '}
                      E.C. · {day(b.created_at)} · {b.recorded_by}
                    </p>
                    {b.voided_at && (
                      <p
                        className={`text-xs font-bold ${isBrown ? 'text-red-300' : 'text-red-700'}`}
                      >
                        Voided {day(b.voided_at)} by {b.voided_by}
                      </p>
                    )}
                  </div>
                  {!b.voided_at && (
                    <button
                      className={secondary}
                      disabled={busy}
                      onClick={async () => {
                        if (
                          window.confirm(
                            'Void this deduction? The record stays in history.',
                          )
                        )
                          await send(
                            'void_breakage',
                            { id: b.id },
                            'Deduction voided',
                          );
                      }}
                    >
                      Void mistake
                    </button>
                  )}
                </article>
              ))}
              {!(data.breakages || []).length && (
                <p className={`rounded-xl p-5 text-sm ${card} ${muted}`}>
                  No deductions recorded.
                </p>
              )}
            </div>
          </section>
        )}
        {tab === 'accounts' && data.who.manager && (
          <section>
            <h2 className="text-2xl font-black">Stock accepters</h2>
            <p className={`mt-1 text-sm ${muted}`}>
              Create a personal login for the person responsible for each
              station.
            </p>
            <form
              className={`mt-5 grid gap-3 rounded-2xl p-5 md:grid-cols-4 ${card}`}
              onSubmit={async (e) => {
                e.preventDefault();
                if (
                  await send(
                    'account',
                    {
                      name: accName,
                      pin: accPin,
                      role: accRole,
                      station: accStation,
                    },
                    'Account created',
                  )
                ) {
                  setAccName('');
                  setAccPin('');
                }
              }}
            >
              <label className={`text-xs font-bold ${muted}`}>
                Name
                <input
                  className={clsInput + ' mt-1'}
                  required
                  value={accName}
                  onChange={(e) => setAccName(e.target.value)}
                />
              </label>
              <label className={`text-xs font-bold ${muted}`}>
                PIN (4–12 digits)
                <input
                  className={clsInput + ' mt-1'}
                  required
                  type="password"
                  inputMode="numeric"
                  pattern="[0-9]{4,12}"
                  value={accPin}
                  onChange={(e) => setAccPin(e.target.value)}
                />
              </label>
              <label className={`text-xs font-bold ${muted}`}>
                Account type
                <select
                  className={clsInput + ' mt-1'}
                  value={accRole}
                  onChange={(e) => setAccRole(e.target.value)}
                >
                  <option value="stock_accepter">Stock accepter</option>
                  {data.who.admin && (
                    <option value="store_manager">Store manager</option>
                  )}
                </select>
              </label>
              <label className={`text-xs font-bold ${muted}`}>
                Station
                <select
                  disabled={accRole === 'store_manager'}
                  className={clsInput + ' mt-1'}
                  value={accStation}
                  onChange={(e) => setAccStation(e.target.value)}
                >
                  {stations.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </label>
              <button disabled={busy} className={btn}>
                Create account
              </button>
            </form>
            <div className={`mt-5 rounded-2xl p-5 ${card}`}>
              {(data.accounts || []).map((a) => (
                <div
                  key={a.id}
                  className={`flex flex-wrap items-center justify-between gap-2 border-b py-3 text-sm ${borderLine}`}
                >
                  <div>
                    <b>{a.name}</b>
                    <span className={`ml-3 capitalize ${muted}`}>
                      {a.role === 'store_manager'
                        ? 'Store manager'
                        : `${a.station} · stock accepter`}
                    </span>
                  </div>
                  {(data.who.admin || a.role !== 'store_manager') && (
                    <div className="flex gap-2">
                      <button
                        className={secondary}
                        onClick={async () => {
                          const p = window.prompt(
                            `New 4–12 digit PIN for ${a.name}:`,
                          );
                          if (p !== null)
                            await send(
                              'reset_pin',
                              { staffId: a.id, pin: p },
                              'PIN reset; old store sessions are signed out',
                            );
                        }}
                      >
                        Reset PIN
                      </button>
                      <button
                        className={secondary}
                        onClick={async () => {
                          if (
                            window.confirm(
                              `Remove ${a.name}'s store login? Their request history will remain.`,
                            )
                          )
                            await send(
                              'remove_account',
                              { staffId: a.id },
                              'Account removed',
                            );
                        }}
                      >
                        Remove login
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
