import React from "react";
import { Calendar } from "lucide-react";
import {
  dubaiToday, dubaiDaysAgo, dubaiMonthsAgo, lastCompleteDays, todayWindow,
} from "./time.js";

// All Dubai calendar dates — "today" near 04:00 local is still yesterday in UTC.
export const today = dubaiToday;
export const daysAgo = dubaiDaysAgo;
export const monthsAgo = dubaiMonthsAgo;

/**
 * Resolves a preset or a custom range down to concrete { from, to } dates.
 * Everything downstream works in absolute dates, so nothing else has to know
 * whether the user picked a preset or typed their own.
 *
 * Day windows end YESTERDAY, not today — see lastCompleteDays in time.js for
 * why a partial day cannot sit in the denominator of a compliance measure.
 * "today" is the deliberate exception, for watching live activity.
 *
 * Month and year-to-date windows still run to today. They are used for listing
 * volume, which is a count rather than a ratio: leaving today out of "this
 * year" would just lose today's listings, and there is no fairness argument
 * about how long a listing has had to be worked.
 */
export function resolveRange({ preset, from, to }) {
  if (preset === "custom") return { from, to };
  const p = String(preset);

  if (p === "today") return todayWindow();
  if (p === "ytd") return { from: `${dubaiToday().slice(0, 4)}-01-01`, to: today() };
  if (p.endsWith("m")) return { from: monthsAgo(Number(p.slice(0, -1)) - 1), to: today() };
  if (p.endsWith("d")) return lastCompleteDays(Number(p.slice(0, -1)));
  return lastCompleteDays(Number(p));
}

export const rangeLabel = ({ preset, from, to }, presets) =>
  preset === "custom"
    ? `${from || "…"} → ${to || "…"}`
    : presets.find(([v]) => String(v) === String(preset))?.[1] ?? "";

/**
 * "1–7 Aug", or "28 Jul – 3 Aug" across a month boundary.
 *
 * The window is no longer what a reader would assume from the preset name —
 * "Last 7 days" on the 8th means the 1st to the 7th — so the dates it resolved
 * to are shown rather than left to be inferred.
 */
export function rangeDates(from, to) {
  if (!from || !to) return "";
  const fmt = (d, withMonth) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Dubai", day: "numeric", ...(withMonth ? { month: "short" } : {}),
    }).format(new Date(`${d}T12:00:00+04:00`));

  if (from === to) return fmt(from, true);
  const sameMonth = from.slice(0, 7) === to.slice(0, 7);
  return sameMonth ? `${fmt(from, false)}–${fmt(to, true)}` : `${fmt(from, true)} – ${fmt(to, true)}`;
}

/**
 * The range written out in full: "1–7 August 2026".
 *
 * For the PDF, which goes to someone who has never seen the dashboard. An
 * abbreviated "1–7 Aug" is fine as a caption beside a picker that explains
 * itself; on a document read in isolation the month and year have to be there.
 */
export function rangeSpelled(from, to) {
  if (!from || !to) return "";
  const d = (s) => new Date(`${s}T12:00:00+04:00`);
  const part = (s, opts) =>
    new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", ...opts }).format(d(s));

  const full = { day: "numeric", month: "long", year: "numeric" };
  if (from === to) return part(from, full);

  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  const sameMonth = sameYear && from.slice(0, 7) === to.slice(0, 7);

  if (sameMonth) return `${part(from, { day: "numeric" })}–${part(to, full)}`;
  if (sameYear) return `${part(from, { day: "numeric", month: "long" })} – ${part(to, full)}`;
  return `${part(from, full)} – ${part(to, full)}`;
}

/** "Last 7 days · 1–7 Aug" — the label plus the window it actually resolved to. */
export function rangeCaption(value, presets) {
  const { from, to } = resolveRange(value);
  const label = rangeLabel(value, presets);
  const dates = rangeDates(from, to);
  if (value.preset === "custom") return label;
  return dates ? `${label} · ${dates}` : label;
}

/** Inclusive whole-day span, for the "n days" caption. */
export const spanDays = (from, to) =>
  Math.max(1, Math.round((new Date(to) - new Date(from)) / 86_400_000) + 1);

export default function DateRange({ value, onChange, presets, className = "" }) {
  const { preset, from, to } = value;
  const invalid = preset === "custom" && from && to && new Date(from) > new Date(to);

  const set = (patch) => onChange({ ...value, ...patch });

  return (
    <div className={`flex items-center gap-2 flex-wrap ${className}`}>
      <div className="flex items-center gap-2 text-sm border border-slate-200 rounded-xl px-3 py-2 bg-white">
        <Calendar className="w-4 h-4 text-slate-400" />
        <select
          value={preset}
          onChange={(e) => {
            const next = e.target.value;
            // Seed the custom inputs from whatever preset was showing, so
            // switching to Custom starts from the range already on screen.
            if (next === "custom") {
              const r = resolveRange(value);
              set({ preset: "custom", from: from || r.from, to: to || r.to });
            } else {
              set({ preset: next });
            }
          }}
          className="bg-transparent outline-none cursor-pointer"
        >
          {presets.map(([v, label]) => (
            <option key={v} value={v}>{label}</option>
          ))}
          <option value="custom">Custom range…</option>
        </select>
      </div>

      {/* The window a preset resolves to is no longer guessable from its name —
          "Last 7 days" on the 8th means the 1st to the 7th, and today is not in
          it. Shown here so nobody has to infer it, or discover it by finding
          that two screens disagree. */}
      {preset !== "custom" && (
        <span className="text-xs text-slate-500 whitespace-nowrap"
          title={`${resolveRange(value).from} → ${resolveRange(value).to}`}>
          {rangeDates(resolveRange(value).from, resolveRange(value).to)}
          {preset === "today" && <span className="text-slate-400"> · partial day</span>}
        </span>
      )}

      {preset === "custom" && (
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={from ?? ""}
            max={to || today()}
            onChange={(e) => set({ from: e.target.value })}
            className={`text-sm border rounded-xl px-3 py-2 bg-white outline-none ${
              invalid ? "border-rose-300 text-rose-700" : "border-slate-200"}`}
          />
          <span className="text-slate-400 text-sm">→</span>
          <input
            type="date"
            value={to ?? ""}
            min={from || undefined}
            max={today()}
            onChange={(e) => set({ to: e.target.value })}
            className={`text-sm border rounded-xl px-3 py-2 bg-white outline-none ${
              invalid ? "border-rose-300 text-rose-700" : "border-slate-200"}`}
          />
          {invalid && (
            <span className="text-xs text-rose-600">Start date is after end date</span>
          )}
        </div>
      )}
    </div>
  );
}
