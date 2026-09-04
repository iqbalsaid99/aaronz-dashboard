import React, { useState } from "react";
import {
  Search, Phone, MessageCircle, Mail, Copy, Check, ExternalLink,
  Loader2, AlertCircle, Building2, ChevronRight,
} from "lucide-react";
import { normalise, fmtNumber, portalOf, dialable } from "./ownerSearch.js";
import { apiFetch } from "./apiFetch.js";

/* iOS-flavoured primitives: hairline dividers, grouped inset lists, generous
   corner radii, system font stack. */
const IOS_FONT =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif';

const Group = ({ title, children, footer }) => (
  <section className="mb-6">
    {title && (
      <p className="px-4 pb-2 text-[13px] font-medium uppercase tracking-wide text-slate-500">
        {title}
      </p>
    )}
    <div className="bg-white rounded-2xl overflow-hidden shadow-sm ring-1 ring-black/5">
      {children}
    </div>
    {footer && <p className="px-4 pt-2 text-[13px] text-slate-500 leading-snug">{footer}</p>}
  </section>
);

/** Grouped-list row with a hairline that stops short of the left edge. */
const Row = ({ label, value, mono }) => (
  <div className="flex items-baseline justify-between gap-4 px-4 py-3
                  border-b border-slate-100 last:border-0">
    <span className="text-[15px] text-slate-500 flex-shrink-0">{label}</span>
    <span className={`text-[15px] text-slate-900 text-right ${mono ? "font-mono text-[13px]" : ""}`}>
      {value}
    </span>
  </div>
);

function CopyButton({ text }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard?.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
      className="p-2 rounded-full hover:bg-slate-100 active:scale-95 transition"
      title="Copy">
      {done ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4 text-slate-400" />}
    </button>
  );
}

/** The call-to-action row — big tap targets, iOS-style tinted actions. */
function ContactRow({ phone }) {
  const num = dialable(phone);
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-100 last:border-0">
      <div className="min-w-0">
        <p className="text-[17px] text-slate-900 font-medium tabular-nums">{phone}</p>
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        <CopyButton text={phone} />
        <a href={`https://wa.me/${num.replace(/^\+/, "")}`} target="_blank" rel="noreferrer"
          className="p-2 rounded-full hover:bg-emerald-50 active:scale-95 transition" title="WhatsApp">
          <MessageCircle className="w-4 h-4 text-emerald-600" />
        </a>
        <a href={`tel:${num}`}
          className="flex items-center gap-1.5 px-3.5 py-2 rounded-full bg-[#007AFF] text-white
                     text-[15px] font-medium active:scale-95 transition">
          <Phone className="w-4 h-4" />Call
        </a>
      </div>
    </div>
  );
}

const SkeletonLine = ({ w = "w-full" }) => (
  <div className={`h-3 ${w} bg-slate-200 rounded-full animate-pulse`} />
);

export default function OwnerSearch() {
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState("idle");   // idle | loading | done | error
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [showRaw, setShowRaw] = useState(false);

  async function lookup(e) {
    e?.preventDefault();
    if (!url.trim() || status === "loading") return;
    setStatus("loading"); setError(null); setResult(null); setShowRaw(false);
    try {
      const res = await apiFetch("/api/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.detail ? { msg: data.error, detail: data.detail } : { msg: data.error });
        setStatus("error");
        return;
      }
      setResult({ raw: data.raw, d: normalise(data.raw) });
      setStatus("done");
    } catch {
      setError({ msg: "Could not reach the lookup service.", detail: "Is the dev server running?" });
      setStatus("error");
    }
  }

  const d = result?.d;
  const portal = portalOf(url);

  const propertyRows = d ? [
    ["Purpose", d.purpose],
    ["Type", d.type],
    ["Beds", d.beds],
    ["Baths", d.baths],
    ["Size", d.area ? `${fmtNumber(d.area)} ${d.areaUnit}` : null],
    ["Community", d.community],
    ["Building", d.tower],
    ["Completion", d.completion],
    ["Handover", d.handover],
    ["Developer", d.developer],
    ["Reference", d.referenceNo],
    ["Permit no.", d.permitNumber],
    ["Listed", d.listedAt],
  ].filter(([, v]) => v != null && v !== "") : [];

  return (
    <div style={{ fontFamily: IOS_FONT }} className="max-w-3xl">
      <h1 className="text-[34px] font-bold text-slate-900 tracking-tight leading-tight">
        Owner search
      </h1>
      <p className="text-[15px] text-slate-500 mt-1 mb-6">
        Paste a listing link from Bayut, Property Finder or Dubizzle to pull the
        contact behind it.
      </p>

      {/* Search bar */}
      <form onSubmit={lookup} className="mb-6">
        <div className="flex items-center gap-2 bg-slate-200/60 rounded-2xl px-4 py-3
                        focus-within:bg-white focus-within:ring-2 focus-within:ring-[#007AFF]/30 transition">
          <Search className="w-5 h-5 text-slate-400 flex-shrink-0" />
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://www.bayut.com/property/details-…"
            className="flex-1 bg-transparent outline-none text-[17px] text-slate-900
                       placeholder:text-slate-400 min-w-0"
          />
          {portal && (
            <span className="text-[13px] text-slate-500 bg-white/70 px-2 py-0.5 rounded-full flex-shrink-0">
              {portal}
            </span>
          )}
          <button type="submit" disabled={!url.trim() || status === "loading"}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-full bg-[#007AFF] text-white
                       text-[15px] font-medium disabled:opacity-40 active:scale-95 transition flex-shrink-0">
            {status === "loading" ? <Loader2 className="w-4 h-4 animate-spin" /> : "Search"}
          </button>
        </div>
      </form>

      {status === "loading" && (
        <Group footer="Cold starts take 20 to 60 seconds. The scraper runs through a residential proxy in the UAE, so this is slower than a normal request.">
          <div className="px-4 py-5 space-y-3">
            <SkeletonLine w="w-2/3" />
            <SkeletonLine w="w-1/2" />
            <SkeletonLine w="w-5/6" />
          </div>
        </Group>
      )}

      {status === "error" && (
        <div className="bg-white rounded-2xl shadow-sm ring-1 ring-black/5 p-5 flex gap-3">
          <AlertCircle className="w-5 h-5 text-[#FF3B30] flex-shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="text-[17px] font-medium text-slate-900">{error?.msg}</p>
            {error?.detail && (
              <p className="text-[13px] text-slate-500 mt-1 leading-relaxed break-words">
                {error.detail}
              </p>
            )}
          </div>
        </div>
      )}

      {status === "done" && d && (
        <>
          {/* Hero */}
          <Group>
            {d.images?.[0] && (
              <img src={d.images[0]} alt="" className="w-full h-52 object-cover" />
            )}
            <div className="px-4 py-4">
              {d.title && (
                <p className="text-[20px] font-semibold text-slate-900 leading-snug">{d.title}</p>
              )}
              <div className="flex items-baseline gap-2 mt-1 flex-wrap">
                {d.price && (
                  <span className="text-[22px] font-bold text-slate-900">
                    {d.currency} {fmtNumber(d.price)}
                  </span>
                )}
                {d.community && <span className="text-[15px] text-slate-500">{d.community}</span>}
              </div>
              {d.url && (
                <a href={d.url} target="_blank" rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[15px] text-[#007AFF] mt-2">
                  Open on {portalOf(d.url) ?? "portal"} <ExternalLink className="w-3.5 h-3.5" />
                </a>
              )}
            </div>
          </Group>

          {/* Who to call */}
          <Group
            title="Contact"
            footer={
              d.contactPhones.length
                ? "Tap Call to dial, or the green icon for WhatsApp."
                : "No phone number came back on this listing. Open the raw response below to check whether the actor returned it under a field name the mapping does not know about yet."
            }>
            {d.contactName && <Row label="Name" value={d.contactName} />}
            {d.brokerage && <Row label="Listed by" value={d.brokerage} />}
            {d.isOwner != null && (
              <Row label="Listed by owner" value={d.isOwner ? "Yes" : "No"} />
            )}
            {d.contactEmail && (
              <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-100 last:border-0">
                <span className="text-[15px] text-slate-500">Email</span>
                <span className="flex items-center gap-1 min-w-0">
                  <a href={`mailto:${d.contactEmail}`}
                    className="text-[15px] text-[#007AFF] truncate">{d.contactEmail}</a>
                  <CopyButton text={d.contactEmail} />
                </span>
              </div>
            )}
            {d.contactPhones.map((p) => <ContactRow key={p} phone={p} />)}
            {!d.contactName && !d.contactPhones.length && !d.contactEmail && !d.brokerage && (
              <div className="px-4 py-6 text-center">
                <Mail className="w-6 h-6 text-slate-300 mx-auto" />
                <p className="text-[15px] text-slate-500 mt-2">No contact details returned.</p>
              </div>
            )}
          </Group>

          {/* The property */}
          {propertyRows.length > 0 && (
            <Group title="Property">
              {propertyRows.map(([label, value]) => (
                <Row key={label} label={label} value={String(value)}
                  mono={label === "Permit no." || label === "Reference"} />
              ))}
            </Group>
          )}

          {/* Escape hatch — the mapping is best-effort until the actor output
              has been inspected, so the full payload stays one tap away. */}
          <Group>
            <button onClick={() => setShowRaw((v) => !v)}
              className="w-full flex items-center justify-between px-4 py-3 hover:bg-slate-50 active:bg-slate-100 transition">
              <span className="text-[15px] text-slate-900">Raw response</span>
              <ChevronRight className={`w-4 h-4 text-slate-400 transition-transform ${showRaw ? "rotate-90" : ""}`} />
            </button>
            {showRaw && (
              <pre className="px-4 pb-4 text-[11px] leading-relaxed text-slate-600 overflow-x-auto max-h-96">
                {JSON.stringify(result.raw, null, 2)}
              </pre>
            )}
          </Group>
        </>
      )}

      {status === "idle" && (
        <Group footer="Each search runs a scraper through a UAE residential proxy, which is the expensive line on the Apify bill. One lookup at a time rather than batching.">
          <div className="px-4 py-10 text-center">
            <Building2 className="w-8 h-8 text-slate-300 mx-auto" />
            <p className="text-[15px] text-slate-500 mt-3">
              Paste a listing URL above to begin.
            </p>
          </div>
        </Group>
      )}
    </div>
  );
}
