/**
 * Piece artwork. Every piece is drawn in the same 45x45 box with the same
 * base plinth, so the Guardian reads as part of the set rather than an import.
 *
 * The Guardian is a shield carrying a bold orthogonal cross — a nod to the four
 * directions it leaps, and to the fact that it never moves diagonally.
 */

const SHAPES = {
  p: () => `
    <circle cx="22.5" cy="12.5" r="5.6"/>
    <path d="M17 33.5c0-6.5 3.4-7.4 3.4-12.6h4.2c0 5.2 3.4 6.1 3.4 12.6z"/>
    <rect x="11.5" y="33.5" width="22" height="4.6" rx="2.3"/>
  `,

  r: () => `
    <path d="M12 9h4.2v3.2h3.6V9h5.4v3.2h3.6V9H33v8.4H12z"/>
    <rect x="11" y="17.4" width="23" height="4" rx="1"/>
    <path d="M15.6 21.4c0 6.3-1 9.6-1.8 12.4h17.4c-.8-2.8-1.8-6.1-1.8-12.4z"/>
    <rect x="10" y="33.8" width="25" height="4.4" rx="2.2"/>
  `,

  n: (a) => `
    <path d="M15.4 33.8c0-4.2.9-8 4-11.6 1.4-1.6 1.9-2.9 1.5-3.9l-3.6 2.6c-2.6 1.5-4.8.4-4.3-2.2.5-3.1 3.1-6.8 6.7-9.4 2.5-1.8 4.6-3.1 6.1-4.7l1 3.5 2.6-2.6c2.6 3.1 4.1 7.6 4.6 12.6.5 5.1.1 10.2-.2 15.7z"/>
    <circle cx="24.6" cy="14.6" r="1.4" fill="${a}" stroke="none"/>
    <path d="M28.6 10.4c1.9 2.6 3 6.2 3.4 10.4" fill="none" stroke="${a}" stroke-width="1.1" opacity=".55"/>
    <rect x="10" y="33.8" width="25" height="4.4" rx="2.2"/>
  `,

  b: (a) => `
    <circle cx="22.5" cy="6.4" r="2.2"/>
    <path d="M22.5 9.4c3.9 3.2 6.8 7.3 6.8 11.6 0 4.4-3 7.2-6.8 7.2s-6.8-2.8-6.8-7.2c0-4.3 2.9-8.4 6.8-11.6z"/>
    <path d="M25.4 13.2l-4.6 6.6" fill="none" stroke="${a}" stroke-width="1.4" stroke-linecap="round" opacity=".7"/>
    <rect x="14.6" y="28" width="15.8" height="3.8" rx="1.6"/>
    <path d="M16.2 31.8c-.6 1.7-1.9 2.6-3.4 3.2h19.4c-1.5-.6-2.8-1.5-3.4-3.2z"/>
    <rect x="9.6" y="34.6" width="25.8" height="3.8" rx="1.9"/>
  `,

  // The widest piece on the board, and the only one with a gem. Between the
  // spiked crown and the flared base it should be unmistakable at a glance.
  q: (a) => `
    <circle cx="6.8" cy="9"   r="2.5"/>
    <circle cx="14.6" cy="6.2" r="2.5"/>
    <circle cx="22.5" cy="4.6" r="2.8"/>
    <circle cx="30.4" cy="6.2" r="2.5"/>
    <circle cx="38.2" cy="9"   r="2.5"/>
    <path d="M8 21.6 6.8 10.2l4.6 7.2 3.2-9.4 4 9.6 3.9-11.6 3.9 11.6 4-9.6 3.2 9.4 4.6-7.2L37 21.6z"/>
    <rect x="7.4" y="21.6" width="30.2" height="4.4" rx="1.6"/>
    <circle cx="22.5" cy="23.8" r="1.9" fill="${a}" stroke="none"/>
    <path d="M9.6 26c.6 4.4-.8 7.6-2.6 9.8h31c-1.8-2.2-3.2-5.4-2.6-9.8z"/>
    <rect x="5.4" y="35.6" width="34.2" height="3.9" rx="1.95"/>
  `,

  // Deliberately narrower than the queen, with a tall cross instead of spikes.
  k: () => `
    <path d="M20.7 2.6h3.6v4.2h4.2v3.6h-4.2v4.4h-3.6v-4.4h-4.2V6.8h4.2z"/>
    <path d="M14.2 24.8c0-4.9 3.7-8.6 8.3-8.6s8.3 3.7 8.3 8.6z"/>
    <rect x="12.8" y="24.8" width="19.4" height="3.8" rx="1.4"/>
    <path d="M14.4 28.6c.2 4-.9 6.2-2.2 8h20.6c-1.3-1.8-2.4-4-2.2-8z"/>
    <rect x="10.2" y="36.6" width="24.6" height="3.6" rx="1.8"/>
  `,

  g: (a) => `
    <path d="M22.5 5.2 33.2 9.4c0 10.4-3.1 18.6-10.7 23.6C15 28 11.8 19.8 11.8 9.4z"/>
    <path d="M20.6 11.4h3.8v5.2h5.2v3.8h-5.2v5.2h-3.8v-5.2h-5.2v-3.8h5.2z"
          fill="${a}" stroke="none"/>
    <path d="M19.8 32.4h5.4v2.6h-5.4z"/>
    <rect x="10.4" y="34.6" width="24.2" height="3.9" rx="1.95"/>
  `,
};

const PALETTE = {
  w: { fill: '#f6f2e8', line: '#20222a', accent: '#20222a' },
  b: { fill: '#33343d', line: '#0c0d12', accent: '#e9e4d6' },
};

/** Inline SVG markup for a piece. `type` is p/r/n/b/q/k/g, `color` is w/b. */
export function pieceSvg(type, color) {
  const shape = SHAPES[type];
  if (!shape) return '';
  const { fill, line, accent } = PALETTE[color];
  return `<svg class="piece-svg" viewBox="0 0 45 45" aria-hidden="true" focusable="false">
    <g fill="${fill}" stroke="${line}" stroke-width="1.5"
       stroke-linejoin="round" stroke-linecap="round">
      ${shape(accent)}
    </g>
  </svg>`;
}

export const PIECE_NAMES = {
  p: 'Pawn', r: 'Rook', n: 'Knight', b: 'Bishop',
  q: 'Queen', k: 'King', g: 'Guardian',
};

export const COLOR_NAMES = { w: 'White', b: 'Black' };

/** Shown on the pieces when the board's letter overlay is switched on. */
export const PIECE_LETTERS = {
  p: 'P', r: 'R', n: 'N', b: 'B', q: 'Q', k: 'K', g: 'G',
};

/** Piece values come from the shared table the engine's bot also uses. */
export { PIECE_VALUE as PIECE_VALUES } from '/shared/values.js';
