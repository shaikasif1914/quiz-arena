'use strict';
/**
 * QUIZ ARENA server: HTTP API + Server-Sent Events + static files. Zero npm dependencies.
 *
 * The server is the single source of truth. It owns the clock (question timer),
 * the questions (and their correct answers), and all scoring. Clients only
 * render the state they are sent and submit their choice.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { openDb, tx } = require('./db');
const { CATEGORIES, CATEGORY_IDS, generateQuestions } = require('./questions');

const cfg = {
  PORT: Number(process.env.PORT) || 3000,
  DB_PATH: process.env.DATABASE_PATH || path.join(__dirname, 'data', 'quiz.db'),
  QUESTION_MS: (Number(process.env.QUESTION_SECONDS) || 10) * 1000,
  REVEAL_MS: (Number(process.env.REVEAL_SECONDS) || 6) * 1000,
  INTRO_MS: (Number(process.env.INTRO_SECONDS) || 4) * 1000,
  MAX_PLAYERS: 10,
  MIN_PLAYERS: Number(process.env.MIN_PLAYERS) || 2,
  ROOM_TTL_MS: (Number(process.env.ROOM_TTL_HOURS) || 24) * 3600 * 1000,
  DISCONNECT_GRACE_MS: Number(process.env.DISCONNECT_GRACE_MS) || 5000,
  LOBBY_IDLE_MS: Number(process.env.LOBBY_IDLE_MS) || 30000,
  TRUST_PROXY: process.env.TRUST_PROXY === '1',
};
const PUBLIC_DIR = path.join(__dirname, 'public');
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const QUESTION_COUNTS = [10, 12, 15];
const AVATAR_COUNT = 8;

const db = openDb(cfg.DB_PATH);

/* ------------------------------------------------------------------ secrets */

function loadSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(path.dirname(cfg.DB_PATH), '.session-secret');
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { /* create below */ }
  const secret = crypto.randomBytes(32).toString('hex');
  try { fs.writeFileSync(file, secret, { mode: 0o600 }); } catch { /* ephemeral secret is acceptable */ }
  return secret;
}
const SECRET = loadSecret();
// A player's token is derived from their id and private client id, so it survives restarts without being stored.
const makeToken = (pid, clientId) => crypto.createHmac('sha256', SECRET).update(`${pid}:${clientId}`).digest('hex');
function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/* --------------------------------------------------------------- statements */

const S = {
  getRoom: db.prepare('SELECT * FROM rooms WHERE id = ?'),
  insRoom: db.prepare('INSERT INTO rooms (id, host_player_id, category, num_questions, created_at, updated_at) VALUES (?, NULL, ?, ?, ?, ?)'),
  setHost: db.prepare('UPDATE rooms SET host_player_id = ?, updated_at = ? WHERE id = ?'),
  setSettings: db.prepare('UPDATE rooms SET category = ?, num_questions = ?, updated_at = ? WHERE id = ?'),
  setPhase: db.prepare('UPDATE rooms SET phase = ?, q_index = ?, phase_started_at = ?, phase_ends_at = ?, updated_at = ? WHERE id = ?'),
  startGameRoom: db.prepare('UPDATE rooms SET game_id = ?, game_no = ?, phase = ?, q_index = -1, phase_started_at = ?, phase_ends_at = ?, used_questions = ?, updated_at = ? WHERE id = ?'),
  toLobby: db.prepare("UPDATE rooms SET phase = 'lobby', game_id = NULL, q_index = -1, phase_started_at = NULL, phase_ends_at = NULL, updated_at = ? WHERE id = ?"),
  allRooms: db.prepare('SELECT * FROM rooms'),
  deleteOldRooms: db.prepare('DELETE FROM rooms WHERE updated_at < ?'),

  getPlayer: db.prepare('SELECT * FROM players WHERE id = ?'),
  byClient: db.prepare('SELECT * FROM players WHERE room_id = ? AND client_id = ?'),
  activePlayers: db.prepare("SELECT * FROM players WHERE room_id = ? AND state = 'active' ORDER BY joined_at, id"),
  insPlayer: db.prepare('INSERT INTO players (id, room_id, client_id, nickname, avatar, joined_at) VALUES (?, ?, ?, ?, ?, ?)'),
  setPlayerState: db.prepare('UPDATE players SET state = ? WHERE id = ?'),
  usedAvatars: db.prepare("SELECT avatar FROM players WHERE room_id = ? AND state = 'active'"),

  insGame: db.prepare('INSERT INTO games (room_id, game_no, category, num_questions, source, started_at) VALUES (?, ?, ?, ?, ?, ?)'),
  getGame: db.prepare('SELECT * FROM games WHERE id = ?'),
  finishGame: db.prepare('UPDATE games SET finished_at = ? WHERE id = ?'),
  insQuestion: db.prepare('INSERT INTO questions (game_id, idx, text, options, correct_idx, difficulty, category) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  getQuestions: db.prepare('SELECT * FROM questions WHERE game_id = ? ORDER BY idx'),
  insGP: db.prepare('INSERT INTO game_players (game_id, player_id) VALUES (?, ?)'),
  participants: db.prepare('SELECT p.* FROM game_players gp JOIN players p ON p.id = gp.player_id WHERE gp.game_id = ? ORDER BY p.joined_at, p.id'),
  isParticipant: db.prepare('SELECT 1 AS ok FROM game_players WHERE game_id = ? AND player_id = ?'),

  insAnswer: db.prepare('INSERT INTO answers (game_id, q_idx, player_id, choice, is_correct, points, time_ms, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
  answersFor: db.prepare('SELECT * FROM answers WHERE game_id = ? AND q_idx = ?'),
  standings: db.prepare(`
    SELECT p.id, p.nickname, p.avatar,
           COALESCE(SUM(a.points), 0)     AS points,
           COALESCE(SUM(a.is_correct), 0) AS correct,
           COUNT(a.player_id)             AS answered,
           AVG(a.time_ms)                 AS avg_ms
    FROM game_players gp
    JOIN players p ON p.id = gp.player_id
    LEFT JOIN answers a ON a.game_id = gp.game_id AND a.player_id = gp.player_id AND a.q_idx <= ?
    WHERE gp.game_id = ?
    GROUP BY p.id`),
};

/* ------------------------------------------------------------------ helpers */

const now = () => Date.now();
const httpErr = (status, message) => Object.assign(new Error(message), { status });
const getRoom = (code) => S.getRoom.get(code);
const categoryLabel = (id) => (CATEGORIES.find((c) => c.id === id) || { label: id }).label;
const cleanNick = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();

function randomCode() {
  let c = '';
  for (let i = 0; i < 6; i++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return c;
}

/** Correct answer: 100. Speed bonus: <=5s +50, <=10s +30, <=15s +15, <=20s +5. */
function scoreAnswer(isCorrect, elapsedMs) {
  if (!isCorrect) return { base: 0, bonus: 0, points: 0 };
  const s = elapsedMs / 1000;
  const bonus = s <= 5 ? 50 : s <= 10 ? 30 : s <= 15 ? 15 : 5;
  return { base: 100, bonus, points: 100 + bonus };
}

/* -------------------------------------------------------------- runtime state */

const runtimes = new Map(); // code -> live (in-memory only) data
function R(code) {
  let r = runtimes.get(code);
  if (!r) {
    r = { clients: new Map(), connected: new Set(), everConnected: new Set(), discTimers: new Map(), idleTimers: new Map(), timer: null, qs: null, bcast: false };
    runtimes.set(code, r);
  }
  return r;
}

function getQuestions(room) {
  const r = R(room.id);
  if (!r.qs || r.qs.gameId !== room.game_id) {
    const rows = S.getQuestions.all(room.game_id);
    r.qs = { gameId: room.game_id, list: rows.map((q) => ({ text: q.text, options: JSON.parse(q.options), correctIdx: q.correct_idx, difficulty: q.difficulty, category: q.category })) };
  }
  return r.qs.list;
}

function standingsFor(gameId, upto) {
  const rows = S.standings.all(upto, gameId);
  const played = upto + 1;
  const list = rows.map((x) => ({
    id: x.id, nickname: x.nickname, avatar: x.avatar,
    points: x.points, correct: x.correct,
    wrong: x.answered - x.correct,
    missed: Math.max(0, played - x.answered),
    answered: x.answered,
    accuracy: played > 0 ? Math.round((x.correct / played) * 100) : 0,
    avgMs: x.avg_ms == null ? null : Math.round(x.avg_ms),
  }));
  list.sort((a, b) => b.points - a.points || b.correct - a.correct || (a.avgMs ?? 1e9) - (b.avgMs ?? 1e9) || a.nickname.localeCompare(b.nickname));
  list.forEach((x, i) => { x.rank = i + 1; });
  return list;
}

/* --------------------------------------------------------------------- views */

/** Builds exactly what ONE player may see. The correct answer only appears in the reveal/finished phases. */
function viewFor(code, pid) {
  const room = getRoom(code);
  if (!room) return null;
  const r = R(code);
  const lobbyish = room.phase === 'lobby' || room.phase === 'starting';
  const me = S.getPlayer.get(pid);
  const view = {
    serverNow: now(),
    room: {
      code, category: room.category, categoryLabel: categoryLabel(room.category),
      numQuestions: room.num_questions, phase: room.phase, hostId: room.host_player_id,
      gameNo: room.game_no, maxPlayers: cfg.MAX_PLAYERS, minPlayers: cfg.MIN_PLAYERS, questionMs: cfg.QUESTION_MS,
      endsAt: room.phase_ends_at,
    },
    me: { id: pid, nickname: me ? me.nickname : '', avatar: me ? me.avatar : 0, isHost: room.host_player_id === pid },
    players: [],
  };

  const decorate = (p) => ({ ...p, connected: r.connected.has(p.id), isHost: p.id === room.host_player_id });

  if (lobbyish || !room.game_id) {
    view.players = S.activePlayers.all(code).map((p) => decorate({ id: p.id, nickname: p.nickname, avatar: p.avatar }));
    return view;
  }

  const total = room.num_questions;
  const qs = getQuestions(room);
  const participantsCount = S.participants.all(room.game_id).length;

  if (room.phase === 'intro') {
    view.players = standingsFor(room.game_id, -1).map(decorate);
  } else if (room.phase === 'question') {
    const cur = qs[room.q_index];
    const answers = S.answersFor.all(room.game_id, room.q_index);
    const answeredIds = new Set(answers.map((a) => a.player_id));
    const mine = answers.find((a) => a.player_id === pid);
    // Scores shown while a question is open only include FINISHED questions, so nobody can infer who got it right.
    view.players = standingsFor(room.game_id, room.q_index - 1).map((p) => decorate({ ...p, answered: answeredIds.has(p.id) }));
    view.question = {
      index: room.q_index, total, text: cur.text, options: cur.options, difficulty: cur.difficulty, category: cur.category,
      startedAt: room.phase_started_at, endsAt: room.phase_ends_at, durationMs: cfg.QUESTION_MS,
      myChoice: mine ? mine.choice : null, answeredCount: answeredIds.size, participants: participantsCount,
    };
  } else if (room.phase === 'reveal') {
    const cur = qs[room.q_index];
    const answers = S.answersFor.all(room.game_id, room.q_index);
    const byPlayer = new Map(answers.map((a) => [a.player_id, a]));
    const board = standingsFor(room.game_id, room.q_index);
    const counts = [0, 0, 0, 0];
    answers.forEach((a) => { counts[a.choice]++; });
    const picks = board.map((p) => {
      const a = byPlayer.get(p.id);
      return { playerId: p.id, choice: a ? a.choice : null, correct: a ? !!a.is_correct : false, points: a ? a.points : 0, timeMs: a ? a.time_ms : null };
    });
    const mine = byPlayer.get(pid);
    view.players = board.map(decorate);
    view.reveal = {
      index: room.q_index, total, text: cur.text, options: cur.options, difficulty: cur.difficulty, category: cur.category,
      correctIdx: cur.correctIdx, endsAt: room.phase_ends_at, startedAt: room.phase_started_at, isLast: room.q_index + 1 >= total,
      counts, picks, answeredCount: answers.length, correctCount: answers.filter((a) => a.is_correct).length, participants: participantsCount,
      me: mine
        ? { choice: mine.choice, correct: !!mine.is_correct, points: mine.points, base: mine.is_correct ? 100 : 0, bonus: mine.is_correct ? mine.points - 100 : 0, timeMs: mine.time_ms }
        : { choice: null, correct: false, points: 0, base: 0, bonus: 0, timeMs: null },
    };
  } else if (room.phase === 'finished') {
    const game = S.getGame.get(room.game_id);
    const board = standingsFor(room.game_id, total - 1);
    view.players = board.map(decorate);
    view.final = {
      standings: view.players, totalQuestions: total, gameNo: room.game_no,
      durationMs: (game.finished_at || now()) - game.started_at, category: game.category, categoryLabel: categoryLabel(game.category),
      winnerId: board.length ? board[0].id : null,
    };
  }
  return view;
}

/* ----------------------------------------------------------------- broadcast */

function sseSend(res, event, data) {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* socket closed */ }
}

/** Coalesces multiple changes in one tick into a single push to every connected player. */
function broadcast(code) {
  const r = R(code);
  if (r.bcast) return;
  r.bcast = true;
  setImmediate(() => {
    r.bcast = false;
    for (const [pid, set] of r.clients) {
      if (!set.size) continue;
      const view = viewFor(code, pid);
      if (!view) continue;
      for (const res of set) sseSend(res, 'state', view);
    }
  });
}

function toast(code, text, kind = 'info', exceptPid = null) {
  const r = R(code);
  for (const [pid, set] of r.clients) {
    if (pid === exceptPid) continue;
    for (const res of set) sseSend(res, 'toast', { text, kind });
  }
}

/* --------------------------------------------------------------- game engine */

function schedule(code, at, fn) {
  const r = R(code);
  clearTimeout(r.timer);
  r.timer = setTimeout(() => { try { fn(); } catch (e) { console.error('[timer]', e); } }, Math.max(0, at - now()));
}

function ensureHost(code) {
  const room = getRoom(code);
  if (!room) return;
  const r = R(code);
  const active = S.activePlayers.all(code);
  const host = active.find((p) => p.id === room.host_player_id);
  const hostGone = !host || (!r.connected.has(host.id) && (room.phase === 'lobby' || room.phase === 'finished'));
  if (!hostGone) return;
  const next = active.find((p) => p.id !== room.host_player_id && r.connected.has(p.id));
  if (next || !host) {
    const chosen = next || active[0];
    if (chosen && chosen.id !== room.host_player_id) {
      S.setHost.run(chosen.id, now(), code);
      toast(code, `${chosen.nickname} is now the host`, 'info');
      broadcast(code);
    }
  }
}

async function startGame(code) {
  const room = getRoom(code);
  S.setPhase.run('starting', -1, now(), null, now(), code);
  broadcast(code);
  try {
    const avoid = JSON.parse(room.used_questions || '[]');
    const { questions, source } = await generateQuestions({ category: room.category, n: room.num_questions, avoid });
    const t = now();
    const players = S.activePlayers.all(code);
    tx(db, () => {
      const gameNo = room.game_no + 1;
      const info = S.insGame.run(code, gameNo, room.category, room.num_questions, source, t);
      const gid = Number(info.lastInsertRowid);
      questions.forEach((q, i) => S.insQuestion.run(gid, i, q.text, JSON.stringify(q.options), q.correctIdx, q.difficulty, q.category));
      players.forEach((p) => S.insGP.run(gid, p.id));
      const used = avoid.concat(questions.map((q) => q.text)).slice(-150);
      S.startGameRoom.run(gid, gameNo, 'intro', t, t + cfg.INTRO_MS, JSON.stringify(used), t, code);
    });
    console.log(`[game] ${code} started: ${questions.length} questions via ${source}, ${players.length} players`);
    broadcast(code);
    schedule(code, t + cfg.INTRO_MS, () => beginQuestion(code, 0));
  } catch (e) {
    console.error('[game] failed to start', e);
    S.setPhase.run('lobby', -1, null, null, now(), code);
    toast(code, 'Could not start the game. Please try again.', 'error');
    broadcast(code);
  }
}

function beginQuestion(code, idx) {
  const room = getRoom(code);
  if (!room || !room.game_id) return;
  const t = now();
  S.setPhase.run('question', idx, t, t + cfg.QUESTION_MS, t, code);
  broadcast(code);
  schedule(code, t + cfg.QUESTION_MS, () => endQuestion(code, idx));
}

function endQuestion(code, idx) {
  const room = getRoom(code);
  if (!room || room.phase !== 'question' || room.q_index !== idx) return;
  const t = now();
  const isLast = idx + 1 >= room.num_questions;
  const dur = cfg.REVEAL_MS + (isLast ? 1500 : 0);
  S.setPhase.run('reveal', idx, t, t + dur, t, code);
  broadcast(code);
  schedule(code, t + dur, () => afterReveal(code, idx));
}

function afterReveal(code, idx) {
  const room = getRoom(code);
  if (!room || room.phase !== 'reveal' || room.q_index !== idx) return;
  if (idx + 1 < room.num_questions) return beginQuestion(code, idx + 1);
  const t = now();
  S.finishGame.run(t, room.game_id);
  S.setPhase.run('finished', idx, t, null, t, code);
  clearTimeout(R(code).timer);
  ensureHost(code);
  broadcast(code);
}

/** Ends the question early once every player who is currently connected has answered. */
function maybeEndEarly(code) {
  const room = getRoom(code);
  if (!room || room.phase !== 'question') return;
  const r = R(code);
  const answered = new Set(S.answersFor.all(room.game_id, room.q_index).map((a) => a.player_id));
  const present = S.participants.all(room.game_id).filter((p) => r.connected.has(p.id));
  if (present.length > 0 && present.every((p) => answered.has(p.id))) endQuestion(code, room.q_index);
}

function resumeAfterRestart() {
  for (const room of S.allRooms.all()) {
    const code = room.id;
    if (room.phase === 'starting') { S.setPhase.run('lobby', -1, null, null, now(), code); continue; }
    if (room.phase === 'intro') schedule(code, room.phase_ends_at, () => beginQuestion(code, 0));
    else if (room.phase === 'question') schedule(code, room.phase_ends_at, () => endQuestion(code, room.q_index));
    else if (room.phase === 'reveal') schedule(code, room.phase_ends_at, () => afterReveal(code, room.q_index));
  }
}

/* ---------------------------------------------------------------- validation */

function auth(code, body) {
  const pid = String(body.pid || '');
  const token = String(body.token || '');
  const p = S.getPlayer.get(pid);
  if (!p || p.room_id !== code || !safeEqual(makeToken(p.id, p.client_id), token)) throw httpErr(401, 'Your session is not valid. Please rejoin the room.');
  if (p.state === 'kicked') throw httpErr(403, 'You were removed from this room by the host.');
  return p;
}
function authActive(code, body) {
  const p = auth(code, body);
  if (p.state !== 'active') throw httpErr(401, 'You are no longer in this room. Please rejoin.');
  return p;
}
function requireHost(code, p) {
  const room = getRoom(code);
  if (!room) throw httpErr(404, 'Room not found.');
  if (room.host_player_id !== p.id) throw httpErr(403, 'Only the host can do that.');
  return room;
}
function parseNick(v) {
  const n = cleanNick(v);
  if (n.length < 1) throw httpErr(400, 'Please enter a nickname.');
  if (n.length > 16) throw httpErr(400, 'Nicknames can be at most 16 characters.');
  return n;
}
function parseClientId(v) {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(v)) throw httpErr(400, 'Invalid client id.');
  return v;
}
function parseSettings(body) {
  const category = String(body.category || '');
  const n = Number(body.numQuestions);
  if (!CATEGORY_IDS.includes(category)) throw httpErr(400, 'Choose a valid category.');
  if (!QUESTION_COUNTS.includes(n)) throw httpErr(400, 'Choose 10, 12 or 15 questions.');
  return { category, n };
}
function session(p) { return { pid: p.id, token: makeToken(p.id, p.client_id) }; }

/* ------------------------------------------------------------------- rate limit */

const hits = new Map();
function rateLimit(ip, bucket, max, windowMs) {
  const key = `${bucket}:${ip}`;
  const t = now();
  const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
  arr.push(t);
  hits.set(key, arr);
  if (arr.length > max) throw httpErr(429, 'Too many requests. Please slow down for a moment.');
}
setInterval(() => { const t = now(); for (const [k, v] of hits) if (!v.some((x) => t - x < 60000)) hits.delete(k); }, 60000).unref();

/* --------------------------------------------------------------------- routes */

const routes = {
  async createRoom(req, body, ip) {
    rateLimit(ip, 'create', 15, 60000);
    const nickname = parseNick(body.nickname);
    const clientId = parseClientId(body.clientId);
    const { category, n } = parseSettings(body);
    let code;
    for (let i = 0; i < 20; i++) { const c = randomCode(); if (!getRoom(c)) { code = c; break; } }
    if (!code) throw httpErr(503, 'Could not allocate a room code. Try again.');
    const t = now();
    const pid = crypto.randomBytes(8).toString('hex');
    tx(db, () => {
      S.insRoom.run(code, category, n, t, t);
      S.insPlayer.run(pid, code, clientId, nickname, 0, t);
      S.setHost.run(pid, t, code);
    });
    return { status: 201, body: { code, ...session(S.getPlayer.get(pid)) } };
  },

  async roomInfo(code, ip) {
    rateLimit(ip, 'lookup', 40, 60000);
    const room = getRoom(code);
    if (!room) throw httpErr(404, 'Room not found. Check the code and try again.');
    const active = S.activePlayers.all(code);
    const host = active.find((p) => p.id === room.host_player_id);
    return {
      status: 200,
      body: {
        code, phase: room.phase, players: active.length, maxPlayers: cfg.MAX_PLAYERS, hostName: host ? host.nickname : null,
        categoryLabel: categoryLabel(room.category), numQuestions: room.num_questions,
        joinable: room.phase === 'lobby' && active.length < cfg.MAX_PLAYERS,
      },
    };
  },

  async join(code, body, ip) {
    rateLimit(ip, 'join', 30, 60000);
    const room = getRoom(code);
    if (!room) throw httpErr(404, 'Room not found. Check the code and try again.');
    const clientId = parseClientId(body.clientId);
    const existing = S.byClient.get(code, clientId);
    const active = S.activePlayers.all(code);

    if (existing) {
      if (existing.state === 'kicked') throw httpErr(403, 'You were removed from this room by the host.');
      if (existing.state === 'active') return { status: 200, body: { code, rejoined: true, ...session(existing) } };
      // state === 'left': let them come back if the room allows it
      const wasPlayer = room.game_id && S.isParticipant.get(room.game_id, existing.id);
      if (room.phase !== 'lobby' && !wasPlayer) throw httpErr(409, 'This game has already started. Ask the host to start a new round.');
      if (active.length >= cfg.MAX_PLAYERS) throw httpErr(409, `This room is full (${cfg.MAX_PLAYERS}/${cfg.MAX_PLAYERS}).`);
      S.setPlayerState.run('active', existing.id);
      toast(code, `${existing.nickname} rejoined`, 'join');
      broadcast(code);
      return { status: 200, body: { code, rejoined: true, ...session(existing) } };
    }

    const nickname = parseNick(body.nickname);
    if (room.phase !== 'lobby') throw httpErr(409, 'This game has already started. Ask the host to start a new round.');
    if (active.length >= cfg.MAX_PLAYERS) throw httpErr(409, `This room is full (${cfg.MAX_PLAYERS}/${cfg.MAX_PLAYERS}).`);
    if (active.some((p) => p.nickname.toLowerCase() === nickname.toLowerCase())) throw httpErr(409, 'That nickname is already taken in this room. Pick another one.');
    const used = new Set(S.usedAvatars.all(code).map((x) => x.avatar));
    let avatar = 0;
    while (used.has(avatar) && avatar < AVATAR_COUNT - 1) avatar++;
    const pid = crypto.randomBytes(8).toString('hex');
    S.insPlayer.run(pid, code, clientId, nickname, avatar, now());
    S.setHost.run(room.host_player_id || pid, now(), code);
    toast(code, `${nickname} joined the room`, 'join');
    broadcast(code);
    return { status: 201, body: { code, rejoined: false, ...session(S.getPlayer.get(pid)) } };
  },

  async resume(code, body) {
    const p = auth(code, body);
    if (p.state !== 'active') throw httpErr(401, 'You are no longer in this room.');
    return { status: 200, body: { ok: true } };
  },

  async start(code, body) {
    const p = authActive(code, body);
    const room = requireHost(code, p);
    if (room.phase !== 'lobby') throw httpErr(409, 'The game has already started.');
    const active = S.activePlayers.all(code);
    if (active.length < cfg.MIN_PLAYERS) throw httpErr(409, `You need at least ${cfg.MIN_PLAYERS} players to start.`);
    startGame(code); // async on purpose: players see the "preparing questions" screen meanwhile
    return { status: 202, body: { ok: true } };
  },

  async answer(code, body) {
    const p = authActive(code, body);
    const room = getRoom(code);
    if (!room) throw httpErr(404, 'Room not found.');
    if (room.phase !== 'question') throw httpErr(409, 'No question is open right now.');
    const qIndex = Number(body.qIndex);
    const choice = Number(body.choice);
    if (!Number.isInteger(qIndex) || qIndex !== room.q_index) throw httpErr(409, 'That question is already over.');
    if (!Number.isInteger(choice) || choice < 0 || choice > 3) throw httpErr(400, 'Invalid answer.');
    if (!S.isParticipant.get(room.game_id, p.id)) throw httpErr(403, 'You are not part of this game.');
    const t = now();
    if (t >= room.phase_ends_at) throw httpErr(409, "Time's up!");
    const elapsed = Math.max(0, t - room.phase_started_at);
    const cur = getQuestions(room)[qIndex];
    const isCorrect = choice === cur.correctIdx;
    const { points } = scoreAnswer(isCorrect, elapsed);
    try {
      S.insAnswer.run(room.game_id, qIndex, p.id, choice, isCorrect ? 1 : 0, points, elapsed, t);
    } catch (e) {
      if (/UNIQUE|PRIMARY/i.test(String(e.message))) throw httpErr(409, 'You already answered this question.');
      throw e;
    }
    broadcast(code);
    maybeEndEarly(code);
    return { status: 200, body: { ok: true, locked: true } }; // deliberately does NOT say whether it was correct
  },

  async kick(code, body) {
    const p = authActive(code, body);
    const room = requireHost(code, p);
    if (room.phase !== 'lobby') throw httpErr(409, 'Players can only be removed from the lobby.');
    const target = S.getPlayer.get(String(body.targetId || ''));
    if (!target || target.room_id !== code || target.state !== 'active') throw httpErr(404, 'Player not found.');
    if (target.id === p.id) throw httpErr(400, 'You cannot remove yourself.');
    S.setPlayerState.run('kicked', target.id);
    const r = R(code);
    for (const res of r.clients.get(target.id) || []) { sseSend(res, 'kicked', { reason: 'You were removed from the room by the host.' }); try { res.end(); } catch { /* ignore */ } }
    r.clients.delete(target.id);
    r.connected.delete(target.id);
    toast(code, `${target.nickname} was removed`, 'leave');
    broadcast(code);
    return { status: 200, body: { ok: true } };
  },

  async settings(code, body) {
    const p = authActive(code, body);
    const room = requireHost(code, p);
    if (room.phase !== 'lobby') throw httpErr(409, 'Settings can only be changed in the lobby.');
    const { category, n } = parseSettings(body);
    S.setSettings.run(category, n, now(), code);
    broadcast(code);
    return { status: 200, body: { ok: true } };
  },

  async rematch(code, body) {
    const p = authActive(code, body);
    const room = requireHost(code, p);
    if (room.phase !== 'finished') throw httpErr(409, 'The game is not finished yet.');
    S.toLobby.run(now(), code);
    toast(code, 'The host is setting up a new round', 'info');
    broadcast(code);
    return { status: 200, body: { ok: true } };
  },

  async leave(code, body) {
    const p = authActive(code, body);
    S.setPlayerState.run('left', p.id);
    const r = R(code);
    for (const res of r.clients.get(p.id) || []) { try { res.end(); } catch { /* ignore */ } }
    r.clients.delete(p.id);
    r.connected.delete(p.id);
    toast(code, `${p.nickname} left the room`, 'leave');
    ensureHost(code);
    broadcast(code);
    maybeEndEarly(code);
    return { status: 200, body: { ok: true } };
  },
};

/* ------------------------------------------------------------------------ SSE */

function handleEvents(req, res, code, params) {
  let p;
  try { p = authActive(code, { pid: params.get('pid'), token: params.get('token') }); } catch (e) { return sendJson(res, e.status || 401, { error: e.message }); }
  if (!getRoom(code)) return sendJson(res, 404, { error: 'Room not found.' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 1500\n\n');

  const r = R(code);
  clearTimeout(r.discTimers.get(p.id));
  clearTimeout(r.idleTimers.get(p.id));
  let set = r.clients.get(p.id);
  if (!set) { set = new Set(); r.clients.set(p.id, set); }
  set.add(res);
  const wasOffline = !r.connected.has(p.id);
  r.connected.add(p.id);
  const reconnected = r.everConnected.has(p.id) && wasOffline;
  r.everConnected.add(p.id);

  sseSend(res, 'state', viewFor(code, p.id));
  if (wasOffline) {
    if (reconnected) toast(code, `${p.nickname} reconnected`, 'join', p.id);
    broadcast(code);
  }

  req.on('close', () => {
    set.delete(res);
    if (set.size) return;
    if (r.clients.get(p.id) === set) r.clients.delete(p.id);
    // Give refreshes / flaky networks a short grace period before showing the player as offline.
    r.discTimers.set(p.id, setTimeout(() => {
      if (r.clients.has(p.id)) return;
      r.connected.delete(p.id);
      const room = getRoom(code);
      if (!room) return;
      const fresh = S.getPlayer.get(p.id);
      if (!fresh || fresh.state !== 'active') return;
      toast(code, `${fresh.nickname} disconnected`, 'leave');
      ensureHost(code);
      broadcast(code);
      maybeEndEarly(code);
      // In the lobby, free the slot if they do not come back.
      if (room.phase === 'lobby') {
        r.idleTimers.set(p.id, setTimeout(() => {
          const rm = getRoom(code); const pl = S.getPlayer.get(p.id);
          if (!rm || !pl || rm.phase !== 'lobby' || pl.state !== 'active' || r.connected.has(p.id)) return;
          S.setPlayerState.run('left', p.id);
          toast(code, `${pl.nickname} left the room`, 'leave');
          ensureHost(code);
          broadcast(code);
        }, cfg.LOBBY_IDLE_MS));
      }
    }, cfg.DISCONNECT_GRACE_MS));
  });
}

setInterval(() => {
  for (const r of runtimes.values()) for (const set of r.clients.values()) for (const res of set) { try { res.write(': hb\n\n'); } catch { /* ignore */ } }
}, 15000).unref();

/* ------------------------------------------------------------------ HTTP layer */

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

function sendJson(res, status, obj) {
  if (res.headersSent) return;
  const body = JSON.stringify(obj);
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(httpErr(413, 'Request too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(v && typeof v === 'object' ? v : {}); } catch { reject(httpErr(400, 'Invalid JSON.')); }
    });
    req.on('error', reject);
  });
}

function clientIp(req) {
  if (cfg.TRUST_PROXY) { const f = req.headers['x-forwarded-for']; if (f) return String(f).split(',')[0].trim(); }
  return req.socket.remoteAddress || 'unknown';
}

function serveStatic(req, res, pathname) {
  let rel = pathname;
  if (rel === '/' || rel === '/create' || rel === '/join' || /^\/r\/[A-Za-z0-9]{6}\/?$/.test(rel)) rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403, SECURITY_HEADERS); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (!p.startsWith('/api/')) {
      if (p === '/healthz') return sendJson(res, 200, { ok: true });
      if (req.method !== 'GET' && req.method !== 'HEAD') throw httpErr(405, 'Method not allowed.');
      return serveStatic(req, res, p);
    }
    const ip = clientIp(req);
    let m;
    if (p === '/api/time' && req.method === 'GET') return sendJson(res, 200, { now: now() });
    if (p === '/api/categories' && req.method === 'GET') return sendJson(res, 200, { categories: CATEGORIES, questionCounts: QUESTION_COUNTS });
    if (p === '/api/rooms' && req.method === 'POST') { const r = await routes.createRoom(req, await readBody(req), ip); return sendJson(res, r.status, r.body); }
    if ((m = p.match(/^\/api\/rooms\/([A-Za-z0-9]{6})(?:\/(\w+))?$/))) {
      const code = m[1].toUpperCase();
      const action = m[2];
      if (!action && req.method === 'GET') { const r = await routes.roomInfo(code, ip); return sendJson(res, r.status, r.body); }
      if (action === 'events' && req.method === 'GET') return handleEvents(req, res, code, url.searchParams);
      if (req.method === 'POST' && routes[action] && !['createRoom', 'roomInfo'].includes(action)) {
        const body = await readBody(req);
        const r = await (action === 'join' ? routes.join(code, body, ip) : routes[action](code, body));
        return sendJson(res, r.status, r.body);
      }
    }
    throw httpErr(404, 'Not found.');
  } catch (e) {
    if (!e.status) console.error('[error]', e);
    sendJson(res, e.status || 500, { error: e.status ? e.message : 'Something went wrong on the server.' });
  }
});

/* ------------------------------------------------------------------- cleanup */

function cleanup() {
  const cutoff = now() - cfg.ROOM_TTL_MS;
  const removed = S.deleteOldRooms.run(cutoff).changes;
  for (const [code, r] of runtimes) {
    if (!getRoom(code)) { clearTimeout(r.timer); runtimes.delete(code); }
  }
  if (removed) console.log(`[cleanup] removed ${removed} idle room(s)`);
}
setInterval(cleanup, 30 * 60 * 1000).unref();

if (require.main === module) {
  resumeAfterRestart();
  cleanup();
  server.listen(cfg.PORT, () => console.log(`QUIZ ARENA listening on http://localhost:${cfg.PORT}  (db: ${cfg.DB_PATH})`));
  const shutdown = () => { server.close(); setTimeout(() => process.exit(0), 200); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { server, cfg, scoreAnswer };
