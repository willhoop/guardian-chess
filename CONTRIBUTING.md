# Contributing

## Running it

```bash
npm install
npm start          # http://localhost:3000
npm test           # the whole suite; it prints the count
```

No build step and no framework. Two runtime dependencies, `express` and `ws`.

## The one rule that matters

`shared/engine.js` is loaded unmodified by **both** the browser and the server.
The client uses it to show legal moves; the server uses it to validate them.
They cannot drift apart because there is only one copy. Any rule change goes
there and nowhere else.

## Layout

| Path | What it holds |
|---|---|
| `shared/engine.js` | the rules: board, moves, check, mate, notation |
| `shared/bot.js` | the computer opponent |
| `shared/rating.js` | Elo maths |
| `shared/values.js` | piece values, shared by the bot and the scoreboard |
| `server/` | HTTP and WebSocket server, rooms, accounts, storage |
| `public/` | the client |
| `tests/` | the test suite |

## Expectations for a change

- A rule change needs a test that fails without it. The suite is the
  specification; several tests exist because a plausible-looking assumption
  turned out to be wrong when it was actually run.
- Do not duplicate a constant that already lives in `shared/`. Piece values were
  briefly defined twice, and the bot and the scoreboard disagreed about what a
  Guardian was worth.
- Run `npm test` before pushing. Everything must pass.
