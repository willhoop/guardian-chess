/**
 * What each piece is worth, in pawns.
 *
 * One table, used by the computer opponent and by the material scoreboard, so
 * the two can never quietly disagree about how much a Guardian is worth.
 *
 * The Guardian is priced below a knight on purpose. It is confined to a quarter
 * of the board for the whole game and can never reach an even rank, so a lot of
 * the activity its move-set suggests is simply unavailable. These are estimates
 * from the piece's geometry, not from played games — adjust them if experience
 * says otherwise.
 */
export const PIECE_VALUE = {
  p: 1,
  n: 3,
  b: 3.25,
  g: 2.75,
  r: 5,
  q: 9,
  k: 0,
};

/** The same numbers in centipawns, which is what the search wants. */
export const CENTIPAWN = Object.fromEntries(
  Object.entries(PIECE_VALUE).map(([k, v]) => [k, Math.round(v * 100)]),
);

/** Total material for one colour. */
export function materialFor(board, color) {
  let total = 0;
  for (const row of board) {
    for (const piece of row) {
      if (piece && piece.c === color) total += PIECE_VALUE[piece.t] || 0;
    }
  }
  return total;
}

/** Trim trailing zeroes: 3.25 stays, 5.0 becomes 5. */
export function formatValue(n) {
  return Number(n.toFixed(2)).toString();
}
