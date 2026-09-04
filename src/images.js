/**
 * UI image registry.
 *
 * Files live in `public/images/`, which Vite serves verbatim at `/images/...`
 * in dev and copies straight into the build. Dropping a new file in that
 * folder makes it available immediately — no import, no rebuild, no restart.
 *
 * Everything is referenced through this map rather than as loose strings, so a
 * renamed or missing file shows up in one place instead of being hunted across
 * components.
 *
 * Two consequences of using public/ rather than bundling through src/:
 *
 *   1. No content hashing. Replacing a file with the same name can leave a
 *      browser showing the cached old one. `v` below is appended as a query
 *      string — bump it when you swap an image and every client picks it up.
 *   2. No build-time optimisation. Keep files small before adding them; an SVG
 *      wordmark would be a couple of KB against this PNG's 14KB.
 */

const v = 1;                       // bump when replacing a file in-place
const url = (name) => `/images/${name}?v=${v}`;

export const IMAGES = {
  /** White wordmark, 268×132. Legible only on dark backgrounds. */
  logoWhite: url("aaronz-logo-white.png"),

  /** WhatsApp mark, 256×256, transparent. Held locally rather than hotlinked:
   *  the source image arrived with the transparency checkerboard baked in as
   *  pixels, so the grey was keyed out and the artwork squared. */
  whatsapp: url("whatsapp.png"),

  /** Meta's infinity glyph, 256×256, transparent. The supplied file was the
   *  full lockup at 2000×1125; the wordmark is a smudge at 20px, so only the
   *  glyph is kept — isolated on colour rather than a guessed crop line. */
  meta: url("meta.png"),
};

/**
 * Images worth fetching before they are needed. `index.html` preloads the logo
 * directly so it paints with the first render; anything added here is warmed
 * in the background once the app is up.
 */
export const PRELOAD = [IMAGES.logoWhite];

export function warmImages(list = PRELOAD) {
  for (const src of list) {
    const img = new Image();
    img.src = src;
  }
}
