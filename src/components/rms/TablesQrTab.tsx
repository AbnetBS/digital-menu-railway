"use client";

import { useState, useEffect } from "react";
import { QrCode, Plus, Trash2, RefreshCw, Printer } from "lucide-react";
import { CafeTable } from "@/types";

function qrUrl(link: string, size = 220) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(link)}&color=2C1B17&bgcolor=FAF6F0&margin=10`;
}

export default function TablesQrTab() {
  const [tables, setTables] = useState<CafeTable[]>([]);
  const [newName, setNewName] = useState("");
  const [baseUrl, setBaseUrl] = useState(""); // effective base for QR links
  const [customBase, setCustomBase] = useState(""); // persisted setting (stable domain)
  const [savedMsg, setSavedMsg] = useState("");

  const load = async () => {
    const [tRes, sRes] = await Promise.all([fetch("/api/tables"), fetch("/api/settings")]);
    if (tRes.ok) setTables(await tRes.json());
    if (sRes.ok) {
      const s = await sRes.json();
      // If owner saved a stable domain (e.g. https://fanacafe.com), use it for ALL QR codes
      const saved = String(s.qr_base_url || "");
      setCustomBase(saved);
      setBaseUrl(saved || window.location.origin);
    } else {
      setBaseUrl(window.location.origin);
    }
  };

  useEffect(() => {
    load();
    setBaseUrl((prev) => prev || window.location.origin);
  }, []);

  const saveQrBase = async () => {
    const r = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ qr_base_url: customBase.trim() }),
    });
    if (r.ok) {
      setBaseUrl(customBase.trim() || window.location.origin);
      setSavedMsg("✓ QR base URL saved — all codes updated");
      setTimeout(() => setSavedMsg(""), 3000);
    }
  };

  const addTable = async () => {
    if (!newName) return;
    const r = await fetch("/api/tables", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName, sortOrder: tables.length + 1 }),
    });
    if (r.ok) {
      setNewName("");
      load();
    }
  };

  const removeTable = async (id: number) => {
    if (!confirm("Remove this table and its QR code?")) return;
    await fetch(`/api/tables?id=${id}`, { method: "DELETE" });
    load();
  };

  const tableLink = (t: CafeTable) => `${baseUrl}/menu?table=${t.id}`;

  const statusColor = (s?: string) =>
    s === "available" ? "text-emerald-400" : s === "ready-for-payment" ? "text-amber-400" : "text-rose-400";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-serif font-bold text-amber-100">Tables & QR Codes</h2>
          <p className="text-xs text-stone-400">Print a QR for each table. Customers scan → digital menu opens (browse only, waiter takes the order).</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => window.print()} className="p-2 bg-white/10 hover:bg-white/20 text-amber-200 rounded-xl flex items-center gap-1.5 text-xs font-bold" title="Print all QR codes">
            <Printer className="w-4 h-4" /> Print
          </button>
          <button onClick={load} className="p-2 bg-white/10 hover:bg-white/20 text-amber-200 rounded-xl" title="Refresh">
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* QR BASE URL — this is what customers reach when they scan */}
      <div className="bg-[#2C1B17] rounded-2xl border border-[#C9A227]/40 p-5 space-y-3">
        <div className="flex items-center gap-2">
          <QrCode className="w-4 h-4 text-[#C9A227]" />
          <h3 className="text-sm font-bold text-amber-200">QR Domain (where scans go)</h3>
        </div>
        <p className="text-xs text-stone-400 leading-relaxed">
          QRs currently encode: <strong className="text-[#C9A227]">{baseUrl || "..."}</strong>
          {" "}— leave empty to auto-use the site you're currently on. For permanent printed QRs, enter your final domain
          (e.g. <code className="text-amber-300">https://fanacafe.com</code>) and save, then print once.
        </p>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            value={customBase}
            onChange={(e) => setCustomBase(e.target.value)}
            placeholder="https://your-domain.com  (empty = auto)"
            className="flex-1 bg-[#3D2314] border border-stone-700 rounded-xl p-3 text-xs text-white font-mono"
          />
          <button
            onClick={saveQrBase}
            className="bg-[#C9A227] hover:bg-amber-400 text-[#2C1B17] font-black text-xs uppercase px-5 py-3 rounded-xl"
          >
            Save Base URL
          </button>
        </div>
        {savedMsg && <p className="text-xs text-emerald-400 font-bold">{savedMsg}</p>}
        {baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1") ? (
          <div className="bg-rose-950/60 border border-rose-600 text-rose-200 text-xs p-3 rounded-xl font-bold">
            ⚠️ You're on localhost — customer phones CAN'T reach these QRs. Deploy to your host (e.g. Railway) first, open the live site, then print.
          </div>
        ) : (
          <div className="bg-emerald-950/60 border border-emerald-700 text-emerald-200 text-xs p-3 rounded-xl font-bold">
            ✓ Live domain detected — scan any QR below with your phone to test it right now.
          </div>
        )}
      </div>

      {/* Add table */}
      <div className="bg-[#2C1B17] rounded-2xl border border-[#C9A227]/30 p-5 flex flex-col sm:flex-row gap-3 sm:items-end">
        <div className="flex-1">
          <label className="block text-xs font-bold text-amber-200 mb-1">New Table Name</label>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={`e.g. Table ${tables.length + 1}, VIP Room, Terrace 1`}
            className="w-full bg-[#3D2314] border border-stone-700 rounded-xl p-3 text-xs text-white"
          />
        </div>
        <button
          onClick={addTable}
          disabled={!newName}
          className="bg-[#C9A227] hover:bg-amber-400 text-[#2C1B17] font-black text-xs uppercase px-6 py-3 rounded-xl flex items-center gap-2 disabled:opacity-40"
        >
          <Plus className="w-4 h-4" /> Add Table
        </button>
      </div>

      {/* Table + QR grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {tables.map((t) => (
          <div key={t.id} className="bg-[#2C1B17] rounded-2xl border border-stone-800 p-5 flex flex-col items-center gap-3 text-center">
            <div className="flex items-center justify-between w-full">
              <span className="font-serif font-bold text-amber-100">{t.name}</span>
              <span className={`text-[10px] font-extrabold uppercase ${statusColor(t.status)}`}>{t.status}</span>
            </div>

            <div className="bg-[#FAF6F0] rounded-2xl p-3">
              <img src={qrUrl(tableLink(t))} alt={`QR ${t.name}`} className="w-40 h-40 rounded-lg" />
            </div>

            <p className="text-[10px] text-stone-500 break-all font-mono">{tableLink(t)}</p>

            <button
              onClick={() => removeTable(t.id)}
              className="w-full p-2 bg-rose-500/20 text-rose-300 hover:bg-rose-500 hover:text-white rounded-xl text-xs font-bold transition flex items-center justify-center gap-1.5"
            >
              <Trash2 className="w-3.5 h-3.5" /> Remove Table
            </button>
          </div>
        ))}
      </div>

      <div className="bg-[#2C1B17] rounded-2xl border border-stone-800 p-4 flex items-start gap-3">
        <QrCode className="w-5 h-5 text-[#C9A227] shrink-0 mt-0.5" />
        <p className="text-xs text-stone-400 leading-relaxed">
          <strong className="text-white">Printing tip:</strong> use the Print button once your real domain (e.g. fanacafe.com) is connected,
          so the QR codes encode your permanent URL — they never need replacing.
        </p>
      </div>
    </div>
  );
}
