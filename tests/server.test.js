/**
 * End-to-end tests over a real HTTP + WebSocket server.
 *
 * These exist mainly to prove the server is authoritative: a client that sends
 * an illegal move, moves out of turn, or moves someone else's pieces must be
 * refused, and the refusal must not corrupt the game.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

import { startServer, Client } from './helpers/server.js';

async function seatTwo(port, code) {
  const white = await Client.connect(port);
  white.send({ type: 'join', code, name: 'Willow' });
  const wJoined = await white.next('joined');

  const black = await Client.connect(port);
  black.send({ type: 'join', code, name: 'Bram' });
  const bJoined = await black.next('joined');

  await white.next('state', (m) => Boolean(m.players.w && m.players.b));
  return { white, black, wColor: wJoined.color, bColor: bJoined.color };
}

async function createRoom(port, color = 'w') {
  const res = await fetch(`http://127.0.0.1:${port}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ color }),
  });
  return (await res.json()).code;
}

test('two clients are seated white and black and both see each move', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const code = await createRoom(srv.port);
  const { white, black, wColor, bColor } = await seatTwo(srv.port, code);

  assert.equal(wColor, 'w');
  assert.equal(bColor, 'b');

  white.send({ type: 'move', from: 'e2', to: 'e4' });
  const seenByBlack = await black.stateAtPly(1);
  assert.equal(seenByBlack.game.history.at(-1).san, 'e4');
  assert.equal(seenByBlack.game.pos.turn, 'b');
  assert.equal(seenByBlack.players.w.name, 'Willow');
  assert.equal(seenByBlack.players.b.name, 'Bram');

  white.close();
  black.close();
});

test('the server rejects a move made out of turn', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const code = await createRoom(srv.port);
  const { white, black } = await seatTwo(srv.port, code);

  black.send({ type: 'move', from: 'e7', to: 'e5' });
  const err = await black.next('error');
  assert.match(err.message, /not your turn/i);

  const room = srv.store.get(code);
  assert.equal(room.game.history.length, 0, 'the rejected move was not applied');

  white.close();
  black.close();
});

test('the server rejects an illegal guardian move from a tampered client', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const code = await createRoom(srv.port);
  const { white, black } = await seatTwo(srv.port, code);

  // A client that ignores the rules and tries to slide the guardian one square.
  white.send({ type: 'move', from: 'd1', to: 'd2' });
  assert.match((await white.next('error')).message, /illegal/i);

  // ...or three squares.
  white.send({ type: 'move', from: 'd1', to: 'd4' });
  assert.match((await white.next('error')).message, /illegal/i);

  // ...or diagonally.
  white.send({ type: 'move', from: 'd1', to: 'f3' });
  assert.match((await white.next('error')).message, /illegal/i);

  const room = srv.store.get(code);
  assert.equal(room.game.history.length, 0);
  assert.equal(room.game.turn, 'w', 'the turn did not pass');

  // The legal two-square leap still works.
  white.send({ type: 'move', from: 'd1', to: 'd3' });
  const state = await white.stateAtPly(1);
  assert.equal(state.game.history.at(-1).san, 'Gd3');

  white.close();
  black.close();
});

test('a third client becomes a spectator and cannot move', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const code = await createRoom(srv.port);
  const { white, black } = await seatTwo(srv.port, code);

  const watcher = await Client.connect(srv.port);
  watcher.send({ type: 'join', code });
  const joined = await watcher.next('joined');
  assert.equal(joined.color, null, 'no seat left');

  watcher.send({ type: 'move', from: 'e2', to: 'e4' });
  assert.match((await watcher.next('error')).message, /spectator/i);

  // But the spectator does receive the position.
  white.send({ type: 'move', from: 'e2', to: 'e4' });
  const seen = await watcher.stateAtPly(1);
  assert.equal(seen.game.history.at(-1).san, 'e4');

  white.close();
  black.close();
  watcher.close();
});

test('a disconnected player reclaims their seat with their token', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const code = await createRoom(srv.port);
  const { white, black } = await seatTwo(srv.port, code);

  white.send({ type: 'move', from: 'e2', to: 'e4' });
  await black.stateAtPly(1);

  const token = srv.store.get(code).players.w.token;
  white.close();
  await new Promise((r) => setTimeout(r, 60));

  const returning = await Client.connect(srv.port);
  returning.send({ type: 'join', code, token, name: 'Willow' });
  const joined = await returning.next('joined');
  assert.equal(joined.color, 'w', 'got the same seat back');

  const state = await returning.next('state', (m) => m.players.w.online);
  assert.equal(state.game.history.length, 1, 'the game carried on');
  assert.equal(state.players.w.online, true);

  returning.close();
  black.close();
});

test('presence flips to offline when a player drops', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const code = await createRoom(srv.port);
  const { white, black } = await seatTwo(srv.port, code);

  black.close();
  const state = await white.next('state', (m) => m.players.b && !m.players.b.online);
  assert.equal(state.players.b.online, false);
  assert.equal(state.players.b.name, 'Bram', 'the seat is held, not vacated');

  white.close();
});

test('resigning ends the game for both players', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const code = await createRoom(srv.port);
  const { white, black } = await seatTwo(srv.port, code);

  white.send({ type: 'resign' });
  const state = await black.next('state', (m) => m.game.result !== null);
  assert.equal(state.game.result.type, 'resignation');
  assert.equal(state.game.result.winner, 'b');

  black.send({ type: 'move', from: 'e7', to: 'e5' });
  assert.match((await black.next('error')).message, /over/i);

  white.close();
  black.close();
});

test('joining a code that does not exist fails cleanly', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const c = await Client.connect(srv.port);
  c.send({ type: 'join', code: 'ZZZZZ' });
  assert.match((await c.next('error')).message, /no game/i);
  c.close();
});

test('room codes are unique and use an unambiguous alphabet', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const seen = new Set();
  for (let i = 0; i < 400; i++) {
    const code = srv.store.create({}).code;
    assert.equal(code.length, 5);
    assert.match(code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/, 'no O, 0, I or 1');
    assert.ok(!seen.has(code), 'codes do not collide');
    seen.add(code);
  }
});

test('a rematch swaps colours and resets the board', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const code = await createRoom(srv.port);
  const { white, black } = await seatTwo(srv.port, code);
  const room = srv.store.get(code);

  room.game.move('e2', 'e4');
  room.game.resign('w');
  assert.ok(room.game.over);

  room.rematch();
  assert.equal(room.game.history.length, 0, 'fresh board');
  assert.equal(room.game.over, false);
  assert.equal(room.players.w.name, 'Bram', 'black now plays white');
  assert.equal(room.players.b.name, 'Willow');

  white.close();
  black.close();
});
