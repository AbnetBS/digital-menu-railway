"use client";

import { useState, useEffect } from "react";
import { Megaphone, Plus, Trash2, Edit3, RefreshCw, Upload, Calendar, Gift } from "lucide-react";
import { Announcement, DailyPromotion, DailyPromotionItem, DailyPromotionType, MenuItem } from "@/types";
import { compressImage } from "@/lib/image-utils";

const PROMOTION_OPTIONS: Array<{ value: "none" | DailyPromotionType; label: string }> = [
  { value: "none", label: "None — announcement only" },
  { value: "special_price", label: "Special Price" },
  { value: "percentage_discount", label: "Percentage Discount" },
  { value: "fixed_amount_discount", label: "Fixed Amount Discount" },
  { value: "buy_x_get_y", label: "Buy X Get Y" },
  { value: "buy_x_get_y_discounted", label: "Buy X Get Y Discounted" },
  { value: "combo", label: "Combo / Bundle" },
];

const PROMOTION_LABELS: Record<DailyPromotionType, string> = Object.fromEntries(
  PROMOTION_OPTIONS.filter((option): option is { value: DailyPromotionType; label: string } => option.value !== "none").map((option) => [option.value, option.label])
) as Record<DailyPromotionType, string>;

export default function DailyBoardTab() {
  const [items, setItems] = useState<Announcement[]>([]);
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [editing, setEditing] = useState<Partial<Announcement> | null>(null);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    const [announcementsResponse, menuResponse] = await Promise.all([
      fetch("/api/announcements"),
      fetch("/api/menu"),
    ]);
    if (announcementsResponse.ok) setItems(await announcementsResponse.json());
    if (menuResponse.ok) setMenuItems(await menuResponse.json());
  };

  useEffect(() => {
    load();
  }, []);

  const save = async () => {
    if (!editing) return;
    setSaving(true);
    const r = await fetch("/api/announcements", {
      method: editing.id ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(editing),
    });
    setSaving(false);
    if (r.ok) {
      setEditing(null);
      load();
    } else {
      const response = await r.json().catch(() => ({}));
      alert(response.error || "Failed to save announcement");
    }
  };

  const remove = async (id: number) => {
    if (!confirm("Delete this announcement?")) return;
    await fetch(`/api/announcements?id=${id}`, { method: "DELETE" });
    load();
  };

  const handlePhoto = async (f: File | undefined) => {
    if (!f) return;
    // Compress on device; the server persists the image only when the
    // announcement is saved (no database write on a canceled upload).
    const small = await compressImage(f, 900, 0.68);
    setEditing((prev) => ({ ...prev, imageUrl: small }));
  };

  const isLive = (a: Announcement) => {
    const today = new Date().toISOString().slice(0, 10);
    if (a.startDate && today < a.startDate) return false;
    if (a.endDate && today > a.endDate) return false;
    return true;
  };

  const defaultItem = (): DailyPromotionItem => ({ menuItemId: menuItems[0]?.id || 0, quantity: 1 });

  const makePromotion = (type: DailyPromotionType, previous?: DailyPromotion | null): DailyPromotion => {
    const base = {
      isActive: previous?.isActive ?? true,
      ...(previous?.startTime ? { startTime: previous.startTime } : {}),
      ...(previous?.endTime ? { endTime: previous.endTime } : {}),
    };
    const previousItems = previous?.items || [];
    if (type === "buy_x_get_y" || type === "buy_x_get_y_discounted") {
      const itemsWithRoles = previousItems.length >= 2
        ? previousItems.map((item, index) => ({ ...item, role: item.role || (index === 0 ? "buy" : "get") as "buy" | "get" }))
        : [{ ...defaultItem(), role: "buy" as const }, { ...defaultItem(), role: "get" as const }];
      return {
        type,
        items: itemsWithRoles,
        ...base,
        ...(type === "buy_x_get_y_discounted" ? { getDiscountPercent: previous?.getDiscountPercent ?? 50 } : {}),
      };
    }

    const items = type === "special_price" || type === "percentage_discount" || type === "fixed_amount_discount"
      ? [previousItems[0] ? { menuItemId: previousItems[0].menuItemId, quantity: previousItems[0].quantity } : defaultItem()]
      : previousItems.length ? previousItems.map(({ menuItemId, quantity }) => ({ menuItemId, quantity })) : [defaultItem()];
    return {
      type,
      items,
      ...base,
      ...(type === "special_price" || type === "combo" ? { specialPrice: previous?.specialPrice ?? 0 } : {}),
      ...(type === "percentage_discount" ? { discountPercent: previous?.discountPercent ?? 20 } : {}),
      ...(type === "fixed_amount_discount" ? { discountAmount: previous?.discountAmount ?? 100 } : {}),
    };
  };

  const updatePromotion = (patch: Partial<DailyPromotion>) => {
    if (!editing?.promotionItems) return;
    setEditing({ ...editing, promotionItems: { ...editing.promotionItems, ...patch } });
  };

  const updatePromotionItem = (index: number, patch: Partial<DailyPromotionItem>) => {
    if (!editing?.promotionItems) return;
    const promotionItems = [...editing.promotionItems.items];
    promotionItems[index] = { ...promotionItems[index], ...patch };
    updatePromotion({ items: promotionItems });
  };

  const promotion = editing?.promotionItems || null;
  const promotionType = promotion?.type || "none";
  const needsBuyGetRoles = promotion?.type === "buy_x_get_y" || promotion?.type === "buy_x_get_y_discounted";
  const canAddPromotionItem = promotion?.type === "combo" || needsBuyGetRoles;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-serif font-bold text-amber-100">📢 Daily Board</h2>
          <p className="text-xs text-stone-400">
            Rotating promos on the customer QR menu: specials, new items, sold-out notes, holiday greetings. Slides automatically when you have 2+.
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={load} className="p-2 bg-white/10 hover:bg-white/20 text-amber-200 rounded-xl" title="Refresh">
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            onClick={() =>
              setEditing({
                title: "🔥 Today's Special",
                description: "Buy 2 Cappuccinos, get 1 Cookie FREE — today only!",
                startDate: new Date().toISOString().slice(0, 10),
                endDate: new Date().toISOString().slice(0, 10),
                priority: items.length,
              })
            }
            className="bg-[#C9A227] hover:bg-amber-400 text-[#2C1B17] font-bold text-xs uppercase px-4 py-2.5 rounded-xl flex items-center gap-2"
          >
            <Plus className="w-4 h-4" /> New Announcement
          </button>
        </div>
      </div>

      {/* List */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {items.map((a) => (
          <div key={a.id} className="bg-[#2C1B17] border border-stone-800 rounded-2xl p-4 space-y-3">
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1">
                <p className="text-sm font-bold text-amber-100">{a.title}</p>
                <p className="text-xs text-stone-400 mt-1 line-clamp-2">{a.description}</p>
              </div>
              <span
                className={`shrink-0 text-[10px] font-black px-2 py-1 rounded-full uppercase ${
                  isLive(a) ? "bg-emerald-500/20 text-emerald-400" : "bg-stone-700 text-stone-400"
                }`}
              >
                {isLive(a) ? "● LIVE" : "Scheduled"}
              </span>
            </div>
            <div className="flex items-center gap-2 text-[11px] text-stone-500">
              <Calendar className="w-3.5 h-3.5 text-[#C9A227]" />
              <span>
                {a.startDate || "Any"} → {a.endDate || "Any"}
                {a.imageUrl ? " • 📸 image" : ""}
                {a.promotionItems ? ` • 🎁 ${PROMOTION_LABELS[a.promotionItems.type]}` : " • display only"}
              </span>
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setEditing(a)} className="p-2 bg-amber-500/20 text-amber-300 hover:bg-amber-500 hover:text-black rounded-lg" title="Edit">
                <Edit3 className="w-4 h-4" />
              </button>
              <button onClick={() => remove(a.id)} className="p-2 bg-rose-500/20 text-rose-300 hover:bg-rose-500 hover:text-white rounded-lg" title="Delete">
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        ))}
        {items.length === 0 && (
          <div className="col-span-2 bg-[#2C1B17] border border-stone-800 rounded-2xl p-10 text-center text-stone-500 text-xs">
            No announcements yet — create your first daily special above!
          </div>
        )}
      </div>

      {/* Edit modal */}
      {editing && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-[#2C1B17] rounded-3xl max-w-md w-full p-6 border border-[#C9A227] space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-stone-800 pb-3">
              <h3 className="font-serif font-bold text-lg text-amber-100 flex items-center gap-2">
                <Megaphone className="w-5 h-5 text-[#C9A227]" /> {editing.id ? "Edit" : "New"} Announcement
              </h3>
              <button onClick={() => setEditing(null)} className="text-stone-400 hover:text-white">✕</button>
            </div>

            <div>
              <label className="block text-xs font-bold text-amber-200 mb-1">Title *</label>
              <input
                value={editing.title || ""}
                onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                placeholder="🔥 Today's Special"
                className="w-full bg-[#3D2314] border border-stone-700 rounded-xl p-3 text-xs text-white"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-amber-200 mb-1">Message *</label>
              <textarea
                rows={2}
                value={editing.description || ""}
                onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                placeholder="20% OFF Chicken Sandwich — today only!"
                className="w-full bg-[#3D2314] border border-stone-700 rounded-xl p-3 text-xs text-white"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold text-amber-200 mb-1">Start Date</label>
                <input type="date" value={editing.startDate || ""} onChange={(e) => setEditing({ ...editing, startDate: e.target.value })} className="w-full bg-[#3D2314] border border-stone-700 rounded-xl p-3 text-xs text-white" />
              </div>
              <div>
                <label className="block text-xs font-bold text-amber-200 mb-1">End Date (auto-hides)</label>
                <input type="date" value={editing.endDate || ""} onChange={(e) => setEditing({ ...editing, endDate: e.target.value })} className="w-full bg-[#3D2314] border border-stone-700 rounded-xl p-3 text-xs text-white" />
              </div>
            </div>

            <div className="bg-[#3D2314] rounded-2xl p-4 border border-stone-700 space-y-3">
              <div>
                <p className="text-xs font-bold text-amber-200 flex items-center gap-1.5"><Gift className="w-3.5 h-3.5" /> Promotion</p>
                <p className="text-[11px] text-stone-400 mt-1">Promotions use your existing menu items. Customer prices are calculated securely when the order is sent.</p>
              </div>
              <div>
                <label className="block text-[11px] font-bold text-stone-300 mb-1">Promotion type</label>
                <select
                  value={promotionType}
                  onChange={(e) => {
                    const type = e.target.value as "none" | DailyPromotionType;
                    setEditing({ ...editing, promotionItems: type === "none" ? null : makePromotion(type, promotion) });
                  }}
                  className="w-full bg-[#2C1B17] border border-stone-700 rounded-xl p-3 text-xs text-white"
                >
                  {PROMOTION_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </div>

              {promotion && (
                <>
                  <label className="flex items-center gap-2 text-[11px] font-bold text-emerald-300 cursor-pointer">
                    <input type="checkbox" checked={promotion.isActive} onChange={(e) => updatePromotion({ isActive: e.target.checked })} className="accent-emerald-500" />
                    Promotion is active and can be ordered
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[11px] font-bold text-stone-300 mb-1">Start Time (optional)</label>
                      <input type="time" value={promotion.startTime || ""} onChange={(e) => updatePromotion({ startTime: e.target.value || null })} className="w-full bg-[#2C1B17] border border-stone-700 rounded-xl p-2.5 text-xs text-white" />
                    </div>
                    <div>
                      <label className="block text-[11px] font-bold text-stone-300 mb-1">End Time (optional)</label>
                      <input type="time" value={promotion.endTime || ""} onChange={(e) => updatePromotion({ endTime: e.target.value || null })} className="w-full bg-[#2C1B17] border border-stone-700 rounded-xl p-2.5 text-xs text-white" />
                    </div>
                  </div>

                  {(promotion.type === "special_price" || promotion.type === "combo") && (
                    <div>
                      <label className="block text-[11px] font-bold text-stone-300 mb-1">{promotion.type === "combo" ? "Combo price (ETB)" : "Special price per item (ETB)"}</label>
                      <input type="number" min="0" value={promotion.specialPrice ?? 0} onChange={(e) => updatePromotion({ specialPrice: Number(e.target.value) })} className="w-full bg-[#2C1B17] border border-stone-700 rounded-xl p-2.5 text-xs text-white" />
                    </div>
                  )}
                  {promotion.type === "percentage_discount" && (
                    <div>
                      <label className="block text-[11px] font-bold text-stone-300 mb-1">Discount (%)</label>
                      <input type="number" min="0" max="100" value={promotion.discountPercent ?? 0} onChange={(e) => updatePromotion({ discountPercent: Number(e.target.value) })} className="w-full bg-[#2C1B17] border border-stone-700 rounded-xl p-2.5 text-xs text-white" />
                    </div>
                  )}
                  {promotion.type === "fixed_amount_discount" && (
                    <div>
                      <label className="block text-[11px] font-bold text-stone-300 mb-1">Discount amount (ETB)</label>
                      <input type="number" min="0" value={promotion.discountAmount ?? 0} onChange={(e) => updatePromotion({ discountAmount: Number(e.target.value) })} className="w-full bg-[#2C1B17] border border-stone-700 rounded-xl p-2.5 text-xs text-white" />
                    </div>
                  )}
                  {promotion.type === "buy_x_get_y_discounted" && (
                    <div>
                      <label className="block text-[11px] font-bold text-stone-300 mb-1">Get item discount (%)</label>
                      <input type="number" min="0" max="100" value={promotion.getDiscountPercent ?? 0} onChange={(e) => updatePromotion({ getDiscountPercent: Number(e.target.value) })} className="w-full bg-[#2C1B17] border border-stone-700 rounded-xl p-2.5 text-xs text-white" />
                    </div>
                  )}

                  <div className="space-y-2">
                    <p className="text-[11px] font-bold text-stone-300">{needsBuyGetRoles ? "Buy and get items" : promotion.type === "combo" ? "Bundle items" : "Menu item"}</p>
                    {promotion.items.map((promotionItem, index) => (
                      <div key={index} className="rounded-xl border border-stone-700 bg-[#2C1B17] p-3 space-y-2">
                        <div className="flex gap-2">
                          <select value={promotionItem.menuItemId || ""} onChange={(e) => updatePromotionItem(index, { menuItemId: Number(e.target.value) })} className="min-w-0 flex-1 bg-[#3D2314] border border-stone-700 rounded-lg px-2 py-2 text-xs text-white">
                            <option value="" disabled>Select menu item</option>
                            {menuItems.map((m) => <option key={m.id} value={m.id}>{m.name} — {m.price} ETB</option>)}
                          </select>
                          {canAddPromotionItem && (
                            <button type="button" onClick={() => updatePromotion({ items: promotion.items.filter((_, itemIndex) => itemIndex !== index) })} className="w-8 h-8 shrink-0 rounded-lg bg-rose-500/15 text-rose-300 hover:bg-rose-500 hover:text-white flex items-center justify-center" aria-label="Remove promotion item">
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <label className="flex items-center gap-2 text-[11px] font-bold text-stone-300">
                            Qty
                            <input type="number" min="1" max="100" value={promotionItem.quantity} onChange={(e) => updatePromotionItem(index, { quantity: Number(e.target.value) })} className="w-16 bg-[#3D2314] border border-stone-700 rounded-lg px-2 py-1.5 text-xs text-white" />
                          </label>
                          {needsBuyGetRoles && (
                            <label className="flex items-center gap-2 text-[11px] font-bold text-amber-200">
                              <span>Customer gets</span>
                              <select value={promotionItem.role || "buy"} onChange={(e) => updatePromotionItem(index, { role: e.target.value as "buy" | "get" })} className="bg-[#3D2314] border border-stone-700 rounded-lg px-2 py-1.5 text-xs text-white">
                                <option value="buy">Buy / pay normal price</option>
                                <option value="get">Get promotional item</option>
                              </select>
                            </label>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                  {canAddPromotionItem && (
                    <button type="button" onClick={() => updatePromotion({ items: [...promotion.items, { ...defaultItem(), ...(needsBuyGetRoles ? { role: "get" as const } : {}) }] })} disabled={menuItems.length === 0} className="w-full border border-dashed border-[#C9A227]/60 text-amber-200 hover:bg-[#C9A227]/10 text-xs font-bold py-2 rounded-xl disabled:opacity-40">
                      + Add another menu item
                    </button>
                  )}
                </>
              )}
            </div>

            <div className="bg-[#3D2314] rounded-2xl p-4 border border-stone-700 space-y-2">
              <p className="text-xs font-bold text-amber-200">Image (optional)</p>
              {editing.imageUrl && <img src={editing.imageUrl} alt="preview" className="w-full h-28 object-cover rounded-xl border border-stone-600" />}
              <label className="flex items-center justify-center gap-2 w-full bg-[#C9A227] hover:bg-amber-400 text-[#2C1B17] font-extrabold text-xs py-2.5 rounded-xl cursor-pointer">
                <Upload className="w-4 h-4" /> {editing.imageUrl ? "Change Photo" : "Upload Photo"}
                <input type="file" accept="image/*" className="hidden" onChange={(e) => handlePhoto(e.target.files?.[0])} />
              </label>
            </div>

            <div>
              <label className="block text-xs font-bold text-amber-200 mb-1">Priority (lower shows first)</label>
              <input type="number" value={editing.priority ?? 0} onChange={(e) => setEditing({ ...editing, priority: Number(e.target.value) })} className="w-full bg-[#3D2314] border border-stone-700 rounded-xl p-3 text-xs text-white" />
            </div>

            <button onClick={save} disabled={saving || !editing.title} className="w-full bg-gradient-to-r from-[#C9A227] to-amber-500 text-[#2C1B17] font-black text-sm uppercase py-3.5 rounded-xl disabled:opacity-40">
              {saving ? "Saving..." : "Post To Daily Board"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
