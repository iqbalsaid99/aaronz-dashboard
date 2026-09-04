/**
 * The Aaronz palette, in one place.
 *
 * Read by tailwind.config.js to generate the utility classes, and available to
 * anything that cannot use Tailwind directly. One set of values to change is
 * the point: everything that carries the brand has to stay visibly the same
 * product.
 *
 * THE RULE FROM THE BRAND GUIDE, encoded below rather than left to memory:
 * teal, gold and sage are accents. Never a surface. Every background in the
 * application is navy, cream, black or white — which is why the surface tokens
 * and the accent tokens are separated here instead of sitting in one flat list.
 */

/* ------------------------------ primaries ------------------------------ */

export const NAVY = '#0C2036';
export const CREAM = '#EFEAE0';
export const BLACK = '#0E0E0E';

/* ---------------------- accents — never backgrounds ---------------------- */

export const TEAL = '#2F6475';
export const GOLD = '#C8A24B';
export const SAGE = '#A8A28B';

/**
 * Navy lightened for hover states and for text that has to sit back without
 * turning grey. Mixed towards white rather than desaturated, so it stays the
 * same hue family.
 */
export const NAVY_LIGHT = '#1B3A5B';
export const NAVY_SOFT = '#33506D';

/** Cream darkened a step, for a table head or a row stripe on a white card. */
export const CREAM_DEEP = '#E5DFD2';

/* ------------------------------ semantic ------------------------------ */

/**
 * Surfaces. Only ever the primaries.
 *
 *   canvas   the page behind everything
 *   surface  cards, which lift off the cream by being white
 *   inverse  the sidebar, and anything else that needs to read as furniture
 */
export const SURFACE = {
  canvas: CREAM,
  surface: '#FFFFFF',
  inverse: NAVY,
  raised: CREAM_DEEP,
};

/** Text. Body is black; anything secondary is navy held back, not grey. */
export const TEXT = {
  body: BLACK,
  heading: NAVY,
  muted: NAVY_SOFT,
  faint: SAGE,
  onDark: CREAM,
};

/** Lines. Sage at low opacity, so borders sit in the palette instead of
 *  reaching for a neutral grey that belongs to no brand. */
export const LINE = {
  DEFAULT: 'rgba(168, 162, 139, 0.45)',
  soft: 'rgba(168, 162, 139, 0.25)',
  strong: 'rgba(168, 162, 139, 0.70)',
};

/* ------------------------------- semantics ------------------------------- */

/**
 * The one colour outside the palette, and the reason for it.
 *
 * Cold is the number this dashboard exists to surface — a lead nobody touched.
 * Rendered in a brand tint it sits quietly beside everything else, which is the
 * opposite of its job. So it keeps a red, warmed towards the palette so it does
 * not read as a borrowed Tailwind rose, and it is the ONLY exception.
 *
 * Everything else that used to be amber, emerald or indigo now uses gold and
 * teal. One loud colour on a page is a signal; four is decoration.
 */
export const ALERT = '#B32D22';
export const ALERT_DEEP = '#8E241B';

/** Gold is too light to read as text on cream, so labels use it darkened. */
export const GOLD_INK = '#8A6A22';

export const SEMANTIC = {
  alert: ALERT,
  alertInk: ALERT_DEEP,
  warn: GOLD_INK,
  positive: TEAL,
};

/**
 * Chart series, in order. Teal first because it carries the most weight
 * against cream, gold second because it is the loudest, sage last.
 */
export const SERIES = [TEAL, GOLD, SAGE];

/** Everything, for the Tailwind config to spread. */
export const TOKENS = {
  navy: { DEFAULT: NAVY, light: NAVY_LIGHT, soft: NAVY_SOFT },
  cream: { DEFAULT: CREAM, deep: CREAM_DEEP },
  ink: BLACK,
  teal: TEAL,
  gold: GOLD,
  sage: SAGE,
  canvas: SURFACE.canvas,
  surface: SURFACE.surface,
  series: { 1: SERIES[0], 2: SERIES[1], 3: SERIES[2] },
  alert: { DEFAULT: ALERT, deep: ALERT_DEEP },
  warn: GOLD_INK,
  positive: TEAL,
};
