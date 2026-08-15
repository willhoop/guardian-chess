# Guardian Chess

Chess on a 10×8 board with a new piece: the **Guardian**, which leaps exactly
two squares orthogonally. Play a friend online with a five-character game code,
or pass one device back and forth.

```bash
npm install
npm start
```

Then open <http://localhost:3000>.

---

## The rules

Everything from standard chess still applies — castling, en passant,
promotion, stalemate, threefold repetition, the fifty-move rule. Three things
are different.

### 1. The board is ten files wide

Files run **a** through **j**. Each side has ten pawns and a ten-piece back
rank:

```
  a  b  c  d  e  f  g  h  i  j
  R  N  B  G  K  Q  G  B  N  R
```

A Guardian stands on either side of the king-and-queen pair, on **d** and **g**.

Note the king on **e** and the queen on **f** — the reverse of ordinary chess.
That is deliberate; see *Why the king and queen are swapped* below.

### 2. The Guardian

It moves **exactly two squares** — up, down, left, or right. Never one. Never
three. Never diagonally.

It **leaps**, like a knight. Anything standing between it and its destination
is ignored and is *not* captured. It captures only what sits on the square it
lands on.

```
        . . ● . .          ● = where a Guardian on the
        . . . . .              centre square may move
        ● . G . ●
        . . . . .          It cannot move to any of the
        . . ● . .          eight squares touching it.
```

### 3. Castling covers three squares

The board is two files wider, so the king travels further:

| | King | Rook | Squares to clear |
|---|---|---|---|
| **Kingside** | e1 → h1 | j1 → g1 | four: `f1 g1 h1 i1` |
| **Queenside** | e1 → b1 | a1 → c1 | three: `b1 c1 d1` |

As always, every square between king and rook must be empty, the king may not
be in check, and it may not pass through or land on an attacked square.

Because the king sits on `e`, **the queenside is the quicker place to castle** —
the reverse of the habit you bring from ordinary chess. In practice the gap is
wider than three-versus-four suggests: castling long needs four developing
moves, castling short needs six, because the queen herself starts boxed in
behind her own pawn.

---

## Things worth knowing about the Guardian

**It is locked to a quarter of the board.** Because it always moves exactly
two, a Guardian can never change whether it stands on an odd or an even rank or
file. A Guardian that starts on d1 can only ever reach 20 of the 80 squares,
and can never touch an even rank — not once, all game. Your two Guardians
travel different quarters. This is a real consequence of the movement rule, not
an oversight; the engine has a test asserting it so it cannot change by
accident.

**It cannot be blocked.** Interposing a piece against a Guardian check does
nothing. You must move the king or capture the Guardian.

**It is slow out of the gate.** In the opening position each Guardian has
exactly one legal move — straight forward two — because its sideways leaps land
on its own occupied back rank.

**It cannot mate alone.** King + Guardian against a lone king is drawn for
insufficient material, as with a lone bishop or knight. (Four Guardians
covering all four quarters *can* force mate, but you will not have four.)

**A pawn may promote to a Guardian.**

---

## Why the king and queen are swapped

Every chess player knows the queen starts on her own colour. On an eight-file
board that agrees with putting her to the king's left, because the left of the
two centre squares happens to be light.

Add two files and the parity flips:

| Board width | Centre files | Square left of the king |
|---|---|---|
| 8 (standard) | d / e | light — both conventions agree |
| **10** | e / f | **dark** — you must pick one |
| 12 | f / g | light — both agree again |

On ten files you can have the queen on the king's left, or the queen on her own
colour, but not both. Capablanca hit the same wall and kept her on the left,
which is why **Capablanca chess has its queen on the wrong colour**. Guardian
Chess makes the opposite choice: the king takes `e`, the queen takes `f`, and
each queen begins on her own colour. Kings still face kings and queens still
face queens, and the corner square on your right is still light.

The cost is the castling asymmetry noted above.

## Prior art

Neither ingredient is new, though the combination appears to be.

- A piece that leaps exactly (2,0) is the **Dabbaba**, one of the oldest fairy
  chess pieces — the name is Arabic for a siege engine. It appears in medieval
  variants such as Tamerlane chess. Its confinement to a quarter of the board
  is a documented property.
- A **10×8 board with two extra pieces flanking the king and queen** is
  **Capablanca chess** (1920s), whose back rank is `RNABQKBCNR`. The
  three-square castling rule used here is Capablanca's too. Guardian Chess
  departs from him in one respect: he kept the queen to the king's left and
  accepted her landing on the wrong colour, where this game does the reverse.

What seems to be original is putting Dabbabas — rather than Capablanca's
Archbishop and Chancellor — on that board, at d and g.

---

## Playing with someone else

**On your own network.** Start the server and give the other player your
machine's LAN address, e.g. `http://192.168.1.20:3000`. The server listens on
all interfaces.

**Over the internet.** Either deploy it (below), or expose your local server
with a tunnel:

```bash
npx localtunnel --port 3000
```

Then one player clicks **Create game** and sends the other the link or the
five-character code. The second player pastes the code into **Join a game**, or
just opens the link.

**Same room, one screen.** Use **Play locally**. The board turns to face
whoever is on move.

**On your own.** Use **Play the computer** — Easy, Normal, or Strong. You play
White. It is not a strong engine, but it will take your hanging pieces and it
sees a mate in one, which is enough to exercise the rules.

## The material scoreboard

The **Score** tab beside the move list shows live material for both sides — a
running total, a bar, who leads and by how much, what each player has captured,
and the value of every piece.

| | Pawn | Guardian | Knight | Bishop | Rook | Queen |
|---|---|---|---|---|---|---|
| Value | 1 | **2.75** | 3 | 3.25 | 5 | 9 |

The Guardian is priced below a knight because it is confined to a quarter of
the board and can never reach an even rank, so much of the activity its move-set
implies is unavailable. These numbers are estimates from the piece geometry,
not from played games — they live in `shared/values.js` and are used by both the
scoreboard and the computer opponent, so the two can never disagree. Change them
there if experience says otherwise.

## Ratings and the leaderboard

Every online game between two different people is rated with **Elo**. Click
**Leaderboard** in the lobby for the rankings and a feed of recent games.

- Everyone starts at **1200**.
- A rating is **provisional** (shown with a `?`) for its first five games, and
  moves in bigger steps until then, so you find your level quickly.
- Beating someone stronger than you is worth much more than beating someone
  weaker. A draw against a much stronger player still gains you points.
- Ratings appear next to each player's name during a game, and the result
  screen shows what the game did to yours.

**What counts.** Only online games between two different players. Games against
the computer, same-screen games, and games that end before both sides have
moved are all unrated — the last of those stops two accounts farming rating by
resigning instantly at move one.

**Who you are.** Two options, and you never have to pick one up front.

*Guest* is the default. A random id is kept in your browser and you start
playing immediately — no sign-up, no email, nothing to dismiss. Your rating is
real and appears on the leaderboard. The catch is that it lives in that browser:
clear your site data and it is gone, and a different device is a different
player.

*An account* is a username and a password, nothing else. No email, no
verification. Your rating then follows you to any device. **Signing up carries
your guest record with you** — the rating you earned before registering is not
thrown away.

Signing out returns you to guest play with a fresh identity.

### How identity is protected

A guest simply asserts an id, which is safe because a guest id is worth nothing
to steal. An account is different, so:

- Passwords are hashed with **scrypt** — salted, memory-hard, and compared in
  constant time. Plaintext is never stored.
- Signing in issues a session token; only its **SHA-256 hash** is persisted, so
  a leaked data file does not hand anyone a working login.
- **A guest can never assert an account's id.** This is the attack the design
  has to stop: without it, anyone could read a rival's player id off the
  leaderboard, paste it into their own browser, and inherit the account. The
  server refuses any unauthenticated claim on an id an account owns and issues
  a fresh guest id instead. Same guard on registration, so `claimId` cannot be
  pointed at somebody else's record. Both paths have tests.
- Password attempts are rate-limited, and a wrong username and a wrong password
  return the same message so the endpoint cannot be used to discover who has an
  account.

Records live in `data/leaderboard.json`, written atomically after each change.
Set `DATA_DIR` to move it.

> **Hosting note:** on a free host the filesystem is wiped on every restart.
> Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` to keep records in
> a free hosted store instead — see *Deploying for free*.

### Deploying for free

Any host that runs Node and allows WebSockets works. The whole thing is two
dependencies and no build step.

The one wrinkle is storage. **Free tiers give you a filesystem that is wiped
whenever the instance restarts**, and a free instance restarts every time it
goes idle — so a local `data/leaderboard.json` means the leaderboard resets
roughly daily. Free hosting therefore needs storage that lives somewhere else.

**Free setup that keeps its data:**

1. **Upstash** (upstash.com) — create a free Redis database. No card required.
   Copy the two REST values it shows you.
2. **Render** (render.com) — New → Blueprint → pick this repo. It reads
   `render.yaml`.
3. In the Render service, add two environment variables:

   ```
   UPSTASH_REDIS_REST_URL    = https://....upstash.io
   UPSTASH_REDIS_REST_TOKEN  = ....
   ```

That is it. With both set the server keeps player records in Upstash instead of
on disk, and they survive every restart. Without them it uses the local file
exactly as before, which is what you want at home or on a VPS.

The whole dataset is one JSON document, read once at boot and written on a
debounce — a handful of requests an hour for a game among friends, far inside
Upstash's free quota.

Two things to expect on Render's free plan: the service sleeps after about 15
minutes idle, so the first visitor waits roughly 30 seconds for it to wake, and
because rooms live in memory, a restart ends any game actually in progress.
Ratings and accounts are unaffected once Upstash is configured.

**Running it at home instead** costs nothing and keeps the data on your own
disk. Start the server and expose it with a tunnel:

```bash
npx cloudflared tunnel --url http://localhost:3000
```

That prints a public URL anyone can use, with no account needed. The catch is
that your machine has to be on.

---

## How it is put together

```
shared/engine.js    the rules — board, moves, check, mate, notation
shared/bot.js       the computer opponent
shared/rating.js    Elo maths
shared/values.js    piece values, shared by the bot and the scoreboard
server/rooms.js     room and seat bookkeeping
server/store.js     persistent player records, accounts and game history
server/storage.js   where that data lives: local file, or a free hosted store
server/auth.js      password hashing and session tokens
server/index.js     HTTP + WebSocket server
public/             the client (no build step, no framework)
test/               100 tests
```

`shared/engine.js` is loaded unmodified by **both** the browser and the server.
The client uses it to show legal moves; the server uses it to validate them.
They cannot drift apart, because there is only one copy.

**The server is authoritative.** Every move is re-checked server-side before it
is accepted. A tampered client cannot make an illegal move — it gets an error
and is resynchronised. The tests cover this directly: moving out of turn,
moving as a spectator, and sliding a Guardian one or three squares are all
rejected without disturbing the game.

**Reconnecting.** Your seat is held by a token in `localStorage`. Refresh,
close the tab, or lose your connection, and you get your side back when you
return. Your opponent sees you go grey in the meantime. Two tabs in the same
browser are treated as the same person and share a seat — for two players on
one machine, use **Play locally**.

Rooms are forgotten after a day of inactivity, but player records are not —
those persist to disk.

## Tests

```bash
npm test
```

36 engine, 10 server, 11 bot, 21 rating, 14 account and 8 storage tests, including a fuzz run of
100 random games. The engine tests pin down the Guardian specifically: that it
refuses to move one or three squares, that it leaps over both colours without
capturing what it jumps, that it cannot be blocked when giving check, that it
can mate with help, and that it stays inside its quarter of the board.

## The computer opponent

`shared/bot.js` is negamax with alpha-beta, a capture-only quiescence search,
and iterative deepening under a wall-clock budget (450ms on Normal, 1.6s on
Strong; Easy just moves at random). It runs in the browser on the main thread,
so the board is painted before it starts thinking.

It prices the Guardian at 270 centipawns — below a knight — because a piece
confined to a quarter of the board cannot use much of its nominal activity.
That number is a guess, not received wisdom; adjust `VALUE` in `shared/bot.js`
if play suggests otherwise.
