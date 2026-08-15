/**
 * Guardian Chess engine.
 *
 * A 10x8 chess variant. The back rank is  r n b g k q g b n r  — a Guardian (g)
 * flanks the king-and-queen pair on either side. The king takes e and the queen
 * f, the reverse of ordinary chess, so that each queen starts on her own colour.
 *
 * The Guardian moves EXACTLY two squares orthogonally (never one, never three,
 * never diagonally) and leaps over anything in between, like a knight.
 * In fairy-chess terms it is a "Dabbaba". An optional rule lets it also step one
 * square, making it a Wazir-Dabbaba compound; see GUARDIAN_STEP_DELTAS.
 *
 * This module is pure ES and runs unchanged in the browser and in Node, so the
 * server can validate every move with the exact code the client used to make it.
 */

export const FILE_COUNT = 10;
export const RANK_COUNT = 8;
export const FILE_CHARS = 'abcdefghij';

export const WHITE = 'w';
export const BLACK = 'b';

/** Piece type codes. */
export const PAWN = 'p';
export const KNIGHT = 'n';
export const BISHOP = 'b';
export const ROOK = 'r';
export const QUEEN = 'q';
export const KING = 'k';
export const GUARDIAN = 'g';

/** What a pawn may become. The Guardian is a legal promotion target. */
export const PROMOTION_TYPES = [QUEEN, ROOK, BISHOP, KNIGHT, GUARDIAN];

const SAN_LETTER = {
  [KNIGHT]: 'N',
  [BISHOP]: 'B',
  [ROOK]: 'R',
  [QUEEN]: 'Q',
  [KING]: 'K',
  [GUARDIAN]: 'G',
};

const KNIGHT_DELTAS = [
  [-2, -1], [-2, 1], [-1, -2], [-1, 2],
  [1, -2], [1, 2], [2, -1], [2, 1],
];
const KING_DELTAS = [
  [-1, -1], [-1, 0], [-1, 1], [0, -1],
  [0, 1], [1, -1], [1, 0], [1, 1],
];
/** The whole point of the piece: exactly two, orthogonal only, leaping. */
const GUARDIAN_DELTAS = [[-2, 0], [2, 0], [0, -2], [0, 2]];

/**
 * Optional rule: the Guardian may also step one square orthogonally.
 *
 * In fairy-chess terms this makes it a Wazir-Dabbaba compound rather than a
 * plain Dabbaba, and it is the one change that lifts the piece's defining
 * limitation. A Dabbaba never changes the parity of its rank or file, so it
 * spends the game on a quarter of the board; add the single step and it can
 * reach every square, defend pawns on their starting rank, and be blocked by
 * nothing on the two-square leap it still owns.
 *
 * Off by default. It is stored on the position so it serialises with the game
 * and both sides are always playing the same rules.
 */
const GUARDIAN_STEP_DELTAS = [[-1, 0], [1, 0], [0, -1], [0, 1]];

/** The Guardian's move set for a given position. */
function guardianDeltas(wazir) {
  return wazir ? [...GUARDIAN_DELTAS, ...GUARDIAN_STEP_DELTAS] : GUARDIAN_DELTAS;
}

const ROOK_DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const BISHOP_DIRS = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
const QUEEN_DIRS = [...ROOK_DIRS, ...BISHOP_DIRS];

/**
 * Rank/file geometry. Row 0 is rank 8 (Black's back rank); row 7 is rank 1.
 * Column 0 is file a; column 9 is file j.
 */
export function onBoard(r, c) {
  return r >= 0 && r < RANK_COUNT && c >= 0 && c < FILE_COUNT;
}

export function squareName(r, c) {
  return FILE_CHARS[c] + (RANK_COUNT - r);
}

export function parseSquare(name) {
  if (typeof name !== 'string' || name.length < 2) return null;
  const c = FILE_CHARS.indexOf(name[0]);
  const r = RANK_COUNT - Number(name.slice(1));
  if (c < 0 || !Number.isInteger(r) || !onBoard(r, c)) return null;
  return { r, c };
}

export function opposite(color) {
  return color === WHITE ? BLACK : WHITE;
}

/**
 * The back rank, files a through j:  R N B G K Q G B N R
 *
 * The king takes e and the queen f — the reverse of standard chess — so that
 * each queen still starts on her own colour. On a ten-wide board the two
 * centre squares are e (dark) and f (light), so a queen placed to the king's
 * left the way she is on an 8x8 board would land on the wrong shade. Capablanca
 * accepted that trade in his own 10x8 game; this one keeps the queen's colour
 * instead and lets her sit to the king's right.
 *
 * Kings still face kings and queens still face queens.
 */
const BACK_RANK = [ROOK, KNIGHT, BISHOP, GUARDIAN, KING, QUEEN, GUARDIAN, BISHOP, KNIGHT, ROOK];

/**
 * Home squares that matter for castling rights. The king starts on e.
 *
 * "Kingside" means the flank the king stands on, so on this board it is the
 * a-side: files a to e hold the king, files f to j hold the queen. That makes
 * the a-file rook the king's rook and the j-file rook the queen's rook — the
 * mirror of ordinary chess, because here the king sits left of centre.
 */
const KING_HOME = { [WHITE]: { r: 7, c: 4 }, [BLACK]: { r: 0, c: 4 } };
const ROOK_HOME = {
  [WHITE]: { k: { r: 7, c: 0 }, q: { r: 7, c: 9 } },
  [BLACK]: { k: { r: 0, c: 0 }, q: { r: 0, c: 9 } },
};

export function initialBoard() {
  const board = Array.from({ length: RANK_COUNT }, () => Array(FILE_COUNT).fill(null));
  for (let c = 0; c < FILE_COUNT; c++) {
    board[0][c] = { t: BACK_RANK[c], c: BLACK };
    board[1][c] = { t: PAWN, c: BLACK };
    board[6][c] = { t: PAWN, c: WHITE };
    board[7][c] = { t: BACK_RANK[c], c: WHITE };
  }
  return board;
}

/**
 * A fresh position. `options.wazir` turns on the compound Guardian described
 * above; leave it out for the standard game.
 */
export function initialPosition(options = {}) {
  return {
    wazir: Boolean(options.wazir),
    board: initialBoard(),
    turn: WHITE,
    castling: { w: { k: true, q: true }, b: { k: true, q: true } },
    // Square a pawn just skipped over, available for en-passant capture.
    ep: null,
    halfmove: 0,
    fullmove: 1,
  };
}

function cloneBoard(board) {
  return board.map((row) => row.slice());
}

function clonePosition(pos) {
  return {
    wazir: Boolean(pos.wazir),
    board: cloneBoard(pos.board),
    turn: pos.turn,
    castling: {
      w: { k: pos.castling.w.k, q: pos.castling.w.q },
      b: { k: pos.castling.b.k, q: pos.castling.b.q },
    },
    ep: pos.ep ? { r: pos.ep.r, c: pos.ep.c } : null,
    halfmove: pos.halfmove,
    fullmove: pos.fullmove,
  };
}

function pieceAt(board, r, c) {
  return onBoard(r, c) ? board[r][c] : null;
}

export function findKing(board, color) {
  for (let r = 0; r < RANK_COUNT; r++) {
    for (let c = 0; c < FILE_COUNT; c++) {
      const p = board[r][c];
      if (p && p.t === KING && p.c === color) return { r, c };
    }
  }
  return null;
}

/**
 * Is square (r,c) attacked by `by`? Used for check detection and for the
 * squares a castling king passes through.
 */
export function isAttacked(board, r, c, by, wazir = false) {
  // Pawns. White pawns capture toward row 0, so a white pawn attacking (r,c)
  // must be sitting one row below it.
  const pawnRow = by === WHITE ? r + 1 : r - 1;
  for (const dc of [-1, 1]) {
    const p = pieceAt(board, pawnRow, c + dc);
    if (p && p.c === by && p.t === PAWN) return true;
  }

  for (const [dr, dc] of KNIGHT_DELTAS) {
    const p = pieceAt(board, r + dr, c + dc);
    if (p && p.c === by && p.t === KNIGHT) return true;
  }

  for (const [dr, dc] of KING_DELTAS) {
    const p = pieceAt(board, r + dr, c + dc);
    if (p && p.c === by && p.t === KING) return true;
  }

  // The Guardian leaps, so nothing in between can block it.
  for (const [dr, dc] of guardianDeltas(wazir)) {
    const p = pieceAt(board, r + dr, c + dc);
    if (p && p.c === by && p.t === GUARDIAN) return true;
  }

  for (const [dr, dc] of ROOK_DIRS) {
    for (let i = 1; ; i++) {
      const rr = r + dr * i;
      const cc = c + dc * i;
      if (!onBoard(rr, cc)) break;
      const p = board[rr][cc];
      if (!p) continue;
      if (p.c === by && (p.t === ROOK || p.t === QUEEN)) return true;
      break;
    }
  }

  for (const [dr, dc] of BISHOP_DIRS) {
    for (let i = 1; ; i++) {
      const rr = r + dr * i;
      const cc = c + dc * i;
      if (!onBoard(rr, cc)) break;
      const p = board[rr][cc];
      if (!p) continue;
      if (p.c === by && (p.t === BISHOP || p.t === QUEEN)) return true;
      break;
    }
  }

  return false;
}

export function inCheck(pos, color = pos.turn) {
  const k = findKing(pos.board, color);
  if (!k) return false;
  return isAttacked(pos.board, k.r, k.c, opposite(color), pos.wazir);
}

function addMove(list, move) {
  list.push(move);
}

function pushPawnMove(list, fr, fc, tr, tc, extra) {
  const promoting = tr === 0 || tr === RANK_COUNT - 1;
  if (promoting) {
    for (const promo of PROMOTION_TYPES) {
      addMove(list, { fr, fc, tr, tc, promo, ...extra });
    }
  } else {
    addMove(list, { fr, fc, tr, tc, promo: null, ...extra });
  }
}

/**
 * Moves that follow the movement rules but may leave the mover's own king in
 * check. `legalMoves` filters those out.
 */
export function pseudoLegalMoves(pos, color = pos.turn) {
  const { board } = pos;
  const moves = [];
  const them = opposite(color);

  for (let r = 0; r < RANK_COUNT; r++) {
    for (let c = 0; c < FILE_COUNT; c++) {
      const p = board[r][c];
      if (!p || p.c !== color) continue;

      switch (p.t) {
        case PAWN: {
          const dir = color === WHITE ? -1 : 1;
          const startRow = color === WHITE ? 6 : 1;

          const oneR = r + dir;
          if (onBoard(oneR, c) && !board[oneR][c]) {
            pushPawnMove(moves, r, c, oneR, c, {});
            const twoR = r + dir * 2;
            if (r === startRow && !board[twoR][c]) {
              addMove(moves, { fr: r, fc: c, tr: twoR, tc: c, promo: null, double: true });
            }
          }

          for (const dc of [-1, 1]) {
            const tc = c + dc;
            if (!onBoard(oneR, tc)) continue;
            const target = board[oneR][tc];
            if (target && target.c === them) {
              pushPawnMove(moves, r, c, oneR, tc, {});
            } else if (!target && pos.ep && pos.ep.r === oneR && pos.ep.c === tc) {
              addMove(moves, { fr: r, fc: c, tr: oneR, tc, promo: null, ep: true });
            }
          }
          break;
        }

        case KNIGHT:
        case KING: {
          const deltas = p.t === KNIGHT ? KNIGHT_DELTAS : KING_DELTAS;
          for (const [dr, dc] of deltas) {
            const tr = r + dr;
            const tc = c + dc;
            if (!onBoard(tr, tc)) continue;
            const target = board[tr][tc];
            if (target && target.c === color) continue;
            addMove(moves, { fr: r, fc: c, tr, tc, promo: null });
          }
          break;
        }

        case GUARDIAN: {
          // Exactly two squares, orthogonal, leaping over whatever is between —
          // plus a single step when the compound rule is on.
          for (const [dr, dc] of guardianDeltas(pos.wazir)) {
            const tr = r + dr;
            const tc = c + dc;
            if (!onBoard(tr, tc)) continue;
            const target = board[tr][tc];
            if (target && target.c === color) continue;
            addMove(moves, { fr: r, fc: c, tr, tc, promo: null });
          }
          break;
        }

        case ROOK:
        case BISHOP:
        case QUEEN: {
          const dirs = p.t === ROOK ? ROOK_DIRS : p.t === BISHOP ? BISHOP_DIRS : QUEEN_DIRS;
          for (const [dr, dc] of dirs) {
            for (let i = 1; ; i++) {
              const tr = r + dr * i;
              const tc = c + dc * i;
              if (!onBoard(tr, tc)) break;
              const target = board[tr][tc];
              if (target && target.c === color) break;
              addMove(moves, { fr: r, fc: c, tr, tc, promo: null });
              if (target) break;
            }
          }
          break;
        }
      }
    }
  }

  addCastlingMoves(pos, color, moves);
  return moves;
}

/**
 * Castling on the wider board: the king steps THREE squares toward the rook
 * and the rook lands on the square the king finished next to — the same rule
 * Capablanca used for his 10x8 game, and the reason the king ends up properly
 * tucked into the corner rather than stranded near the middle.
 *
 *   Kingside  (O-O)  : K e1 -> b1, R a1 -> c1   — three squares to clear
 *   Queenside (O-O-O): K e1 -> h1, R j1 -> g1   — four squares to clear
 *
 * The king stands on e, so the a-side is his side: castling kingside is the
 * short one, just as it is in ordinary chess. It simply happens to run toward
 * the a-file here, because the two extra files were added on the queen's side.
 */
function addCastlingMoves(pos, color, moves) {
  const rights = pos.castling[color];
  if (!rights.k && !rights.q) return;

  const home = KING_HOME[color];
  const king = pos.board[home.r][home.c];
  if (!king || king.t !== KING || king.c !== color) return;
  if (isAttacked(pos.board, home.r, home.c, opposite(color), pos.wazir)) return;

  const row = home.r;
  // `between` must be empty; `pass` is every square the king touches after
  // leaving f, including where it lands, and none of them may be attacked.
  const sides = [
    { side: 'k', rookCol: 0, kingTo: 1, rookTo: 2, between: [1, 2, 3], pass: [3, 2, 1] },
    { side: 'q', rookCol: 9, kingTo: 7, rookTo: 6, between: [5, 6, 7, 8], pass: [5, 6, 7] },
  ];

  for (const s of sides) {
    if (!rights[s.side]) continue;
    const rook = pos.board[row][s.rookCol];
    if (!rook || rook.t !== ROOK || rook.c !== color) continue;
    if (s.between.some((c) => pos.board[row][c])) continue;
    if (s.pass.some((c) => isAttacked(pos.board, row, c, opposite(color), pos.wazir))) continue;
    addMove(moves, {
      fr: row, fc: home.c, tr: row, tc: s.kingTo, promo: null,
      castle: s.side, rookFrom: s.rookCol, rookTo: s.rookTo,
    });
  }
}

function revokeCastlingForSquare(castling, r, c) {
  for (const color of [WHITE, BLACK]) {
    const home = ROOK_HOME[color];
    if (home.k.r === r && home.k.c === c) castling[color].k = false;
    if (home.q.r === r && home.q.c === c) castling[color].q = false;
  }
}

/** Apply a move to a position, returning a new position. No validation. */
export function applyMove(pos, move) {
  const next = clonePosition(pos);
  const { board } = next;
  const piece = board[move.fr][move.fc];
  const captured = move.ep
    ? board[move.fr][move.tc]
    : board[move.tr][move.tc];

  board[move.fr][move.fc] = null;

  if (move.ep) {
    board[move.fr][move.tc] = null;
  }

  board[move.tr][move.tc] = move.promo
    ? { t: move.promo, c: piece.c }
    : piece;

  if (move.castle) {
    const rook = board[move.fr][move.rookFrom];
    board[move.fr][move.rookFrom] = null;
    board[move.fr][move.rookTo] = rook;
  }

  if (piece.t === KING) {
    next.castling[piece.c].k = false;
    next.castling[piece.c].q = false;
  }
  revokeCastlingForSquare(next.castling, move.fr, move.fc);
  revokeCastlingForSquare(next.castling, move.tr, move.tc);

  next.ep = move.double
    ? { r: (move.fr + move.tr) / 2, c: move.fc }
    : null;

  next.halfmove = piece.t === PAWN || captured ? 0 : pos.halfmove + 1;
  if (pos.turn === BLACK) next.fullmove = pos.fullmove + 1;
  next.turn = opposite(pos.turn);

  return next;
}

/** Every move the side to move may actually play. */
export function legalMoves(pos, color = pos.turn) {
  const out = [];
  for (const m of pseudoLegalMoves(pos, color)) {
    const after = applyMove(pos, m);
    if (!inCheck(after, color)) out.push(m);
  }
  return out;
}

/**
 * A compact, comparable key for a position. Two positions with the same key
 * are the same for repetition purposes.
 */
export function positionKey(pos) {
  let s = '';
  for (let r = 0; r < RANK_COUNT; r++) {
    let empty = 0;
    for (let c = 0; c < FILE_COUNT; c++) {
      const p = pos.board[r][c];
      if (!p) { empty++; continue; }
      if (empty) { s += empty; empty = 0; }
      s += p.c === WHITE ? p.t.toUpperCase() : p.t;
    }
    if (empty) s += empty;
    s += '/';
  }
  const cast =
    (pos.castling.w.k ? 'K' : '') + (pos.castling.w.q ? 'Q' : '') +
    (pos.castling.b.k ? 'k' : '') + (pos.castling.b.q ? 'q' : '');
  return `${s} ${pos.turn} ${cast || '-'} ${pos.ep ? squareName(pos.ep.r, pos.ep.c) : '-'}`
    + (pos.wazir ? ' w' : '');
}

/**
 * Neither side can construct a mate. Guardians are treated as minor pieces —
 * a lone Guardian cannot force mate any more than a lone bishop can.
 */
export function insufficientMaterial(board) {
  const counts = {
    w: { minors: 0, major: false, bishops: [] },
    b: { minors: 0, major: false, bishops: [] },
  };

  for (let r = 0; r < RANK_COUNT; r++) {
    for (let c = 0; c < FILE_COUNT; c++) {
      const p = board[r][c];
      if (!p || p.t === KING) continue;
      const side = counts[p.c];
      if (p.t === PAWN || p.t === ROOK || p.t === QUEEN) {
        side.major = true;
      } else {
        side.minors++;
        if (p.t === BISHOP) side.bishops.push((r + c) % 2);
      }
    }
  }

  if (counts.w.major || counts.b.major) return false;
  if (counts.w.minors === 0 && counts.b.minors === 0) return true;
  // A single minor on one side, nothing on the other.
  if (counts.w.minors <= 1 && counts.b.minors === 0) return true;
  if (counts.b.minors <= 1 && counts.w.minors === 0) return true;
  // Bishop against bishop on the same colour complex.
  if (
    counts.w.minors === 1 && counts.b.minors === 1 &&
    counts.w.bishops.length === 1 && counts.b.bishops.length === 1 &&
    counts.w.bishops[0] === counts.b.bishops[0]
  ) return true;

  return false;
}

/** Standard algebraic notation, with G for the Guardian and files a–j. */
export function toSan(pos, move) {
  if (move.castle) {
    const base = move.castle === 'k' ? 'O-O' : 'O-O-O';
    return base + checkSuffix(pos, move);
  }

  const piece = pos.board[move.fr][move.fc];
  const captured = move.ep ? true : Boolean(pos.board[move.tr][move.tc]);
  const dest = squareName(move.tr, move.tc);
  let s = '';

  if (piece.t === PAWN) {
    if (captured) s += FILE_CHARS[move.fc] + 'x';
    s += dest;
    if (move.promo) s += '=' + SAN_LETTER[move.promo];
  } else {
    s += SAN_LETTER[piece.t];
    s += disambiguate(pos, move, piece);
    if (captured) s += 'x';
    s += dest;
  }

  return s + checkSuffix(pos, move);
}

function disambiguate(pos, move, piece) {
  const rivals = legalMoves(pos, piece.c).filter(
    (m) =>
      !(m.fr === move.fr && m.fc === move.fc) &&
      m.tr === move.tr &&
      m.tc === move.tc &&
      pos.board[m.fr][m.fc] &&
      pos.board[m.fr][m.fc].t === piece.t,
  );
  if (rivals.length === 0) return '';
  const sameFile = rivals.some((m) => m.fc === move.fc);
  const sameRank = rivals.some((m) => m.fr === move.fr);
  if (!sameFile) return FILE_CHARS[move.fc];
  if (!sameRank) return String(RANK_COUNT - move.fr);
  return squareName(move.fr, move.fc);
}

function checkSuffix(pos, move) {
  const after = applyMove(pos, move);
  if (!inCheck(after, after.turn)) return '';
  return legalMoves(after).length === 0 ? '#' : '+';
}

/** Match a client-supplied {from,to,promo} against the legal move list. */
export function findMove(pos, from, to, promo = null) {
  const f = typeof from === 'string' ? parseSquare(from) : from;
  const t = typeof to === 'string' ? parseSquare(to) : to;
  if (!f || !t) return null;
  const candidates = legalMoves(pos).filter(
    (m) => m.fr === f.r && m.fc === f.c && m.tr === t.r && m.tc === t.c,
  );
  if (candidates.length === 0) return null;
  if (candidates.length === 1 && !candidates[0].promo) return candidates[0];
  return candidates.find((m) => m.promo === promo) || null;
}

/**
 * A full game: position, move history, repetition tracking, and result.
 * Serialises to plain JSON so the server can ship it straight to clients.
 */
export class Game {
  constructor(state, options = {}) {
    if (state) {
      this.pos = state.pos;
      this.history = state.history;
      this.repetition = state.repetition;
      this.result = state.result;
    } else {
      this.pos = initialPosition(options);
      this.history = [];
      this.repetition = { [positionKey(this.pos)]: 1 };
      this.result = null;
    }
  }

  static fromJSON(o) {
    return new Game({
      pos: o.pos,
      history: o.history,
      repetition: o.repetition,
      result: o.result,
    });
  }

  toJSON() {
    return {
      pos: this.pos,
      history: this.history,
      repetition: this.repetition,
      result: this.result,
    };
  }

  get turn() {
    return this.pos.turn;
  }

  /** Is the compound-Guardian rule in force for this game? */
  get wazir() {
    return Boolean(this.pos.wazir);
  }

  get over() {
    return this.result !== null;
  }

  legalMoves() {
    return this.over ? [] : legalMoves(this.pos);
  }

  legalMovesFrom(r, c) {
    return this.legalMoves().filter((m) => m.fr === r && m.fc === c);
  }

  inCheck(color = this.pos.turn) {
    return inCheck(this.pos, color);
  }

  /**
   * Play a move given as square names. Returns the history entry.
   * Throws if the move is not legal — the server relies on this.
   */
  move(from, to, promo = null) {
    if (this.over) throw new Error('game is over');
    const m = findMove(this.pos, from, to, promo);
    if (!m) throw new Error(`illegal move ${from}${to}${promo || ''}`);

    const san = toSan(this.pos, m);
    const mover = this.pos.turn;
    const capturedPiece = m.ep
      ? this.pos.board[m.fr][m.tc]
      : this.pos.board[m.tr][m.tc];

    this.pos = applyMove(this.pos, m);

    const entry = {
      san,
      color: mover,
      from: squareName(m.fr, m.fc),
      to: squareName(m.tr, m.tc),
      promo: m.promo || null,
      captured: capturedPiece ? capturedPiece.t : null,
      castle: m.castle || null,
      ep: Boolean(m.ep),
      number: Math.floor(this.history.length / 2) + 1,
    };
    this.history.push(entry);

    const key = positionKey(this.pos);
    this.repetition[key] = (this.repetition[key] || 0) + 1;
    this.#updateResult(key);

    return entry;
  }

  #updateResult(key) {
    const moves = legalMoves(this.pos);
    if (moves.length === 0) {
      if (inCheck(this.pos, this.pos.turn)) {
        this.result = {
          type: 'checkmate',
          winner: opposite(this.pos.turn),
          reason: 'Checkmate',
        };
      } else {
        this.result = { type: 'stalemate', winner: null, reason: 'Stalemate' };
      }
      return;
    }
    if (insufficientMaterial(this.pos.board)) {
      this.result = { type: 'draw', winner: null, reason: 'Insufficient material' };
      return;
    }
    if (this.repetition[key] >= 3) {
      this.result = { type: 'draw', winner: null, reason: 'Threefold repetition' };
      return;
    }
    if (this.pos.halfmove >= 100) {
      this.result = { type: 'draw', winner: null, reason: 'Fifty-move rule' };
    }
  }

  resign(color) {
    if (this.over) return;
    this.result = {
      type: 'resignation',
      winner: opposite(color),
      reason: `${color === WHITE ? 'White' : 'Black'} resigned`,
    };
  }

  drawByAgreement() {
    if (this.over) return;
    this.result = { type: 'draw', winner: null, reason: 'Draw by agreement' };
  }

  timeout(color) {
    if (this.over) return;
    this.result = {
      type: 'timeout',
      winner: opposite(color),
      reason: `${color === WHITE ? 'White' : 'Black'} ran out of time`,
    };
  }
}
