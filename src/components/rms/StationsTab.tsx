"use client";

import { useState, useEffect } from "react";
import { Coffee, CookingPot, RefreshCw, Save, CheckCircle2 } from "lucide-react";
import { DEFAULT_CATEGORY_ROUTING } from "@/lib/initial-data";

type Station = "barista" | "kitchen";

export default function StationsTab() {
  const [categories, setCategories] = useState<Array<{ id: number; name: string; slug: string }>>([]);
  const [routing, setRouting] = useState<Record<string, Station>>(DEFAULT_CATEGORY_ROUTING);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState("");

  const load = async () => {
    const [cRes, sRes] = await Promise.all([fetch("/api/categories"), fetch("/api/settings")]);
    if (cRes.ok) {
      const all = await cRes.json();
      setCategories(all.filter((c: any) => c.slug !== "all"));
    }
    if (sRes.ok) {
      const s = await sRes.json();
      if (s.category_routing) {
        try {
          setRouting((prev) => ({ ...prev, ...JSON.parse(s.category_routing) }));
        } catch {}
      }
    }
  };

  useEffect(() => {
    load();
  }, []);

  const save = async () => {
    setSaving(true);
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category_routing: JSON.stringify(routing) }),
    });
    setSaving(false);
    if (res.ok) {
      setSavedMsg("✓ Stations routing saved — all new orders will split correctly by station");
      setTimeout(() => setSavedMsg(""), 3500);
    } else alert("Failed to save routing.");
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-serif font-bold text-amber-100">👨‍🍳 Stations Routing (Barista vs Kitchen)</h2>
          <p className="text-xs text-stone-400">
            Choose which station each food category goes to. Drinks & juices default to <strong className="text-amber-200">Barista</strong>; food & pastries default to <strong className="text-amber-200">Kitchen (Chef)</strong>.
          </p>
        </div>
        <button
          onClick={save}
          disabled={saving}
          className="bg-[#C9A227] hover:bg-amber-400 text-[#2C1B17] font-black text-xs uppercase px-5 py-3 rounded-xl flex items-center gap-2 disabled:opacity-40"
        >
          <Save className="w-4 h-4" />
          {saving ? "Saving..." : "Save Routing"}
        </button>
      </div>

      {savedMsg && (
        <div className="bg-emerald-900/60 border border-emerald-500 text-emerald-200 text-xs p-3 rounded-xl flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          <span>{savedMsg}</span>
        </div>
      )}

      <div className="bg-[#2C1B17] rounded-2xl border border-[#C9A227]/30 p-5 space-y-1">
        <div className="grid grid-cols-[1fr_auto_auto] gap-3 items-center pb-3 border-b border-stone-800 text-[10px] uppercase font-extrabold text-stone-400">
          <span>Category</span>
          <span className="flex items-center gap-1.5 text-amber-200"><Coffee className="w-3.5 h-3.5" /> Barista</span>
          <span className="flex items-center gap-1.5 text-emerald-200"><CookingPot className="w-3.5 h-3.5" /> Kitchen</span>
        </div>

        <div className="divide-y divide-stone-800">
          {categories.map((c) => (
            <div key={c.id} className="grid grid-cols-[1fr_auto_auto] gap-3 items-center py-2.5">
              <span className="text-xs font-bold text-amber-100">{c.name}</span>
              <button
                onClick={() => setRouting({ ...routing, [c.slug]: "barista" })}
                className={`w-7 h-7 rounded-full border-2 flex items-center justify-center transition ${
                  routing[c.slug] === "barista"
                    ? "bg-amber-500 border-amber-400"
                    : "border-stone-600 hover:border-amber-500"
                }`}
                title={`Send "${c.name}" to Barista`}
                aria-label={`Route ${c.name} to barista`}
              >
                {routing[c.slug] === "barista" && <span className="w-3 h-3 rounded-full bg-white" />}
              </button>
              <button
                onClick={() => setRouting({ ...routing, [c.slug]: "kitchen" })}
                className={`w-7 h-7 rounded-full border-2 flex items-center justify-center transition ${
                  routing[c.slug] === "kitchen"
                    ? "bg-emerald-500 border-emerald-400"
                    : "border-stone-600 hover:border-emerald-500"
                }`}
                title={`Send "${c.name}" to Kitchen`}
                aria-label={`Route ${c.name} to kitchen`}
              >
                {routing[c.slug] === "kitchen" && <span className="w-3 h-3 rounded-full bg-white" />}
              </button>
            </div>
          ))}
          {categories.length === 0 && (
            <p className="py-6 text-center text-xs text-stone-500">No categories yet. Add them under the Menu tab.</p>
          )}
        </div>
      </div>

      <div className="bg-[#2C1B17]/70 border border-stone-800 rounded-xl p-4 text-xs text-stone-400 space-y-1.5">
        <p className="font-bold text-amber-200">🔁 Workflow after cashier accepts an order:</p>
        <p>1. Items auto-split instantly: drinks & juices → <strong>Barista</strong> | foods & pastries → <strong>Kitchen (Chef)</strong></p>
        <p>2. Station crews see their own lane (<code className="text-[#C9A227]">/barista</code> & <code className="text-[#C9A227]">/kitchen</code>), press <strong>Accept</strong> to commence, <strong>Done</strong> when finished.</p>
        <p>3. Cashier sees live station pills ("Barista 2/3 ✓ | Kitchen 1/2 ✓") per table so they know preparation progress at a glance.</p>
      </div>
    </div>
  );
}
