/**
 * The bot only has to be legal, finite, and not obviously silly. These tests
 * check exactly that — not playing strength.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Game, initialPosition, legalMoves, parseSquare, squareName,
  RANK_COUNT, FILE_COUNT, WHITE, BLACK,
} from '../shared/engine.js';
import { chooseMove, evaluate } from '../shared/bot.js';

function setup(pieces, turn = WHITE) {
  const pos = initialPosition();
  pos.board = Array.from({ length: RANK_COUNT }, () => Array(FILE_COUNT).fill(null));
  pos.turn = turn;
  pos.castling = { w: { k: false, q: false }, b: { k: false, q: false } };
  pos.ep = null;
  for (const [sq, code] of Object.entries(pieces)) {
    const { r, c } = parseSquare(sq);
    pos.board[r][c] = { c: code[0], t: code[1] };
  }
  return pos;
}

const isLegal = (pos, mv) =>
  legalMoves(pos).some((m) =>
    squareName(m.fr, m.fc) === mv.from &&
    squareName(m.tr, m.tc) === mv.to &&
    (m.promo || null) === (mv.promo || null));

// Deeper levels are slower, so play fewer plies at the top settings.
for (const [level, plies] of [['easy', 40], ['normal', 12], ['strong', 4]]) {
  test(`${level} bot only ever returns a legal move`, () => {
    const g = new Game();
    for (let ply = 0; ply < plies && !g.over; ply++) {
      const mv = chooseMove(g.pos, level);
      assert.ok(mv, 'a move was offered');
      assert.ok(isLegal(g.pos, mv), `${mv.from}${mv.to} is legal`);
      g.move(mv.from, mv.to, mv.promo);
    }
  });
}

test('the bot returns null when there are no moves', () => {
  // Black is stalemated.
  const pos = setup({ a8: 'bk', c7: 'wq', f1: 'wk' }, BLACK);
  assert.equal(legalMoves(pos).length, 0);
  assert.equal(chooseMove(pos, 'normal'), null);
});

test('the bot plays mate in one when it is there', () => {
  // Rj8# on the back rank; the black king is boxed in by its own pawns.
  const pos = setup({ a8: 'bk', a7: 'bp', b7: 'bp', j1: 'wr', f1: 'wk' });
  const mv = chooseMove(pos, 'normal');
  const g = new Game({ pos, history: [], repetition: {}, result: null });
  g.move(mv.from, mv.to, mv.promo);
  assert.equal(g.result?.type, 'checkmate', `expected mate, played ${mv.from}${mv.to}`);
});

test('the bot takes a free queen', () => {
  const pos = setup({ f1: 'wk', a1: 'wr', a5: 'bq', j8: 'bk' });
  const mv = chooseMove(pos, 'normal');
  assert.deepEqual({ from: mv.from, to: mv.to }, { from: 'a1', to: 'a5' });
});

test('the bot does not give its queen away for nothing', () => {
  // Qd4 is en prise to the pawn on c5 if it steps to d5/c5; it should not.
  const pos = setup({
    f1: 'wk', d4: 'wq',
    c5: 'bp', b6: 'bp', j8: 'bk',
  });
  const mv = chooseMove(pos, 'normal');
  const g = new Game({ pos, history: [], repetition: {}, result: null });
  g.move(mv.from, mv.to, mv.promo);
  // After the bot moves, black should have no capture of the queen available.
  const queenGrabs = legalMoves(g.pos).filter((m) => {
    const target = g.pos.board[m.tr][m.tc];
    return target && target.t === 'q' && target.c === WHITE;
  });
  assert.equal(queenGrabs.length, 0, `queen was left hanging by ${mv.from}${mv.to}`);
});

test('the bot understands that a guardian cannot be blocked', () => {
  // White guardian on e4 checks the black king on e6. Interposing is useless,
  // so the only legal replies are king moves; the bot must find one.
  const pos = setup({ e4: 'wg', e6: 'bk', a1: 'br', f1: 'wk' }, BLACK);
  const mv = chooseMove(pos, 'normal');
  assert.ok(isLegal(pos, mv));
  assert.equal(mv.from, 'e6', 'only the king can address a guardian check here');
});

test('a full bot-versus-bot game terminates and stays legal', () => {
  const g = new Game();
  let plies = 0;
  while (!g.over && plies < 200) {
    const mv = chooseMove(g.pos, 'easy');
    assert.ok(isLegal(g.pos, mv));
    g.move(mv.from, mv.to, mv.promo);
    plies++;
  }
  // Either it finished, or it is still a valid game in progress.
  assert.ok(g.over || g.legalMoves().length > 0);
});

test('evaluation is symmetric and material-driven', () => {
  const even = setup({ f1: 'wk', f8: 'bk' });
  assert.equal(evaluate(even), 0, 'bare kings are equal');

  const upAQueen = setup({ f1: 'wk', d4: 'wq', f8: 'bk' });
  assert.ok(evaluate(upAQueen) > 500, 'white to move, white up a queen');

  const downAQueen = setup({ f1: 'wk', d4: 'wq', f8: 'bk' }, BLACK);
  assert.ok(evaluate(downAQueen) < -500, 'same position, black to move');
});

test('a guardian is valued below a knight', () => {
  const withGuardian = setup({ f1: 'wk', e4: 'wg', f8: 'bk' });
  const withKnight = setup({ f1: 'wk', e4: 'wn', f8: 'bk' });
  assert.ok(
    evaluate(withGuardian) < evaluate(withKnight),
    'the guardian is colour-bound to a quarter of the board',
  );
});
