import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Game,
  FILE_COUNT,
  RANK_COUNT,
  initialPosition,
  legalMoves,
  applyMove,
  findMove,
  squareName,
  parseSquare,
  positionKey,
  insufficientMaterial,
  isAttacked,
  inCheck,
  WHITE,
  BLACK,
} from '../shared/engine.js';

/** Build a sparse position for targeted tests. `pieces` maps square -> "wg", "bk", ... */
function setup(pieces, turn = WHITE, extra = {}) {
  const pos = initialPosition();
  pos.board = Array.from({ length: RANK_COUNT }, () => Array(FILE_COUNT).fill(null));
  pos.turn = turn;
  pos.castling = { w: { k: false, q: false }, b: { k: false, q: false } };
  pos.ep = null;
  for (const [sq, code] of Object.entries(pieces)) {
    const { r, c } = parseSquare(sq);
    pos.board[r][c] = { c: code[0], t: code[1] };
  }
  return Object.assign(pos, extra);
}

function movesFrom(pos, sq) {
  const { r, c } = parseSquare(sq);
  return legalMoves(pos)
    .filter((m) => m.fr === r && m.fc === c)
    .map((m) => squareName(m.tr, m.tc))
    .sort();
}

test('board is 10 files by 8 ranks', () => {
  const pos = initialPosition();
  assert.equal(pos.board.length, 8);
  assert.equal(pos.board[0].length, 10);
  assert.equal(squareName(0, 9), 'j8');
  assert.equal(squareName(7, 0), 'a1');
  assert.deepEqual(parseSquare('j8'), { r: 0, c: 9 });
});

test('opening setup has guardians flanking king and queen', () => {
  const pos = initialPosition();
  const back = pos.board[7].map((p) => p.t).join('');
  assert.equal(back, 'rnbgkqgbnr');
  assert.equal(pos.board[0].map((p) => p.t).join(''), 'rnbgkqgbnr');
  // d1 and g1 are the white guardians; e1 king, f1 queen.
  assert.equal(pos.board[7][3].t, 'g');
  assert.equal(pos.board[7][4].t, 'k');
  assert.equal(pos.board[7][5].t, 'q');
  assert.equal(pos.board[7][6].t, 'g');
  // Twenty pawns, ten a side.
  assert.equal(pos.board[6].filter((p) => p && p.t === 'p').length, 10);
  assert.equal(pos.board[1].filter((p) => p && p.t === 'p').length, 10);
});

test('each queen starts on her own colour', () => {
  // This is the whole reason the king takes e and the queen f. A light square
  // is one where rank + file is even, the convention that makes a1 dark.
  const pos = initialPosition();
  const isLight = (r, c) => (r + c) % 2 === 0;

  const wq = pos.board[7].findIndex((p) => p.t === 'q');
  const bq = pos.board[0].findIndex((p) => p.t === 'q');
  assert.equal(squareName(7, wq), 'f1');
  assert.equal(squareName(0, bq), 'f8');
  assert.equal(isLight(7, wq), true, 'white queen on a light square');
  assert.equal(isLight(0, bq), false, 'black queen on a dark square');

  // The board still follows the usual convention in the corners.
  assert.equal(isLight(7, 0), false, 'a1 is dark');
  assert.equal(isLight(7, 9), true, 'the right-hand corner is light');

  // Kings face kings and queens face queens.
  assert.equal(pos.board[0].findIndex((p) => p.t === 'k'), 4);
  assert.equal(pos.board[7].findIndex((p) => p.t === 'k'), 4);
  assert.equal(bq, wq);
});

test('the opening position has 26 legal moves', () => {
  const g = new Game();
  const moves = g.legalMoves();
  // 10 pawns x 2 steps each.
  assert.equal(moves.filter((m) => m.fr === 6).length, 20);
  // 2 knights x 2 squares each; their third square is blocked by a pawn.
  assert.equal(moves.filter((m) => m.fc === 1 || m.fc === 8).length - 4, 4);
  // Each guardian has exactly one move at the start: straight forward two.
  // Its sideways leaps land on its own back rank, which is fully occupied.
  const guardianMoves = moves.filter((m) => m.fr === 7 && (m.fc === 3 || m.fc === 6));
  assert.equal(guardianMoves.length, 2);
  assert.deepEqual(
    guardianMoves.map((m) => squareName(m.tr, m.tc)).sort(),
    ['d3', 'g3'],
  );
  assert.equal(moves.length, 26);
});

// --- The Guardian ------------------------------------------------------

test('guardian moves exactly two squares orthogonally, never one or three', () => {
  const pos = setup({ e4: 'wg', f1: 'wk', f8: 'bk' });
  assert.deepEqual(movesFrom(pos, 'e4'), ['c4', 'e2', 'e6', 'g4'].sort());
});

test('guardian does not move diagonally', () => {
  const pos = setup({ e4: 'wg', f1: 'wk', f8: 'bk' });
  const dests = movesFrom(pos, 'e4');
  for (const bad of ['c2', 'c6', 'g2', 'g6', 'd3', 'f5']) {
    assert.ok(!dests.includes(bad), `guardian should not reach ${bad}`);
  }
});

test('guardian leaps over pieces of either colour', () => {
  const pos = setup({
    e4: 'wg',
    e5: 'wp', // own piece directly in the path
    d4: 'bp', // enemy piece directly in the path
    f1: 'wk', f8: 'bk',
  });
  const dests = movesFrom(pos, 'e4');
  assert.ok(dests.includes('e6'), 'should leap over its own pawn');
  assert.ok(dests.includes('c4'), 'should leap over an enemy pawn');
});

test('guardian captures only on its landing square', () => {
  const pos = setup({ e4: 'wg', e6: 'bp', e5: 'bp', f1: 'wk', f8: 'bk' });
  const g = new Game({ pos, history: [], repetition: {}, result: null });
  g.move('e4', 'e6');
  // The leapt-over pawn on e5 survives; the one on e6 is taken.
  assert.equal(g.pos.board[parseSquare('e5').r][parseSquare('e5').c].t, 'p');
  assert.equal(g.pos.board[parseSquare('e6').r][parseSquare('e6').c].t, 'g');
});

test('guardian cannot land on a friendly piece', () => {
  const pos = setup({ e4: 'wg', e6: 'wp', f1: 'wk', f8: 'bk' });
  assert.ok(!movesFrom(pos, 'e4').includes('e6'));
});

test('guardian is blocked only by the board edge', () => {
  const pos = setup({ a1: 'wg', f8: 'bk', f1: 'wk' });
  assert.deepEqual(movesFrom(pos, 'a1'), ['a3', 'c1'].sort());
  const pos2 = setup({ j8: 'bg', f8: 'bk', f1: 'wk' }, BLACK);
  assert.deepEqual(movesFrom(pos2, 'j8'), ['h8', 'j6'].sort());
});

test('guardian gives check and can be blocked only by capture', () => {
  const pos = setup({ e4: 'wg', e6: 'bk', f1: 'wk' }, BLACK);
  assert.ok(inCheck(pos, BLACK), 'guardian two squares away gives check');
  // Interposing on e5 does nothing, because the guardian leaps.
  const pos2 = setup({ e4: 'wg', e6: 'bk', e5: 'br', f1: 'wk' }, BLACK);
  assert.ok(inCheck(pos2, BLACK), 'a piece in between cannot block a leaper');
});

test('guardian is confined to one parity of rank and file', () => {
  // A documented consequence of the movement rule, asserted so it cannot
  // change silently: from d1 the guardian only ever reaches odd ranks and
  // even-indexed files (b, d, f, h, j).
  const start = parseSquare('d1');
  const seen = new Set([`${start.r},${start.c}`]);
  const queue = [start];
  while (queue.length) {
    const { r, c } = queue.pop();
    for (const [dr, dc] of [[-2, 0], [2, 0], [0, -2], [0, 2]]) {
      const rr = r + dr;
      const cc = c + dc;
      if (rr < 0 || rr >= RANK_COUNT || cc < 0 || cc >= FILE_COUNT) continue;
      const key = `${rr},${cc}`;
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push({ r: rr, c: cc });
    }
  }
  assert.equal(seen.size, 20, 'guardian reaches exactly a quarter of the board');
  for (const key of seen) {
    const [r, c] = key.split(',').map(Number);
    assert.equal(r % 2, 1, 'never leaves odd rows (ranks 1,3,5,7)');
    assert.equal(c % 2, 1, 'never leaves odd columns (files b,d,f,h,j)');
  }
});

test('isAttacked sees guardians but not at range one or three', () => {
  const board = setup({ e4: 'wg' }).board;
  const at = (sq) => {
    const { r, c } = parseSquare(sq);
    return isAttacked(board, r, c, WHITE);
  };
  assert.ok(at('e6'));
  assert.ok(at('e2'));
  assert.ok(at('c4'));
  assert.ok(at('g4'));
  assert.ok(!at('e5'), 'one square away is not attacked');
  assert.ok(!at('e7'), 'three squares away is not attacked');
  assert.ok(!at('c6'), 'diagonally two-and-two is not attacked');
});

// --- Ordinary pieces on the wider board --------------------------------

test('rook sweeps the full ten-file rank', () => {
  const pos = setup({ a1: 'wr', f5: 'wk', f8: 'bk' });
  const dests = movesFrom(pos, 'a1');
  assert.ok(dests.includes('j1'), 'reaches the far file');
  assert.equal(dests.filter((d) => d.endsWith('1')).length, 9);
});

test('queen and bishop use the long diagonals', () => {
  const pos = setup({ a1: 'wb', f5: 'wk', f8: 'bk' });
  assert.ok(movesFrom(pos, 'a1').includes('h8'));
});

test('knight moves normally', () => {
  const pos = setup({ e4: 'wn', f1: 'wk', f8: 'bk' });
  assert.deepEqual(
    movesFrom(pos, 'e4'),
    ['c3', 'c5', 'd2', 'd6', 'f2', 'f6', 'g3', 'g5'].sort(),
  );
});

// --- Pawns --------------------------------------------------------------

test('pawn double step and en passant work on the wide board', () => {
  const g = new Game();
  g.move('j2', 'j4');
  g.move('a7', 'a5');
  g.move('j4', 'j5');
  g.move('i7', 'i5'); // double step alongside the white pawn
  const ep = g.pos.ep;
  assert.deepEqual(ep, parseSquare('i6'));
  const entry = g.move('j5', 'i6');
  assert.equal(entry.ep, true);
  assert.equal(entry.san, 'jxi6');
  // The captured pawn was on i5, not on the landing square.
  assert.equal(g.pos.board[parseSquare('i5').r][parseSquare('i5').c], null);
});

test('pawn promotes, and may become a guardian', () => {
  const pos = setup({ b7: 'wp', f1: 'wk', a1: 'bk' });
  const g = new Game({ pos, history: [], repetition: {}, result: null });
  const promos = legalMoves(pos)
    .filter((m) => m.fr === parseSquare('b7').r)
    .map((m) => m.promo);
  assert.deepEqual([...new Set(promos)].sort(), ['b', 'g', 'n', 'q', 'r']);
  g.move('b7', 'b8', 'g');
  assert.equal(g.pos.board[0][1].t, 'g');
  assert.equal(g.history[0].san.startsWith('b8=G'), true);
});

// --- Castling -----------------------------------------------------------

test('castling moves the king three squares toward the rook', () => {
  const pos = setup(
    { e1: 'wk', j1: 'wr', a1: 'wr', e8: 'bk' },
    WHITE,
    { castling: { w: { k: true, q: true }, b: { k: false, q: false } } },
  );
  const dests = movesFrom(pos, 'e1');
  // The king stands on e, so the a-side is the kingside and O-O runs left.
  assert.ok(dests.includes('b1'), 'kingside castling available');
  assert.ok(dests.includes('h1'), 'queenside castling available');
  assert.ok(!dests.includes('g1'), 'only the three-square castle exists');
  assert.ok(!dests.includes('c1'), 'only the three-square castle exists');

  const g = new Game({ pos, history: [], repetition: {}, result: null });
  g.move('e1', 'b1');
  assert.equal(g.pos.board[7][1].t, 'k', 'king lands on b1');
  assert.equal(g.pos.board[7][2].t, 'r', 'rook lands on c1');
  assert.equal(g.pos.board[7][0], null, 'a1 is vacated');
  assert.equal(g.pos.board[7][4], null, 'e1 is vacated');
  assert.equal(g.history[0].san, 'O-O', 'castling with the king rook is short');
});

test('kingside is the short castle, as it is in ordinary chess', () => {
  const pos = setup(
    { e1: 'wk', j1: 'wr', a1: 'wr', e8: 'bk' },
    WHITE,
    { castling: { w: { k: true, q: true }, b: { k: false, q: false } } },
  );
  // Squares that must be empty between the king and each rook.
  const between = (from, to) => {
    let n = 0;
    for (let c = Math.min(from, to) + 1; c < Math.max(from, to); c++) n++;
    return n;
  };
  assert.equal(between(4, 0), 3, 'kingside: b1 c1 d1');
  assert.equal(between(4, 9), 4, 'queenside: f1 g1 h1 i1');

  // And the notation follows the rook, not the direction of travel.
  const short = new Game({ pos, history: [], repetition: {}, result: null });
  short.move('e1', 'b1');
  assert.equal(short.history[0].san, 'O-O');

  const long = new Game({ pos, history: [], repetition: {}, result: null });
  long.move('e1', 'h1');
  assert.equal(long.history[0].san, 'O-O-O');
});

test('queenside castling clears the four squares between king and rook', () => {
  const blocked = setup(
    { e1: 'wk', j1: 'wr', h1: 'wn', e8: 'bk' },
    WHITE,
    { castling: { w: { k: false, q: true }, b: { k: false, q: false } } },
  );
  assert.ok(!movesFrom(blocked, 'e1').includes('h1'), 'knight on h1 blocks');

  const clear = setup(
    { e1: 'wk', j1: 'wr', e8: 'bk' },
    WHITE,
    { castling: { w: { k: false, q: true }, b: { k: false, q: false } } },
  );
  const g = new Game({ pos: clear, history: [], repetition: {}, result: null });
  g.move('e1', 'h1');
  assert.equal(g.pos.board[7][7].t, 'k', 'king lands on h1');
  assert.equal(g.pos.board[7][6].t, 'r', 'rook lands on g1');
  assert.equal(g.pos.board[7][9], null, 'j1 is vacated');
  assert.equal(g.history[0].san, 'O-O-O');
});

test('cannot castle out of, through, or into check', () => {
  const rights = { w: { k: false, q: true }, b: { k: false, q: false } };
  // The king crosses f1 and g1 on its way to h1, so all three are guarded.
  for (const [square, attacker] of [['f1', 'f8'], ['g1', 'g8'], ['h1', 'h8']]) {
    const pos = setup({ e1: 'wk', j1: 'wr', [attacker]: 'br', e8: 'bk' }, WHITE, { castling: rights });
    assert.ok(!movesFrom(pos, 'e1').includes('h1'), `${square} is attacked`);
  }

  const outOf = setup({ e1: 'wk', j1: 'wr', e7: 'br', e8: 'bk' }, WHITE, { castling: rights });
  assert.ok(!movesFrom(outOf, 'e1').includes('h1'), 'king is in check');
});

test('a guardian can veto castling by covering a transit square', () => {
  // Black guardian on g3 attacks g1, the square the white king crosses.
  const pos = setup(
    { e1: 'wk', j1: 'wr', g3: 'bg', e8: 'bk' },
    WHITE,
    { castling: { w: { k: false, q: true }, b: { k: false, q: false } } },
  );
  assert.ok(!movesFrom(pos, 'e1').includes('h1'));
});

test('moving the king or rook forfeits castling rights', () => {
  const pos = setup(
    { e1: 'wk', j1: 'wr', e8: 'bk', a8: 'br' },
    WHITE,
    { castling: { w: { k: false, q: true }, b: { k: false, q: false } } },
  );
  const g = new Game({ pos, history: [], repetition: {}, result: null });
  g.move('j1', 'i1');
  g.move('e8', 'd8');
  g.move('i1', 'j1');
  g.move('d8', 'e8');
  assert.equal(g.pos.castling.w.q, false, 'the j-file rook is the queen rook');
  assert.ok(!movesFrom(g.pos, 'e1').includes('h1'));
});

// --- Check, mate, and endings -------------------------------------------

test('a move that leaves the king in check is illegal', () => {
  // White bishop on d2 is pinned against the king on e1 by a queen on a5.
  const pos = setup({ e1: 'wk', d2: 'wb', a5: 'bq', e8: 'bk' });
  assert.deepEqual(movesFrom(pos, 'd2'), ['a5', 'b4', 'c3'].sort());
});

test('checkmate ends the game and names the winner', () => {
  // Back-rank mate: black king on a8, white rook delivers on the 8th, own pawns box it in.
  const pos = setup({ a8: 'bk', a7: 'bp', b7: 'bp', j1: 'wr', f1: 'wk' });
  const g = new Game({ pos, history: [], repetition: {}, result: null });
  g.move('j1', 'j8');
  assert.equal(g.history[0].san, 'Rj8#');
  assert.deepEqual(g.result, { type: 'checkmate', winner: WHITE, reason: 'Checkmate' });
  assert.throws(() => g.move('a7', 'a6'), /game is over/);
});

test('a guardian can deliver checkmate', () => {
  // Black king cornered on a8. The rook on b1 seals b7 and b8; the guardian on
  // c7 covers a7; the second guardian leaps a4-a6 to give a check that cannot
  // be blocked (it leaps) and cannot be captured (a6 is not adjacent to a8).
  const pos = setup({ a8: 'bk', a4: 'wg', c7: 'wg', b1: 'wr', f1: 'wk' });
  assert.ok(!inCheck(pos, BLACK), 'black is not already in check');
  const g = new Game({ pos, history: [], repetition: {}, result: null });
  g.move('a4', 'a6');
  assert.equal(g.history[0].san, 'Ga6#');
  assert.equal(g.result.type, 'checkmate');
  assert.equal(g.result.winner, WHITE);
});

test('stalemate is a draw', () => {
  const pos = setup({ a8: 'bk', c7: 'wq', f1: 'wk' }, BLACK);
  const g = new Game({ pos, history: [], repetition: {}, result: null });
  assert.equal(g.legalMoves().length, 0);
  const g2 = new Game({
    pos: setup({ a8: 'bk', c8: 'wq', f1: 'wk' }),
    history: [], repetition: {}, result: null,
  });
  g2.move('c8', 'c7');
  assert.deepEqual(g2.result, { type: 'stalemate', winner: null, reason: 'Stalemate' });
});

test('lone king versus king and guardian is insufficient material', () => {
  assert.ok(insufficientMaterial(setup({ a1: 'wk', j8: 'bk' }).board));
  assert.ok(insufficientMaterial(setup({ a1: 'wk', b1: 'wg', j8: 'bk' }).board));
  assert.ok(!insufficientMaterial(setup({ a1: 'wk', b1: 'wr', j8: 'bk' }).board));
  assert.ok(!insufficientMaterial(setup({ a1: 'wk', b2: 'wp', j8: 'bk' }).board));
});

test('threefold repetition draws', () => {
  const g = new Game();
  for (let i = 0; i < 2; i++) {
    g.move('b1', 'c3');
    g.move('b8', 'c6');
    g.move('c3', 'b1');
    g.move('c6', 'b8');
  }
  assert.equal(g.result.type, 'draw');
  assert.equal(g.result.reason, 'Threefold repetition');
});

test('fifty-move rule draws', () => {
  const pos = setup({ a1: 'wk', j8: 'bk', a3: 'wr', j6: 'br' }, WHITE, { halfmove: 98 });
  const g = new Game({ pos, history: [], repetition: {}, result: null });
  g.move('a3', 'b3');
  assert.equal(g.result, null);
  g.move('j6', 'i6');
  assert.equal(g.result.reason, 'Fifty-move rule');
});

test('resignation records the opponent as winner', () => {
  const g = new Game();
  g.resign(WHITE);
  assert.equal(g.result.winner, BLACK);
  assert.equal(g.result.type, 'resignation');
});

// --- Integrity ----------------------------------------------------------

test('illegal moves are rejected rather than silently applied', () => {
  const g = new Game();
  assert.throws(() => g.move('d1', 'd2'), /illegal/, 'guardian cannot move one square');
  assert.throws(() => g.move('d1', 'd4'), /illegal/, 'guardian cannot move three squares');
  assert.throws(() => g.move('d1', 'f3'), /illegal/, 'guardian cannot move diagonally');
  assert.throws(() => g.move('a7', 'a6'), /illegal/, 'cannot move the opponent pieces');
  assert.throws(() => g.move('e1', 'e5'), /illegal/, 'queen cannot jump its own pawn');
  assert.equal(g.history.length, 0, 'no rejected move altered the game');
});

test('applyMove does not mutate the position it was given', () => {
  const pos = initialPosition();
  const before = positionKey(pos);
  const m = findMove(pos, 'e2', 'e4');
  applyMove(pos, m);
  assert.equal(positionKey(pos), before);
});

test('a game round-trips through JSON with its state intact', () => {
  const g = new Game();
  g.move('e2', 'e4');
  g.move('e7', 'e5');
  g.move('d1', 'd3');
  const revived = Game.fromJSON(JSON.parse(JSON.stringify(g.toJSON())));
  assert.equal(positionKey(revived.pos), positionKey(g.pos));
  assert.deepEqual(revived.history, g.history);
  assert.equal(revived.legalMoves().length, g.legalMoves().length);
});

test('a hundred random games finish without the engine throwing', () => {
  let seed = 12345;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

  for (let i = 0; i < 100; i++) {
    const g = new Game();
    for (let ply = 0; ply < 120 && !g.over; ply++) {
      const moves = g.legalMoves();
      assert.ok(moves.length > 0, 'a game that is not over must have a legal move');
      const m = moves[Math.floor(rand() * moves.length)];
      g.move(squareName(m.fr, m.fc), squareName(m.tr, m.tc), m.promo);
      // The side to move must always still have a king.
      assert.ok(g.pos.board.flat().some((p) => p && p.t === 'k' && p.c === 'w'));
      assert.ok(g.pos.board.flat().some((p) => p && p.t === 'k' && p.c === 'b'));
    }
  }
});
