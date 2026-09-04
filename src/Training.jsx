import React, { useState, useEffect, useCallback } from "react";
import { ChevronLeft, ChevronRight, GraduationCap } from "lucide-react";

/**
 * Training — "Sales Training Excellence", the 54-slide broker deck.
 *
 * The source PDF is 42MB and, more to the point, exported wrong: its page box
 * is A4 portrait while the artwork is A4 landscape at the origin, so every
 * viewer clips the right-hand third of every slide — the third column of
 * "Residential property types" simply is not there. Serving that file would
 * have shipped the fault. So the pages are rendered at the artwork's true
 * bounds, the 16:9 design cropped out of its letterboxing, and written to
 * `public/training/slides/pNN.jpg` — 54 files, 6.9MB the lot, against 42MB for
 * a document that reads correctly nowhere.
 *
 * Paged rather than a long scroll because the deck is paged: it numbers its
 * own slides "03/54" in the corner. That badge is also why there is no counter
 * of ours over the artwork — the two would disagree the moment either moved.
 * The count under the controls is the honest place for it.
 *
 * Only the current slide, its neighbour either side, and whatever has already
 * been visited are in the DOM. At ~128KB a slide, mounting all 54 would pull
 * the whole 6.9MB on open to show one image.
 */

const COUNT = 54;
const src = (n) => `/training/slides/p${String(n).padStart(2, "0")}.jpg`;

export default function Training() {
  const [page, setPage] = useState(1);

  const go = useCallback((n) => setPage(Math.min(COUNT, Math.max(1, n))), []);

  // Arrow keys are how anyone reads a deck. Ignored while a field has focus,
  // so this never eats a keystroke meant for an input elsewhere on the page.
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "ArrowRight" || e.key === "PageDown") { e.preventDefault(); go(page + 1); }
      if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); go(page - 1); }
      if (e.key === "Home") { e.preventDefault(); go(1); }
      if (e.key === "End") { e.preventDefault(); go(COUNT); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [page, go]);

  // The next slide is fetched while the current one is being read, so paging
  // forward — which is what all but a handful of these clicks will be — lands
  // on an image that is already there.
  useEffect(() => {
    if (page < COUNT) { const img = new Image(); img.src = src(page + 1); }
  }, [page]);

  const btn = "flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg border transition " +
    "border-slate-200 bg-white text-slate-700 hover:bg-slate-50 hover:border-slate-300 " +
    "disabled:opacity-40 disabled:pointer-events-none";

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Training</h1>
          <p className="text-sm text-slate-500 mt-1">
            Sales Training Excellence — your comprehensive guide to mastering Dubai real estate sales.
          </p>
        </div>
        <span className="flex items-center gap-2 text-xs font-medium text-slate-500
                         bg-white border border-slate-200 rounded-lg px-3 py-2">
          <GraduationCap className="w-4 h-4 text-slate-400" />
          Broker training · {COUNT} slides
        </span>
      </div>

      {/*
        Navy artwork on a navy mount: a white card behind these slides would
        draw a bright rectangle around every one of them.

        Width is capped by the WINDOW HEIGHT, not by the column. A 16:9 slide
        filling a wide column is 790px tall before the heading and the pager
        are counted, which puts the Next button under the fold — and a deck you
        have to scroll to page through is worse than a slightly smaller deck.
        The 15rem is what the heading, the controls and the page padding
        actually occupy; the slide takes what is left and the column caps it
        on narrow windows.
      */}
      <div className="bg-slate-900 rounded-2xl p-3 sm:p-4 mx-auto w-full"
        style={{ maxWidth: "min(100%, calc((100vh - 15rem) * 16 / 9))" }}>
        <div className="relative aspect-[16/9] rounded-xl overflow-hidden bg-slate-950">
          {Array.from({ length: COUNT }, (_, i) => i + 1)
            .filter((n) => Math.abs(n - page) <= 1)
            .map((n) => (
              <img
                key={n}
                src={src(n)}
                alt={`Slide ${n} of ${COUNT}`}
                width="1600"
                height="899"
                draggable="false"
                className={`absolute inset-0 w-full h-full object-contain transition-opacity
                            duration-200 ${n === page ? "opacity-100" : "opacity-0"}`}
              />
            ))}
        </div>
      </div>

      <div className="flex items-center justify-between gap-4 mt-4">
        <button className={btn} onClick={() => go(page - 1)} disabled={page === 1}>
          <ChevronLeft className="w-4 h-4" /> Previous
        </button>

        <div className="flex items-center gap-3 min-w-0">
          {/* A 54-step scrubber beats 54 clicks when someone wants slide 40. */}
          <input
            type="range" min="1" max={COUNT} value={page}
            onChange={(e) => go(Number(e.target.value))}
            aria-label="Slide"
            className="w-32 sm:w-64 accent-slate-900 cursor-pointer"
          />
          <span className="text-sm text-slate-600 tabular-nums whitespace-nowrap">
            <span className="font-semibold text-slate-900">{page}</span> / {COUNT}
          </span>
        </div>

        <button className={btn} onClick={() => go(page + 1)} disabled={page === COUNT}>
          Next <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      <p className="text-xs text-slate-400 mt-3">Use ← and → to move through the deck.</p>
    </>
  );
}
