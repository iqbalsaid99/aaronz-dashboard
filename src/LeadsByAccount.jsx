import React, { useState, useEffect, useCallback } from "react";
import { Loader2, RefreshCw, Users, Info } from "lucide-react";
import { fetchLeadCountsByAccount } from "./propspace.js";

const Card = ({ children, className = "" }) => (
  <div className={`bg-white border border-slate-200 rounded-2xl ${className}`}>{children}</div>
);

const fmt = (n) => (n == null ? "—" : n.toLocaleString("en-GB"));

/**
 * Leads per CRM account — how many sit under each user, all time.
 *
 * COUNTS ONLY, ON PURPOSE. No contact, no status, no window. The question this
 * answers is "how big is each account", and the moment a lead's details appear
 * here it becomes a second, worse version of the Insights tab, which already
 * does that properly over a range.
 *
 * The figures come from the CRM's own per-user total rather than from adding
 * records up, so they are exact and cover the account's whole history — see
 * fetchLeadCountsByAccount for why that is one request per account rather than
 * the 429 that paging the book would take.
 */
export default function LeadsByAccount() {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState([0, 0]);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    (async () => {
      setBusy(true); setError(null); setProgress([0, 0]);
      try {
        const d = await fetchLeadCountsByAccount({
          onProgress: (done, total) => { if (alive) setProgress([done, total]); },
        });
        if (alive) setData(d);
      } catch (err) {
        if (alive) setError(err.message);
      } finally {
        if (alive) setBusy(false);
      }
    })();
    return () => { alive = false; };
  }, [nonce]);

  const rows = data?.rows ?? [];
  const share = (n) => (!data?.attributed ? "—" : `${((n / data.attributed) * 100).toFixed(1)}%`);

  return (
    <div className="space-y-4">
      <Card className="p-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex gap-2.5 min-w-0">
          <Users className="w-4 h-4 text-slate-400 flex-shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="text-xs font-medium text-slate-700">
              How many leads sit under each CRM account, all time.
            </p>
            <p className="text-[11px] text-slate-500 mt-0.5 leading-relaxed">
              Counts only — no contact details, no statuses, no date window. Read from the CRM's
              own total for each user, so each figure is exact and covers that account's whole
              history. Accounts holding nothing are left out.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setNonce((n) => n + 1)} disabled={busy}
            className={`flex items-center gap-2 px-3 py-2 text-sm rounded-xl border border-slate-200 bg-white
                        disabled:opacity-40 enabled:hover:bg-slate-50 enabled:hover:border-slate-300 ${busy ? "is-fetching" : ""}`}>
            <RefreshCw className={`w-4 h-4 ${busy ? "animate-spin" : ""}`} />Refresh
          </button>
        </div>
      </Card>

      {error && (
        <Card className="p-4 border-amber-200 bg-amber-50">
          <p className="text-sm font-medium text-amber-900">Couldn't count the leads</p>
          <p className="text-xs text-amber-700 mt-1 font-mono break-all">{error}</p>
        </Card>
      )}

      {busy && !data ? (
        <Card className="p-16 text-center">
          <Loader2 className="w-6 h-6 text-slate-300 mx-auto animate-spin" />
          <p className="text-sm text-slate-500 mt-3">
            Counting each account{progress[1] ? ` — ${progress[0]} of ${progress[1]}` : ""}…
          </p>
        </Card>
      ) : data ? (
        <>
          <div className="grid sm:grid-cols-3 gap-4">
            {[
              ["Leads in the CRM", data.crmTotal, "Every lead on the account, however old."],
              ["Under an account", data.attributed, `Held across ${rows.length} users.`],
              ["Under no account", data.unattributed, "No agent on the record."],
            ].map(([label, value, note]) => (
              <Card key={label} className="p-4">
                <p className="text-xs font-medium text-slate-600">{label}</p>
                <p className="mt-2 text-3xl font-bold text-slate-900 tracking-tight tabular-nums">
                  {fmt(value)}
                </p>
                <p className="mt-1 text-[11px] text-slate-400">{note}</p>
              </Card>
            ))}
          </div>

          {/* Stated on the screen as well as in the export: a table that does
              not reach the CRM's own total invites the reader to assume it does. */}
          <Card className="p-4 flex gap-2.5">
            <Info className="w-4 h-4 text-slate-400 flex-shrink-0 mt-0.5" />
            <p className="text-[11px] text-slate-500 leading-relaxed">
              <span className="font-medium text-slate-700">The account rows do not add up to the
              CRM total, and that difference is real.</span>{" "}
              {fmt(data.unattributed)} leads carry no agent on the record, or sit under an id that is
              no longer in the CRM's user list. Neither is "under an account", so neither is a row —
              but both are counted above rather than quietly dropped.
              {data.scoped ? " Some accounts are hidden by your access level and are not listed." : ""}
            </p>
          </Card>

          <Card className="p-5">
            <div className="flex items-center justify-between gap-3 mb-4">
              <p className="text-sm font-semibold text-slate-900">Accounts, by leads held</p>
              <span className="text-xs text-slate-400">
                {rows.length} of {data.accounts} users · {data.empty} hold none
              </span>
            </div>

            {rows.length ? (
              <div className="overflow-x-auto -mx-5 px-5">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-slate-500 border-b border-slate-200 bg-slate-50">
                      <th className="pl-0 pr-3 py-2.5 font-medium w-10">#</th>
                      <th className="px-3 py-2.5 font-medium">Account</th>
                      <th className="px-3 py-2.5 font-medium">Sign-in</th>
                      <th className="px-3 py-2.5 font-medium text-right">Leads</th>
                      <th className="px-3 py-2.5 font-medium text-right">Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60">
                        <td className="pl-0 pr-3 py-2.5 text-xs text-slate-400 tabular-nums">{r.rank}</td>
                        <td className="px-3 py-2.5 text-slate-900 font-medium">{r.name}</td>
                        <td className="px-3 py-2.5 text-xs text-slate-500">{r.email || "—"}</td>
                        <td className="px-3 py-2.5 text-right font-semibold text-slate-900 tabular-nums">
                          {fmt(r.leads)}
                        </td>
                        <td className="px-3 py-2.5 text-right text-xs text-slate-500 tabular-nums">
                          {share(r.leads)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-slate-900">
                      <td />
                      <td className="px-3 py-2.5 font-semibold text-slate-900">Under an account</td>
                      <td />
                      <td className="px-3 py-2.5 text-right font-bold text-slate-900 tabular-nums">
                        {fmt(data.attributed)}
                      </td>
                      <td className="px-3 py-2.5 text-right text-xs text-slate-500">100%</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            ) : (
              <p className="text-xs text-slate-400 py-8 text-center">
                No account holds a lead, which is a failed read rather than an empty CRM.
              </p>
            )}
          </Card>
        </>
      ) : null}
    </div>
  );
}
