/**
 * A small Guardian Chess opponent.
 *
 * Negamax with alpha-beta, a capture-only quiescence search, and iterative
 * deepening under a wall-clock budget. It is not strong — it is here so you can
 * exercise the rules without needing a second person — but it will not hang a
 * queen for nothing, and it sees a mate in one.
 *
 * Lives in shared/ rather than public/ so the tests can drive it under Node.
 */

import {
  legalMoves, applyMove, inCheck, squareName,
  RANK_COUNT, FILE_COUNT,
  PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, GUARDIAN, WHITE,
} from './engine.js';
import { CENTIPAWN } from './values.js';

/** Centipawn values, shared with the material scoreboard. */
const VALUE = CENTIPAWN;

const MATE = 1_000_000;

/** Small nudge toward the middle of the 10x8 board. */
const CENTRALITY = (() => {
  const table = [];
  for (let r = 0; r < RANK_COUNT; r++) {
    const row = [];
    for (let c = 0; c < FILE_COUNT; c++) {
      const dr = Math.abs(r - (RANK_COUNT - 1) / 2);
      const dc = Math.abs(c - (FILE_COUNT - 1) / 2);
      row.push(Math.round(12 - (dr + dc) * 2.2));
    }
    table.push(row);
  }
  return table;
})();

/** Static evaluation, from the point of view of the side to move. */
export function evaluate(pos) {
  let score = 0;
  for (let r = 0; r < RANK_COUNT; r++) {
    for (let c = 0; c < FILE_COUNT; c++) {
      const p = pos.board[r][c];
      if (!p) continue;

      let v = VALUE[p.t];
      if (p.t === KNIGHT || p.t === BISHOP || p.t === QUEEN || p.t === GUARDIAN) {
        v += CENTRALITY[r][c];
      } else if (p.t === PAWN) {
        // Reward pawns for getting closer to promotion.
        v += (p.c === WHITE ? 6 - r : r - 1) * 7;
      }
      score += p.c === WHITE ? v : -v;
    }
  }
  return pos.turn === WHITE ? score : -score;
}

function isCapture(pos, m) {
  return Boolean(m.ep || pos.board[m.tr][m.tc]);
}

/** Try the promising moves first so alpha-beta gets to prune. */
function order(pos, moves) {
  return moves
    .map((m) => {
      const victim = m.ep ? PAWN : pos.board[m.tr][m.tc]?.t;
      const attacker = pos.board[m.fr][m.fc].t;
      let s = 0;
      // Most valuable victim, least valuable attacker.
      if (victim) s += 10_000 + VALUE[victim] * 10 - VALUE[attacker];
      if (m.promo) s += 8_000 + VALUE[m.promo];
      return { m, s };
    })
    .sort((a, b) => b.s - a.s)
    .map((x) => x.m);
}

/**
 * Search captures only, so the evaluation is never taken in the middle of a
 * trade. Without this the bot cheerfully grabs a defended pawn on the last ply.
 */
function quiesce(pos, alpha, beta, deadline) {
  const standPat = evaluate(pos);
  if (standPat >= beta) return beta;
  if (standPat > alpha) alpha = standPat;
  if (Date.now() > deadline) return alpha;

  const captures = order(pos, legalMoves(pos).filter((m) => isCapture(pos, m)));
  for (const m of captures) {
    const score = -quiesce(applyMove(pos, m), -beta, -alpha, deadline);
    if (score >= beta) return beta;
    if (score > alpha) alpha = score;
  }
  return alpha;
}

function negamax(pos, depth, alpha, beta, ply, deadline) {
  const moves = legalMoves(pos);
  if (moves.length === 0) {
    // Mate found sooner is worth more, so the bot actually finishes games.
    return inCheck(pos, pos.turn) ? -MATE + ply : 0;
  }
  if (depth <= 0) return quiesce(pos, alpha, beta, deadline);
  if (Date.now() > deadline) return evaluate(pos);

  for (const m of order(pos, moves)) {
    const score = -negamax(applyMove(pos, m), depth - 1, -beta, -alpha, ply + 1, deadline);
    if (score >= beta) return beta;
    if (score > alpha) alpha = score;
  }
  return alpha;
}

export const LEVELS = {
  easy: { label: 'Easy', random: true },
  normal: { label: 'Normal', budgetMs: 450, maxDepth: 4 },
  strong: { label: 'Strong', budgetMs: 1600, maxDepth: 6 },
};

/**
 * Pick a move for the side to move.
 *
 * Returns `{ from, to, promo }` as square names, ready to hand to Game.move,
 * or null if there is nothing to play.
 */
export function chooseMove(pos, level = 'normal', rng = Math.random) {
  const config = LEVELS[level] || LEVELS.normal;
  const moves = legalMoves(pos);
  if (moves.length === 0) return null;

  if (config.random) return asMove(moves[Math.floor(rng() * moves.length)]);

  const deadline = Date.now() + config.budgetMs;
  const ordered = order(pos, moves);
  let best = [ordered[0]];

  // Iterative deepening: always have a usable answer when time runs out.
  for (let depth = 1; depth <= config.maxDepth; depth++) {
    let alpha = -Infinity;
    let tied = [];
    let aborted = false;

    for (const m of ordered) {
      if (Date.now() > deadline) { aborted = true; break; }
      // Root moves get a full window. Narrowing it to (-Infinity, -alpha)
      // would prune harder, but a move that fails high comes back clamped to
      // exactly alpha — indistinguishable from a genuine tie, which lets a
      // strictly worse move win the random tiebreak.
      const score = -negamax(applyMove(pos, m), depth - 1, -Infinity, Infinity, 1, deadline);
      if (score > alpha) {
        alpha = score;
        tied = [m];
      } else if (score === alpha) {
        tied.push(m);
      }
    }

    // A half-finished depth mixes real scores with timed-out guesses, so it is
    // worse than the depth below it. Keep the last complete result instead.
    if (!aborted && tied.length) best = tied;
    if (aborted || Date.now() > deadline) break;
  }

  // Choose among equally good moves so it does not replay the same game twice.
  return asMove(best[Math.floor(rng() * best.length)]);
}

function asMove(m) {
  return {
    from: squareName(m.fr, m.fc),
    to: squareName(m.tr, m.tc),
    promo: m.promo || null,
  };
}
