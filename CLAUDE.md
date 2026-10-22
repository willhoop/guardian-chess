# CLAUDE.md — Guardian Chess

Universal rules live in my global Claude Instructions. This file is
project-specific only.

**Goal.** A playable implementation of Alex Hooper's chess variant that is
honest about its own rules and cannot cheat.

## The rule that shapes the codebase

`shared/engine.js` is loaded unmodified by **both** the browser and the server.
The client uses it to display legal moves; the server uses it to validate them.
They cannot drift apart because there is only one copy. A rule change goes there
and nowhere else.

The server is authoritative. Every move is re-validated before it is accepted.

## Facts that are easy to get wrong

- **The Guardian is a Dabbaba** — a (2,0) leaper, one of the oldest fairy
  pieces. It is *twice colour-bound*: it reaches only a quarter of the board and
  can never stand on an even rank. Do not "fix" this.
- **The king is on e and the queen on f**, the reverse of ordinary chess, so
  each queen starts on her own colour. On ten files the two centre squares are
  opposite shades and only f is right for the queen.
- **"Kingside" follows the king**, so on this board it is the a-side. `O-O`
  clears three squares toward a; `O-O-O` clears four toward j. Kingside is still
  the short castle.
- **Castling moves the king three squares**, not two.
- Piece values live in `shared/values.js` only. They were briefly duplicated and
  the bot and scoreboard disagreed about the Guardian.

## Expectations

- A rule change needs a test that fails without it.
- Run `npm test` before pushing. Every test must pass.
- Several tests exist because an assumption that looked obviously right turned
  out to be wrong when it was actually run in a browser. Prefer running the
  thing to reasoning about it.

## Deployment

Two runtime dependencies, no build step. `DATA_DIR` moves the data file; setting
`UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` moves player records to a
hosted store instead, which is what free hosts need because their filesystem is
wiped on restart.

Repository map:

| Project | Repository | Live at |
|---|---|---|
| Guardian Chess | `willhoop/guardian-chess` | `guardian-chess.onrender.com` |
