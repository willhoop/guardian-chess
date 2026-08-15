/**
 * The remote storage backend.
 *
 * These run against a stub HTTP server that speaks the Upstash REST shape, so
 * they verify our client — the request it makes, the response it accepts, and
 * what happens when the service misbehaves. They do not verify Upstash itself.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { makeBackend } from '../server/storage.js';
import { PlayerStore } from '../server/store.js';

/** A stand-in for Upstash: GET /get/:key and POST /set/:key over one value. */
async function stubUpstash({ failWith = null } = {}) {
  const state = { value: null, gets: 0, sets: 0, lastAuth: null };

  const server = createServer((req, res) => {
    state.lastAuth = req.headers.authorization;
    if (failWith) {
      res.writeHead(failWith).end('nope');
      return;
    }
    if (req.url.startsWith('/get/')) {
      state.gets++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result: state.value }));
      return;
    }
    if (req.url.startsWith('/set/')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        state.sets++;
        state.value = body;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: 'OK' }));
      });
      return;
    }
    res.writeHead(404).end();
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();

  return {
    state,
    url: `http://127.0.0.1:${port}`,
    async close() { server.close(); await once(server, 'close'); },
  };
}

function backendFor(url) {
  return makeBackend({
    UPSTASH_REDIS_REST_URL: url,
    UPSTASH_REDIS_REST_TOKEN: 'test-token',
  });
}

test('no backend is configured unless both variables are present', () => {
  assert.equal(makeBackend({}), null);
  assert.equal(makeBackend({ UPSTASH_REDIS_REST_URL: 'https://x' }), null);
  assert.equal(makeBackend({ UPSTASH_REDIS_REST_TOKEN: 't' }), null);
  assert.ok(backendFor('https://x'), 'both present');
});

test('the store falls back to a local file when nothing is configured', () => {
  const store = new PlayerStore({ dir: '/tmp/gc-none', autosave: false });
  assert.equal(store.remote, null);
});

test('data round-trips through the remote store', async (t) => {
  const stub = await stubUpstash();
  t.after(() => stub.close());

  const first = new PlayerStore({ backend: backendFor(stub.url) });
  await first.init();
  first.recordGame({
    whiteId: 'a', blackId: 'b', whiteName: 'Ann', blackName: 'Ben',
    winner: 'w', reason: 'Checkmate', plies: 30,
  });
  const rating = first.publicPlayer('a').rating;
  await first.saveNow();

  assert.equal(stub.state.sets, 1, 'one write');
  assert.equal(stub.state.lastAuth, 'Bearer test-token', 'token is sent');

  // A fresh instance, as if the host restarted it.
  const second = new PlayerStore({ backend: backendFor(stub.url) });
  await second.init();
  assert.equal(second.publicPlayer('a').rating, rating);
  assert.equal(second.publicPlayer('a').name, 'Ann');
  assert.equal(second.recentGames().length, 1);
  assert.equal(second.leaderboard()[0].name, 'Ann');
});

test('accounts and sessions survive through the remote store', async (t) => {
  const stub = await stubUpstash();
  t.after(() => stub.close());

  const first = new PlayerStore({ backend: backendFor(stub.url) });
  await first.init();
  const account = await first.createAccount('Willj', 'testing-only-123');
  const token = first.startSession(account.id);
  await first.saveNow();

  const second = new PlayerStore({ backend: backendFor(stub.url) });
  await second.init();
  assert.equal(second.resolveSession(token), account.id, 'still signed in');
  assert.ok(await second.checkPassword('Willj', 'testing-only-123'));
  assert.equal(second.isAccountId(account.id), true);
});

test('an unreachable store refuses to start rather than starting empty', async (t) => {
  const stub = await stubUpstash({ failWith: 500 });
  t.after(() => stub.close());

  const store = new PlayerStore({ backend: backendFor(stub.url) });
  // Starting empty would let the first save wipe everyone's ratings.
  await assert.rejects(() => store.init(), /Could not read player data/);
});

test('an empty store starts fresh without complaining', async (t) => {
  const stub = await stubUpstash();
  t.after(() => stub.close());

  const store = new PlayerStore({ backend: backendFor(stub.url) });
  await store.init();
  assert.deepEqual(store.leaderboard(), []);
});

test('a failing write is reported but does not crash the server', async (t) => {
  const stub = await stubUpstash();
  t.after(() => stub.close());

  const store = new PlayerStore({ backend: backendFor(stub.url) });
  await store.init();
  store.recordGame({
    whiteId: 'a', blackId: 'b', whiteName: 'A', blackName: 'B',
    winner: 'w', reason: 'Checkmate', plies: 30,
  });

  // The service starts failing mid-session.
  const errors = [];
  const realError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  await stub.close();
  await store.saveNow();
  console.error = realError;

  assert.equal(errors.length, 1, 'the failure was reported');
  assert.match(errors[0], /Upstash/);
  // And the in-memory game carries on regardless.
  assert.equal(store.leaderboard().length, 2);
});

test('concurrent writes are coalesced instead of racing', async (t) => {
  const stub = await stubUpstash();
  t.after(() => stub.close());

  const store = new PlayerStore({ backend: backendFor(stub.url) });
  await store.init();

  // Three saves fired back to back should not produce three overlapping writes.
  const a = store.saveNow();
  const b = store.saveNow();
  const c = store.saveNow();
  await Promise.all([a, b, c]);
  // Let any coalesced follow-up land.
  await new Promise((r) => setTimeout(r, 50));

  assert.ok(stub.state.sets <= 2, `expected at most 2 writes, got ${stub.state.sets}`);
  assert.ok(stub.state.sets >= 1, 'but at least one');
});
