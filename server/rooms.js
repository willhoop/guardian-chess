/**
 * Room bookkeeping for Guardian Chess.
 *
 * Games live in memory. The server owns the authoritative Game object and is
 * the only thing allowed to advance it — clients send intents, never state.
 */

import { randomBytes } from 'node:crypto';
import { Game, WHITE, BLACK, opposite } from '../shared/engine.js';

/** Unambiguous alphabet: no O/0, no I/1. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;

const IDLE_MS = 24 * 60 * 60 * 1000; // rooms are forgotten after a day of silence
const MAX_CHAT = 200;
const MAX_ROOMS = 5000;

export function makeToken() {
  return randomBytes(16).toString('hex');
}

export class Room {
  constructor(code, options = {}) {
    this.code = code;
    /** Optional rules chosen by whoever created the room. */
    this.rules = { wazir: Boolean(options.wazir) };
    this.game = new Game(null, this.rules);
    /** token -> {token, name, color} for the two seated players. */
    this.players = { [WHITE]: null, [BLACK]: null };
    this.chat = [];
    this.drawOffer = null;    // color that has an outstanding draw offer
    this.rematchOffer = null; // color that has offered a rematch
    /** Set once a finished game has been written to the leaderboard. */
    this.recorded = false;
    /** Rating movement from the game just finished, for the result overlay. */
    this.lastRatingChange = null;
    this.createdAt = Date.now();
    this.touchedAt = Date.now();
    this.hostColor = options.hostColor || WHITE;
    /** token -> Set<WebSocket>; a player may have several tabs open. */
    this.sockets = new Map();
  }

  touch() {
    this.touchedAt = Date.now();
  }

  seatOf(token) {
    if (this.players[WHITE]?.token === token) return WHITE;
    if (this.players[BLACK]?.token === token) return BLACK;
    return null;
  }

  isFull() {
    return Boolean(this.players[WHITE] && this.players[BLACK]);
  }

  /**
   * Seat a player, or return their existing seat if they are reconnecting.
   * Returns the colour they hold, or null if they are a spectator.
   */
  join(token, name, preferredColor = null) {
    const existing = this.seatOf(token);
    if (existing) {
      this.players[existing].name = name || this.players[existing].name;
      return existing;
    }

    const order = preferredColor
      ? [preferredColor, opposite(preferredColor)]
      : [this.hostColor, opposite(this.hostColor)];

    for (const color of order) {
      if (!this.players[color]) {
        this.players[color] = { token, name: name || defaultName(color), color };
        return color;
      }
    }
    return null; // spectator
  }

  connected(color) {
    const player = this.players[color];
    if (!player) return false;
    const set = this.sockets.get(player.token);
    return Boolean(set && set.size > 0);
  }

  addSocket(token, ws) {
    if (!this.sockets.has(token)) this.sockets.set(token, new Set());
    this.sockets.get(token).add(ws);
  }

  removeSocket(token, ws) {
    const set = this.sockets.get(token);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) this.sockets.delete(token);
  }

  addChat(from, text) {
    const clean = String(text).slice(0, 500).trim();
    if (!clean) return null;
    const entry = { from, text: clean, at: Date.now() };
    this.chat.push(entry);
    if (this.chat.length > MAX_CHAT) this.chat.shift();
    return entry;
  }

  /** Start a fresh game with the colours swapped. */
  rematch() {
    const w = this.players[WHITE];
    const b = this.players[BLACK];
    this.players[WHITE] = b ? { ...b, color: WHITE } : null;
    this.players[BLACK] = w ? { ...w, color: BLACK } : null;
    // A rematch keeps whatever rules the room was created with.
    this.game = new Game(null, this.rules);
    this.drawOffer = null;
    this.rematchOffer = null;
    this.recorded = false;
    this.lastRatingChange = null;
  }

  /**
   * Is this game worth rating? Only two different humans playing each other,
   * and only once both sides have actually moved — otherwise a pair of accounts
   * could farm rating by resigning at move one over and over.
   */
  isRated() {
    return Boolean(
      this.players[WHITE] &&
      this.players[BLACK] &&
      this.players[WHITE].token !== this.players[BLACK].token &&
      this.game.history.length >= 2,
    );
  }

  /** The view any client is allowed to see. Identical for players and spectators. */
  snapshot() {
    return {
      code: this.code,
      game: this.game.toJSON(),
      players: {
        w: this.players[WHITE]
          ? { name: this.players[WHITE].name, online: this.connected(WHITE) }
          : null,
        b: this.players[BLACK]
          ? { name: this.players[BLACK].name, online: this.connected(BLACK) }
          : null,
      },
      chat: this.chat,
      drawOffer: this.drawOffer,
      rematchOffer: this.rematchOffer,
      rated: this.isRated(),
      ratingChange: this.lastRatingChange,
      rules: this.rules,
    };
  }
}

/**
 * Shown in the room when a guest has not typed a name. Only ever a display
 * label — it is deliberately not written to their leaderboard record, which
 * would otherwise rename them after whichever colour they drew.
 */
function defaultName(color) {
  return color === WHITE ? 'White' : 'Black';
}

export class RoomStore {
  constructor() {
    this.rooms = new Map();
  }

  create(options) {
    if (this.rooms.size >= MAX_ROOMS) this.sweep(true);
    let code;
    do {
      code = randomCode();
    } while (this.rooms.has(code));
    const room = new Room(code, options);
    this.rooms.set(code, room);
    return room;
  }

  get(code) {
    return this.rooms.get(String(code || '').toUpperCase()) || null;
  }

  /** Drop rooms nobody has touched in a day. */
  sweep(aggressive = false) {
    const cutoff = Date.now() - (aggressive ? IDLE_MS / 24 : IDLE_MS);
    for (const [code, room] of this.rooms) {
      if (room.touchedAt < cutoff && room.sockets.size === 0) {
        this.rooms.delete(code);
      }
    }
  }

  get size() {
    return this.rooms.size;
  }
}

function randomCode() {
  const bytes = randomBytes(CODE_LENGTH);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}
