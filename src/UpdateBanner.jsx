import React, { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

/**
 * Tells a stale tab that a newer build is live.
 *
 * A dashboard like this gets left open for days. When a deploy goes out, those
 * tabs keep running the old bundle — which matters more than usual here,
 * because a change to what "worked" counts as, or to who is in the broker
 * ranking, silently changes the numbers on screen. Two people comparing
 * figures across two tabs of different vintage is a genuinely confusing hour.
 *
 * `__BUILD_ID__` is compiled into this bundle by vite.config.js; version.json
 * is emitted by the same constant at build time and served from the origin.
 * When they differ, the server has moved on and this tab has not.
 *
 * The banner never reloads by itself. Someone may be mid-edit in the billings
 * form or halfway through an owner lookup, and throwing that away to save a
 * click would be a poor trade. It asks, and waits.
 */

/** Build stamped into this bundle. Undefined only if `define` is missing. */
const CURRENT = typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : null;

const POLL_MS = 5 * 60 * 1000;

export default function UpdateBanner() {
  const [latest, setLatest] = useState(null);

  useEffect(() => {
    if (!CURRENT) return;               // nothing to compare against
    let alive = true;

    async function check() {
      try {
        // cache: no-store matters. version.json sits next to hashed assets and
        // would otherwise be served from the browser or edge cache — the tab
        // would keep reading its own build id back and never see the deploy.
        const res = await fetch("/version.json", { cache: "no-store" });
        if (!res.ok) return;            // dev server, or mid-deploy 404
        const { buildId } = await res.json();
        if (alive && typeof buildId === "string") setLatest(buildId);
      } catch {
        // Offline, or the request was cut off. A failed check is not evidence
        // of an update, so it says nothing rather than guessing.
      }
    }

    check();
    const timer = setInterval(check, POLL_MS);
    // The common case is a laptop reopened in the morning: a tab that has been
    // hidden for hours checks the moment it is looked at again, rather than
    // waiting out the rest of its interval.
    const onFocus = () => check();
    window.addEventListener("focus", onFocus);

    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  if (!CURRENT || !latest || latest === CURRENT) return null;

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[70] w-[min(28rem,calc(100vw-2rem))]">
      <div className="flex items-center gap-3 rounded-2xl border border-indigo-200 bg-white
                      shadow-lg px-4 py-3">
        <span className="w-8 h-8 rounded-xl bg-indigo-50 text-indigo-600
                         flex items-center justify-center flex-shrink-0">
          <RefreshCw className="w-4 h-4" strokeWidth={2} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-slate-900">A newer version is available</p>
          <p className="text-xs text-slate-500">
            This tab is running an older build. Reload to pick up the latest figures.
          </p>
        </div>
        <button
          onClick={() => window.location.reload()}
          className="text-sm font-medium px-3 py-1.5 rounded-xl bg-slate-900 text-white
                     hover:bg-slate-700 flex-shrink-0">
          Reload
        </button>
      </div>
    </div>
  );
}
