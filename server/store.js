/**
 * Persistent player records and game history.
 *
 * A single JSON file, written atomically and debounced. There is no database
 * because there does not need to be one: a few thousand players and a rolling
 * game log fit comfortably in memory, and this keeps the app to two runtime
 * dependencies and zero setup.
 *
 * Set DATA_DIR to control where it lives. On a host with an ephemeral
 * filesystem the file will not survive a redeploy — see README.
 */

import fs from 'node:fs';
import path from 'node:path';

import { STARTING_RATING, PROVISIONAL_GAMES, applyResult } from '../shared/rating.js';
import {
  hashPassword, verifyPassword, makeSessionToken, hashSessionToken, makePlayerId,
} from './auth.js';
import { makeBackend } from './storage.js';

/** How many finished games to keep for the recent-games feed. */
const HISTORY_LIMIT = 500;
const SAVE_DEBOUNCE_MS = 400;

/** Sessions older than this must sign in again. */
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

const EMPTY = { version: 2, players: {}, games: [], accounts: {}, sessions: {} };

export class PlayerStore {
  constructor(options = {}) {
    this.dir = options.dir || process.env.DATA_DIR || path.join(process.cwd(), 'data');
    this.file = path.join(this.dir, 'leaderboard.json');
    this.autosave = options.autosave !== false;
    // A remote backend is only ever used by a real server. Tests pass
    // autosave:false and therefore always stay on the local file.
    this.remote = this.autosave
      ? (options.backend !== undefined ? options.backend : makeBackend())
      : null;
    // With a remote store the local file is not just unnecessary, it is wrong:
    // reading it would seed the server with whatever stale copy happens to be
    // on that disk. Start empty and let init() fetch the real data.
    this.data = this.remote ? structuredClone(EMPTY) : this.#load();
    this.saveTimer = null;
    this.saving = false;
    this.saveAgain = false;
  }

  /**
   * Finish start-up. A remote backend cannot be read synchronously, so the
   * server awaits this before it begins serving; otherwise the first request
   * could be answered from an empty dataset and create duplicate accounts.
   */
  async init() {
    if (!this.remote) return;
    try {
      const loaded = await this.remote.load();
      if (loaded && loaded.players) {
        this.data = {
          version: 2,
          players: loaded.players,
          games: loaded.games || [],
          accounts: loaded.accounts || {},
          sessions: loaded.sessions || {},
        };
        const count = Object.keys(this.data.players).length;
        console.log(`Loaded ${count} player record(s) from ${this.remote.name}.`);
      } else {
        console.log(`No existing data in ${this.remote.name}; starting fresh.`);
      }
    } catch (err) {
      // Refuse to run rather than quietly overwrite good remote data with an
      // empty file the first time anything saves.
      throw new Error(
        `Could not read player data from ${this.remote.name}: ${err.message}`,
      );
    }
  }

  #load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !parsed.players) return structuredClone(EMPTY);
      // Files written before accounts existed simply have no accounts key.
      return {
        version: 2,
        players: parsed.players,
        games: parsed.games || [],
        accounts: parsed.accounts || {},
        sessions: parsed.sessions || {},
      };
    } catch (err) {
      // A missing file is the normal first run. Anything else is worth saying
      // out loud rather than silently starting from scratch.
      if (err.code !== 'ENOENT') {
        console.error(`Could not read ${this.file}, starting empty:`, err.message);
      }
      return structuredClone(EMPTY);
    }
  }

  /** Write now. Atomic on disk, so a crash mid-write cannot truncate the file. */
  saveNow() {
    // This write covers everything a pending debounce was going to write, so
    // cancel it. Otherwise every explicit save is followed by a duplicate,
    // which is pure waste against a free tier's request quota.
    clearTimeout(this.saveTimer);
    if (this.remote) return this.#saveRemote();
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('Could not save leaderboard:', err.message);
    }
    return undefined;
  }

  /**
   * Push to the remote store, one write at a time. If changes arrive while a
   * write is in flight, coalesce them into a single follow-up write rather
   * than racing — the last writer would otherwise win with stale data.
   */
  async #saveRemote() {
    if (this.saving) { this.saveAgain = true; return; }
    this.saving = true;
    try {
      await this.remote.save(this.data);
    } catch (err) {
      console.error(`Could not save to ${this.remote.name}:`, err.message);
    } finally {
      this.saving = false;
      if (this.saveAgain) {
        this.saveAgain = false;
        this.#saveRemote();
      }
    }
  }

  #scheduleSave() {
    if (!this.autosave) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), SAVE_DEBOUNCE_MS);
    this.saveTimer.unref?.();
  }

  /** Fetch a player, creating them on first sight. */
  player(id, name) {
    let p = this.data.players[id];
    if (!p) {
      p = {
        id,
        name: cleanName(name) || 'Anonymous',
        rating: STARTING_RATING,
        peak: STARTING_RATING,
        games: 0,
        wins: 0,
        losses: 0,
        draws: 0,
        streak: 0,
        firstSeen: Date.now(),
        lastSeen: Date.now(),
      };
      this.data.players[id] = p;
      this.#scheduleSave();
    }
    return p;
  }

  /** Update the display name a player is known by. */
  touch(id, name) {
    const p = this.player(id, name);
    const clean = cleanName(name);
    if (clean && clean !== p.name) {
      p.name = clean;
      this.#scheduleSave();
    }
    p.lastSeen = Date.now();
    return p;
  }

  /**
   * Record a finished human-versus-human game and move both ratings.
   * `winner` is 'w', 'b', or null for a draw.
   *
   * Returns the rating deltas, or null if the game was not eligible.
   */
  recordGame({ whiteId, blackId, whiteName, blackName, winner, reason, plies }) {
    if (!whiteId || !blackId || whiteId === blackId) return null;

    // `player` rather than `touch`: the names passed in are the seat labels,
    // which for an unnamed guest are just "White" and "Black". Overwriting with
    // those would rename a player after whichever colour they happened to take.
    // A name is only adopted when the record is first created.
    const white = this.player(whiteId, whiteName);
    const black = this.player(blackId, blackName);
    white.lastSeen = Date.now();
    black.lastSeen = Date.now();

    const scoreWhite = winner === 'w' ? 1 : winner === 'b' ? 0 : 0.5;
    const next = applyResult(
      { rating: white.rating, games: white.games },
      { rating: black.rating, games: black.games },
      scoreWhite,
    );

    for (const [p, side, score] of [[white, 'a', scoreWhite], [black, 'b', 1 - scoreWhite]]) {
      p.rating = next[side].rating;
      p.peak = Math.max(p.peak ?? p.rating, p.rating);
      p.games += 1;
      if (score === 1) { p.wins += 1; p.streak = p.streak > 0 ? p.streak + 1 : 1; }
      else if (score === 0) { p.losses += 1; p.streak = p.streak < 0 ? p.streak - 1 : -1; }
      else { p.draws += 1; p.streak = 0; }
    }

    this.data.games.unshift({
      at: Date.now(),
      whiteId, blackId,
      whiteName: white.name, blackName: black.name,
      winner: winner ?? null,
      reason,
      plies,
      whiteDelta: next.a.delta,
      blackDelta: next.b.delta,
      whiteRating: white.rating,
      blackRating: black.rating,
    });
    if (this.data.games.length > HISTORY_LIMIT) this.data.games.length = HISTORY_LIMIT;

    this.#scheduleSave();
    return { w: next.a.delta, b: next.b.delta };
  }

  /* ── Accounts ──────────────────────────────────────────────────── */

  /**
   * Is this id owned by a registered account?
   *
   * This is the guard that stops a guest from typing someone else's player id
   * into their own browser storage and inheriting their rating. Guest ids are
   * self-asserted and therefore only ever trusted for ids nobody owns.
   */
  isAccountId(id) {
    return this.data.players[id]?.account === true;
  }

  accountByUsername(username) {
    return this.data.accounts[String(username).trim().toLowerCase()] || null;
  }

  /**
   * Register an account. If `claimId` names an existing guest record that no
   * account owns, that record is carried over, so signing up does not throw
   * away the rating you earned as a guest.
   */
  async createAccount(username, password, claimId = null) {
    const name = String(username).trim();
    const key = name.toLowerCase();
    if (this.data.accounts[key]) {
      throw Object.assign(new Error('That username is taken.'), { status: 409 });
    }

    const canClaim = Boolean(
      claimId && this.data.players[claimId] && !this.isAccountId(claimId),
    );
    const id = canClaim ? claimId : makePlayerId();

    this.data.accounts[key] = {
      id,
      username: name,
      passwordHash: await hashPassword(password),
      createdAt: Date.now(),
    };

    const record = this.player(id, name);
    record.name = name;
    record.account = true;
    record.lastSeen = Date.now();

    this.#scheduleSave();
    return { id, username: name, claimed: canClaim };
  }

  /** Check a password. Returns the account, or null. */
  async checkPassword(username, password) {
    const account = this.accountByUsername(username);
    if (!account) return null;
    const ok = await verifyPassword(String(password), account.passwordHash);
    return ok ? account : null;
  }

  /** Issue a session for an account id. Returns the raw token, shown once. */
  startSession(id) {
    const token = makeSessionToken();
    this.data.sessions[hashSessionToken(token)] = {
      id,
      createdAt: Date.now(),
      lastSeen: Date.now(),
    };
    this.#scheduleSave();
    return token;
  }

  /** Resolve a session token to a player id, or null if it is no good. */
  resolveSession(token) {
    if (typeof token !== 'string' || token.length !== 64) return null;
    const key = hashSessionToken(token);
    const session = this.data.sessions[key];
    if (!session) return null;
    if (Date.now() - session.createdAt > SESSION_TTL_MS) {
      delete this.data.sessions[key];
      this.#scheduleSave();
      return null;
    }
    session.lastSeen = Date.now();
    return session.id;
  }

  endSession(token) {
    if (typeof token !== 'string') return;
    const key = hashSessionToken(token);
    if (this.data.sessions[key]) {
      delete this.data.sessions[key];
      this.#scheduleSave();
    }
  }

  /** Public view of one player. */
  publicPlayer(id) {
    const p = this.data.players[id];
    return p ? shape(p) : null;
  }

  /** Ranked table, best first. Unrated players are excluded. */
  leaderboard(limit = 100) {
    return Object.values(this.data.players)
      .filter((p) => p.games > 0)
      .sort((a, b) => b.rating - a.rating || b.games - a.games || a.name.localeCompare(b.name))
      .slice(0, limit)
      .map((p, i) => ({ rank: i + 1, ...shape(p) }));
  }

  recentGames(limit = 20) {
    return this.data.games.slice(0, limit);
  }

  /** Every finished game involving a player, newest first. */
  gamesFor(id, limit = 20) {
    return this.data.games
      .filter((g) => g.whiteId === id || g.blackId === id)
      .slice(0, limit);
  }
}

function shape(p) {
  return {
    id: p.id,
    name: p.name,
    account: p.account === true,
    rating: p.rating,
    peak: p.peak ?? p.rating,
    games: p.games,
    wins: p.wins,
    losses: p.losses,
    draws: p.draws,
    streak: p.streak,
    provisional: p.games < PROVISIONAL_GAMES,
  };
}

function cleanName(name) {
  if (typeof name !== 'string') return '';
  // Strip control characters so a name cannot break the table layout.
  return name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24);
}
