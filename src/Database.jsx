import React, { useState, useEffect, useMemo } from "react";
import {
  Search, MessageCircle, Copy, Check, Loader2, AlertCircle, Download, Users,
} from "lucide-react";

/**
 * Tilal Al Ghaf 2026 owner datasheet.
 *
 * Transcribed from "Tilal al Ghaf 2026.xlsx" — 4,204 rows covering 3,215 units
 * and 3,775 distinct owners. Rows outnumber units because jointly owned
 * properties list each owner separately, so a unit can appear two or three
 * times with different names against the same plot.
 *
 * Served from public/data rather than bundled: at 782KB it would otherwise sit
 * in the main JS bundle and be downloaded by everyone who opens the dashboard,
 * regardless of whether they ever open this tab.
 *
 * To refresh, re-run the extraction against a newer copy of the sheet. Columns
 * are Area ID, Master Project, Project, LandNo_1, LandDmNo, LandDmSubNo, Size,
 * Building No, BuildingNameEn, Rooms, Owner Name, Mobile.
 */
const SRC = "/data/tilal-al-ghaf-2026.json";

const Card = ({ children, className = "" }) => (
  <div className={`bg-white border border-slate-200 rounded-2xl ${className}`}>{children}</div>
);

const ctrl =
  "text-sm border border-slate-200 rounded-xl px-3 py-2 bg-white outline-none focus:ring-2 focus:ring-indigo-200";

const dial = (p) => String(p ?? "").replace(/[^\d+]/g, "");

function CopyBtn({ text }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard?.writeText(text); setDone(true); setTimeout(() => setDone(false), 1200); }}
      className="p-1 rounded hover:bg-slate-100" title="Copy">
      {done ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5 text-slate-300" />}
    </button>
  );
}

export default function Database() {
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState(null);
  const [q, setQ] = useState("");
  const [project, setProject] = useState("");
  const [rooms, setRooms] = useState("");
  const [limit, setLimit] = useState(200);

  useEffect(() => {
    fetch(SRC)
      .then((r) => { if (!r.ok) throw new Error(`${r.status} loading the datasheet`); return r.json(); })
      .then(setRows)
      .catch((e) => setError(String(e.message ?? e)))
      .finally(() => setBusy(false));
  }, []);

  const projects = useMemo(() => {
    const c = new Map();
    for (const r of rows) if (r.project) c.set(r.project, (c.get(r.project) ?? 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  const roomOptions = useMemo(
    () => [...new Set(rows.map((r) => r.rooms).filter(Boolean))]
      .sort((a, b) => Number(a) - Number(b)), [rows]
  );

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (project && r.project !== project) return false;
      if (rooms && String(r.rooms) !== rooms) return false;
      if (!needle) return true;
      return [r.owner, r.mobile, r.unit, r.land, r.dm, r.dmSub]
        .filter(Boolean).some((v) => String(v).toLowerCase().includes(needle));
    });
  }, [rows, q, project, rooms]);

  const units = useMemo(() => new Set(shown.map((r) => r.unit).filter(Boolean)).size, [shown]);
  const owners = useMemo(() => new Set(shown.map((r) => r.owner)).size, [shown]);

  function exportCsv() {
    const head = ["Owner", "Mobile", "Project", "Unit", "Rooms", "Size (sqm)", "Land No", "DM No", "DM Sub No"];
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv = [head.join(",")].concat(
      shown.map((r) => [r.owner, r.mobile, r.project, r.unit, r.rooms, r.size, r.land, r.dm, r.dmSub]
        .map(esc).join(","))
    ).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `tilal-al-ghaf-2026${project ? `-${project.toLowerCase()}` : ""}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Tilal Al Ghaf 2026</h1>
          <p className="text-sm text-slate-500 mt-1">
            Owner datasheet
            {!busy && ` · ${shown.length.toLocaleString()} rows · ${units.toLocaleString()} units · ${owners.toLocaleString()} owners`}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-2 border border-slate-200 rounded-xl px-3 py-2 bg-white">
            <Search className="w-4 h-4 text-slate-400" />
            <input value={q} onChange={(e) => { setQ(e.target.value); setLimit(200); }}
              placeholder="Owner, mobile, unit, plot" className="text-sm outline-none w-52" />
          </div>
          <select value={project} onChange={(e) => { setProject(e.target.value); setLimit(200); }} className={ctrl}>
            <option value="">All projects</option>
            {projects.map(([p, n]) => <option key={p} value={p}>{p} ({n})</option>)}
          </select>
          <select value={rooms} onChange={(e) => { setRooms(e.target.value); setLimit(200); }} className={ctrl}>
            <option value="">Any beds</option>
            {roomOptions.map((r) => <option key={r} value={r}>{r} bed</option>)}
          </select>
          <button onClick={exportCsv} disabled={!shown.length}
            className="flex items-center gap-2 px-3 py-2 text-sm rounded-xl border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-40">
            <Download className="w-4 h-4 text-slate-400" />CSV
          </button>
        </div>
      </div>

      {busy && (
        <Card className="p-5 flex items-center gap-3">
          <Loader2 className="w-4 h-4 animate-spin text-slate-400" />
          <p className="text-sm text-slate-600">Loading datasheet…</p>
        </Card>
      )}

      {error && (
        <Card className="p-5 border-amber-200 bg-amber-50 flex gap-3">
          <AlertCircle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-amber-900">{error}</p>
        </Card>
      )}

      {!busy && !error && (
        <>
          <Card className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 border-b border-slate-200 bg-slate-50">
                  <th className="px-5 py-2.5 font-medium">Owner</th>
                  <th className="px-3 py-2.5 font-medium">Mobile</th>
                  <th className="px-3 py-2.5 font-medium">Project</th>
                  <th className="px-3 py-2.5 font-medium">Unit</th>
                  <th className="px-3 py-2.5 font-medium text-right">Beds</th>
                  <th className="px-3 py-2.5 font-medium text-right">Size</th>
                  <th className="px-5 py-2.5 font-medium">Plot</th>
                </tr>
              </thead>
              <tbody>
                {shown.slice(0, limit).map((r, i) => (
                  <tr key={`${r.unit}-${r.owner}-${i}`}
                    className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                    <td className="px-5 py-2.5 font-medium text-slate-900">{r.owner}</td>
                    <td className="px-3 py-2.5">
                      {r.mobile ? (
                        <span className="flex items-center gap-1">
                          <a href={`tel:${dial(r.mobile)}`} className="text-slate-900 tabular-nums">{r.mobile}</a>
                          <CopyBtn text={r.mobile} />
                          <a href={`https://wa.me/${dial(r.mobile).replace(/^\+/, "")}`}
                            target="_blank" rel="noreferrer"
                            className="p-1 rounded hover:bg-emerald-50" title="WhatsApp">
                            <MessageCircle className="w-3.5 h-3.5 text-emerald-600" />
                          </a>
                        </span>
                      ) : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-3 py-2.5 text-slate-600">{r.project}</td>
                    <td className="px-3 py-2.5 font-mono text-xs text-slate-700">{r.unit ?? "—"}</td>
                    <td className="px-3 py-2.5 text-right text-slate-600">{r.rooms ?? "—"}</td>
                    <td className="px-3 py-2.5 text-right text-slate-600 whitespace-nowrap">
                      {r.size ? `${Math.round(r.size * 10.7639).toLocaleString()} sqft` : "—"}
                    </td>
                    <td className="px-5 py-2.5 text-[11px] text-slate-400 font-mono whitespace-nowrap">
                      {[r.land, r.dm, r.dmSub].filter(Boolean).join(" / ")}
                    </td>
                  </tr>
                ))}
                {!shown.length && (
                  <tr><td colSpan={7} className="px-5 py-10 text-center text-slate-400">
                    Nothing matches that search.
                  </td></tr>
                )}
              </tbody>
            </table>
          </Card>

          {shown.length > limit && (
            <div className="text-center mt-4">
              <button onClick={() => setLimit((l) => l + 500)}
                className="px-4 py-2 text-sm rounded-xl border border-slate-200 bg-white hover:bg-slate-50">
                Show more — {(shown.length - limit).toLocaleString()} remaining
              </button>
            </div>
          )}

          <p className="text-xs text-slate-400 mt-6 flex items-start gap-2">
            <Users className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <span>
              4,204 rows across 3,215 units. Rows exceed units because jointly owned properties
              list each owner separately — the same unit appears more than once with different
              names against the same plot. Sizes are converted from square metres.
            </span>
          </p>
        </>
      )}
    </div>
  );
}
