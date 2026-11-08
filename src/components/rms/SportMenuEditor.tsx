"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Flag, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useStaffT, tNow } from "@/lib/staff-i18n";
import {
  fetchSportCatalog,
  type SportCatalogItem,
  type SportCatalogResponse,
} from "@/lib/sport-menu-client";

/**
 * THE SPORT MENU EDITOR — OWNER/ADMIN ONLY (owner, 2026-11-08).
 *
 * "the one who is responsible to edit the items is the admin not the waiters".
 *
 * So this is the ONLY place a match-day price can be typed, and it lives on the
 * dashboard's Sport menu tab. The waiter has no editor: when he taps Sport on his
 * phone he gets the ordinary ordering screen with these numbers on the items the
 * admin re-priced. Nothing here is visible to a guest either.
 *
 * The owner adds a whole category at a time (cold drinks, hot drinks, pastry) and
 * each item inside it reads `from <menu price> to <the price he types>`. Nothing
 * is saved until he saves, and the ordinary menu is never touched: these numbers
 * live in their own table.
 */

type Props = {
  /**
   * Rendered as a dashboard tab rather than a phone overlay: the list scrolls
   * with the page. Kept as a prop so the component stays usable in a modal if a
   * future screen needs one, but the waiter never mounts it.
   */
  embedded?: boolean;
};

const money = (n: number) => (Math.round(Number(n) * 100) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 });

export default function SportMenuEditor({ embedded = true }: Props) {
  const { t: L } = useStaffT();
  const [catalog, setCatalog] = useState<SportCatalogResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  /** The category the owner just added and is now pricing. */
  const [openCategory, setOpenCategory] = useState<string>("");
  /** menuItemId → what he is typing, before he saves it. */
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  /** Admin-only actions answer 401 for a plain waiter, so the editor hides itself. */
  const [canEdit, setCanEdit] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const next = await fetchSportCatalog("admin");
    setLoading(false);
    if (!next) {
      setError(tNow("Could not read the sport menu. Check the connection and try again."));
      return;
    }
    setError("");
    setCatalog(next);
  }, []);

  useEffect(() => {
    // `canEdit` comes from the server (the owner's cookie). A plain user who
    // somehow reaches this tab sees the list read-only and no input at all.
    void (async () => {
      setLoading(true);
      const next = await fetchSportCatalog("admin");
      setLoading(false);
      if (!next) {
        setError(tNow("Could not read the sport menu. Check the connection and try again."));
        return;
      }
      setCatalog(next);
      setCanEdit(Boolean(next.canEdit));
    })();
  }, []);

  const menu = catalog?.menu || null;
  const added = useMemo(() => menu?.categories || [], [menu]);
  const items = useMemo(() => catalog?.items || [], [catalog]);

  /** Items of one category, normal price beside the typed one. */
  const itemsOf = useCallback(
    (slug: string): SportCatalogItem[] => items.filter((item) => item.category === slug),
    [items]
  );

  const pricedFor = (item: SportCatalogItem): number | null => {
    const draft = drafts[item.id];
    if (draft !== undefined) {
      const value = Number(String(draft).replace(/,/g, ""));
      return Number.isFinite(value) ? value : null;
    }
    return item.sportPrice;
  };

  const categoriesToAdd = useMemo(
    () => (catalog?.categories || []).filter((category) => category.slug !== "all" && itemsOf(category.slug).length > 0),
    [catalog, itemsOf]
  );

  const post = async (body: Record<string, unknown>, okMessage?: string) => {
    setBusy(String(body.action || ""));
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/sport-menu", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      setBusy("");
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          setCanEdit(false);
          setError(tNow("Only the owner can change sport prices."));
        } else {
          setError(String(data?.error || tNow("Could not save the sport menu.")));
        }
        return null;
      }
      if (data?.menu) {
        setCatalog((current) => (current ? { ...current, menu: data.menu, categories: data.categories || current.categories, items: data.items || current.items } : current));
      }
      setMessage(String(data?.message || okMessage || tNow("Sport menu saved.")));
      return data;
    } catch {
      setBusy("");
      setError(tNow("Could not save the sport menu. Check the connection and try again."));
      return null;
    }
  };

  const addCategory = async (slug: string) => {
    const data = await post({ action: "add_category", category: slug });
    if (data) {
      setOpenCategory(slug);
      setDrafts({});
    }
  };

  /**
   * SAVE ONE ITEM (owner, 2026-11-08): "he change the item price only for the
   * sport item". A single row is saved on its own, so the admin never has to
   * re-save the whole category to fix one drink, and the other items keep the
   * prices he already typed.
   */
  const saveItem = async (item: SportCatalogItem) => {
    const typed = drafts[item.id] ?? (item.sportPrice === null ? "" : String(item.sportPrice));
    if (String(typed).trim() === "") {
      setError(tNow("Type the event price first."));
      return;
    }
    const data = await post(
      { action: "set_price", menuItemId: item.id, sportPrice: typed },
      tNow("{name} saved. Only this item changed.", { name: item.name })
    );
    if (data) setDrafts((current) => {
      const next = { ...current };
      delete next[item.id];
      return next;
    });
  };

  const saveCategory = async (slug: string) => {
    const rows = itemsOf(slug)
      .map((item) => ({ menuItemId: item.id, regularPrice: item.regularPrice, sportPrice: drafts[item.id] ?? item.sportPrice }))
      .filter((row) => row.sportPrice !== null && row.sportPrice !== undefined && String(row.sportPrice) !== "")
      .map((row) => ({ ...row, sportPrice: Number(row.sportPrice) }));
    if (rows.length === 0) {
      setError(tNow("Type at least one sport price first."));
      return;
    }
    const data = await post({ action: "set_category_prices", category: slug, rows });
    if (data) setDrafts({});
  };

  const removeCategory = async (slug: string) => {
    const data = await post({ action: "remove_category", category: slug });
    if (data && openCategory === slug) setOpenCategory("");
  };

  const toggleActive = async () => {
    await post({ action: "set_active", active: !(menu && menu.active !== false) });
  };

  const active = Boolean(menu && menu.active !== false);
  const pricedCount = menu?.prices.filter((price) => added.includes(price.category)).length || 0;

  return (
    <div className="w-full">
      <div className="max-w-4xl mx-auto bg-[#1C120F] border border-violet-500/40 rounded-3xl">
        <div className="z-10 bg-[#2C1B17]/95 backdrop-blur border-b border-violet-500/30 px-4 py-3 flex items-center justify-between gap-3 rounded-t-3xl">
          <div className="flex items-center gap-3 min-w-0">
            <div className="min-w-0">
              <h2 className="font-serif font-black text-xl text-amber-100 flex items-center gap-2">
                <Flag className="w-5 h-5 text-violet-300" />
                {L("Sport menu")}
              </h2>
              <p className="text-[11px] text-stone-400">
                {L("Only the owner sets these prices. The waiter sees them on the normal menu and a customer never does.")}
              </p>
            </div>
          </div>
        </div>

        <div className="p-4 space-y-4">
          {error && (
            <div className="rounded-xl border border-rose-600/60 bg-rose-950/50 px-3 py-2 text-xs font-bold text-rose-200">{error}</div>
          )}
          {message && (
            <div className="rounded-xl border border-emerald-600/60 bg-emerald-950/40 px-3 py-2 text-xs font-bold text-emerald-200">{message}</div>
          )}

          {/* ── State of the list, and the two buttons that matter most ── */}
          <div className="rounded-2xl border border-violet-500/30 bg-violet-950/20 p-3 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-xs font-black text-violet-200">
                  {active ? L("Sport prices are ON") : L("Sport prices are OFF")}
                </p>
                <p className="text-[11px] text-stone-400">
                  {L("{categories} categories added • {prices} items priced", { categories: added.length, prices: pricedCount })}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => void load()}
                  className="p-2 rounded-xl bg-white/10 text-stone-300 hover:bg-white/20"
                  aria-label={L("Refresh")}
                  disabled={loading}
                >
                  <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
                </button>
                {canEdit && (
                  <button
                    onClick={() => void toggleActive()}
                    disabled={busy === "set_active"}
                    className={`px-3 py-2 rounded-xl text-[11px] font-black border transition ${
                      active
                        ? "bg-violet-500/25 border-violet-400 text-violet-100"
                        : "bg-[#241714] border-stone-700 text-stone-300"
                    }`}
                  >
                    {active ? L("Switch off for today") : L("Switch on for today")}
                  </button>
                )}
              </div>
            </div>
            {active && (
              <p className="text-[10px] font-bold text-stone-500">
                {L("Guide price: 1 cold drink on a match day costs more than on a normal day. Items you did not price keep the normal price.")}
              </p>
            )}
          </div>

          {/* ── The owner's editor ── */}
          {canEdit && (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] font-black uppercase tracking-wider text-violet-300">{L("Add a category")}</p>
                <span className="text-[10px] font-bold text-stone-500">{L("One category at a time")}</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {categoriesToAdd.map((category) => {
                  const isAdded = added.includes(category.slug);
                  return (
                    <button
                      key={category.slug}
                      onClick={() => (isAdded ? setOpenCategory(category.slug) : void addCategory(category.slug))}
                      disabled={busy === "add_category"}
                      className={`px-3 py-2 rounded-xl border text-[11px] font-black transition ${
                        isAdded
                          ? "bg-violet-500/20 border-violet-400 text-violet-100"
                          : "bg-[#241714] border-stone-700 text-stone-300 hover:border-violet-500/60"
                      }`}
                    >
                      {isAdded ? <Check className="w-3 h-3 inline mr-1 -mt-0.5" /> : <Plus className="w-3 h-3 inline mr-1 -mt-0.5" />}
                      {category.name}
                    </button>
                  );
                })}
                {categoriesToAdd.length === 0 && (
                  <p className="text-[11px] text-stone-500">{L("No menu categories yet. Add dishes in the Menu tab first.")}</p>
                )}
              </div>
            </div>
          )}

          {/* ── Every added category, with from / to per item ── */}
          <div className="space-y-3">
            {added.length === 0 && (
              <div className="rounded-2xl border border-stone-800 bg-[#241714] p-4 text-center text-sm text-stone-400">
                {L("No category added yet. Add cold drinks, hot drinks or pastry above, then type the match-day price of each item.")}
              </div>
            )}
            {added.map((slug) => {
              const name = catalog?.categories.find((category) => category.slug === slug)?.name || slug;
              const list = itemsOf(slug);
              const opened = openCategory === slug;
              const priced = list.filter((item) => pricedFor(item) !== null).length;
              return (
                <div key={slug} className="rounded-2xl border border-violet-500/25 bg-[#241714] overflow-hidden">
                  <button
                    onClick={() => setOpenCategory(opened ? "" : slug)}
                    className="w-full px-3 py-2.5 flex items-center justify-between gap-2 text-left"
                  >
                    <span className="min-w-0">
                      <span className="block text-sm font-black text-amber-100 truncate">{name}</span>
                      <span className="block text-[10px] font-bold text-stone-500">
                        {L("{priced} of {total} items priced", { priced, total: list.length })}
                      </span>
                    </span>
                    <span className="text-[10px] font-black text-violet-300 shrink-0">{opened ? L("HIDE") : L("EDIT ITEMS")}</span>
                  </button>
                  {opened && (
                    <div className="border-t border-stone-800 p-3 space-y-2">
                      <p className="text-[10px] font-bold text-stone-500">
                        {L("Type only the items you want to change for the sport menu, then Save that item. Everything else keeps the normal price.")}
                      </p>
                      {list.map((item) => {
                        const current = pricedFor(item);
                        const raised = current !== null && current > item.regularPrice;
                        const lowered = current !== null && current < item.regularPrice;
                        return (
                          <div key={item.id} className="flex items-center gap-2">
                            <div className="min-w-0 flex-1">
                              <p className="text-xs font-bold text-amber-100 truncate">{item.name}</p>
                              <p className="text-[10px] font-bold text-stone-500">
                                {L("from")} <span className="line-through">{money(item.regularPrice)}</span> ETB
                                {current !== null && (
                                  <>
                                    {" "}
                                    {L("to")}{" "}
                                    <span className={raised ? "text-emerald-300" : lowered ? "text-rose-300" : "text-stone-300"}>
                                      {money(current)}
                                    </span>{" "}
                                    ETB
                                  </>
                                )}
                              </p>
                            </div>
                            <input
                              value={drafts[item.id] ?? (item.sportPrice === null ? "" : String(item.sportPrice))}
                              onChange={(event) => setDrafts((current) => ({ ...current, [item.id]: event.target.value }))}
                              inputMode="decimal"
                              placeholder={String(item.regularPrice)}
                              aria-label={`${item.name} ${L("sport price")}`}
                              className="w-20 shrink-0 bg-black/30 border border-stone-700 rounded-xl px-2.5 py-2 text-sm font-bold text-white text-right"
                            />
                            {/* One item on its own: the row is saved by itself,
                                the other items of the category are untouched. */}
                            <button
                              onClick={() => void saveItem(item)}
                              disabled={busy === "set_price"}
                              className="shrink-0 px-2.5 py-2 rounded-xl bg-violet-600 text-white text-[10px] font-black disabled:opacity-40"
                              title={L("Save this item only")}
                            >
                              {L("Save")}
                            </button>
                          </div>
                        );
                      })}
                      <div className="flex items-center gap-2 pt-1">
                        <button
                          onClick={() => void saveCategory(slug)}
                          disabled={busy === "set_category_prices"}
                          className="flex-1 bg-[#C9A227] text-[#2C1B17] text-xs font-black py-2.5 rounded-xl disabled:opacity-50"
                        >
                          {L("Save {name} prices", { name })}
                        </button>
                        <button
                          onClick={() => void removeCategory(slug)}
                          className="px-3 py-2.5 rounded-xl bg-rose-900/40 text-rose-300 text-xs font-black flex items-center gap-1"
                          title={L("Remove this category from the sport menu")}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          {L("Remove")}
                        </button>
                      </div>
                      <p className="text-[10px] font-bold text-stone-500">
                        {L("Saving copies every price you typed into the sport menu only. The normal menu and the customer QR page are untouched.")}
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {!canEdit && added.length === 0 && (
            <p className="text-center text-[11px] font-bold text-stone-500">
              {L("Ask the owner to add the match-day categories and prices.")}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
