import React, { useState, useEffect, useMemo } from "react";
import { TrendingDown, TrendingUp, RefreshCw, Info } from "lucide-react";
import { fetchLeads } from "./propspace.js";
import { dubaiToday } from "./time.js";
import { coldSeries, trendOf, bucketsFor, RECORD_START } from "./coldTrend.js";

/**
 * Cold share over time, since the record began.
 *
 * One series, so no legend: the heading names it. A single hue rather than a
 * categorical palette, because this is one magnitude over time and not four
 * things being compared — and rose, which is what the Cold card is already
 * painted in, so the chart and the number that opened it read as the same
 * subject.
 *
 * A bucket with no leads leaves a GAP. Drawing it at zero would say the week
 * was perfect when in fact nothing arrived, and that is the single most
 * flattering lie a chart like this can tell.
 *
 * It fetches its own window rather than reading the panel's. The panel follows
 * the date picker; this question is fixed to the record, and a trend line that
 * moved when somebody changed the range would not be a trend.
 */
export default function ColdTrend() {
  const [leads, setLeads] = useState(null);
  const [state, setState] = useState("loading");
  const [error, setError] = useState(null);
  const [grain, setGrain] = useState("auto");

  const today = dubaiToday();

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    fetchLeads({ from: RECORD_START, to: today })
      .then((rows) => { if (!cancelled) { setLeads(rows); setState("ready"); } })
      .catch((e) => { if (!cancelled) { setError(String(e.message ?? e)); setState("failed"); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line
  }, []);

  const series = useMemo(
    () => (leads ? coldSeries(leads, { start: RECORD_START, today, mode: grain }) : []),
    [leads, grain, today]
  );
  const trend = useMemo(() => trendOf(series), [series]);
  const points = series.filter((p) => p.rate !== null);
  const monthly = bucketsFor(RECORD_START, today, "auto").length > 0 &&
    bucketsFor(RECORD_START, today, "auto")[0].key.length === 7;

  if (state === "loading") {
    return (
      <div className="px-6 py-5 border-b border-slate-200 bg-white">
        <p className="text-xs text-slate-500 flex items-center gap-2">
          <RefreshCw className="w-3.5 h-3.5 animate-spin text-slate-300" />
          Reading every lead since {RECORD_START} to work out the trend…
        </p>
      </div>
    );
  }

  if (state === "failed") {
    return (
      <div className="px-6 py-4 border-b border-slate-200 bg-white">
        <p className="text-xs text-slate-500">Could not load the trend. {error}</p>
      </div>
    );
  }

  /* ------------------------------ geometry ------------------------------ */
  const W = 640, H = 150, PAD = { t: 14, r: 16, b: 22, l: 34 };
  const innerW = W - PAD.l - PAD.r, innerH = H - PAD.t - PAD.b;

  // Always anchored at zero. A y-axis that starts at the lowest point makes a
  // two-point wobble look like a collapse, which is the classic way to lie
  // with a line.
  const maxRate = Math.max(0.2, ...points.map((p) => p.rate));
  const top = Math.min(1, Math.ceil(maxRate * 10) / 10);

  const x = (i) => PAD.l + (series.length === 1 ? innerW / 2 : (i / (series.length - 1)) * innerW);
  const y = (r) => PAD.t + innerH - (r / top) * innerH;

  // Broken into runs so an empty bucket leaves a gap rather than a line drawn
  // straight through it.
  const runs = [];
  let run = [];
  series.forEach((p, i) => {
    if (p.rate === null) { if (run.length) runs.push(run); run = []; return; }
    run.push({ ...p, i });
  });
  if (run.length) runs.push(run);

  const gridlines = [0, top / 2, top];
  const pct = (r) => `${Math.round(r * 100)}%`;

  return (
    <div className="px-6 py-5 border-b border-slate-200 bg-white">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
        <div>
          <p className="text-xs font-bold tracking-wider text-slate-500 uppercase">
            Cold share since the record began
          </p>
          {trend ? (
            <p className="text-sm text-slate-700 mt-1">
              <span className="font-semibold text-slate-900">{pct(trend.last.rate)}</span> now,
              from <span className="font-semibold">{pct(trend.first.rate)}</span> in{" "}
              {trend.first.label}{" "}
              <span className={`inline-flex items-center gap-1 ml-1 px-1.5 py-0.5 rounded text-[11px]
                font-semibold ${trend.improving ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>
                {trend.improving ? <TrendingDown className="w-3 h-3" /> : <TrendingUp className="w-3 h-3" />}
                {trend.deltaPts > 0 ? "+" : ""}{Math.round(trend.deltaPts)} pts
              </span>
            </p>
          ) : (
            <p className="text-sm text-slate-500 mt-1">
              {points.length === 1
                ? `${pct(points[0].rate)} in ${points[0].label} — one measurement. A second period is needed before this is a trend.`
                : "No leads have arrived since the record began."}
            </p>
          )}
        </div>

        {/* Only offered once both readings are possible. */}
        {monthly && (
          <div className="flex items-center gap-1">
            {[["auto", "Month"], ["week", "Week"]].map(([k, label]) => (
              <button key={k} onClick={() => setGrain(k)}
                className={`px-2 py-1 text-[11px] rounded-md border transition ${grain === k
                  ? "bg-slate-900 text-white border-slate-900"
                  : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"}`}>
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {points.length > 0 && (
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 150 }}
          role="img" aria-label={`Cold share by ${monthly && grain === "auto" ? "month" : "week"} since ${RECORD_START}`}>
          {/* Recessive grid: present enough to read a value against, quiet
              enough that the line is the thing you see. */}
          {gridlines.map((g) => (
            <g key={g}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(g)} y2={y(g)} stroke="#E2E8F0" strokeWidth="1" />
              <text x={PAD.l - 6} y={y(g) + 3} textAnchor="end"
                style={{ font: "500 9px ui-sans-serif, system-ui" }} className="fill-slate-400">
                {pct(g)}
              </text>
            </g>
          ))}

          {runs.map((r, ri) => (
            <g key={ri}>
              {r.length > 1 && (
                <>
                  <path d={`M ${r.map((p) => `${x(p.i)} ${y(p.rate)}`).join(" L ")}`}
                    fill="none" stroke="#E11D48" strokeWidth="2"
                    strokeLinecap="round" strokeLinejoin="round" />
                  <path d={`M ${x(r[0].i)} ${y(0)} L ${r.map((p) => `${x(p.i)} ${y(p.rate)}`).join(" L ")} L ${x(r[r.length - 1].i)} ${y(0)} Z`}
                    fill="#E11D48" opacity="0.07" />
                </>
              )}
              {r.map((p) => (
                <g key={p.key}>
                  {/* A hit target larger than the mark, carrying the numbers. */}
                  <circle cx={x(p.i)} cy={y(p.rate)} r="12" fill="transparent">
                    <title>{`${p.label}${p.partial ? " (so far)" : ""}: ${pct(p.rate)} cold — ${p.cold} of ${p.total} leads`}</title>
                  </circle>
                  {/* The unfinished period is hollow, so it is not read as a
                      settled result. */}
                  <circle cx={x(p.i)} cy={y(p.rate)} r="4"
                    fill={p.partial ? "#fff" : "#E11D48"} stroke="#E11D48" strokeWidth="2" />
                </g>
              ))}
            </g>
          ))}

          {/* Direct label on the latest point only — a number on every point is
              a table pretending to be a chart. */}
          {points.length > 0 && (() => {
            const last = points[points.length - 1];
            const lx = x(last.i), ly = y(last.rate);
            return (
              <text x={Math.min(lx, W - PAD.r - 2)} y={ly - 10} textAnchor={lx > W - 60 ? "end" : "middle"}
                style={{ font: "700 11px ui-sans-serif, system-ui" }} className="fill-slate-900">
                {pct(last.rate)}
              </text>
            );
          })()}

          {series.map((p, i) => (
            <text key={p.key} x={x(i)} y={H - 6} textAnchor="middle"
              style={{ font: "500 9px ui-sans-serif, system-ui" }} className="fill-slate-400">
              {p.label}
            </text>
          ))}
        </svg>
      )}

      <p className="text-[11px] text-slate-400 mt-2 flex items-start gap-1.5">
        <Info className="w-3 h-3 mt-0.5 flex-shrink-0" />
        <span>
          Every sales lead that arrived in each period, across all brokers — Property Management
          excluded, as on the card. A point is the share of that period’s leads that is
          <strong className="font-semibold text-slate-500"> still</strong> untouched today, so past
          periods improve when old leads are finally worked. The CRM stores no timestamp for a
          status change, so a true “cold on the day” figure cannot be reconstructed backwards.
          {series.some((p) => p.partial) && " The last point is a period in progress."}
        </span>
      </p>
    </div>
  );
}
