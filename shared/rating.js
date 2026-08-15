/**
 * Elo ratings.
 *
 * Standard Elo, with a larger K while a player is still provisional so new
 * accounts find their level quickly instead of grinding up from 1200.
 */

export const STARTING_RATING = 1200;

/** Below this many rated games a rating is shown as provisional. */
export const PROVISIONAL_GAMES = 5;

/**
 * How far a single result can move a rating. New players move fast, settled
 * players move slowly, strong players slowest of all.
 */
export function kFactor(gamesPlayed, rating) {
  if (gamesPlayed < 10) return 40;
  if (rating >= 2100) return 16;
  return 24;
}

/** Probability that `rating` beats `opponent`, between 0 and 1. */
export function expectedScore(rating, opponent) {
  return 1 / (1 + 10 ** ((opponent - rating) / 400));
}

/**
 * New ratings after a game. `scoreA` is 1 if A won, 0 if A lost, 0.5 for a draw.
 * Returns whole-number ratings plus the deltas, so the UI can show "+12".
 */
export function applyResult(a, b, scoreA) {
  const expectedA = expectedScore(a.rating, b.rating);
  const expectedB = 1 - expectedA;

  const nextA = Math.round(a.rating + kFactor(a.games, a.rating) * (scoreA - expectedA));
  const nextB = Math.round(b.rating + kFactor(b.games, b.rating) * ((1 - scoreA) - expectedB));

  return {
    a: { rating: nextA, delta: nextA - a.rating },
    b: { rating: nextB, delta: nextB - b.rating },
  };
}
