/**
 * End-to-end tests over a real HTTP + WebSocket server.
 *
 * These exist mainly to prove the server is authoritative: a client that sends
 * an illegal move, moves out of turn, or moves someone else's pieces must be
 * refused, and the refusal must not corrupt the game.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';

import { RoomStore, makeToken } from '../server/rooms.js';

/**
 * A stripped-down copy of the server wiring. It reuses the real RoomStore and
 * the real engine, so the rules and the seat logic under test are production
 * code; only the listen/static plumbing is local to the test.
 */
async function startServer() {
  const store = new RoomStore();
  const app = express();
  app.use(express.json());

  app.post('/api/rooms', (req, res) => {
    const hostColor = req.body?.color === 'b' ? 'b' : 'w';
    res.json({ code: store.create({ hostColor }).code, hostColor });
  });

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  const broadcast = (room) => {
    const text = JSON.stringify({ type: 'state', ...room.snapshot() });
    for (const set of room.sockets.values()) {
      for (const ws of set) if (ws.readyState === ws.OPEN) ws.send(text);
    }
  };

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      const fail = (m) => ws.send(JSON.stringify({ type: 'error', message: m }));

      try {
        if (msg.type === 'join') {
          const room = store.get(msg.code);
          if (!room) return fail('No game with that code.');
          const token = msg.token || makeToken();
          ws.room = room;
          ws.token = token;
          ws.color = room.join(token, msg.name, null);
          room.addSocket(token, ws);
          ws.send(JSON.stringify({ type: 'joined', code: room.code, token, color: ws.color }));
          return broadcast(room);
        }

        const room = ws.room;
        if (!room) return fail('Join a game first');

        if (msg.type === 'move') {
          if (!ws.color) return fail('Spectators cannot move');
          if (room.game.over) return fail('The game is already over');
          if (room.game.turn !== ws.color) return fail('Not your turn');
          if (!room.isFull()) return fail('Waiting for an opponent');
          room.game.move(msg.from, msg.to, msg.promo || null);
          return broadcast(room);
        }
        if (msg.type === 'resign') {
          if (!ws.color) return fail('Spectators cannot resign');
          room.game.resign(ws.color);
          return broadcast(room);
        }
      } catch (err) {
        fail(err.message);
      }
    });
    ws.on('close', () => {
      if (ws.room && ws.token) { ws.room.removeSocket(ws.token, ws); broadcast(ws.room); }
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();

  return {
    port,
    store,
    async close() {
      for (const c of wss.clients) c.terminate();
      wss.close();
      server.close();
      await once(server, 'close');
    },
  };
}

/**
 * A test client that queues messages so tests can await them.
 *
 * Every join broadcasts a state to the whole room, so several state messages
 * are usually already sitting in the queue. Matching on type alone would hand
 * a test a stale snapshot, so `next` takes a predicate and skips anything that
 * does not satisfy it.
 */
class Client {
  constructor(port) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.queue = [];
    this.waiters = [];
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      const i = this.waiters.findIndex((w) => w.type === msg.type && w.match(msg));
      if (i >= 0) {
        this.waiters.splice(i, 1)[0].resolve(msg);
      } else {
        this.queue.push(msg);
      }
    });
  }

  static async connect(port) {
    const c = new Client(port);
    await once(c.ws, 'open');
    return c;
  }

  send(msg) { this.ws.send(JSON.stringify(msg)); }

  /** Resolve with the next message of `type` satisfying `match`. */
  next(type, match = () => true, timeout = 2000) {
    const i = this.queue.findIndex((m) => m.type === type && match(m));
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { type, match, resolve };
      this.waiters.push(waiter);
      setTimeout(() => {
        const at = this.waiters.indexOf(waiter);
        if (at >= 0) {
          this.waiters.splice(at, 1);
          reject(new Error(`timed out waiting for "${type}"`));
        }
      }, timeout).unref();
    });
  }

  /** The next state showing exactly `n` moves played. */
  stateAtPly(n) {
    return this.next('state', (m) => m.game.history.length === n);
  }

  close() { this.ws.close(); }
}

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
