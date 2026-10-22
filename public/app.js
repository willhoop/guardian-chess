/**
 * Guardian Chess client.
 *
 * The board, the network layer, and the local pass-and-play mode. Rules live
 * entirely in shared/engine.js — the same file the server validates with, so
 * the two can never drift apart.
 */

import {
  Game, FILE_CHARS, RANK_COUNT, FILE_COUNT,
  squareName, parseSquare, PROMOTION_TYPES,
} from '/shared/engine.js';
import { chooseMove, LEVELS } from '/shared/bot.js';
import {
  pieceSvg, PIECE_NAMES, PIECE_LETTERS, COLOR_NAMES, PIECE_VALUES,
} from './pieces.js';
import { materialFor, formatValue } from '/shared/values.js';

const $ = (sel) => document.querySelector(sel);
const el = {
  lobby: $('#lobby'), game: $('#game'),
  board: $('#board'), ranks: $('#ranks'), files: $('#files'),
  overlay: $('#board-overlay'),
  overlayTitle: $('#overlay-title'), overlaySub: $('#overlay-sub'),
  overlayActions: $('#overlay-actions'),
  oppBar: $('#opp-bar'), meBar: $('#me-bar'),
  roomLine: $('#room-line'), statusLine: $('#status-line'),
  share: $('#share'), shareLink: $('#share-link'), shareCode: $('#share-code'),
  movelist: $('#movelist'), chatlog: $('#chatlog'), chatInput: $('#chat-input'),
  notice: $('#notice'), toast: $('#toast'),
  promo: $('#promo'), promoOptions: $('#promo-options'),
  rulesModal: $('#rules-modal'),
  nameInput: $('#player-name'), joinCode: $('#join-code'),
  boardModal: $('#board-modal'), lbTable: $('#lb-table'), lbRecent: $('#lb-recent'),
  myRating: $('#my-rating'), scoreboard: $('#scoreboard'),
  authModal: $('#auth-modal'), authForm: $('#auth-form'),
  authUser: $('#auth-username'), authPass: $('#auth-password'),
  authError: $('#auth-error'), authHint: $('#auth-hint'), authSubmit: $('#auth-submit'),
  guestBox: $('#guest-box'), accountBox: $('#account-box'), accountName: $('#account-name'),
};

const state = {
  mode: null,          // 'online' | 'local' | 'bot'
  botLevel: 'normal',
  thinking: false,     // the bot is picking a move; input is locked
  code: null,
  token: null,
  myColor: null,       // null while spectating
  game: new Game(),
  players: { w: null, b: null },
  chat: [],
  drawOffer: null,
  rematchOffer: null,
  flipped: false,
  labels: false,       // draw a letter on each piece
  selected: null,      // {r, c}
  targets: [],         // legal moves from the selected square
  lastMove: null,      // {from, to} as square names
  connection: 'idle',
  pendingPromo: null,
  drag: null,
  account: null,       // the signed-in account, or null when playing as a guest
  authMode: 'signin',
  me: null,            // this player's leaderboard record
  rated: false,        // is the current online game rated
  ratingChange: null,  // {w, b} deltas from the game just finished
};

/* ── Storage ─────────────────────────────────────────────────────── */

const store = {
  get name() { return localStorage.getItem('gc:name') || ''; },
  set name(v) { localStorage.setItem('gc:name', v); },
  get labels() { return localStorage.getItem('gc:labels') === '1'; },
  set labels(v) { localStorage.setItem('gc:labels', v ? '1' : '0'); },

  get session() { return localStorage.getItem('gc:session') || ''; },
  set session(v) {
    if (v) localStorage.setItem('gc:session', v);
    else localStorage.removeItem('gc:session');
  },

  /**
   * One identity for this browser, reused in every game. It doubles as the
   * seat token when reconnecting and as the leaderboard key, which is why it
   * is no longer stored per room. Losing it means losing your rating, so it is
   * only ever generated when absent.
   */
  get playerId() {
    let id = localStorage.getItem('gc:playerId');
    if (!id || id.length !== 32) {
      id = [...crypto.getRandomValues(new Uint8Array(16))]
        .map((b) => b.toString(16).padStart(2, '0')).join('');
      localStorage.setItem('gc:playerId', id);
    }
    return id;
  },
};

/* ── Toast ───────────────────────────────────────────────────────── */

let toastTimer;
function toast(message, bad = false) {
  el.toast.textContent = message;
  el.toast.classList.toggle('bad', bad);
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 3200);
}

/* ── Networking ──────────────────────────────────────────────────── */

let socket = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
let intentionalClose = false;

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

function connect() {
  if (state.mode !== 'online' || !state.code) return;
  clearTimeout(reconnectTimer);
  intentionalClose = false;

  setConnection('connecting');
  socket = new WebSocket(wsUrl());

  socket.addEventListener('open', () => {
    reconnectAttempts = 0;
    setConnection('online');
    socket.send(JSON.stringify({
      type: 'join',
      code: state.code,
      token: store.playerId,
      session: store.session || undefined,
      name: store.name || undefined,
    }));
  });

  socket.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    onServerMessage(msg);
  });

  socket.addEventListener('close', () => {
    socket = null;
    if (intentionalClose || state.mode !== 'online') return;
    setConnection('offline');
    scheduleReconnect();
  });

  socket.addEventListener('error', () => { /* close handler does the work */ });
}

function scheduleReconnect() {
  reconnectAttempts++;
  const delay = Math.min(1000 * 2 ** (reconnectAttempts - 1), 15000);
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, delay);
}

function disconnect() {
  intentionalClose = true;
  clearTimeout(reconnectTimer);
  if (socket) { socket.close(); socket = null; }
  setConnection('idle');
}

function setConnection(value) {
  state.connection = value;
  renderRoomLine();
}

function sendToServer(payload) {
  if (state.mode !== 'online') return;
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    toast('Still reconnecting — try that again in a moment.', true);
    return false;
  }
  socket.send(JSON.stringify(payload));
  return true;
}

function onServerMessage(msg) {
  switch (msg.type) {
    case 'joined': {
      state.token = msg.token;
      state.myColor = msg.color;
      if (msg.me) state.me = msg.me;
      // Show the board from your own side.
      setFlipped(msg.color === 'b');
      break;
    }
    case 'state': {
      const prevPly = state.game.history.length;
      state.game = Game.fromJSON(msg.game);
      state.players = msg.players;
      state.chat = msg.chat;
      state.drawOffer = msg.drawOffer;
      state.rematchOffer = msg.rematchOffer;
      state.rated = Boolean(msg.rated);
      state.ratingChange = msg.ratingChange || null;
      // Our own record moves when a rated game ends.
      if (msg.ratingChange && state.myColor && state.me) {
        state.me = { ...state.me, rating: state.me.rating + msg.ratingChange[state.myColor] };
      }

      const h = state.game.history;
      state.lastMove = h.length ? { from: h[h.length - 1].from, to: h[h.length - 1].to } : null;
      if (h.length !== prevPly) clearSelection();
      renderAll();
      return;
    }
    case 'error': {
      toast(msg.message || 'That did not work.', true);
      // A refused join or a rate limit says resync: false. Re-joining then
      // would be refused again, and the two sides would loop.
      if (msg.resync === false) return;
      // Our optimistic view may now be wrong; pull the truth back down.
      sendToServer({
        type: 'join', code: state.code,
        token: store.playerId, session: store.session || undefined,
        name: store.name || undefined,
      });
      return;
    }
  }
  renderAll();
}

/* ── Starting and joining games ──────────────────────────────────── */

async function createRoom() {
  const pick = document.querySelector('input[name="hostcolor"]:checked')?.value;
  const body = { wazir: $('#opt-wazir').checked };
  if (pick === 'w' || pick === 'b') body.color = pick;
  let data;
  try {
    const res = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('Server said no');
    data = await res.json();
  } catch {
    toast('Could not reach the server.', true);
    return;
  }
  enterOnline(data.code);
}

function enterOnline(code) {
  state.mode = 'online';
  state.code = String(code).toUpperCase();
  state.myColor = null;
  state.game = new Game();
  state.players = { w: null, b: null };
  state.chat = [];
  state.lastMove = null;
  clearSelection();
  location.hash = state.code;
  showScreen('game');
  buildBoard();
  renderAll();
  connect();
}

function enterLocal() {
  disconnect();
  state.mode = 'local';
  state.code = null;
  state.myColor = null;
  state.token = null;
  state.game = new Game(null, { wazir: $('#opt-wazir-local').checked });
  state.players = { w: { name: 'White', online: true }, b: { name: 'Black', online: true } };
  state.chat = [];
  state.drawOffer = null;
  state.rematchOffer = null;
  state.lastMove = null;
  state.flipped = false;
  clearSelection();
  history.replaceState(null, '', location.pathname);
  showScreen('game');
  buildBoard();
  renderAll();
}

/** Start a game against the built-in opponent. You are always White. */
function enterBot(level) {
  disconnect();
  state.mode = 'bot';
  state.botLevel = LEVELS[level] ? level : 'normal';
  state.code = null;
  state.token = null;
  state.myColor = 'w';
  state.thinking = false;
  state.game = new Game(null, { wazir: $('#opt-wazir-bot').checked });
  state.players = {
    w: { name: store.name || 'You', online: true },
    b: { name: `Computer (${LEVELS[state.botLevel].label})`, online: true },
  };
  state.chat = [];
  state.drawOffer = null;
  state.rematchOffer = null;
  state.lastMove = null;
  state.flipped = false;
  clearSelection();
  history.replaceState(null, '', location.pathname);
  showScreen('game');
  buildBoard();
  renderAll();
}

/**
 * Let the opponent reply. The search blocks the main thread, so paint the
 * player's own move first and only then start thinking.
 */
function maybeBotMove() {
  if (state.mode !== 'bot' || state.game.over) return;
  if (state.game.pos.turn === state.myColor) return;
  if (state.thinking) return;

  state.thinking = true;
  renderStatus();

  setTimeout(() => {
    // The game can be abandoned or restarted while we were queued.
    if (state.mode !== 'bot' || state.game.over) { state.thinking = false; return; }
    try {
      const mv = chooseMove(state.game.pos, state.botLevel);
      if (mv) {
        state.game.move(mv.from, mv.to, mv.promo);
        state.lastMove = { from: mv.from, to: mv.to };
      }
    } catch (err) {
      toast(`The computer got stuck: ${err.message}`, true);
    }
    state.thinking = false;
    clearSelection();
    renderAll();
  }, 180);
}

function leaveGame() {
  disconnect();
  state.mode = null;
  state.code = null;
  history.replaceState(null, '', location.pathname);
  showScreen('lobby');
  refreshMyRating();
}

function showScreen(which) {
  el.lobby.hidden = which !== 'lobby';
  el.game.hidden = which !== 'game';
}

/**
 * Persist whatever is in the name box.
 *
 * Only ever call this from a deliberate click. Browsers restore form fields on
 * reload, sometimes after scripts have run, so saving during an automatic
 * hash-driven join would write a stale restored value over the real name.
 */
function saveName() {
  const v = el.nameInput.value.trim();
  if (v) store.name = v;
}

/* ── Board construction ──────────────────────────────────────────── */

function displayRows() {
  const rows = [...Array(RANK_COUNT).keys()];
  return state.flipped ? rows.reverse() : rows;
}
function displayCols() {
  const cols = [...Array(FILE_COUNT).keys()];
  return state.flipped ? cols.reverse() : cols;
}

/** Rebuild the grid of squares. Called on first entry and on every flip. */
function buildBoard() {
  el.board.textContent = '';
  for (const r of displayRows()) {
    for (const c of displayCols()) {
      const sq = document.createElement('div');
      sq.className = `sq ${(r + c) % 2 === 0 ? 'light' : 'dark'}`;
      sq.dataset.r = r;
      sq.dataset.c = c;
      sq.setAttribute('role', 'gridcell');
      sq.setAttribute('aria-label', squareName(r, c));
      el.board.append(sq);
    }
  }

  el.ranks.textContent = '';
  for (const r of displayRows()) {
    const d = document.createElement('div');
    d.textContent = RANK_COUNT - r;
    el.ranks.append(d);
  }

  el.files.textContent = '';
  for (const c of displayCols()) {
    const d = document.createElement('div');
    d.textContent = FILE_CHARS[c];
    el.files.append(d);
  }
}

function squareEl(r, c) {
  return el.board.querySelector(`[data-r="${r}"][data-c="${c}"]`);
}

/**
 * Turn the board around. Squares are keyed by rank and file rather than by
 * position in the grid, so flipping means rebuilding the grid — a plain
 * re-render would leave the old order in place.
 */
function setFlipped(value) {
  if (state.flipped === value) return;
  state.flipped = value;
  buildBoard();
}

/* ── Rendering ───────────────────────────────────────────────────── */

function renderAll() {
  renderBoard();
  renderRoomLine();
  renderStatus();
  renderPlayerBars();
  renderMoves();
  renderScoreboard();
  renderChat();
  renderShare();
  renderNotice();
  renderOverlay();
  renderControls();
}

function renderBoard() {
  const { game } = state;
  const board = game.pos.board;
  const checkedColor = game.inCheck(game.pos.turn) && !game.over ? game.pos.turn : null;
  const kingSq = checkedColor ? findKingSquare(board, checkedColor) : null;

  const targetKeys = new Set(state.targets.map((m) => `${m.tr},${m.tc}`));
  const lastFrom = state.lastMove && parseSquare(state.lastMove.from);
  const lastTo = state.lastMove && parseSquare(state.lastMove.to);
  const movable = canAct();

  for (let r = 0; r < RANK_COUNT; r++) {
    for (let c = 0; c < FILE_COUNT; c++) {
      const sq = squareEl(r, c);
      if (!sq) continue;
      const piece = board[r][c];

      sq.classList.toggle('sel', Boolean(state.selected && state.selected.r === r && state.selected.c === c));
      sq.classList.toggle('last', Boolean(
        (lastFrom && lastFrom.r === r && lastFrom.c === c) ||
        (lastTo && lastTo.r === r && lastTo.c === c),
      ));
      sq.classList.toggle('check', Boolean(kingSq && kingSq.r === r && kingSq.c === c));
      sq.classList.toggle('playable', movable &&
        (targetKeys.has(`${r},${c}`) || Boolean(piece && piece.c === activeColor())));

      const isTarget = targetKeys.has(`${r},${c}`);
      const wantHint = isTarget ? (piece ? 'capture' : 'dot') : null;
      const wantPiece = piece ? `${piece.c}${piece.t}` : null;

      // Only touch the DOM when something actually changed, so dragging stays smooth.
      if (sq.dataset.piece !== (wantPiece || '') || sq.dataset.hint !== (wantHint || '')) {
        sq.textContent = '';
        if (wantHint) {
          const hint = document.createElement('div');
          hint.className = `hint${wantHint === 'capture' ? ' capture' : ''}`;
          sq.append(hint);
        }
        if (piece) {
          const holder = document.createElement('div');
          holder.className = 'piece';
          holder.innerHTML = pieceSvg(piece.t, piece.c);
          holder.title = `${COLOR_NAMES[piece.c]} ${PIECE_NAMES[piece.t]}`;
          if (lastTo && lastTo.r === r && lastTo.c === c) holder.classList.add('landed');
          if (state.labels) {
            const tag = document.createElement('span');
            tag.className = 'piece-letter';
            tag.textContent = PIECE_LETTERS[piece.t];
            holder.append(tag);
          }
          sq.append(holder);
        }
        sq.dataset.piece = wantPiece || '';
        sq.dataset.hint = wantHint || '';
      }
    }
  }
}

function findKingSquare(board, color) {
  for (let r = 0; r < RANK_COUNT; r++) {
    for (let c = 0; c < FILE_COUNT; c++) {
      const p = board[r][c];
      if (p && p.t === 'k' && p.c === color) return { r, c };
    }
  }
  return null;
}

function renderRoomLine() {
  if (state.mode === 'local') {
    el.roomLine.textContent = `Local game · same screen${rulesSuffix()}`;
    return;
  }
  if (state.mode === 'bot') {
    el.roomLine.textContent =
      `Versus computer · ${LEVELS[state.botLevel].label}${rulesSuffix()}`;
    return;
  }
  const conn = {
    connecting: '· connecting…',
    online: '',
    offline: '· reconnecting…',
    idle: '',
  }[state.connection] || '';
  const seat = state.myColor
    ? `You are ${COLOR_NAMES[state.myColor]}`
    : 'Watching';
  el.roomLine.textContent =
    `Game ${state.code} · ${seat}${rulesSuffix()} ${conn}`.trim();
}

/** Names any non-default rule, so nobody is surprised mid-game. */
function rulesSuffix() {
  return state.game.pos.wazir ? ' · stepping Guardians' : '';
}

function renderStatus() {
  const { game } = state;
  if (game.over) {
    const r = game.result;
    const who = r.winner ? `${COLOR_NAMES[r.winner]} wins` : 'Draw';
    el.statusLine.innerHTML = `<span class="good">${who}</span> — ${r.reason}`;
    return;
  }
  if (state.mode === 'online' && !bothSeated()) {
    el.statusLine.textContent = 'Waiting for an opponent…';
    return;
  }
  if (state.mode === 'bot' && state.thinking) {
    el.statusLine.textContent = 'Computer is thinking…';
    return;
  }
  const turn = COLOR_NAMES[game.pos.turn];
  const yours = state.mode === 'local'
    ? ''
    : game.pos.turn === state.myColor ? ' (you)' : '';
  const check = game.inCheck(game.pos.turn)
    ? ' <span class="warn">— check</span>'
    : '';
  el.statusLine.innerHTML = `${turn} to move${yours}${check}`;
}

function bothSeated() {
  return Boolean(state.players.w && state.players.b);
}

function renderPlayerBars() {
  const bottom = state.flipped ? 'b' : 'w';
  const top = bottom === 'w' ? 'b' : 'w';
  el.oppBar.replaceChildren(...playerBar(top));
  el.meBar.replaceChildren(...playerBar(bottom));
  el.oppBar.classList.toggle('turn', !state.game.over && state.game.pos.turn === top);
  el.meBar.classList.toggle('turn', !state.game.over && state.game.pos.turn === bottom);
}

function playerBar(color) {
  const p = state.players[color];
  const nodes = [];

  const dot = document.createElement('span');
  dot.className = `dot${p && p.online ? ' on' : ''}`;
  nodes.push(dot);

  const name = document.createElement('span');
  name.className = 'pname';
  name.textContent = p ? (p.name || COLOR_NAMES[color]) : 'Empty seat';
  nodes.push(name);

  if (p && typeof p.rating === 'number') {
    const rating = document.createElement('span');
    rating.className = 'prating';
    rating.textContent = String(p.rating);
    rating.title = 'Rating';
    nodes.push(rating);
  }

  const meta = document.createElement('span');
  meta.className = 'pmeta';
  const bits = [COLOR_NAMES[color]];
  if (state.mode === 'online') {
    if (!p) bits.push('waiting');
    else if (!p.online) bits.push('offline');
    if (color === state.myColor) bits.push('you');
  }
  meta.textContent = `· ${bits.join(' · ')}`;
  nodes.push(meta);

  const { taken, advantage } = capturedBy(color);
  const box = document.createElement('span');
  box.className = 'captured';
  for (const t of taken) {
    const holder = document.createElement('span');
    holder.innerHTML = pieceSvg(t, color === 'w' ? 'b' : 'w');
    box.append(holder);
  }
  if (advantage > 0) {
    const adv = document.createElement('span');
    adv.className = 'adv';
    adv.textContent = `+${advantage}`;
    box.append(adv);
  }
  nodes.push(box);

  return nodes;
}

/** What `color` has captured, and their material lead if any. */
function capturedBy(color) {
  const order = ['q', 'r', 'b', 'n', 'g', 'p'];
  const mine = [];
  const theirs = [];
  for (const h of state.game.history) {
    if (!h.captured) continue;
    (h.color === color ? mine : theirs).push(h.captured);
  }
  const sum = (list) => list.reduce((n, t) => n + (PIECE_VALUES[t] || 0), 0);
  mine.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return { taken: mine, advantage: sum(mine) - sum(theirs) };
}

function renderMoves() {
  const h = state.game.history;
  el.movelist.textContent = '';
  if (!h.length) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.className = 'empty';
    span.textContent = 'No moves yet.';
    li.append(span);
    el.movelist.append(li);
    return;
  }
  for (let i = 0; i < h.length; i += 2) {
    const li = document.createElement('li');
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = `${i / 2 + 1}.`;
    li.append(num);
    for (const ply of [h[i], h[i + 1]]) {
      const span = document.createElement('span');
      span.className = 'ply';
      if (ply) {
        span.textContent = ply.san;
        if (h.indexOf(ply) === h.length - 1) span.classList.add('current');
      }
      li.append(span);
    }
    el.movelist.append(li);
  }
  el.movelist.scrollTop = el.movelist.scrollHeight;
}

function renderChat() {
  el.chatlog.textContent = '';
  if (!state.chat.length) {
    const d = document.createElement('div');
    d.className = 'sys';
    d.textContent = state.mode === 'online'
      ? 'No messages yet.'
      : 'Chat is for online games.';
    el.chatlog.append(d);
    return;
  }
  for (const m of state.chat) {
    const d = document.createElement('div');
    d.className = 'msg';
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = `${m.from}:`;
    d.append(who, document.createTextNode(m.text));
    el.chatlog.append(d);
  }
  el.chatlog.scrollTop = el.chatlog.scrollHeight;
}

function renderShare() {
  const show = state.mode === 'online' && !bothSeated() && !state.game.over;
  el.share.hidden = !show;
  if (!show) return;
  el.shareLink.value = `${location.origin}/#${state.code}`;
  el.shareCode.textContent = state.code;
}

function renderNotice() {
  const offer = state.drawOffer;
  const theirs = offer && state.myColor && offer !== state.myColor;
  const mine = offer && offer === state.myColor;

  if (!offer || state.game.over || state.mode !== 'online') {
    el.notice.hidden = true;
    return;
  }

  el.notice.hidden = false;
  el.notice.textContent = '';
  const p = document.createElement('div');

  if (theirs) {
    p.textContent = `${COLOR_NAMES[offer]} offers a draw.`;
    const actions = document.createElement('div');
    actions.className = 'notice-actions';
    actions.append(
      button('Accept', 'btn btn-small btn-primary', () => sendToServer({ type: 'acceptDraw' })),
      button('Decline', 'btn btn-small', () => sendToServer({ type: 'declineDraw' })),
    );
    el.notice.append(p, actions);
  } else if (mine) {
    p.textContent = 'Draw offered. Waiting for a reply…';
    el.notice.append(p);
  } else {
    el.notice.hidden = true;
  }
}

function renderOverlay() {
  const { game } = state;
  if (!game.over) { el.overlay.hidden = true; return; }

  el.overlay.hidden = false;
  const r = game.result;
  el.overlayTitle.textContent = r.winner ? `${COLOR_NAMES[r.winner]} wins` : 'Draw';
  el.overlaySub.textContent = r.reason;

  // Show what the result did to your rating.
  const existing = el.overlayActions.parentElement.querySelector('.overlay-rating');
  if (existing) existing.remove();
  if (state.ratingChange && state.myColor) {
    const delta = state.ratingChange[state.myColor];
    const line = document.createElement('p');
    line.className = 'overlay-rating';
    const sign = delta > 0 ? '+' : '';
    line.innerHTML = `<span class="delta ${delta >= 0 ? 'up' : 'down'}">${sign}${delta}</span>` +
      (state.me ? ` &rarr; ${state.me.rating}` : '');
    el.overlayActions.parentElement.insertBefore(line, el.overlayActions);
  } else if (state.mode === 'online' && !state.rated && state.myColor) {
    const line = document.createElement('p');
    line.className = 'overlay-rating';
    line.style.color = 'var(--muted)';
    line.style.fontWeight = '400';
    line.style.fontSize = '.86rem';
    line.textContent = 'Unrated game';
    el.overlayActions.parentElement.insertBefore(line, el.overlayActions);
  }

  el.overlayActions.textContent = '';
  if (state.mode === 'local') {
    el.overlayActions.append(button('New game', 'btn btn-primary', enterLocal));
    return;
  }
  if (state.mode === 'bot') {
    el.overlayActions.append(
      button('New game', 'btn btn-primary', () => enterBot(state.botLevel)),
      button('Leave', 'btn', leaveGame),
    );
    return;
  }
  if (!state.myColor) return;

  const offer = state.rematchOffer;
  if (offer && offer !== state.myColor) {
    el.overlayActions.append(
      button('Accept rematch', 'btn btn-primary', () => sendToServer({ type: 'acceptRematch' })),
    );
  } else if (offer === state.myColor) {
    const waiting = document.createElement('span');
    waiting.className = 'pmeta';
    waiting.textContent = 'Rematch offered…';
    el.overlayActions.append(waiting);
  } else {
    el.overlayActions.append(
      button('Offer rematch', 'btn btn-primary', () => sendToServer({ type: 'offerRematch' })),
    );
  }
  el.overlayActions.append(button('Leave', 'btn', leaveGame));
}

function renderControls() {
  const online = state.mode === 'online' && state.myColor && !state.game.over;
  $('#btn-draw').disabled = !online || !bothSeated();
  // Resigning to the computer is allowed; there is nobody to agree a draw with.
  $('#btn-resign').disabled = !online && !(state.mode === 'bot' && !state.game.over);
}

function button(label, className, onClick) {
  const b = document.createElement('button');
  b.className = className;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

/* ── Whose move is it, and may I make it ─────────────────────────── */

function activeColor() {
  return state.game.pos.turn;
}

/** True when this browser is allowed to move the side to move. */
function canAct() {
  if (state.game.over) return false;
  if (state.mode === 'local') return true;
  if (state.mode === 'bot') return !state.thinking && state.game.pos.turn === state.myColor;
  if (!state.myColor) return false;
  if (!bothSeated()) return false;
  return state.game.pos.turn === state.myColor;
}

/* ── Selection and moving ────────────────────────────────────────── */

function clearSelection() {
  state.selected = null;
  state.targets = [];
}

function select(r, c) {
  const piece = state.game.pos.board[r][c];
  if (!piece || piece.c !== activeColor() || !canAct()) {
    clearSelection();
    return false;
  }
  state.selected = { r, c };
  state.targets = state.game.legalMovesFrom(r, c);
  return true;
}

function attemptMove(from, to) {
  const candidates = state.targets.filter((m) => m.tr === to.r && m.tc === to.c);
  if (!candidates.length) return false;

  if (candidates.length > 1 && candidates.some((m) => m.promo)) {
    openPromotion(from, to, candidates);
    return true;
  }
  commitMove(from, to, candidates[0].promo || null);
  return true;
}

function commitMove(from, to, promo) {
  const fromName = squareName(from.r, from.c);
  const toName = squareName(to.r, to.c);

  // Offline modes apply the move straight to the local game.
  if (state.mode === 'local' || state.mode === 'bot') {
    try {
      state.game.move(fromName, toName, promo);
    } catch (err) {
      toast(err.message, true);
      return;
    }
    state.lastMove = { from: fromName, to: toName };
    clearSelection();
    if (state.mode === 'local') {
      // Turn the board to face whoever is now on move.
      setFlipped(state.game.pos.turn === 'b');
    }
    renderAll();
    if (state.mode === 'bot') maybeBotMove();
    return;
  }

  // Online: play it locally for instant feedback, then let the server's
  // broadcast be the final word.
  if (!sendToServer({ type: 'move', from: fromName, to: toName, promo })) return;
  try {
    state.game.move(fromName, toName, promo);
    state.lastMove = { from: fromName, to: toName };
  } catch {
    /* The server will correct us. */
  }
  clearSelection();
  renderAll();
}

/* ── Promotion ───────────────────────────────────────────────────── */

function openPromotion(from, to, candidates) {
  state.pendingPromo = { from, to };
  el.promoOptions.textContent = '';
  const available = PROMOTION_TYPES.filter((t) => candidates.some((m) => m.promo === t));
  for (const t of available) {
    const b = document.createElement('button');
    b.innerHTML = pieceSvg(t, activeColor());
    b.title = PIECE_NAMES[t];
    b.setAttribute('aria-label', PIECE_NAMES[t]);
    b.addEventListener('click', () => {
      el.promo.hidden = true;
      const pending = state.pendingPromo;
      state.pendingPromo = null;
      if (pending) commitMove(pending.from, pending.to, t);
    });
    el.promoOptions.append(b);
  }
  el.promo.hidden = false;
}

$('#promo-cancel').addEventListener('click', () => {
  el.promo.hidden = true;
  state.pendingPromo = null;
  clearSelection();
  renderAll();
});

/* ── Pointer interaction: click-to-move and drag-to-move ─────────── */

function coordsOf(sq) {
  if (!sq || !el.board.contains(sq)) return null;
  return { r: Number(sq.dataset.r), c: Number(sq.dataset.c) };
}

/** Where the pointer went down: the event target is the square itself. */
function squareFromEvent(ev) {
  return coordsOf(ev.target instanceof Element ? ev.target.closest('.sq') : null);
}

/**
 * Where a drag was released. Pointer capture retargets the event to the board,
 * so the square underneath has to be hit-tested.
 */
function squareFromPoint(x, y) {
  const target = document.elementFromPoint(x, y);
  return coordsOf(target && target.closest('.sq'));
}

el.board.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0) return;
  const hit = squareFromEvent(ev);
  if (!hit) return;
  ev.preventDefault();

  // Clicking a highlighted target completes the move.
  if (state.selected && attemptMove(state.selected, hit)) return;

  const piece = state.game.pos.board[hit.r][hit.c];
  if (piece && piece.c === activeColor() && canAct()) {
    const wasSelected = state.selected && state.selected.r === hit.r && state.selected.c === hit.c;
    select(hit.r, hit.c);
    state.drag = {
      origin: hit,
      startX: ev.clientX,
      startY: ev.clientY,
      moved: false,
      wasSelected,
      pointerId: ev.pointerId,
    };
    // Capture keeps the drag alive outside the board. Not worth failing the
    // click over if the browser refuses it.
    try { el.board.setPointerCapture(ev.pointerId); } catch { /* click still works */ }
  } else {
    clearSelection();
  }
  renderAll();
});

el.board.addEventListener('pointermove', (ev) => {
  const drag = state.drag;
  if (!drag || ev.pointerId !== drag.pointerId) return;

  const dx = ev.clientX - drag.startX;
  const dy = ev.clientY - drag.startY;
  if (!drag.moved && Math.hypot(dx, dy) < 6) return;

  if (!drag.moved) {
    drag.moved = true;
    const piece = state.game.pos.board[drag.origin.r][drag.origin.c];
    if (!piece) return;
    const ghost = document.createElement('div');
    ghost.id = 'drag-ghost';
    const size = el.board.getBoundingClientRect().width / FILE_COUNT;
    ghost.style.width = ghost.style.height = `${size}px`;
    ghost.innerHTML = pieceSvg(piece.t, piece.c);
    document.body.append(ghost);
    drag.ghost = ghost;
    squareEl(drag.origin.r, drag.origin.c)?.querySelector('.piece')?.classList.add('dragging');
  }

  if (drag.ghost) {
    drag.ghost.style.left = `${ev.clientX}px`;
    drag.ghost.style.top = `${ev.clientY}px`;
  }
});

function endDrag(ev) {
  const drag = state.drag;
  if (!drag || ev.pointerId !== drag.pointerId) return;
  state.drag = null;
  try { el.board.releasePointerCapture(ev.pointerId); } catch { /* never captured */ }

  drag.ghost?.remove();
  squareEl(drag.origin.r, drag.origin.c)?.querySelector('.piece')?.classList.remove('dragging');

  if (drag.moved) {
    const hit = squareFromPoint(ev.clientX, ev.clientY) || squareFromEvent(ev);
    if (hit && !(hit.r === drag.origin.r && hit.c === drag.origin.c)) {
      if (!attemptMove(drag.origin, hit)) clearSelection();
    }
    // A drag that goes nowhere leaves the piece selected for a follow-up click.
  } else if (drag.wasSelected) {
    // A second click on the same piece deselects it.
    clearSelection();
  }
  renderAll();
}

el.board.addEventListener('pointerup', endDrag);
el.board.addEventListener('pointercancel', endDrag);
el.board.addEventListener('contextmenu', (ev) => {
  ev.preventDefault();
  clearSelection();
  renderAll();
});

/* ── Accounts ────────────────────────────────────────────────────── */

/**
 * The id my results are recorded under.
 *
 * Signed in, that is the account id, which is not the same as the guest id
 * sitting in localStorage — signing out deliberately issues a fresh guest id.
 * Anything asking "is this row me?" has to go through here.
 */
function myId() {
  return state.account?.id || store.playerId;
}

function openAuth(mode) {
  state.authMode = mode;
  for (const t of document.querySelectorAll('.authtab')) {
    t.classList.toggle('is-active', t.dataset.authtab === mode);
  }
  const signup = mode === 'signup';
  el.authSubmit.textContent = signup ? 'Create account' : 'Sign in';
  el.authPass.autocomplete = signup ? 'new-password' : 'current-password';
  el.authHint.textContent = signup
    ? 'Letters, numbers, hyphens and underscores. Password at least 8 characters.'
    : '';
  el.authError.hidden = true;
  el.authModal.hidden = false;
  el.authUser.focus();
}

function authError(message) {
  el.authError.textContent = message;
  el.authError.hidden = false;
}

async function submitAuth(ev) {
  ev.preventDefault();
  const username = el.authUser.value.trim();
  const password = el.authPass.value;
  if (!username || !password) return authError('Fill in both fields.');

  const signup = state.authMode === 'signup';
  el.authSubmit.disabled = true;
  el.authError.hidden = true;

  try {
    const body = signup
      // Carry the guest record over, so signing up does not reset your rating.
      ? { username, password, claimId: store.playerId }
      : { username, password };
    const res = await fetch(signup ? '/api/register' : '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) { authError(data.error || 'That did not work.'); return; }

    store.session = data.session;
    setAccount(data.player);
    el.authModal.hidden = true;
    el.authForm.reset();
    toast(data.claimed
      ? `Welcome, ${data.player.name}. Your guest rating came with you.`
      : `Signed in as ${data.player.name}.`);
  } catch {
    authError('Could not reach the server.');
  } finally {
    el.authSubmit.disabled = false;
  }
}

/** Reflect the signed-in account (or lack of one) in the lobby. */
function setAccount(player) {
  state.account = player;
  state.me = player || state.me;
  el.guestBox.hidden = Boolean(player);
  el.accountBox.hidden = !player;
  if (player) {
    el.accountName.textContent = player.name;
    // An account's display name is its username.
    store.name = player.name;
    el.nameInput.value = player.name;
  }
  refreshMyRating();
}

async function signOut() {
  const session = store.session;
  store.session = '';
  state.account = null;
  // Back to being a guest, with a brand new identity.
  localStorage.removeItem('gc:playerId');
  el.guestBox.hidden = false;
  el.accountBox.hidden = true;
  try {
    await fetch('/api/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session }),
    });
  } catch { /* the local session is gone either way */ }
  state.me = null;
  refreshMyRating();
  toast('Signed out. You are playing as a guest.');
}

/** Restore a signed-in browser on page load. */
async function restoreSession() {
  if (!store.session) return;
  try {
    const res = await fetch(`/api/me?session=${encodeURIComponent(store.session)}`);
    const { player } = await res.json();
    if (player) setAccount(player);
    else store.session = '';       // expired or revoked
  } catch { /* offline; try again next load */ }
}

/* ── Material scoreboard ─────────────────────────────────────────── */

const SCORE_ORDER = ['q', 'r', 'b', 'n', 'g', 'p'];

/**
 * Material on the board for each side, what each has captured, and the value
 * table itself, so the numbers are never a mystery.
 */
function renderScoreboard() {
  const board = state.game.pos.board;
  const host = el.scoreboard;
  host.textContent = '';

  const white = materialFor(board, 'w');
  const black = materialFor(board, 'b');
  const total = white + black || 1;

  const head = document.createElement('div');
  head.className = 'sb-head';
  head.append(
    span('sb-side', 'White'), span('sb-total', formatValue(white)),
    span('sb-total', formatValue(black)), span('sb-side', 'Black'),
  );
  head.style.gap = '8px';
  host.append(head);

  const bar = document.createElement('div');
  bar.className = 'sb-bar';
  const w = document.createElement('div');
  w.className = 'w';
  w.style.width = `${(white / total) * 100}%`;
  const b = document.createElement('div');
  b.className = 'b';
  b.style.flex = '1';
  bar.append(w, b);
  host.append(bar);

  const lead = document.createElement('p');
  lead.className = 'sb-lead';
  const diff = white - black;
  lead.innerHTML = diff === 0
    ? 'Material is level'
    : `<strong>${COLOR_NAMES[diff > 0 ? 'w' : 'b']}</strong> leads by ` +
      `<strong>${formatValue(Math.abs(diff))}</strong>`;
  host.append(lead);

  for (const color of ['w', 'b']) {
    host.append(subhead(`${COLOR_NAMES[color]} has captured`));
    const { taken } = capturedBy(color);
    if (!taken.length) {
      host.append(span('sb-empty', 'Nothing yet.'));
      continue;
    }
    const counts = {};
    for (const t of taken) counts[t] = (counts[t] || 0) + 1;
    for (const type of SCORE_ORDER) {
      if (!counts[type]) continue;
      host.append(scoreRow(type, color === 'w' ? 'b' : 'w', counts[type]));
    }
  }

  host.append(subhead('Piece values'));
  for (const type of SCORE_ORDER) {
    const row = document.createElement('div');
    row.className = 'sb-row';
    const icon = document.createElement('span');
    icon.innerHTML = pieceSvg(type, 'w');
    row.append(icon, span('nm', PIECE_NAMES[type]), span('vl', formatValue(PIECE_VALUES[type])));
    host.append(row);
  }

  const note = document.createElement('p');
  note.className = 'sb-note';
  note.textContent =
    'The Guardian is priced below a knight because it can only ever reach a ' +
    'quarter of the board. These are estimates from the piece geometry, not ' +
    'from played games.';
  host.append(note);
}

function scoreRow(type, color, count) {
  const row = document.createElement('div');
  row.className = 'sb-row';
  const icon = document.createElement('span');
  icon.innerHTML = pieceSvg(type, color);
  row.append(
    icon,
    span('nm', PIECE_NAMES[type]),
    span('ct', count > 1 ? `x${count}` : ''),
    span('vl', formatValue(PIECE_VALUES[type] * count)),
  );
  return row;
}

function span(className, text) {
  const el2 = document.createElement('span');
  el2.className = className;
  el2.textContent = text;
  return el2;
}

function subhead(text) {
  const d = document.createElement('div');
  d.className = 'sb-sub';
  d.textContent = text;
  return d;
}

/* ── Leaderboard ─────────────────────────────────────────────────── */

async function openLeaderboard() {
  el.boardModal.hidden = false;
  el.lbTable.textContent = 'Loading…';
  el.lbRecent.textContent = '';
  try {
    const res = await fetch('/api/leaderboard');
    if (!res.ok) throw new Error('bad response');
    const data = await res.json();
    renderLeaderboard(data.players);
    renderRecentGames(data.recent);
  } catch {
    el.lbTable.textContent = '';
    el.lbTable.append(emptyRow('Could not load the leaderboard.'));
  }
}

function emptyRow(text) {
  const d = document.createElement('div');
  d.className = 'lb-empty';
  d.textContent = text;
  return d;
}

function renderLeaderboard(rows) {
  el.lbTable.textContent = '';
  if (!rows.length) {
    el.lbTable.append(emptyRow('No rated games yet. Play someone online to get on the board.'));
    return;
  }

  const table = document.createElement('table');
  table.className = 'lb';
  table.innerHTML =
    '<thead><tr><th>#</th><th>Player</th><th>Rating</th><th>W&nbsp;/&nbsp;L&nbsp;/&nbsp;D</th>' +
    '<th>Games</th><th>Streak</th></tr></thead>';

  const body = document.createElement('tbody');
  for (const p of rows) {
    const tr = document.createElement('tr');
    if (p.id === myId()) tr.className = 'me';

    const streak = p.streak > 0 ? `W${p.streak}` : p.streak < 0 ? `L${-p.streak}` : '—';
    const streakClass = p.streak > 0 ? 'up' : p.streak < 0 ? 'down' : '';

    tr.append(
      cell(String(p.rank), 'rank'),
      cell(p.name + (p.id === myId() ? ' (you)' : '')),
      ratingCell(p),
      cell(`${p.wins} / ${p.losses} / ${p.draws}`, 'wld'),
      cell(String(p.games), 'wld'),
      cell(streak, `streak ${streakClass}`),
    );
    body.append(tr);
  }
  table.append(body);
  el.lbTable.append(table);
}

function cell(text, className) {
  const td = document.createElement('td');
  if (className) td.className = className;
  td.textContent = text;
  return td;
}

function ratingCell(p) {
  const td = document.createElement('td');
  td.className = 'rating';
  td.textContent = String(p.rating);
  return td;
}

function renderRecentGames(games) {
  el.lbRecent.textContent = '';
  if (!games || !games.length) {
    el.lbRecent.append(emptyRow('No games played yet.'));
    return;
  }
  for (const g of games) {
    const row = document.createElement('div');
    row.className = 'lb-game';

    const result = g.winner === 'w' ? [g.whiteName, 'beat', g.blackName]
      : g.winner === 'b' ? [g.blackName, 'beat', g.whiteName]
        : [g.whiteName, 'drew with', g.blackName];

    const a = document.createElement('span');
    a.className = 'who ' + (g.winner ? 'win' : '');
    a.textContent = result[0];
    const verb = document.createElement('span');
    verb.className = 'loss';
    verb.textContent = ` ${result[1]} `;
    const b = document.createElement('span');
    b.className = 'who';
    b.textContent = result[2];

    const moves = Math.ceil(g.plies / 2);
    const why = document.createElement('span');
    why.className = 'why';
    why.textContent = `${g.reason} · ${moves} ${moves === 1 ? 'move' : 'moves'}`;

    row.append(a, verb, b, why);
    el.lbRecent.append(row);
  }
}

/** The small rating chip in the lobby. */
async function refreshMyRating() {
  try {
    const res = await fetch(`/api/players/${myId()}`);
    if (!res.ok) { el.myRating.hidden = true; return; }
    const { player } = await res.json();
    // Null means this browser has not finished a rated game yet.
    if (!player) { el.myRating.hidden = true; return; }
    state.me = player;
    el.myRating.hidden = false;
    el.myRating.textContent = '';
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = String(player.rating);
    const meta = document.createElement('span');
    meta.className = 'meta';
    // The win/loss record already shows how new a rating is. A "provisional"
    // badge only raises a question it does not answer.
    meta.textContent = `${player.wins}W ${player.losses}L ${player.draws}D`;
    el.myRating.append(num, meta);
  } catch {
    el.myRating.hidden = true;
  }
}

/* ── Rules panel ─────────────────────────────────────────────────── */

function buildRules() {
  const template = $('#rules-template');
  for (const host of document.querySelectorAll('.rules')) {
    host.replaceChildren(template.content.cloneNode(true));
    const diagram = host.querySelector('#guardian-diagram');
    if (diagram) buildGuardianDiagram(diagram);
    // ids must stay unique across the two copies of the rules
    diagram?.removeAttribute('id');
  }
}

/**
 * A 5x5 slice of board: the Guardian in the middle, dots on the four squares
 * it can reach, crosses on the four it cannot.
 */
function buildGuardianDiagram(host) {
  host.textContent = '';
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
      const cell = document.createElement('div');
      cell.className = (r + c) % 2 === 0 ? 'l' : 'd';
      const dr = r - 2;
      const dc = c - 2;
      if (dr === 0 && dc === 0) {
        cell.innerHTML = pieceSvg('g', 'w');
      } else if ((Math.abs(dr) === 2 && dc === 0) || (Math.abs(dc) === 2 && dr === 0)) {
        cell.classList.add('t');
      } else if ((Math.abs(dr) === 1 && dc === 0) || (Math.abs(dc) === 1 && dr === 0)) {
        cell.classList.add('x');
      }
      host.append(cell);
    }
  }
}

/* ── Wiring ──────────────────────────────────────────────────────── */

$('#btn-create').addEventListener('click', () => { saveName(); createRoom(); });
$('#btn-local').addEventListener('click', () => { saveName(); enterLocal(); });
$('#btn-bot').addEventListener('click', () => {
  saveName();
  enterBot(document.querySelector('input[name="botlevel"]:checked')?.value);
});

$('#join-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const code = el.joinCode.value.trim().toUpperCase();
  if (code.length < 4) { toast('That code looks too short.', true); return; }
  saveName();
  enterOnline(code);
});

$('#btn-labels').addEventListener('click', () => {
  state.labels = !state.labels;
  store.labels = state.labels;
  $('#btn-labels').setAttribute('aria-pressed', String(state.labels));
  // Squares are cached by their contents, so force a clean rebuild.
  buildBoard();
  renderAll();
});

$('#btn-flip').addEventListener('click', () => {
  setFlipped(!state.flipped);
  renderAll();
});

$('#btn-copy').addEventListener('click', async () => {
  const link = el.shareLink.value;
  try {
    await navigator.clipboard.writeText(link);
    toast('Link copied.');
  } catch {
    el.shareLink.select();
    toast('Press Ctrl+C to copy.');
  }
});

$('#btn-resign').addEventListener('click', () => {
  if (!confirm('Resign this game?')) return;
  if (state.mode === 'bot') {
    state.game.resign(state.myColor);
    renderAll();
    return;
  }
  sendToServer({ type: 'resign' });
});

$('#btn-draw').addEventListener('click', () => sendToServer({ type: 'offerDraw' }));
$('#btn-leave').addEventListener('click', leaveGame);

$('#chat-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const text = el.chatInput.value.trim();
  if (!text) return;
  if (state.mode !== 'online') { toast('Chat is for online games.'); return; }
  if (sendToServer({ type: 'chat', text })) el.chatInput.value = '';
});

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('is-active', t === tab);
    for (const p of document.querySelectorAll('.tabpanel')) {
      p.classList.toggle('is-active', p.dataset.panel === tab.dataset.tab);
    }
  });
}

$('#btn-signin').addEventListener('click', () => openAuth('signin'));
$('#btn-signup').addEventListener('click', () => openAuth('signup'));
$('#btn-signout').addEventListener('click', signOut);
$('#auth-close').addEventListener('click', () => { el.authModal.hidden = true; });
el.authModal.addEventListener('click', (ev) => {
  if (ev.target === el.authModal) el.authModal.hidden = true;
});
el.authForm.addEventListener('submit', submitAuth);
for (const tab of document.querySelectorAll('.authtab')) {
  tab.addEventListener('click', () => openAuth(tab.dataset.authtab));
}

$('#btn-leaderboard').addEventListener('click', openLeaderboard);
$('#board-close').addEventListener('click', () => { el.boardModal.hidden = true; });
el.boardModal.addEventListener('click', (ev) => {
  if (ev.target === el.boardModal) el.boardModal.hidden = true;
});
for (const tab of document.querySelectorAll('.lbtab')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.lbtab')) t.classList.toggle('is-active', t === tab);
    for (const pane of document.querySelectorAll('.lbpanel')) {
      pane.classList.toggle('is-active', pane.dataset.lbpanel === tab.dataset.lbtab);
    }
  });
}

$('#btn-rules-lobby').addEventListener('click', () => { el.rulesModal.hidden = false; });
$('#rules-close').addEventListener('click', () => { el.rulesModal.hidden = true; });
el.rulesModal.addEventListener('click', (ev) => {
  if (ev.target === el.rulesModal) el.rulesModal.hidden = true;
});

document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  if (!el.promo.hidden) { $('#promo-cancel').click(); return; }
  if (!el.authModal.hidden) { el.authModal.hidden = true; return; }
  if (!el.boardModal.hidden) { el.boardModal.hidden = true; return; }
  if (!el.rulesModal.hidden) { el.rulesModal.hidden = true; return; }
  if (state.selected) { clearSelection(); renderAll(); }
});

el.joinCode.addEventListener('input', () => {
  el.joinCode.value = el.joinCode.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

window.addEventListener('hashchange', () => {
  const code = location.hash.replace('#', '').toUpperCase();
  if (code && code !== state.code) enterOnline(code);
});

/* ── Boot ────────────────────────────────────────────────────────── */

buildRules();
el.nameInput.value = store.name;
state.labels = store.labels;
$('#btn-labels').setAttribute('aria-pressed', String(state.labels));

// Signing in refreshes the rating chip itself, so only ask separately when
// this browser turns out to be a guest.
restoreSession().then(() => { if (!state.account) refreshMyRating(); });

const initialCode = location.hash.replace('#', '').toUpperCase();
if (initialCode) {
  enterOnline(initialCode);
} else {
  showScreen('lobby');
}
