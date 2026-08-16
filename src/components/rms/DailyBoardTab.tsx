"use client";

import { useState, useEffect } from "react";
import { Megaphone, Plus, Trash2, Edit3, RefreshCw, Upload, Calendar } from "lucide-react";
import { Announcement } from "@/types";
import { compressImage } from "@/lib/image-utils";

export default function DailyBoardTab() {
  const [items, setItems] = useState<Announcement[]>([]);
  const [editing, setEditing] = useState<Partial<Announcement> | null>(null);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    const r = await fetch("/api/announcements");
    if (r.ok) setItems(await r.json());
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
    } else alert("Failed to save announcement");
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
                placeholder="Buy 2 Cappuccinos, get 1 Cookie FREE — today only!"
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
