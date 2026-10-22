/**
 * Abuse tests against the real server wiring (server/app.js).
 *
 * Each test names the attack it covers. Each one was run against the code
 * with its fix removed and failed there (see CHANGELOG 1.0.1).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';

import { startServer, Client } from './helpers/server.js';
import { LIMITS, WindowCounter, TokenBucket, clientIp } from '../server/limits.js';

async function makeRoom(port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ color: 'w' }),
  });
  return (await res.json()).code;
}

async function seatTwo(port, code) {
  const white = await Client.connect(port);
  white.send({ type: 'join', code });
  await white.next('joined');
  const black = await Client.connect(port);
  black.send({ type: 'join', code });
  await black.next('joined');
  await white.next('state', (m) => Boolean(m.players.w && m.players.b));
  return { white, black };
}

/** True when the server still answers HTTP. */
async function alive(port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/health`);
  return res.ok;
}

/* ── Crashes ─────────────────────────────────────────────────────────── */

test('an invalid WebSocket frame closes that socket and the server keeps running', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const c = await Client.connect(srv.port);
  c.ws.on('error', () => {});
  // A masked text frame with reserved opcode 0x3. Without an 'error' listener
  // on the server's socket, ws re-throws this and Node exits.
  c.ws._socket.write(Buffer.from([0x83, 0x80, 1, 2, 3, 4]));
  await once(c.ws, 'close');
  assert.equal(await alive(srv.port), true);
});

test('a message over the size cap closes the socket with 1009 and the server keeps running', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const c = await Client.connect(srv.port);
  c.ws.on('error', () => {});
  c.ws.send('x'.repeat(LIMITS.wsMaxBytes + 1));
  const [code] = await once(c.ws, 'close');
  assert.equal(code, 1009);
  assert.equal(await alive(srv.port), true);
});

test('a message exactly at the size cap is read, not refused', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const c = await Client.connect(srv.port);
  const base = JSON.stringify({ type: 'ping', pad: '' });
  c.ws.send(JSON.stringify({ type: 'ping', pad: 'x'.repeat(LIMITS.wsMaxBytes - base.length) }));
  assert.equal((await c.next('pong')).type, 'pong');
  c.close();
});

/* ── Malformed input ─────────────────────────────────────────────────── */

test('malformed JSON over the socket is refused without a resync, and the socket stays usable', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const c = await Client.connect(srv.port);
  for (const bad of ['{not json', 'null', '"move"', '[]', '{"type":7}']) {
    c.ws.send(bad);
    const err = await c.next('error');
    assert.equal(err.message, 'Malformed message', bad);
    assert.equal(err.resync, false, bad);
  }
  c.send({ type: 'ping' });
  assert.equal((await c.next('pong')).type, 'pong');
  c.close();
});

test('malformed JSON over HTTP answers 400 in JSON, with no stack trace', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const res = await fetch(`http://127.0.0.1:${srv.port}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"color":',
  });
  assert.equal(res.status, 400);
  const text = await res.text();
  assert.deepEqual(JSON.parse(text), { error: 'Malformed request' });
  assert.doesNotMatch(text, /SyntaxError|node_modules|at /);
});

/* ── Rate limit per connection ───────────────────────────────────────── */

test('a flood on one socket is answered up to the burst, refused once, then closed with 1008', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const c = await Client.connect(srv.port);
  let pongs = 0;
  let errors = 0;
  c.ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'pong') pongs += 1;
    if (m.type === 'error') errors += 1;
  });
  // burst (20) answered, then wsMaxRefused (20) refused: the 20th refusal closes.
  const sent = LIMITS.wsBurst + LIMITS.wsMaxRefused;
  for (let i = 0; i < sent; i++) c.send({ type: 'ping' });
  const [code] = await once(c.ws, 'close');
  assert.equal(code, 1008);
  // All sent inside a few ms, so refill adds at most one token.
  assert.ok(pongs >= LIMITS.wsBurst && pongs <= LIMITS.wsBurst + 1, `pongs ${pongs}`);
  assert.equal(errors, 1, 'one "slow down" message, not one per refused message');
});

test('normal play at human speed never hits the message limit', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const code = await makeRoom(srv.port);
  const { white, black } = await seatTwo(srv.port, code);
  // Twelve plies (well past the burst) at 250 ms apart: 4 a second, under the 5 a second refill.
  const plies = [['e2', 'e3'], ['e7', 'e6'], ['d2', 'd3'], ['d7', 'd6'], ['c2', 'c3'], ['c7', 'c6'],
    ['b2', 'b3'], ['b7', 'b6'], ['a2', 'a3'], ['a7', 'a6'], ['h2', 'h3'], ['h7', 'h6']];
  for (let i = 0; i < plies.length; i++) {
    const mover = i % 2 === 0 ? white : black;
    mover.send({ type: 'move', from: plies[i][0], to: plies[i][1] });
    mover.send({ type: 'chat', text: `move ${i + 1}` });
    await white.stateAtPly(i + 1);
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.equal(white.queue.some((m) => m.type === 'error'), false);
  assert.equal(black.queue.some((m) => m.type === 'error'), false);
  white.close();
  black.close();
});

/* ── Code guessing ───────────────────────────────────────────────────── */

test('after the allowed number of wrong codes, even a real code is refused from that address', async (t) => {
  const srv = await startServer({ codeMisses: 3 });
  t.after(() => srv.close());
  const real = await makeRoom(srv.port);
  const c = await Client.connect(srv.port);
  for (let i = 0; i < 3; i++) {
    c.send({ type: 'join', code: `ZZZZ${i + 2}` });
    const err = await c.next('error');
    assert.match(err.message, /No game with that code/);
    assert.equal(err.resync, false, 'a refused join must not make the client re-join');
  }
  c.send({ type: 'join', code: real });
  const blocked = await c.next('error');
  assert.match(blocked.message, /Too many wrong game codes/);
  // The HTTP lookup shares the same counter.
  const res = await fetch(`http://127.0.0.1:${srv.port}/api/rooms/${real}`);
  assert.equal(res.status, 429);
  c.close();
});

test('the HTTP code lookup counts misses and blocks the same way', async (t) => {
  const srv = await startServer({ codeMisses: 2 });
  t.after(() => srv.close());
  const real = await makeRoom(srv.port);
  const get = (code) => fetch(`http://127.0.0.1:${srv.port}/api/rooms/${code}`);
  assert.equal((await get(real)).status, 200, 'a hit is not counted');
  assert.equal((await get('ZZZZ2')).status, 404);
  assert.equal((await get('ZZZZ3')).status, 404);
  assert.equal((await get(real)).status, 429);
});

test('room creation is capped per address', async (t) => {
  const srv = await startServer({ roomCreates: 2 });
  t.after(() => srv.close());
  const post = () => fetch(`http://127.0.0.1:${srv.port}/api/rooms`, { method: 'POST' });
  assert.equal((await post()).status, 200);
  assert.equal((await post()).status, 200);
  assert.equal((await post()).status, 429);
  assert.equal(srv.store.size, 2);
});

/* ── Server authority over moves ─────────────────────────────────────── */

test('moves given as objects, numbers or long strings are refused and the board is unchanged', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const code = await makeRoom(srv.port);
  const { white, black } = await seatTwo(srv.port, code);
  const before = JSON.stringify(srv.store.get(code).game.toJSON());
  const bad = [
    { from: { r: 6, c: 4 }, to: { r: 5, c: 4 } }, // engine accepts {r,c}; the wire must not
    { from: 52, to: 44 },
    { from: 'e2'.repeat(500), to: 'e3' },
    { from: 'e2', to: 'e5' }, // pawn three squares
    { from: 'e7', to: 'e6' }, // black's pawn on white's turn
    { from: 'd1', to: 'd5' }, // guardian on d1 leaps two only
  ];
  for (const m of bad) {
    white.send({ type: 'move', ...m });
    await white.next('error');
  }
  assert.equal(JSON.stringify(srv.store.get(code).game.toJSON()), before);
  // A legal move still works afterwards.
  white.send({ type: 'move', from: 'e2', to: 'e3' });
  assert.equal((await black.stateAtPly(1)).game.history[0].to, 'e3');
  white.close();
  black.close();
});

test('a spectator cannot cancel a draw offer', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const code = await makeRoom(srv.port);
  const { white, black } = await seatTwo(srv.port, code);
  white.send({ type: 'offerDraw' });
  await black.next('state', (m) => m.drawOffer === 'w');
  const spy = await Client.connect(srv.port);
  spy.send({ type: 'join', code });
  await spy.next('joined');
  spy.send({ type: 'declineDraw' });
  await spy.next('error');
  assert.equal(srv.store.get(code).drawOffer, 'w');
  for (const c of [white, black, spy]) c.close();
});

test('joining a second room leaves the first', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const a = await makeRoom(srv.port);
  const b = await makeRoom(srv.port);
  const c = await Client.connect(srv.port);
  c.send({ type: 'join', code: a });
  await c.next('joined');
  c.send({ type: 'join', code: b });
  await c.next('joined', (m) => m.code === b);
  assert.equal(srv.store.get(a).sockets.size, 0);
  assert.equal(srv.store.get(b).sockets.size, 1);
  c.close();
});

/* ── The client ──────────────────────────────────────────────────────── */

test('the shipped client does not re-join after an error marked resync: false', () => {
  // The browser loop this guards against was measured at 234 joins a second
  // on a mistyped code. The client is DOM code, so the guard is checked in source.
  const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const errorCase = src.slice(src.indexOf("case 'error':"), src.indexOf("case 'error':") + 600);
  const guard = errorCase.indexOf('msg.resync === false) return');
  const rejoin = errorCase.indexOf("type: 'join'");
  assert.ok(guard > 0, 'guard present');
  assert.ok(guard < rejoin, 'guard comes before the re-join');
});

/* ── The limiters themselves ─────────────────────────────────────────── */

test('WindowCounter allows max hits per window, then blocks until the window ends', () => {
  let now = 0;
  const w = new WindowCounter(2, 1000, () => now);
  assert.equal(w.hit('a'), false); // 1
  assert.equal(w.hit('a'), false); // 2
  assert.equal(w.blocked('a'), true);
  assert.equal(w.hit('a'), true); // 3 > 2
  assert.equal(w.blocked('b'), false, 'keys are independent');
  now = 1001;
  assert.equal(w.blocked('a'), false);
  assert.equal(w.hit('a'), false);
});

test('WindowCounter prunes expired keys', () => {
  let now = 0;
  const w = new WindowCounter(5, 100, () => now);
  for (let i = 0; i < 50; i++) w.hit(`ip${i}`);
  now = 201;
  w.hit('fresh');
  assert.equal(w.counts.size, 1);
});

test('TokenBucket gives the burst, then one token per 1/perSecond seconds', () => {
  let now = 0;
  const b = new TokenBucket(3, 2, () => now);
  assert.deepEqual([b.take(), b.take(), b.take(), b.take()], [true, true, true, false]);
  now = 499; // 0.998 tokens
  assert.equal(b.take(), false);
  now = 500; // 2 tokens/s × 0.5 s = 1 token
  assert.equal(b.take(), true);
  now = 100_000;
  assert.deepEqual([b.take(), b.take(), b.take(), b.take()], [true, true, true, false], 'capped at the burst');
});

test('clientIp trusts the last forwarded address only behind the proxy', () => {
  const req = { headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }, socket: { remoteAddress: '10.0.0.1' } };
  assert.equal(clientIp(req, true), '203.0.113.9', 'the entry the proxy appended, not a spoofed first entry');
  assert.equal(clientIp(req, false), '10.0.0.1', 'without a proxy the header is ignored');
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '10.0.0.1' } }, true), '10.0.0.1');
});
