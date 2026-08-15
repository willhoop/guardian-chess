/**
 * Accounts, sessions, and guest play.
 *
 * The security-relevant test here is the last group: a guest asserts their own
 * id, so nothing must let a guest assert an id that belongs to an account.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  hashPassword, verifyPassword, makeSessionToken, hashSessionToken,
  validateUsername, validatePassword,
} from '../server/auth.js';
import { PlayerStore } from '../server/store.js';

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-auth-'));
  return new PlayerStore({ dir, autosave: false });
}

// Obviously fake credentials, used only against a throwaway store.
const PASS = 'correct-horse-battery';

/* ── Password handling ───────────────────────────────────────────────── */

test('a password verifies against its own hash and nothing else', async () => {
  const hash = await hashPassword(PASS);
  assert.equal(await verifyPassword(PASS, hash), true);
  assert.equal(await verifyPassword(PASS + 'x', hash), false);
  assert.equal(await verifyPassword('', hash), false);
});

test('the stored hash never contains the password', async () => {
  const hash = await hashPassword(PASS);
  assert.ok(!hash.includes(PASS));
  assert.match(hash, /^[0-9a-f]{32}:[0-9a-f]{128}$/);
});

test('the same password hashes differently every time', async () => {
  const a = await hashPassword(PASS);
  const b = await hashPassword(PASS);
  assert.notEqual(a, b, 'salted');
  assert.equal(await verifyPassword(PASS, a), true);
  assert.equal(await verifyPassword(PASS, b), true);
});

test('a malformed stored hash is rejected rather than throwing', async () => {
  for (const bad of ['', 'nonsense', 'aa:bb', null, undefined]) {
    assert.equal(await verifyPassword(PASS, bad), false);
  }
});

test('session tokens are long, random, and stored only as hashes', () => {
  const a = makeSessionToken();
  const b = makeSessionToken();
  assert.equal(a.length, 64);
  assert.notEqual(a, b);
  const digest = hashSessionToken(a);
  assert.equal(digest.length, 64);
  assert.notEqual(digest, a, 'the raw token is not what gets stored');
  assert.equal(hashSessionToken(a), digest, 'hashing is stable');
});

/* ── Validation ──────────────────────────────────────────────────────── */

test('usernames and passwords are checked', () => {
  assert.equal(validateUsername('willj'), null);
  assert.equal(validateUsername('a_b-9'), null);
  assert.ok(validateUsername('ab'), 'too short');
  assert.ok(validateUsername('x'.repeat(21)), 'too long');
  assert.ok(validateUsername('has space'), 'no spaces');
  assert.ok(validateUsername('emoji😀'), 'no symbols');
  assert.ok(validateUsername(null));

  assert.equal(validatePassword('12345678'), null);
  assert.ok(validatePassword('short'));
  assert.ok(validatePassword(null));
});

/* ── Accounts ────────────────────────────────────────────────────────── */

test('an account can be created and signed into', async () => {
  const store = tempStore();
  const account = await store.createAccount('Willj', PASS);
  assert.equal(account.username, 'Willj');

  assert.ok(await store.checkPassword('Willj', PASS));
  assert.ok(await store.checkPassword('willj', PASS), 'usernames are case-insensitive');
  assert.equal(await store.checkPassword('Willj', 'wrong'), null);
  assert.equal(await store.checkPassword('nobody', PASS), null);
});

test('usernames are unique regardless of case', async () => {
  const store = tempStore();
  await store.createAccount('Brother', PASS);
  await assert.rejects(() => store.createAccount('BROTHER', PASS), /taken/i);
});

test('a session resolves to its account and can be revoked', async () => {
  const store = tempStore();
  const account = await store.createAccount('Willj', PASS);
  const token = store.startSession(account.id);

  assert.equal(store.resolveSession(token), account.id);
  assert.equal(store.resolveSession('garbage'), null);
  assert.equal(store.resolveSession('0'.repeat(64)), null);

  store.endSession(token);
  assert.equal(store.resolveSession(token), null, 'signing out kills the session');
});

test('signing up carries a guest record over', async () => {
  const store = tempStore();
  const guestId = 'a'.repeat(32);
  store.recordGame({
    whiteId: guestId, blackId: 'other', whiteName: 'Guest', blackName: 'Other',
    winner: 'w', reason: 'Checkmate', plies: 30,
  });
  const earned = store.publicPlayer(guestId).rating;
  assert.ok(earned > 1200);

  const account = await store.createAccount('Willj', PASS, guestId);
  assert.equal(account.id, guestId, 'the same record is reused');
  assert.equal(account.claimed, true);

  const me = store.publicPlayer(account.id);
  assert.equal(me.rating, earned, 'rating survived the upgrade');
  assert.equal(me.wins, 1);
  assert.equal(me.name, 'Willj', 'renamed to the username');
  assert.equal(me.account, true);
});

test('signing up cannot steal a record that already belongs to an account', async () => {
  const store = tempStore();
  const victim = await store.createAccount('Victim', PASS);
  store.recordGame({
    whiteId: victim.id, blackId: 'other', whiteName: 'Victim', blackName: 'Other',
    winner: 'w', reason: 'Checkmate', plies: 30,
  });
  const victimRating = store.publicPlayer(victim.id).rating;

  // An attacker registers, pointing claimId at the victim's record.
  const attacker = await store.createAccount('Attacker', PASS, victim.id);
  assert.notEqual(attacker.id, victim.id, 'the claim was refused');
  assert.equal(attacker.claimed, false);
  assert.equal(store.publicPlayer(attacker.id).rating, 1200, 'starts fresh');
  assert.equal(store.publicPlayer(victim.id).rating, victimRating, 'victim untouched');
  assert.equal(store.publicPlayer(victim.id).name, 'Victim');
});

test('an account id is recognisable as one', async () => {
  const store = tempStore();
  const account = await store.createAccount('Willj', PASS);
  store.touch('guest-id', 'Guest');

  assert.equal(store.isAccountId(account.id), true);
  assert.equal(store.isAccountId('guest-id'), false);
  assert.equal(store.isAccountId('never-seen'), false);
});

/* ── Persistence ─────────────────────────────────────────────────────── */

test('accounts and sessions survive a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-auth-'));
  const first = new PlayerStore({ dir, autosave: false });
  const account = await first.createAccount('Willj', PASS);
  const token = first.startSession(account.id);
  first.saveNow();

  const reopened = new PlayerStore({ dir, autosave: false });
  assert.equal(reopened.resolveSession(token), account.id, 'still signed in');
  assert.ok(await reopened.checkPassword('Willj', PASS));
  assert.equal(reopened.isAccountId(account.id), true);
});

test('a data file written before accounts existed still loads', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-auth-'));
  fs.writeFileSync(path.join(dir, 'leaderboard.json'), JSON.stringify({
    version: 1,
    players: { old: { id: 'old', name: 'Old', rating: 1300, peak: 1300,
      games: 2, wins: 1, losses: 1, draws: 0, streak: 0 } },
    games: [],
  }));

  const store = new PlayerStore({ dir, autosave: false });
  assert.equal(store.publicPlayer('old').rating, 1300);
  assert.equal(store.isAccountId('old'), false, 'old records are guests');
  assert.equal(store.leaderboard().length, 1);
});
