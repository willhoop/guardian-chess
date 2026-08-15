/**
 * The optional Wazir-Dabbaba compound: Guardians may also step one square.
 *
 * The point of these tests is that the option changes the Guardian and nothing
 * else, that it is off unless asked for, and that it genuinely lifts the
 * parity limitation rather than merely appearing to.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Game, initialPosition, legalMoves, squareName, parseSquare,
  isAttacked, inCheck, positionKey, applyMove, findMove,
  RANK_COUNT, FILE_COUNT, WHITE, BLACK,
} from '../shared/engine.js';
import { chooseMove } from '../shared/bot.js';

function setup(pieces, turn = WHITE, extra = {}) {
  const pos = initialPosition(extra.wazir ? { wazir: true } : {});
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

const movesFrom = (pos, sq) => {
  const { r, c } = parseSquare(sq);
  return legalMoves(pos).filter((m) => m.fr === r && m.fc === c)
    .map((m) => squareName(m.tr, m.tc)).sort();
};

/* ── Off by default ──────────────────────────────────────────────────── */

test('the compound is off unless asked for', () => {
  assert.equal(initialPosition().wazir, false);
  assert.equal(new Game().wazir, false);
  assert.equal(new Game(null, {}).wazir, false);
  assert.equal(new Game(null, { wazir: true }).wazir, true);
});

test('without the option the guardian still refuses a single step', () => {
  const pos = setup({ e4: 'wg', e1: 'wk', e8: 'bk' });
  assert.deepEqual(movesFrom(pos, 'e4'), ['c4', 'e2', 'e6', 'g4'].sort());
});

/* ── With the option on ──────────────────────────────────────────────── */

test('the compound guardian moves one or two squares, still never diagonally', () => {
  const pos = setup({ e4: 'wg', e1: 'wk', e8: 'bk' }, WHITE, { wazir: true });
  assert.deepEqual(
    movesFrom(pos, 'e4'),
    ['c4', 'd4', 'e2', 'e3', 'e5', 'e6', 'f4', 'g4'].sort(),
  );
  for (const bad of ['d3', 'd5', 'f3', 'f5', 'c6', 'g2']) {
    assert.ok(!movesFrom(pos, 'e4').includes(bad), `still not ${bad}`);
  }
});

test('it keeps the leap: a piece in the way blocks neither distance', () => {
  const pos = setup(
    { e4: 'wg', e6: 'bp', d4: 'bp', e1: 'wk', e8: 'bk' },
    WHITE, { wazir: true },
  );
  const dests = movesFrom(pos, 'e4');
  assert.ok(dests.includes('e6'), 'leaps to capture at range two');
  assert.ok(dests.includes('e5'), 'and may still step to the empty square between');
  assert.ok(dests.includes('d4'), 'captures the adjacent piece too');
});

test('the option lifts the parity limitation', () => {
  // The plain piece reaches a quarter of the board; the compound reaches all.
  const reach = (wazir) => {
    const deltas = wazir
      ? [[-2, 0], [2, 0], [0, -2], [0, 2], [-1, 0], [1, 0], [0, -1], [0, 1]]
      : [[-2, 0], [2, 0], [0, -2], [0, 2]];
    const start = parseSquare('d1');
    const seen = new Set([`${start.r},${start.c}`]);
    const queue = [start];
    while (queue.length) {
      const { r, c } = queue.pop();
      for (const [dr, dc] of deltas) {
        const rr = r + dr; const cc = c + dc;
        if (rr < 0 || rr >= RANK_COUNT || cc < 0 || cc >= FILE_COUNT) continue;
        const key = `${rr},${cc}`;
        if (seen.has(key)) continue;
        seen.add(key);
        queue.push({ r: rr, c: cc });
      }
    }
    return seen.size;
  };
  assert.equal(reach(false), 20, 'plain: a quarter of the board');
  assert.equal(reach(true), 80, 'compound: every square');
});

test('a compound guardian can defend a pawn on its starting rank', () => {
  // Rank 2 is even, so the plain piece can never do this.
  // The king must stand well clear, or it defends d2 itself and proves nothing.
  const plain = setup({ d3: 'wg', j1: 'wk', e8: 'bk' });
  const compound = setup({ d3: 'wg', j1: 'wk', e8: 'bk' }, WHITE, { wazir: true });
  const { r, c } = parseSquare('d2');
  assert.equal(isAttacked(plain.board, r, c, WHITE, false), false);
  assert.equal(isAttacked(compound.board, r, c, WHITE, true), true);
});

test('a compound guardian gives check from one square away', () => {
  const pos = setup({ e5: 'wg', e6: 'bk', e1: 'wk' }, BLACK, { wazir: true });
  assert.ok(inCheck(pos, BLACK), 'adjacent guardian checks when stepping is on');

  const plain = setup({ e5: 'wg', e6: 'bk', e1: 'wk' }, BLACK);
  assert.ok(!inCheck(plain, BLACK), 'but not in the standard game');
});

test('the two-square check still cannot be blocked', () => {
  const pos = setup({ e4: 'wg', e6: 'bk', e5: 'br', e1: 'wk' }, BLACK, { wazir: true });
  assert.ok(inCheck(pos, BLACK), 'a leaper is a leaper either way');
});

test('a compound guardian covers castling squares it otherwise could not', () => {
  // f1 is even-file; a plain black guardian on f3 could never attack it.
  const rights = { w: { k: false, q: true }, b: { k: false, q: false } };
  const plain = setup({ e1: 'wk', j1: 'wr', f2: 'bg', e8: 'bk' }, WHITE, { castling: rights });
  assert.ok(movesFrom(plain, 'e1').includes('h1'), 'plain guardian on f2 cannot reach f1');

  const compound = setup(
    { e1: 'wk', j1: 'wr', f2: 'bg', e8: 'bk' },
    WHITE, { castling: rights, wazir: true },
  );
  assert.ok(!movesFrom(compound, 'e1').includes('h1'), 'stepping, it covers f1');
});

/* ── The option travels with the game ────────────────────────────────── */

test('the rule survives a move, a clone and a JSON round trip', () => {
  const g = new Game(null, { wazir: true });
  g.move('e2', 'e4');
  assert.equal(g.pos.wazir, true, 'kept across applyMove');
  const revived = Game.fromJSON(JSON.parse(JSON.stringify(g.toJSON())));
  assert.equal(revived.wazir, true);
  assert.equal(revived.legalMoves().length, g.legalMoves().length);
});

test('the rule is part of the position key', () => {
  // Otherwise repetition could match two positions played under different rules.
  const plain = initialPosition();
  const compound = initialPosition({ wazir: true });
  assert.notEqual(positionKey(plain), positionKey(compound));
});

test('applyMove does not lose the rule', () => {
  const pos = initialPosition({ wazir: true });
  const after = applyMove(pos, findMove(pos, 'e2', 'e4'));
  assert.equal(after.wazir, true);
});

test('the option does not change the opening position at all', () => {
  // Worth pinning down, because it is counter-intuitive. Every square next to a
  // Guardian at the start is occupied by one of its own pieces: a pawn in front,
  // and the bishop, king, queen or knight on either side. So the extra single
  // step buys nothing until the position opens up, and both games begin with
  // the same 26 moves and the same two guardian moves.
  const plain = new Game();
  const compound = new Game(null, { wazir: true });
  assert.equal(plain.legalMoves().length, 26);
  assert.equal(compound.legalMoves().length, 26);

  const guardianMoves = (g) => g.legalMoves()
    .filter((m) => m.fr === 7 && (m.fc === 3 || m.fc === 6))
    .map((m) => squareName(m.tr, m.tc)).sort();
  assert.deepEqual(guardianMoves(compound), ['d3', 'g3']);
  assert.deepEqual(guardianMoves(compound), guardianMoves(plain));
});

test('nothing else about the game changes', () => {
  const plain = initialPosition();
  const compound = initialPosition({ wazir: true });
  // Same board, same rights, same everything but the flag.
  assert.deepEqual(compound.board, plain.board);
  assert.deepEqual(compound.castling, plain.castling);
  assert.equal(compound.turn, plain.turn);

  // Non-guardian pieces are untouched.
  const kn = setup({ e4: 'wn', e1: 'wk', e8: 'bk' }, WHITE, { wazir: true });
  assert.deepEqual(
    movesFrom(kn, 'e4'),
    ['c3', 'c5', 'd2', 'd6', 'f2', 'f6', 'g3', 'g5'].sort(),
  );
});

test('the bot plays the compound game legally', () => {
  const g = new Game(null, { wazir: true });
  for (let ply = 0; ply < 10 && !g.over; ply++) {
    const mv = chooseMove(g.pos, 'easy');
    assert.ok(mv, 'a move was offered');
    const legal = legalMoves(g.pos).some((m) =>
      squareName(m.fr, m.fc) === mv.from && squareName(m.tr, m.tc) === mv.to);
    assert.ok(legal, `${mv.from}${mv.to} is legal under the compound rule`);
    g.move(mv.from, mv.to, mv.promo);
  }
});

test('a compound game of random moves never reaches an illegal state', () => {
  let seed = 99;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 15; i++) {
    const g = new Game(null, { wazir: true });
    for (let ply = 0; ply < 80 && !g.over; ply++) {
      const moves = g.legalMoves();
      assert.ok(moves.length > 0);
      const m = moves[Math.floor(rand() * moves.length)];
      g.move(squareName(m.fr, m.fc), squareName(m.tr, m.tc), m.promo);
      assert.ok(g.pos.board.flat().some((p) => p && p.t === 'k' && p.c === 'w'));
      assert.ok(g.pos.board.flat().some((p) => p && p.t === 'k' && p.c === 'b'));
    }
  }
});
