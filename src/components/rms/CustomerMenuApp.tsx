"use client";

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import {
  Coffee, Plus, Minus, Search, Send, CheckCircle2, Clock, X, Phone, Utensils, Loader2, QrCode,
  ChevronLeft, ChevronRight, MapPin, Star, MessageSquare, Globe, Camera,
} from "lucide-react";
import { MenuItem, Category, CafeTable, SiteSettings, Announcement, GalleryItem, Review } from "@/types";
import { DEFAULT_SETTINGS, DEFAULT_CATEGORIES, DEFAULT_MENU_ITEMS } from "@/lib/initial-data";
import { effectivePrice } from "@/lib/price";
import { fixBrandText } from "@/lib/brand";
import { useMenuText, useT } from "@/lib/i18n";
import LanguageToggle from "@/components/LanguageToggle";
import { optimizeImageUrl, FALLBACK_FOOD_IMAGE } from "@/lib/image-utils";

interface CartEntry {
  menuItemId: number;
  name: string;
  category: string;
  price: number;
  quantity: number;
  notes: string;
}

export default function CustomerMenuApp() {
  const searchParams = useSearchParams();
  const tableId = Number(searchParams.get("table") || 0);
  const t = useT();
  const menuText = useMenuText();

  // Start with EMPTY states — NEVER flash the default demo items for those first seconds.
  // Customers now see a branded loading skeleton until real menu data arrives from the database.
  const [settings, setSettings] = useState<SiteSettings>(DEFAULT_SETTINGS as SiteSettings);
  const [categories, setCategories] = useState<Category[]>([]);
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [menuLoading, setMenuLoading] = useState(true);
  const [tableName, setTableName] = useState(tableId ? `Table ${tableId}` : "");

  const [category, setCategory] = useState("all");
  const [search, setSearch] = useState("");
  const [cart, setCart] = useState<CartEntry[]>([]);
  const [reviewMode, setReviewMode] = useState(false);
  const [detailItem, setDetailItem] = useState<MenuItem | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");
  const [lastOrderNumber, setLastOrderNumber] = useState("");

  // ── IDEMPOTENCY (Group 1): one key per submission attempt, reused on retries so
  //    a double-tap or WiFi retry can NEVER create a duplicate order. If the cart
  //    changes after a failed attempt, the next click is a NEW submission (new key).
  const pendingKeyRef = useRef("");
  const lastCartSigRef = useRef("");

  useEffect(() => {
    const sig = JSON.stringify(cart);
    if (pendingKeyRef.current && lastCartSigRef.current && sig !== lastCartSigRef.current) {
      pendingKeyRef.current = ""; // cart edited → next submit is a brand-new submission
    }
  }, [cart]);

  const newSubmissionKey = () =>
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  // Daily Board + bottom content
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [slideIdx, setSlideIdx] = useState(0);
  const [galleryPhotos, setGalleryPhotos] = useState<GalleryItem[]>([]);
  const [approvedReviews, setApprovedReviews] = useState<Review[]>([]);
  const [revName, setRevName] = useState("");
  const [revRating, setRevRating] = useState(5);
  const [revText, setRevText] = useState("");
  const [revSending, setRevSending] = useState(false);
  const [revMsg, setRevMsg] = useState("");

  const logoUrl = String(settings.logo_url || "/logo.png");
  // Brand guard: business is Fana Cafe & Restaurant — never show FanaQueen text
  const brandName = fixBrandText(settings.cafe_name || "Fana Cafe & Restaurant");

  // SPEED: show cached menu + announcements INSTANTLY on repeat visits,
  // then refresh silently in the background (stale-while-revalidate)
  useEffect(() => {
    try {
      const cached = sessionStorage.getItem("fana_menu_cache");
      if (cached) {
        const { t: cachedAt, data } = JSON.parse(cached);
        if (Date.now() - cachedAt < 300_000 && data) {
          if (data.menuItems) setMenuItems(data.menuItems);
          if (data.categories) setCategories(data.categories);
          if (data.announcements) setAnnouncements(data.announcements);
          if (data.galleryPhotos) setGalleryPhotos(data.galleryPhotos);
          if (data.approvedReviews) setApprovedReviews(data.approvedReviews);
        }
      }
    } catch {}
  }, [tableId]);

  // Extracted so a stale-cart submit ("Unknown menu item") can re-pull the menu.
  // Returns the fresh menu items (used to prune a stale cart) or null on failure.
  const loadAllData = useCallback(async (): Promise<MenuItem[] | null> => {
    try {
      // 1. Critical path for instant ordering: menu items, categories, settings, and tables
      const corePromise = Promise.all([
        fetch("/api/settings").then((r) => (r.ok ? r.json() : null)),
        fetch("/api/categories").then((r) => (r.ok ? r.json() : null)),
        fetch("/api/menu").then((r) => (r.ok ? r.json() : null)),
        fetch("/api/tables").then((r) => (r.ok ? r.json() : null)),
      ]);

      // 2. Secondary path: below-the-fold announcements, gallery, reviews
      const secondaryPromise = Promise.all([
        fetch("/api/announcements?active=1").then((r) => (r.ok ? r.json() : [])),
        fetch("/api/gallery").then((r) => (r.ok ? r.json() : [])),
        fetch("/api/reviews").then((r) => (r.ok ? r.json() : [])),
      ]);

      const [s, c, m, tbl] = await corePromise;
      const fresh: Record<string, unknown> = {};
      let freshMenu: MenuItem[] | null = null;

      if (s) setSettings(s);
      if (c) {
        setCategories(c);
        fresh.categories = c;
      }
      if (m) {
        setMenuItems(m);
        fresh.menuItems = m;
        freshMenu = m;
      }
      if (tbl) {
        const found = tbl.find((x: CafeTable) => x.id === tableId);
        if (found) setTableName(found.name);
      }
      // Critical menu rendering unlocks immediately!
      setMenuLoading(false);

      // Await secondary below-the-fold content without delaying menu interaction
      const [anns, gal, revs] = await secondaryPromise;
      if (anns) {
        setAnnouncements(anns);
        fresh.announcements = anns;
      }
      if (gal) {
        const p = gal.slice(0, 8);
        setGalleryPhotos(p);
        fresh.galleryPhotos = p;
      }
      if (revs) {
        const ap = revs.filter((r: Review) => r.isApproved).slice(0, 5);
        setApprovedReviews(ap);
        fresh.approvedReviews = ap;
      }

      // update instant-cache for the next visit
      try {
        sessionStorage.setItem("fana_menu_cache", JSON.stringify({ t: Date.now(), data: fresh }));
      } catch {}
      return freshMenu;
    } catch {
      setMenuLoading(false);
      return null;
    }
  }, [tableId]);

  useEffect(() => {
    loadAllData();
  }, [loadAllData]);

  // Daily Board auto-slide when 2+ announcements (seconds interval), swipeable with arrows
  useEffect(() => {
    if (announcements.length < 2) return;
    const t = setInterval(() => setSlideIdx((i) => (i + 1) % announcements.length), 4500);
    return () => clearInterval(t);
  }, [announcements.length]);

  useEffect(() => {
    setSlideIdx(0);
  }, [announcements.length]);

  const submitReview = async () => {
    if (!revName.trim() || !revText.trim()) {
      setRevMsg(t("review_need_name"));
      return;
    }
    setRevSending(true);
    const r = await fetch("/api/reviews", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customerName: revName.trim(), rating: revRating, reviewText: revText.trim() }),
    });
    setRevSending(false);
    if (r.ok) {
      setRevName("");
      setRevText("");
      setRevMsg(t("review_thanks"));
    } else setRevMsg(t("review_fail"));
  };

  const filteredMenu = useMemo(
    () =>
      menuItems.filter(
        (m) =>
          (category === "all" || m.category === category) &&
          (m.name.toLowerCase().includes(search.toLowerCase()) ||
            menuText(m.name).toLowerCase().includes(search.toLowerCase()) ||
            menuText(m.description).toLowerCase().includes(search.toLowerCase()))
      ),
    [menuItems, category, search, menuText]
  );

  // Unified quantity control: qty 0 = remove from cart (fixes "accidental Add" confusion)
  // Applies the auto-scheduled SALE price when active for today.
  const setQty = (m: MenuItem, qty: number) => {
    if (!m.isAvailable) return;
    const { price: unitPrice } = effectivePrice(m);
    setCart((prev) => {
      const exists = prev.find((c) => c.menuItemId === m.id);
      if (qty <= 0) return prev.filter((c) => c.menuItemId !== m.id);
      if (exists) return prev.map((c) => (c.menuItemId === m.id ? { ...c, quantity: qty, price: unitPrice } : c));
      return [...prev, { menuItemId: m.id, name: m.name, category: m.category, price: unitPrice, quantity: qty, notes: "" }];
    });
  };

  const addToCart = (m: MenuItem) => setQty(m, 1);

  const cartQty = (id: number) => cart.find((c) => c.menuItemId === id)?.quantity || 0;

  const cartTotal = cart.reduce((s, c) => s + c.price * c.quantity, 0);
  const cartCount = cart.reduce((s, c) => s + c.quantity, 0);

  const submitOrder = async () => {
    if (cart.length === 0 || !tableId || submitting) return;
    if (!pendingKeyRef.current) pendingKeyRef.current = newSubmissionKey();
    lastCartSigRef.current = JSON.stringify(cart);
    setSubmitting(true);
    setError("");
    try {
      const r = await fetch("/api/tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tableId,
          source: "customer",
          idempotencyKey: pendingKeyRef.current,
          items: cart.map((c) => ({
            menuItemId: c.menuItemId,
            name: c.name,
            category: c.category,
            price: c.price,
            quantity: c.quantity,
            notes: c.notes,
          })),
        }),
      });
      if (r.ok) {
        const d = await r.json();
        setLastOrderNumber(d.orderNumber || "");
        pendingKeyRef.current = ""; // submission recorded — next cart is a new order
        setSubmitted(true);
        setCart([]);
        setReviewMode(false);
      } else {
        // Server returns customer-friendly messages (raw DB errors are logged
        // server-side, never shown to guests). One special case: the tab holds
        // a cached menu where an item was since removed/changed by the owner —
        // silently refresh the menu instead of confusing the guest.
        const d = await r.json().catch(() => ({}));
        if (r.status === 400 && String(d.error || "").includes("Unknown menu item")) {
          try { sessionStorage.removeItem("fana_menu_cache"); } catch {}
          setError("");
          setReviewMode(false);
          const freshMenu = await loadAllData();
          if (freshMenu) {
            // Drop cart rows whose item no longer exists on the (updated) menu,
            // so the guest re-adds from what's actually available now.
            const validIds = new Set(freshMenu.map((fm) => fm.id));
            setCart((prev) => prev.filter((row) => validIds.has(row.menuItemId)));
          }
          pendingKeyRef.current = ""; // cart may change → fresh submission key
          setError(t("err_menu_updated"));
        } else {
          setError(d.error || t("err_submit"));
        }
      }
    } catch {
      // Safe retry: the same key is reused, so the kitchen will never cook twice.
      setError(t("err_connection"));
    } finally {
      setSubmitting(false);
    }
  };

  const phone = settings.phone || "0911 065 022";

  /* ── Submitted confirmation ── */
  if (submitted) {
    return (
      <div className="min-h-screen bg-[#FAF6F0] flex items-center justify-center p-6">
        <div className="bg-white rounded-3xl border-2 border-[#C9A227] p-8 max-w-sm w-full text-center space-y-4 shadow-2xl">
          <div className="w-16 h-16 rounded-full bg-emerald-100 flex items-center justify-center mx-auto">
            <CheckCircle2 className="w-9 h-9 text-emerald-600" />
          </div>
          <h1 className="font-serif text-2xl font-bold text-[#2C1B17]">{t("order_sent_title")}</h1>
          {lastOrderNumber && (
            <p className="inline-block bg-[#2C1B17] text-[#C9A227] font-black text-sm px-4 py-1.5 rounded-full">
              Order #{lastOrderNumber}
            </p>
          )}
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 space-y-1">
            <p className="text-sm font-bold text-[#2C1B17] flex items-center justify-center gap-1.5">
              <Clock className="w-4 h-4 text-[#C9A227]" /> {t("waiting_confirmation")}
            </p>
            <p className="text-xs text-stone-600">
              {t("waiter_walking", { table: menuText(tableName) })}
            </p>
          </div>
          <p className="text-xs text-stone-500">{t("add_more_note")}</p>
          <button
            onClick={() => setSubmitted(false)}
            className="w-full bg-[#4E342E] text-amber-200 font-bold text-sm py-3.5 rounded-xl"
          >
            {t("back_to_menu")}
          </button>
        </div>
      </div>
    );
  }

  /* ── Invalid table ── */
  if (!tableId) {
    return (
      <div className="min-h-screen bg-[#FAF6F0] flex items-center justify-center p-6 text-center">
        <div className="bg-white rounded-3xl p-8 max-w-sm w-full border border-[#C9A227]/40 space-y-3">
          <QrCode className="w-10 h-10 text-[#C9A227] mx-auto" />
          <h1 className="font-serif text-xl font-bold">{t("scan_qr_title")}</h1>
          <p className="text-sm text-stone-600">{t("scan_qr_sub")}</p>
        </div>
      </div>
    );
  }

  /* ── REVIEW MODE (before submit) ── */
  if (reviewMode) {
    return (
      <div className="min-h-screen bg-[#FAF6F0] pb-32">
        <header className="bg-[#2C1B17] text-white sticky top-0 z-40 px-4 py-3 flex items-center gap-3 shadow-xl">
          <button onClick={() => setReviewMode(false)} className="text-amber-200"><X className="w-5 h-5" /></button>
          <h1 className="font-serif font-bold">{t("review_your_order")} — {menuText(tableName)}</h1>
        </header>

        <div className="max-w-lg mx-auto p-4 space-y-3">
          {error && <div className="bg-rose-100 border border-rose-300 text-rose-700 text-xs p-3 rounded-xl">{error}</div>}

          {cart.map((c) => (
            <div key={c.menuItemId} className="bg-white rounded-2xl border border-[#C9A227]/30 p-4 space-y-2 shadow-sm">
              <div className="flex items-center justify-between">
                <p className="font-bold text-[#2C1B17] text-sm">{menuText(c.name)}</p>
                <p className="font-extrabold text-[#4E342E]">{c.price * c.quantity} ETB</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setCart(cart.map((x) => (x.menuItemId === c.menuItemId ? { ...x, quantity: Math.max(1, x.quantity - 1) } : x)))}
                  className="w-7 h-7 rounded-lg bg-stone-100 flex items-center justify-center"
                >
                  <Minus className="w-3.5 h-3.5" />
                </button>
                <span className="font-extrabold w-5 text-center text-[#2C1B17]">{c.quantity}</span>
                <button
                  onClick={() => setCart(cart.map((x) => (x.menuItemId === c.menuItemId ? { ...x, quantity: x.quantity + 1 } : x)))}
                  className="w-7 h-7 rounded-lg bg-[#C9A227] flex items-center justify-center"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => setCart(cart.filter((x) => x.menuItemId !== c.menuItemId))} className="ml-auto text-rose-500 text-xs font-bold">
                  {t("remove")}
                </button>
              </div>
              <input
                value={c.notes}
                onChange={(e) => setCart(cart.map((x) => (x.menuItemId === c.menuItemId ? { ...x, notes: e.target.value } : x)))}
                placeholder={t("note_ph")}
                className="w-full bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-[#2C1B17] placeholder-stone-400"
              />
            </div>
          ))}
        </div>

        {/* submit bar */}
        <div className="fixed bottom-0 left-0 right-0 bg-[#2C1B17] border-t-2 border-[#C9A227] p-4">
          <div className="max-w-lg mx-auto flex items-center gap-3">
            <div className="flex-1">
              <p className="text-[10px] text-stone-400 uppercase font-bold">{cartCount} {t("items_label")}</p>
              <p className="font-serif font-black text-xl text-[#C9A227]">{cartTotal} ETB</p>
            </div>
            <button
              onClick={submitOrder}
              disabled={submitting}
              className="flex-1 bg-gradient-to-r from-[#C9A227] to-amber-500 text-[#2C1B17] font-black text-sm uppercase py-3.5 rounded-xl flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              {submitting ? t("sending") : t("submit_order")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  /* ── MAIN MENU ── */
  return (
    <div className="min-h-screen bg-[#FAF6F0] pb-28">
      <LanguageToggle />
      {/* Header with logo */}
      <header className="bg-[#2C1B17] text-white sticky top-0 z-40 shadow-xl">
        <div className="px-4 py-2.5 flex items-center justify-between max-w-lg mx-auto">
          <div className="flex items-center gap-2.5">
            <img src={logoUrl} alt="Fana" className="w-10 h-10 rounded-full object-contain bg-white p-0.5" />
            <div>
              <p className="font-serif font-bold text-sm text-amber-100 leading-none">{menuText(brandName)}</p>
              <p className="text-[10px] text-[#C9A227] font-bold uppercase tracking-wider">{t("menu_label")} • {menuText(tableName)}</p>
            </div>
          </div>
          <a href={`tel:${phone.replace(/\s+/g, "")}`} className="flex items-center gap-1 bg-[#C9A227] text-[#2C1B17] text-[11px] font-extrabold px-3 py-1.5 rounded-full">
            <Phone className="w-3 h-3" /> {t("waiter")}
          </a>
        </div>
      </header>

      {/* intro */}
      <div className="bg-gradient-to-r from-[#4E342E] to-[#2C1B17] text-amber-100 text-center text-xs py-2.5 px-4">
        {t("intro")}
      </div>

      {/* ── 📢 DAILY BOARD — rotating announcements (auto-slide every few seconds when 2+) ── */}
      {announcements.length > 0 && (
        <div className="mx-4 mt-3 max-w-lg lg:mx-auto">
          {(() => {
            const a = announcements[slideIdx];
            const hasPhoto = Boolean(a?.imageUrl);
            return (
              <div className="relative rounded-2xl shadow-xl overflow-hidden min-h-[175px]">
                {/* full-bleed photo background (no frame) */}
                {hasPhoto && (
                  <>
                    <img src={optimizeImageUrl(a!.imageUrl!, 800, 500)} alt="" className="absolute inset-0 w-full h-full object-cover" onError={(e) => { const el = e.currentTarget; if (!el.src.includes("placeholder")) el.src = FALLBACK_FOOD_IMAGE; }} />
                    {/* dark scrim so white text always pops, on any photo */}
                    <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/45 to-black/15" />
                  </>
                )}

                {/* gold promo card style when there's no image */}
                {!hasPhoto && <div className="absolute inset-0 bg-gradient-to-r from-[#C9A227] via-[#E2B93B] to-[#C9A227]" />}

                {/* content overlay */}
                <div className={`relative z-10 p-5 min-h-[175px] flex flex-col justify-end`}>
                  <p
                    className={`font-serif font-black text-xl leading-tight ${
                      hasPhoto ? "text-white drop-shadow-[0_2px_5px_rgba(0,0,0,0.9)]" : "text-[#2C1B17]"
                    }`}
                  >
                    {menuText(a?.title || "")}
                  </p>
                  {a?.description && (
                    <p
                      className={`text-[13px] font-semibold mt-0.5 leading-snug ${
                        hasPhoto ? "text-white drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]" : "text-[#3D2314]"
                      }`}
                    >
                      {menuText(a.description)}
                    </p>
                  )}
                </div>

                {/* controls — visible on both photo & gold backgrounds */}
                {announcements.length > 1 && (
                  <>
                    <button
                      onClick={() => setSlideIdx((slideIdx - 1 + announcements.length) % announcements.length)}
                      className="absolute left-2 top-1/2 -translate-y-1/2 z-20 w-8 h-8 rounded-full bg-black/40 backdrop-blur-sm text-white flex items-center justify-center hover:bg-black/60 transition"
                      aria-label="Previous"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => setSlideIdx((slideIdx + 1) % announcements.length)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 z-20 w-8 h-8 rounded-full bg-black/40 backdrop-blur-sm text-white flex items-center justify-center hover:bg-black/60 transition"
                      aria-label="Next"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </button>
                    <div className="absolute bottom-2 left-1/2 -translate-x-1/2 z-20 flex gap-1.5">
                      {announcements.map((_, i) => (
                        <button
                          key={i}
                          onClick={() => setSlideIdx(i)}
                          className={`w-1.5 h-1.5 rounded-full transition shadow ${
                            i === slideIdx ? "bg-white w-3.5" : "bg-white/50"
                          }`}
                          aria-label={`Slide ${i + 1}`}
                        />
                      ))}
                    </div>
                  </>
                )}
              </div>
            );
          })()}
        </div>
      )}

      {/* search + categories */}
      <div className="sticky top-[61px] z-30 bg-[#FAF6F0] px-4 pt-3 pb-2 space-y-2 max-w-lg mx-auto">
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("search_ph")}
            className="w-full bg-white border border-[#C9A227]/40 rounded-xl pl-9 pr-3 py-2.5 text-sm shadow-sm"
          />
        </div>
        <div className="flex gap-2 overflow-x-auto pb-1.5 scrollbar-none">
          {categories.map((c) => (
            <button
              key={c.slug}
              onClick={() => setCategory(c.slug)}
              className={`px-3.5 py-1.5 rounded-full text-xs font-bold whitespace-nowrap border transition ${
                category === c.slug ? "bg-[#4E342E] text-amber-200 border-[#C9A227]" : "bg-white text-stone-600 border-stone-200"
              }`}
            >
              {menuText(c.name)}
            </button>
          ))}
        </div>
      </div>

      {/* Branded skeleton — replaces the old "default items flash" while menu loads */}
      {menuLoading && menuItems.length === 0 && (
        <div className="px-4 glass-skeleton max-w-lg mx-auto space-y-4 pt-2">
          <div className="text-center py-6 space-y-2">
            <div className="relative w-14 h-14 mx-auto">
              <img src={logoUrl} alt="Loading" className="w-14 h-14 rounded-full object-contain bg-white border-2 border-[#C9A227] p-0.5 animate-pulse" />
              <span className="absolute inset-0 rounded-full border-2 border-[#C9A227] animate-ping opacity-30" />
            </div>
            <p className="font-serif font-bold text-sm text-[#2C1B17]">{t("loading_menu")}</p>
            <p className="text-[11px] text-stone-500">{t("loading_sub")}</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="bg-white rounded-2xl overflow-hidden border border-stone-200 shadow-sm animate-pulse">
                <div className="w-full h-28 bg-stone-200" />
                <div className="p-3 space-y-2">
                  <div className="h-3 bg-stone-200 rounded w-4/5" />
                  <div className="h-2.5 bg-stone-200 rounded w-2/3" />
                  <div className="flex justify-between pt-1">
                    <div className="h-4 bg-stone-200 rounded w-14" />
                    <div className="h-6 bg-stone-200 rounded w-16" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* menu grid */}
      <div className="px-4 grid grid-cols-2 gap-3 max-w-lg mx-auto">
        {filteredMenu.map((m) => {
          const qty = cartQty(m.id);
          const out = !m.isAvailable;
          return (
            <div key={m.id} className={`bg-white rounded-2xl overflow-hidden border shadow-sm ${out ? "opacity-60 border-stone-200" : "border-[#C9A227]/25"}`}>
              {/* Tap photo or name → BIG detail view with full description */}
              <button
                onClick={() => setDetailItem(m)}
                className="relative w-full text-left cursor-pointer"
                title="Tap for full details"
              >
                <img src={optimizeImageUrl(m.imageUrl, 400, 250)} alt={menuText(m.name)} loading="lazy" decoding="async" className="w-full h-28 object-cover bg-stone-100" onError={(e) => { const el = e.currentTarget; if (!el.src.includes("placeholder")) el.src = FALLBACK_FOOD_IMAGE; }} />
                <span className="absolute bottom-1.5 right-1.5 bg-black/60 text-white text-[9px] font-bold px-2 py-0.5 rounded-full backdrop-blur-sm">
                  🔍 {t("details")}
                </span>
                {out && (
                  <span className="absolute top-2 left-2 bg-rose-600 text-white text-[9px] font-extrabold uppercase px-2 py-0.5 rounded-full">
                    {t("out_of_stock")}
                  </span>
                )}
              </button>
              <div className="p-3 space-y-1.5">
                <button onClick={() => setDetailItem(m)} className="text-left w-full">
                  <p className="text-xs font-bold text-[#2C1B17] leading-tight line-clamp-2 min-h-[2rem] hover:text-[#C9A227] transition-colors">{menuText(m.name)}</p>
                </button>
                <p className="text-[10px] text-stone-500 line-clamp-2">{menuText(m.description)}</p>
                <div className="flex items-center justify-between pt-1 gap-1">
                  {(() => {
                    const ep = effectivePrice(m);
                    return ep.onSale ? (
                      <span className="flex flex-col leading-none">
                        <span className="text-[10px] line-through text-stone-400 font-semibold">{m.price} ETB</span>
                        <span className="font-extrabold text-emerald-700 text-sm">{ep.price} ETB <span className="text-[9px] bg-emerald-600 text-white px-1.5 py-0.5 rounded font-extrabold">{t("sale")}</span></span>
                      </span>
                    ) : (
                      <span className="font-extrabold text-[#4E342E] text-sm">{m.price} ETB</span>
                    );
                  })()}
                  {out ? (
                    <span className="text-[10px] text-stone-400 font-bold">—</span>
                  ) : qty > 0 ? (
                  // Inline −/+ stepper — customer can decrease or remove
                    <div className="flex items-center gap-1.5 bg-stone-100 rounded-lg p-1">
                      <button
                        onClick={() => setQty(m, qty - 1)}
                        className="w-7 h-7 rounded-md bg-white shadow-sm flex items-center justify-center text-[#2C1B17] font-bold hover:bg-rose-50"
                        aria-label="Decrease"
                      >
                        <Minus className="w-3.5 h-3.5" />
                      </button>
                      <span className="font-extrabold w-5 text-center text-[#2C1B17] text-sm">{qty}</span>
                      <button
                        onClick={() => setQty(m, qty + 1)}
                        className="w-7 h-7 rounded-md bg-emerald-600 shadow-sm flex items-center justify-center text-white font-bold"
                        aria-label="Increase"
                      >
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setQty(m, 1)}
                      className="text-[11px] font-extrabold px-3 py-1.5 rounded-lg flex items-center gap-1 transition bg-[#C9A227] text-[#2C1B17]"
                    >
                      <Plus className="w-3 h-3" /> {t("add")}
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        {!menuLoading && filteredMenu.length === 0 && (
          <div className="col-span-2 text-center py-12 text-stone-400 text-sm">
            <Utensils className="w-8 h-8 mx-auto mb-2 text-stone-300" />
            {t("nothing_found")}
          </div>
        )}
      </div>

      {/* ── ITEM DETAIL MODAL — big photo + FULL description ── */}
      {detailItem && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => setDetailItem(null)}>
          <div
            className="bg-white rounded-t-3xl sm:rounded-3xl max-w-lg w-full max-h-[90vh] overflow-y-auto shadow-2xl animate-scaleUp"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="relative">
              <img src={optimizeImageUrl(detailItem.imageUrl, 600, 400)} alt={menuText(detailItem.name)} className="w-full h-56 sm:h-64 object-cover bg-stone-100" onError={(e) => { const el = e.currentTarget; if (!el.src.includes("placeholder")) el.src = FALLBACK_FOOD_IMAGE; }} />
              <button
                onClick={() => setDetailItem(null)}
                className="absolute top-3 right-3 w-9 h-9 rounded-full bg-black/60 text-white flex items-center justify-center hover:bg-black"
                aria-label="Close"
              >
                <X className="w-5 h-5" />
              </button>
              {detailItem.badge && (
                <span className="absolute top-3 left-3 bg-[#C9A227] text-[#2C1B17] text-[10px] font-extrabold uppercase px-3 py-1 rounded-full">
                  {menuText(detailItem.badge)}
                </span>
              )}
            </div>

            <div className="p-5 space-y-4">
              <div className="flex items-start justify-between gap-3">
                <h2 className="font-serif font-bold text-xl text-[#2C1B17] flex-1">{menuText(detailItem.name)}</h2>
                {(() => {
                  const ep = effectivePrice(detailItem);
                  return ep.onSale ? (
                    <span className="flex flex-col items-end leading-none whitespace-nowrap">
                      <span className="text-xs line-through text-stone-400 font-semibold">{detailItem.price} ETB</span>
                      <span className="font-serif font-black text-xl text-emerald-700">
                        {ep.price} ETB <span className="text-[10px] bg-emerald-600 text-white px-1.5 py-0.5 rounded font-extrabold align-middle">{t("sale")}</span>
                      </span>
                      <span className="text-[10px] text-emerald-600 font-bold mt-0.5">{t("you_save")} {ep.savings} ETB{detailItem.saleEnd ? ` • ${t("until")} ${detailItem.saleEnd}` : ""}</span>
                    </span>
                  ) : (
                    <span className="font-serif font-black text-xl text-[#4E342E] whitespace-nowrap">{detailItem.price} ETB</span>
                  );
                })()}
              </div>

              {/* FULL description — nothing hidden */}
              <div>
                <p className="text-[10px] font-extrabold uppercase tracking-wider text-stone-400 mb-1">{t("description")}</p>
                <p className="text-sm text-stone-700 leading-relaxed">{menuText(detailItem.description)}</p>
              </div>

              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                {detailItem.prepTime && (
                  <span className="flex items-center gap-1 bg-amber-50 text-amber-800 border border-amber-200 px-2.5 py-1 rounded-full font-bold">
                    ⏱ {detailItem.prepTime}
                  </span>
                )}
                {detailItem.dietaryTags &&
                  detailItem.dietaryTags.split(",").map((t, i) => (
                    <span key={i} className="bg-emerald-50 text-emerald-700 border border-emerald-200 px-2.5 py-1 rounded-full font-bold">
                      ✓ {menuText(t.trim())}
                    </span>
                  ))}
              </div>

              {detailItem.isAvailable ? (
                <div className="pt-2 border-t border-stone-100 flex items-center gap-3">
                  {cartQty(detailItem.id) > 0 ? (
                    <div className="flex items-center gap-2 bg-stone-100 rounded-xl p-1.5">
                      <button onClick={() => setQty(detailItem, cartQty(detailItem.id) - 1)} className="w-9 h-9 rounded-lg bg-white shadow-sm flex items-center justify-center font-bold">
                        <Minus className="w-4 h-4" />
                      </button>
                      <span className="font-extrabold w-7 text-center text-lg">{cartQty(detailItem.id)}</span>
                      <button onClick={() => setQty(detailItem, cartQty(detailItem.id) + 1)} className="w-9 h-9 rounded-lg bg-emerald-600 shadow-sm flex items-center justify-center text-white font-bold">
                        <Plus className="w-4 h-4" />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setQty(detailItem, 1)}
                      className="flex-1 bg-gradient-to-r from-[#C9A227] to-amber-500 text-[#2C1B17] font-black text-sm uppercase py-3.5 rounded-xl flex items-center justify-center gap-2 shadow-lg"
                    >
                      <Plus className="w-4 h-4" /> {t("add_to_order")} — {effectivePrice(detailItem).price} ETB
                    </button>
                  )}
                </div>
              ) : (
                <div className="pt-2 border-t border-stone-100">
                  <span className="block text-center bg-rose-100 text-rose-700 font-bold text-sm py-3 rounded-xl">{t("out_of_stock")}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ═══════════ BELOW-MENU CONTENT (customers scroll while waiting) ═══════════ */}
      <div className="max-w-lg mx-auto px-4 mt-10 space-y-10">

        {/* 3. ABOUT US — short, 2–3 sentences */}
        <section className="bg-white rounded-2xl p-5 border border-[#C9A227]/25 shadow-sm">
          <h3 className="font-serif font-bold text-lg text-[#2C1B17] flex items-center gap-2">{t("about_us")}</h3>
          <p className="text-sm text-stone-600 leading-relaxed mt-2">
            {menuText(
              settings.about_description?.split(".").slice(0, 2).join(".") ||
                "Since 2018, Fana Cafe has served premium Ethiopian coffee, fresh pastries, and traditional meals in a comfortable atmosphere. Made with love in Addis Ababa."
            )}
          </p>
        </section>

        {/* 4. GALLERY — photos to browse while waiting */}
        {galleryPhotos.length > 0 && (
          <section>
            <h3 className="font-serif font-bold text-lg text-[#2C1B17] mb-3 flex items-center gap-2">
              <Camera className="w-5 h-5 text-[#C9A227]" /> {t("gallery")}
            </h3>
            <div className="grid grid-cols-3 gap-2">
              {galleryPhotos.slice(0, 6).map((g) => (
                <img key={g.id} src={optimizeImageUrl(g.imageUrl, 300, 200)} alt={menuText(g.title)} className="w-full h-24 object-cover rounded-xl shadow-sm bg-stone-100" loading="lazy" onError={(e) => { const el = e.currentTarget; if (!el.src.includes("placeholder")) el.src = FALLBACK_FOOD_IMAGE; }} />
              ))}
            </div>
          </section>
        )}

        {/* 5. SERVICES — very short */}
        <section className="bg-[#2C1B17] rounded-2xl p-5">
          <h3 className="font-serif font-bold text-lg text-amber-100 mb-3">{t("what_we_serve")}</h3>
          <div className="grid grid-cols-2 gap-2 text-xs">
            {[t("premium_coffee"), t("ethiopian_meals"), t("fresh_pastries"), t("fresh_juices")].map((s) => (
              <div key={s} className="bg-[#3D2314] text-amber-100 font-bold px-3 py-2.5 rounded-xl text-center border border-[#C9A227]/20">
                {s}
              </div>
            ))}
          </div>
        </section>

        {/* 6. FIND US — map, address, phone, hours (customers save/share) */}
        <section className="bg-white rounded-2xl p-5 border border-[#C9A227]/25 shadow-sm space-y-3">
          <h3 className="font-serif font-bold text-lg text-[#2C1B17] flex items-center gap-2">
            <MapPin className="w-5 h-5 text-[#C9A227]" /> {t("find_us")}
          </h3>
          <iframe
            title="Fana Location"
            src="https://maps.google.com/maps?q=9.0148457,38.7875868&z=17&output=embed"
            className="w-full h-44 rounded-xl border border-stone-200"
            loading="lazy"
          />
          <div className="text-xs text-stone-600 space-y-1.5">
            <p>📍 {menuText(settings.address || "Town Square Building, 22 Square, Djibouti Street, Addis Ababa")}</p>
            <p>📞 <a href={`tel:${String(settings.phone || "0911065022").replace(/\s+/g, "")}`} className="font-extrabold text-[#4E342E]">{settings.phone || "0911 065 022"}</a></p>
            <p>🕒 {menuText(settings.opening_hours || "Open Daily Until 8:30 PM")}</p>
            <p className="text-stone-400">Plus Code: {settings.plus_code || "2Q7Q+W2 Addis Ababa"}</p>
          </div>
          <a
            href="https://www.google.com/maps/place/Fana+cafe/@9.0148457,38.7875868,17z"
            target="_blank"
            rel="noreferrer"
            className="block text-center bg-[#4E342E] text-amber-200 font-bold text-xs py-2.5 rounded-xl"
          >
            {t("open_maps")}
          </a>
        </section>

        {/* 7. REVIEWS — 3–5 recent + leave a review */}
        <section className="space-y-3">
          <h3 className="font-serif font-bold text-lg text-[#2C1B17] flex items-center gap-2">
            <Star className="w-5 h-5 text-[#C9A227] fill-[#C9A227]" /> {t("what_guests_say")}
          </h3>
          {approvedReviews.map((r) => (
            <div key={r.id} className="bg-white rounded-2xl p-4 border border-stone-200 shadow-sm">
              <div className="flex items-center justify-between">
                <p className="text-xs font-bold text-[#2C1B17]">{r.customerName}</p>
                <span className="text-[#C9A227] text-xs font-bold">{"★".repeat(r.rating)}{"☆".repeat(5 - r.rating)}</span>
              </div>
              <p className="text-xs text-stone-600 mt-1.5 leading-relaxed italic">"{menuText(r.reviewText)}"</p>
            </div>
          ))}

          {/* leave a review — inline quick form */}
          <div className="bg-[#2C1B17] rounded-2xl p-5 space-y-3">
            <p className="font-bold text-sm text-amber-100 flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-[#C9A227]" /> {t("leave_review")}
            </p>
            <input
              value={revName}
              onChange={(e) => setRevName(e.target.value)}
              placeholder={t("your_name_ph")}
              className="w-full bg-[#3D2314] border border-stone-700 rounded-xl px-3 py-2.5 text-xs text-white"
            />
            <div className="flex gap-1.5">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  onClick={() => setRevRating(n)}
                  className={`text-xl transition ${n <= revRating ? "text-[#C9A227]" : "text-stone-600"}`}
                  aria-label={`${n} stars`}
                >
                  ★
                </button>
              ))}
            </div>
            <textarea
              rows={2}
              value={revText}
              onChange={(e) => setRevText(e.target.value)}
              placeholder={t("review_q_ph")}
              className="w-full bg-[#3D2314] border border-stone-700 rounded-xl px-3 py-2.5 text-xs text-white"
            />
            {revMsg && <p className="text-[11px] font-bold text-amber-300">{revMsg}</p>}
            <button
              onClick={submitReview}
              disabled={revSending}
              className="w-full bg-[#C9A227] text-[#2C1B17] font-black text-xs uppercase py-3 rounded-xl disabled:opacity-50"
            >
              {revSending ? t("sending") : t("submit_review")}
            </button>
            <p className="text-[10px] text-stone-500 text-center">{t("reviews_note")}</p>
          </div>
        </section>
      </div>

      {/* 8. FOOTER — phone + socials + copyright */}
      <footer className="bg-[#1C120F] text-stone-400 mt-10 pb-24 pt-8">
        <div className="max-w-lg mx-auto px-4 text-center space-y-4">
          <img src={logoUrl} alt="Fana Cafe" className="w-12 h-12 rounded-full object-contain bg-white mx-auto border-2 border-[#C9A227] p-0.5" />
          <p className="font-serif font-bold text-amber-100 text-sm">{menuText(brandName)}</p>
          <a href={`tel:${String(settings.phone || "0911065022").replace(/\s+/g, "")}`} className="inline-flex items-center gap-2 text-[#C9A227] font-bold text-sm">
            <Phone className="w-4 h-4" /> {settings.phone || "0911 065 022"}
          </a>
          <div className="flex items-center justify-center gap-4 pt-1">
            <a href="https://facebook.com" target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-xs font-bold bg-white/10 px-3.5 py-2 rounded-full hover:bg-white/20">
              <Globe className="w-3.5 h-3.5 text-[#C9A227]" /> Facebook
            </a>
            <a href="https://instagram.com" target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-xs font-bold bg-white/10 px-3.5 py-2 rounded-full hover:bg-white/20">
              <Camera className="w-3.5 h-3.5 text-[#C9A227]" /> Instagram
            </a>
            <a href="https://t.me" target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-xs font-bold bg-white/10 px-3.5 py-2 rounded-full hover:bg-white/20">
              <Send className="w-3.5 h-3.5 text-[#C9A227]" /> Telegram
            </a>
          </div>
          <p className="text-[10px] text-stone-600 pt-2">
            © {new Date().getFullYear()} {brandName} • {settings.plus_code || "2Q7Q+W2 Addis Ababa"}
          </p>
          <div className="bg-[#C9A227]/10 border border-[#C9A227]/30 rounded-xl py-2.5 px-3">
            <p className="text-[11px] font-black text-[#C9A227] tracking-wider uppercase">Powered by AB Web</p>
            <a href="tel:+251919081802" className="text-[11px] font-bold text-stone-300 hover:text-amber-300">
              📞 +251 91 908 1802 — AB Web · Digital Menus & Websites
            </a>
          </div>
        </div>
      </footer>

      {/* cart bar */}
      {cart.length > 0 && (
        <div className="fixed bottom-0 left-0 right-0 z-40 bg-[#2C1B17] border-t-2 border-[#C9A227] p-4">
          <div className="max-w-lg mx-auto flex items-center gap-3">
            <div className="flex-1">
              <p className="text-[10px] text-stone-400 uppercase font-bold">{cartCount} {t("items_label")}</p>
              <p className="font-serif font-black text-xl text-[#C9A227]">{cartTotal} ETB</p>
            </div>
            <button
              onClick={() => setReviewMode(true)}
              className="flex-1 bg-gradient-to-r from-[#C9A227] to-amber-500 text-[#2C1B17] font-black text-sm uppercase py-3.5 rounded-xl flex items-center justify-center gap-2"
            >
              <Coffee className="w-4 h-4" /> {t("review_order")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
