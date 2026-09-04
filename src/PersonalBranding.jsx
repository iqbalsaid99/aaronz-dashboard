import React from "react";

/**
 * Personal Branding — the broker training deck, embedded whole.
 *
 * The page itself lives at `public/personal-branding/`, exactly as it was
 * delivered: markup, inline scroll logic and the four wheel photos, no build
 * step. It is not ported to JSX on purpose. It owns a viewport — its own
 * scroll container, scroll-snap, `100vh` sections and a rotating wheel driven
 * by that container's scrollTop — and none of that survives being dropped into
 * a padded column inside the dashboard's own scroll. An iframe gives it the
 * viewport it was written against, and keeps its cream background and Archivo
 * / Poppins / Playfair loads from leaking into the rest of the app.
 *
 * Swapping a photo or dropping in the Yapper clips is therefore a file
 * operation in that folder — `public/personal-branding/README.md` says which
 * names to keep — with no React change here at all.
 *
 * The negative margins cancel `main`'s padding so the deck runs edge to edge
 * against the sidebar. Below `lg` the tab row sits above it, hence the shorter
 * height there: over-tall would put a second scrollbar on the page, and an
 * outer scroll fighting the deck's snap points is worse than a little slack.
 */
export default function PersonalBranding() {
  return (
    <div className="-mx-6 lg:-mx-10 -mb-8 lg:-mt-8 h-[calc(100vh-6rem)] lg:h-screen">
      <iframe
        src="/personal-branding/"
        title="Personal Branding — Aaronz &amp; Co"
        allow="autoplay"
        className="w-full h-full block border-0"
      />
    </div>
  );
}
