"use client";

import { useState, useEffect } from "react";
import { Coffee, CookingPot, CupSoda, RefreshCw, Save, CheckCircle2, Timer, Minus, Plus } from "lucide-react";
import { DEFAULT_CATEGORY_ROUTING } from "@/lib/initial-data";
import { useStaffT, tNow } from "@/lib/staff-i18n";
import {
  WAITER_SEND_HOLD_DEFAULT_SECONDS,
  WAITER_SEND_HOLD_MAX_SECONDS,
  WAITER_SEND_HOLD_MIN_SECONDS,
  waiterSendHoldSeconds,
} from "@/lib/send-hold";

type Station = "barista" | "kitchen" | "juice";

export default function StationsTab() {
  const { t: L, rich: Lr } = useStaffT();
  const [categories, setCategories] = useState<Array<{ id: number; name: string; slug: string }>>([]);
  const [routing, setRouting] = useState<Record<string, Station>>(DEFAULT_CATEGORY_ROUTING);
  // THE WAITER'S SEND HOLD (owner, Sept 2026): how long a waiter's own order
  // waits before it is released to the stations. She can still edit it while
  // it counts down, and a "Send now" button releases it immediately.
  const [holdSeconds, setHoldSeconds] = useState(WAITER_SEND_HOLD_DEFAULT_SECONDS);
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
      setHoldSeconds(waiterSendHoldSeconds(s.waiter_send_hold_seconds));
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
      body: JSON.stringify({
        category_routing: JSON.stringify(routing),
        waiter_send_hold_seconds: String(holdSeconds),
      }),
    }).catch(() => null);
    setSaving(false);
    if (!res) return alert(L("Network error. Try again."));
    if (res.ok) {
      setSavedMsg(tNow("✓ Stations routing and send hold saved • new orders will split correctly by station"));
      setTimeout(() => setSavedMsg(""), 3500);
    } else alert(L("Failed to save routing."));
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-serif font-bold text-amber-100">{L("👨‍🍳 Stations Routing (Barista vs Kitchen vs Juice)")}</h2>
          <p className="text-xs text-stone-400">
            {Lr("Choose which station each food category goes to. Machine coffee & cold drinks default to <b>Barista</b>; fresh juices default to <b2>Juice Maker</b2>; food & pastries default to <b>Kitchen (Chef)</b>.", { b: (s) => <strong className="text-amber-200">{s}</strong>, b2: (s) => <strong className="text-lime-200">{s}</strong> })}
          </p>
        </div>
        <button
          onClick={save}
          disabled={saving}
          className="bg-[#C9A227] hover:bg-amber-400 text-[#2C1B17] font-black text-xs uppercase px-5 py-3 rounded-xl flex items-center gap-2 disabled:opacity-40"
        >
          <Save className="w-4 h-4" />
          {saving ? L("Saving...") : L("Save Routing")}
        </button>
      </div>

      {savedMsg && (
        <div className="bg-emerald-900/60 border border-emerald-500 text-emerald-200 text-xs p-3 rounded-xl flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          <span>{savedMsg}</span>
        </div>
      )}

      <div className="bg-[#2C1B17] rounded-2xl border border-[#C9A227]/30 p-5 space-y-1">
        <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3 items-center pb-3 border-b border-stone-800 text-[10px] uppercase font-extrabold text-stone-400">
          <span>{L("Category")}</span>
          <span className="flex items-center gap-1.5 text-amber-200"><Coffee className="w-3.5 h-3.5" /> {L("Barista")}</span>
          <span className="flex items-center gap-1.5 text-emerald-200"><CookingPot className="w-3.5 h-3.5" /> {L("Kitchen")}</span>
          <span className="flex items-center gap-1.5 text-lime-200"><CupSoda className="w-3.5 h-3.5" /> {L("Juice")}</span>
        </div>

        <div className="divide-y divide-stone-800">
          {categories.map((c) => (
            <div key={c.id} className="grid grid-cols-[1fr_auto_auto_auto] gap-3 items-center py-2.5">
              <span className="text-xs font-bold text-amber-100">{c.name}</span>
              <button
                onClick={() => setRouting({ ...routing, [c.slug]: "barista" })}
                className={`w-7 h-7 rounded-full border-2 flex items-center justify-center transition ${
                  routing[c.slug] === "barista"
                    ? "bg-amber-500 border-amber-400"
                    : "border-stone-600 hover:border-amber-500"
                }`}
                title={L("Send \"{name}\" to Barista", { name: c.name })}
                aria-label={L("Route {name} to barista", { name: c.name })}
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
                title={L("Send \"{name}\" to Kitchen", { name: c.name })}
                aria-label={L("Route {name} to kitchen", { name: c.name })}
              >
                {routing[c.slug] === "kitchen" && <span className="w-3 h-3 rounded-full bg-white" />}
              </button>
              <button
                onClick={() => setRouting({ ...routing, [c.slug]: "juice" })}
                className={`w-7 h-7 rounded-full border-2 flex items-center justify-center transition ${
                  routing[c.slug] === "juice"
                    ? "bg-lime-500 border-lime-400"
                    : "border-stone-600 hover:border-lime-500"
                }`}
                title={L("Send \"{name}\" to Juice Maker", { name: c.name })}
                aria-label={L("Route {name} to juice", { name: c.name })}
              >
                {routing[c.slug] === "juice" && <span className="w-3 h-3 rounded-full bg-white" />}
              </button>
            </div>
          ))}
          {categories.length === 0 && (
            <p className="py-6 text-center text-xs text-stone-500">{L("No categories yet. Add them under the Menu tab.")}</p>
          )}
        </div>
      </div>

      {/* ── THE WAITER'S SEND HOLD (owner, Sept 2026) ──
          The kitchen kept receiving an order and a correction a minute later,
          so a waiter's OWN send now waits this long before it is released: she
          can still fix a dish, a quantity or a note, and a "Send now" button
          sits beside the countdown for the small orders that should not wait.
          Tune it here as the room gets busier or quieter. */}
      <div className="bg-[#2C1B17] rounded-2xl border border-[#C9A227]/30 p-5 space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <h3 className="text-sm font-bold text-amber-200 flex items-center gap-2">
              <Timer className="w-4 h-4 text-[#C9A227]" /> {L("Waiter Send Hold (seconds)")}
            </h3>
            <p className="text-[11px] text-stone-400 mt-1">
              {L("How long a waiter's own order waits before it is released to the stations. She can still edit it during the hold, and a \"Send now\" button releases it immediately.")}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => setHoldSeconds((s) => Math.max(WAITER_SEND_HOLD_MIN_SECONDS, s - 15))}
              className="w-9 h-9 rounded-xl bg-white/10 hover:bg-white/20 flex items-center justify-center"
              title={L("15 seconds less")}
              aria-label={L("15 seconds less")}
            >
              <Minus className="w-4 h-4" />
            </button>
            <span className="font-serif font-black text-2xl text-[#C9A227] w-16 text-center tabular-nums">{holdSeconds}</span>
            <button
              onClick={() => setHoldSeconds((s) => Math.min(WAITER_SEND_HOLD_MAX_SECONDS, s + 15))}
              className="w-9 h-9 rounded-xl bg-[#C9A227] text-black hover:bg-amber-400 flex items-center justify-center"
              title={L("15 seconds more")}
              aria-label={L("15 seconds more")}
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {[30, 60, 120, 180].map((preset) => (
            <button
              key={preset}
              onClick={() => setHoldSeconds(preset)}
              className={`px-3 py-2 rounded-xl text-[11px] font-black border transition ${
                holdSeconds === preset
                  ? "bg-[#C9A227] text-black border-[#C9A227]"
                  : "bg-black/30 text-stone-300 border-stone-700 hover:border-[#C9A227]/60"
              }`}
            >
              {preset === 30 ? L("30 sec") : preset === 60 ? L("1 min") : preset === 120 ? L("2 min") : L("3 min")}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-stone-500">
          {L("A guest's QR order is never affected: it always waits for a human confirmation.")}
        </p>
      </div>

      <div className="bg-[#2C1B17]/70 border border-stone-800 rounded-xl p-4 text-xs text-stone-400 space-y-1.5">
        <p className="font-bold text-amber-200">{L("🔁 Workflow after cashier accepts an order:")}</p>
        <p>{Lr("1. Items auto-split instantly: machine coffee & cold drinks → <b>Barista</b> | fresh juices → <b>Juice Maker</b> | foods & pastries → <b>Kitchen (Chef)</b>", { b: (s) => <strong>{s}</strong> })}</p>
        <p>{Lr("2. Station crews see their own lane (<c>/barista</c>, <c>/kitchen</c> & <c>/juice</c>), press <b>Accept</b> to commence, <b>Done</b> when finished.", { c: (s) => <code className="text-[#C9A227]">{s}</code>, b: (s) => <strong>{s}</strong> })}</p>
        <p>{L("3. Cashier sees live station pills (\"Barista 2/3 ✓ | Kitchen 1/2 ✓\") per table so they know preparation progress at a glance.")}</p>
      </div>
    </div>
  );
}
