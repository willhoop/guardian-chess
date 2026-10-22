# Security

## Reporting

Open a private security advisory on the repository, or contact Will Hooper
directly. Please do not open a public issue for anything that affects accounts.

## What this application handles

Guardian Chess stores very little, but it does hold two things worth guarding:
account passwords and session tokens.

**Passwords** are hashed with scrypt — salted per user, memory-hard, and
compared in constant time. Plaintext is never stored, never logged, and never
returned by any endpoint.

**Session tokens** are 32 random bytes. Only their SHA-256 hash is persisted, so
a leaked data file does not yield working logins.

**Guest identity** is a random id held in the browser. It is self-asserted and
deliberately worth nothing to steal. The server refuses any unauthenticated
claim on an id that belongs to a registered account, which is the attack that
would otherwise let anyone read a rival's id and inherit their rating. The same
guard applies when registering, so the guest-record claim cannot be pointed at
someone else's account. Both paths are covered by tests in `tests/auth.test.js`.

**Game integrity.** The server is authoritative. Every move is re-validated with
`shared/engine.js` before it is accepted, so a modified client cannot make an
illegal move — it receives an error and is resynchronised. Moving out of turn,
moving as a spectator, and illegal Guardian moves are all covered by tests.

**Rate limiting.** Password attempts are throttled per address. A wrong username
and a wrong password return an identical message, so the endpoint cannot be used
to discover who holds an account. On Render the address is the one Render's
proxy reports; before 1.0.1 it was the proxy's own address, so every visitor
shared one counter.

**Game codes.** A code is five characters from 32: 33,554,432 codes. Each
address may look up a fixed number of codes that do not exist per window (over
HTTP and WebSocket alike); after that, every lookup from it is refused until the
window ends. Room creation is capped per address the same way.

**WebSocket abuse.** Frames over a size cap are refused and the socket closed. Each
connection has a message budget (a burst, then a steady rate); a socket that keeps
sending past it is closed. A malformed frame or malformed JSON closes or refuses
that one socket and never stops the server. All of these numbers live in
`LIMITS` in `server/limits.js`.

## Known limits

- Rooms live in memory. A restart ends games in progress; ratings survive.
- There is no email address on file, so there is no password reset. A forgotten
  password means a new account.
- Deployed over HTTPS the session token is protected in transit. Do not run a
  public instance over plain HTTP.
