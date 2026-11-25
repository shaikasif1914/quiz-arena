'use strict';
/**
 * End-to-end simulation with 4 (+extra) simulated players talking to a real server
 * over real HTTP + SSE. Run:  node test/simulate.js
 */
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BANK, plan } = require('../questions');

const PORT = 4100 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-arena-test-'));
const ENV = { ...process.env, PORT: String(PORT), DATABASE_PATH: path.join(TMP, 'test.db'), INTRO_SECONDS: '2', REVEAL_SECONDS: '1', QUESTION_SECONDS: '20', DISCONNECT_GRACE_MS: '1500', NODE_NO_WARNINGS: '1' };
delete ENV.ANTHROPIC_API_KEY; // bank-only for this run (the AI path is covered by test/ai.test.js)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0; const failures = [];
function check(cond, label, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${label}`); } else { failures.push(label); console.log(`  FAIL  ${label} ${detail}`); }
}
const section = (t) => console.log(`\n== ${t}`);

/* ---------------------------------------------------------------- server proc */
let proc;
function startServer() {
  proc = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write(`[srv] ${d}`));
  proc.stderr.on('data', (d) => process.stderr.write(`[srv-err] ${d}`));
  return (async () => { for (let i = 0; i < 60; i++) { try { const r = await fetch(`${BASE}/healthz`); if (r.ok) return; } catch { /* retry */ } await sleep(100); } throw new Error('server did not start'); })();
}
const stopServer = () => new Promise((res) => {
  if (!proc) return res();
  const p = proc; // capture: `proc` is reassigned when the server is restarted
  const killer = setTimeout(() => p.kill('SIGKILL'), 2000);
  p.once('exit', () => { clearTimeout(killer); res(); });
  p.kill('SIGTERM');
});

async function http(method, p, body) {
  const r = await fetch(BASE + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let json = {}; try { json = await r.json(); } catch { /* none */ }
  return { status: r.status, json };
}

/* ------------------------------------------------------------------ SSE client */
class Player {
  constructor(name) { this.name = name; this.clientId = crypto.randomUUID(); this.states = []; this.toasts = []; this.waiters = []; this.kicked = false; }
  async create(category, n) { const r = await http('POST', '/api/rooms', { nickname: this.name, clientId: this.clientId, category, numQuestions: n }); Object.assign(this, { code: r.json.code, pid: r.json.pid, token: r.json.token }); return r; }
  async join(code) { const r = await http('POST', `/api/rooms/${code}/join`, { nickname: this.name, clientId: this.clientId }); if (r.json.pid) Object.assign(this, { code, pid: r.json.pid, token: r.json.token }); return r; }
  auth(extra = {}) { return { pid: this.pid, token: this.token, ...extra }; }
  post(action, extra) { return http('POST', `/api/rooms/${this.code}/${action}`, this.auth(extra)); }
  async connect() {
    this.ac = new AbortController();
    const res = await fetch(`${BASE}/api/rooms/${this.code}/events?pid=${this.pid}&token=${this.token}`, { signal: this.ac.signal });
    if (res.status !== 200) throw new Error(`SSE ${res.status}`);
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          buf += dec.decode(value, { stream: true });
          let i; while ((i = buf.indexOf('\n\n')) !== -1) { const block = buf.slice(0, i); buf = buf.slice(i + 2); this.onBlock(block); }
        }
      } catch { /* aborted */ }
    })();
    await this.waitFor(() => true, 5000);
  }
  onBlock(block) {
    let ev = 'message'; let data = '';
    for (const line of block.split('\n')) { if (line.startsWith('event:')) ev = line.slice(6).trim(); else if (line.startsWith('data:')) data += line.slice(5).trim(); }
    if (!data) return;
    const obj = JSON.parse(data);
    if (ev === 'state') { obj._recv = Date.now(); this.states.push(obj); this.latest = obj; this.waiters = this.waiters.filter((w) => { if (w.pred(obj)) { w.resolve(obj); return false; } return true; }); }
    else if (ev === 'toast') this.toasts.push(obj);
    else if (ev === 'kicked') this.kicked = true;
  }
  waitFor(pred, timeout = 40000) {
    if (this.latest && pred(this.latest)) return Promise.resolve(this.latest);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve }; this.waiters.push(w);
      setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); reject(new Error(`${this.name}: timeout waiting for state (latest: ${this.latest ? this.latest.room.phase + ' q=' + ((this.latest.question || this.latest.reveal || {}).index) : 'none'})`)); }, timeout);
    });
  }
  close() { this.latest = null; try { this.ac.abort(); } catch { /* ignore */ } }
}

const correctIdxFor = (q) => { const row = BANK.find((b) => b.text === q.text); return q.options.indexOf(row.answer); };
const tier = (ms) => (ms <= 5000 ? 50 : ms <= 10000 ? 30 : ms <= 15000 ? 15 : 5);

/* ------------------------------------------------------------------------ main */
async function main() {
  await startServer();

  section('Room creation, joining, lobby rules');
  const alice = new Player('Alice'), bob = new Player('Bob'), cara = new Player('Cara'), dev = new Player('Dev');
  const r0 = await alice.create('mixed', 12);
  check(r0.status === 201 && /^[A-HJ-NP-Z2-9]{6}$/.test(alice.code), 'host creates a room with a unique 6-char code', JSON.stringify(r0.json));
  const code = alice.code;
  await alice.connect(); // host sits in the lobby while friends join
  const info = await http('GET', `/api/rooms/${code}`);
  check(info.status === 200 && info.json.joinable && info.json.players === 1, 'room info endpoint reports 1/5 players and joinable');
  check((await http('GET', '/api/rooms/ZZZZZZ')).status === 404, 'unknown room code returns 404');
  check((await bob.join(code)).status === 201, 'Bob joins via code');
  check((await cara.join(code)).status === 201, 'Cara joins');
  check((await dev.join(code)).status === 201, 'Dev joins');
  const dupe = new Player('alice'); // same nickname, different identity, different case
  check((await dupe.join(code)).status === 409, 'duplicate nickname (case-insensitive) is rejected');
  const bobAgain = await http('POST', `/api/rooms/${code}/join`, { nickname: 'Bob', clientId: bob.clientId });
  check(bobAgain.status === 200 && bobAgain.json.pid === bob.pid, 'same identity joining again restores the SAME player (no duplicate)');
  const eve = new Player('Eve'), frank = new Player('Frank');
  check((await eve.join(code)).status === 201, 'Eve joins as 5th player (5/5)');
  const full = await frank.join(code);
  check(full.status === 409 && /full/i.test(full.json.error), 'a 6th player is rejected: room is full', JSON.stringify(full.json));

  for (const p of [bob, cara, dev]) await p.connect();
  await alice.waitFor((s) => s.players.length === 5 && s.players.filter((x) => x.connected).length === 4);
  check(alice.latest.players.filter((x) => x.connected).length === 4, 'lobby shows live connection status (4 online, Eve offline)');
  check(alice.latest.players.find((x) => x.id === alice.pid).isHost && alice.latest.me.isHost, 'creator is Host');
  check(alice.toasts.some((t) => /Bob joined/.test(t.text)), 'host receives a "player joined" notification');

  check((await bob.post('kick', { targetId: cara.pid })).status === 403, 'non-host cannot remove players');
  check((await alice.post('kick', { targetId: eve.pid })).status === 200, 'host removes Eve');
  const eveRetry = await eve.join(code);
  check(eveRetry.status === 403, 'removed player cannot rejoin the room');
  await alice.waitFor((s) => s.players.length === 4);
  check(alice.latest.players.length === 4, 'player list now shows 4/5');
  check((await bob.post('start')).status === 403, 'only the host can start the game');
  const solo = new Player('Solo'); await solo.create('general', 10);
  check((await solo.post('start')).status === 409, 'cannot start with fewer than 2 players');
  check((await alice.post('settings', { category: 'mixed', numQuestions: 12 })).status === 200, 'host can change settings in the lobby');
  check((await alice.post('settings', { category: 'nope', numQuestions: 12 })).status === 400, 'invalid settings are rejected');

  section('Game 1 (12 mixed questions, 4 players, scripted answer speeds)');
  const t0 = Date.now();
  check((await alice.post('start')).status === 202, 'host starts the game');
  const late = new Player('Late');
  await sleep(50);
  check((await late.join(code)).status === 409, 'late players cannot join after the game starts');
  await alice.waitFor((s) => s.room.phase === 'intro');
  const N = 12;

  // Scripted behaviour. q===2 exercises every speed-bonus tier; Dev never answers q===5 (timer expiry); Bob refreshes at q===4.
  const scripts = {
    Alice: (q) => ({ delay: q === 2 ? 2000 : 1000, pick: 'correct' }),
    Bob: (q) => ({ delay: q === 2 ? 7000 : 1500, pick: q % 2 === 0 ? 'correct' : 'wrong' }),
    Cara: (q) => ({ delay: q === 2 ? 12000 : 1200, pick: 'correct' }),
    Dev: (q) => (q === 5 ? { pick: 'skip' } : { delay: q === 2 ? 17000 : 2000, pick: 'correct' }),
  };
  const expected = { Alice: 0, Bob: 0, Cara: 0, Dev: 0 };
  const expCorrect = { Alice: 0, Bob: 0, Cara: 0, Dev: 0 };
  const apiResults = { doubleSubmit: null, badToken: null, refresh: null };
  const qEnd = {}; // q -> client timestamps of questions end per player
  const players = [alice, bob, cara, dev];

  await Promise.all(players.map(async (p) => {
    for (let q = 0; q < N; q++) {
      let st = await p.waitFor((s) => s.room.phase === 'question' && s.question.index === q, 45000);
      const sc = scripts[p.name](q);
      if (p.name === 'Bob' && q === 4) {
        const endsBefore = st.question.endsAt;
        p.close(); await sleep(700); await p.connect(); // a quick refresh, shorter than the disconnect grace period
        st = await p.waitFor((s) => s.room.phase === 'question' && s.question.index === 4);
        apiResults.refresh = { sameEnds: st.question.endsAt === endsBefore, scoreKept: st.players.find((x) => x.id === p.pid).points };
      }
      if (sc.pick !== 'skip') {
        await sleep(sc.delay);
        const ci = correctIdxFor(st.question);
        const choice = sc.pick === 'correct' ? ci : [0, 1, 2, 3].find((i) => i !== ci);
        const res = await p.post('answer', { qIndex: q, choice });
        if (res.status !== 200) console.log('   answer failed', p.name, q, res.status, res.json);
        if (sc.pick === 'correct') { expected[p.name] += 100 + tier(sc.delay); expCorrect[p.name]++; }
        if (p.name === 'Alice' && q === 0) {
          apiResults.doubleSubmit = (await p.post('answer', { qIndex: 0, choice: ci })).status;
          apiResults.badToken = (await http('POST', `/api/rooms/${code}/answer`, { pid: p.pid, token: 'x'.repeat(64), qIndex: 0, choice: 0 })).status;
          apiResults.changed = (await p.post('answer', { qIndex: 0, choice: (ci + 1) % 4 })).status;
        }
        if (p.name === 'Alice' && q === 1) apiResults.wrongQ = (await p.post('answer', { qIndex: 0, choice: 0 })).status;
      }
      await p.waitFor((s) => (s.room.phase === 'reveal' && s.reveal.index === q) || s.room.phase === 'finished', 45000);
    }
  }));
  await Promise.all(players.map((p) => p.waitFor((s) => s.room.phase === 'finished')));
  const g1Seconds = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  (game 1 finished in ${g1Seconds}s)`);

  section('Verifying synchronization and fairness');
  const qViews = (p) => p.states.filter((s) => s.room.phase === 'question');
  let sameQs = true, sameEnds = true, noLeak = true, scoreHidden = true;
  const questionTexts = [];
  for (let q = 0; q < N; q++) {
    const views = players.map((p) => qViews(p).find((s) => s.question.index === q));
    const sig = views.map((v) => JSON.stringify([v.question.text, v.question.options]));
    if (new Set(sig).size !== 1) sameQs = false;
    if (new Set(views.map((v) => v.question.endsAt)).size !== 1 || new Set(views.map((v) => v.question.startedAt)).size !== 1) sameEnds = false;
    questionTexts.push(views[0].question.text);
  }
  for (const p of players) for (const s of qViews(p)) {
    const raw = JSON.stringify(s);
    if (/correctIdx/.test(raw)) noLeak = false;
  }
  check(sameQs, 'all 4 players received identical questions AND identical option order for all 12 questions');
  check(sameEnds, 'all players share the same server-issued start/end timestamps (server-driven timer)');
  check(noLeak, 'correct answers never appear in any state sent while a question is open');
  check(new Set(questionTexts).size === N, 'no duplicate questions within the game');
  const reveals = alice.states.filter((s) => s.room.phase === 'reveal');
  check(reveals.length >= N && reveals.every((s) => Number.isInteger(s.reveal.correctIdx)), 'correct answer is revealed only in the reveal phase');
  const diffCount = { easy: 0, medium: 0, hard: 0 }; const cats = new Set();
  for (const s of reveals.filter((x, i, a) => a.findIndex((y) => y.reveal.index === x.reveal.index) === i)) { diffCount[s.reveal.difficulty]++; cats.add(s.reveal.category); }
  const pl = plan(12);
  check(diffCount.easy === pl.easy && diffCount.medium === pl.medium && diffCount.hard === pl.hard, `difficulty mix is 40/40/20 (${JSON.stringify(diffCount)})`);
  check(cats.size >= 3, `mixed category draws from several categories (${[...cats].join(', ')})`);
  // Scores during a question only include finished questions.
  for (let q = 1; q < N; q++) {
    const prevReveal = alice.states.find((s) => s.room.phase === 'reveal' && s.reveal.index === q - 1);
    const open = qViews(alice).find((s) => s.question.index === q);
    for (const pl2 of open.players) { const before = prevReveal.players.find((x) => x.id === pl2.id); if (pl2.points !== before.points || pl2.correct !== before.correct) scoreHidden = false; }
  }
  check(scoreHidden, 'live scores do not reveal whether someone just answered correctly');
  // clock sanity: serverNow in each pushed state is close to the receiving moment (same machine here)
  const skew = Math.max(...players.flatMap((p) => p.states.slice(0, 20).map((s) => Math.abs(s._recv - s.serverNow))));
  check(skew < 500, `server timestamps in pushes are fresh (max apparent skew ${skew}ms)`);

  section('Answer rules');
  check(apiResults.doubleSubmit === 409, 'second answer to the same question is rejected (409)');
  check(apiResults.changed === 409, 'a locked answer cannot be changed');
  check(apiResults.badToken === 401, 'forged token is rejected (401)');
  check(apiResults.wrongQ === 409, 'answering a question that is no longer active is rejected');
  const lateTry = await alice.post('answer', { qIndex: 0, choice: 1 });
  check(lateTry.status === 409, 'answers after the game moved on are rejected');
  const lockedView = qViews(alice).filter((s) => s.question.index === 0).pop();
  check(lockedView.question.myChoice !== null && lockedView.question.answeredCount >= 1, 'a player\'s own choice is locked and visible only to them');
  check(Object.keys(lockedView.question).every((k) => !/correct/i.test(k)), 'question payload contains no correctness fields');
  const dev5 = alice.states.find((s) => s.room.phase === 'reveal' && s.reveal.index === 5);
  const devPick = dev5.reveal.picks.find((x) => x.playerId === dev.pid);
  check(devPick.choice === null && devPick.points === 0, 'no answer before the timer ends = 0 points');
  check(dev5.reveal.answeredCount === 3 && dev5.reveal.participants === 4, 'reveal shows 3 of 4 players answered when the timer expired');
  const q5ms = dev5.reveal.startedAt - alice.states.find((s) => s.room.phase === 'question' && s.question.index === 5).question.startedAt;
  check(q5ms >= 19900 && q5ms < 21000, `question with a missing answer ran the full 20s timer (${q5ms}ms)`);
  const fast = alice.states.find((s) => s.room.phase === 'reveal' && s.reveal.index === 0);
  const fastMs = fast.reveal.startedAt - alice.states.find((s) => s.room.phase === 'question' && s.question.index === 0).question.startedAt;
  check(fastMs < 4500, `question ends early once everyone has answered (${fastMs}ms)`);
  check(fast.reveal.correctCount === 4 && fast.reveal.counts.reduce((a, b) => a + b, 0) === 4, 'reveal shows how many players answered correctly (4 of 4 on Q1)');
  const rv1 = alice.states.find((x) => x.room.phase === 'reveal' && x.reveal.index === 1);
  check(rv1.reveal.correctCount === 3 && rv1.reveal.answeredCount === 4, 'reveal shows 3 of 4 correct on Q2 (Bob answers odd questions wrong)');

  section('Reconnection');
  check(apiResults.refresh && apiResults.refresh.sameEnds, 'refreshing the page mid-question restores the same question and the same server deadline');
  check(apiResults.refresh && apiResults.refresh.scoreKept > 0, 'score is preserved across the refresh');
  check(!alice.toasts.some((t) => /Bob disconnected/.test(t.text)), 'a quick page refresh (inside the grace period) does not show the player as disconnected');

  section('Scoring and final leaderboard');
  const fin = alice.latest.final;
  const byName = Object.fromEntries(fin.standings.map((s) => [s.nickname, s]));
  for (const n of ['Alice', 'Bob', 'Cara', 'Dev']) check(byName[n].points === expected[n], `${n}: ${byName[n].points} pts == expected ${expected[n]} (server-computed)`);
  check(byName.Alice.correct === 12 && byName.Bob.correct === 6 && byName.Dev.correct === 11, 'correct-answer counts are right');
  check(byName.Bob.wrong === 6 && byName.Dev.missed === 1 && byName.Dev.wrong === 0, 'incorrect vs unanswered are tracked separately');
  check(byName.Alice.accuracy === 100 && byName.Bob.accuracy === 50 && byName.Dev.accuracy === 92, 'accuracy percentages are right (100 / 50 / 92)');
  check(fin.standings.map((s) => s.nickname).join() === 'Alice,Cara,Dev,Bob' && fin.standings.map((s) => s.rank).join() === '1,2,3,4', 'final ranking order is correct: Alice, Cara, Dev, Bob');
  check(fin.standings.every((s) => s.avgMs > 0), 'average response time is reported for everyone');
  check(fin.winnerId === alice.pid && fin.totalQuestions === 12 && fin.durationMs > 20000, `winner, total questions and duration are reported (${Math.round(fin.durationMs / 1000)}s)`);
  const finals = players.map((p) => JSON.stringify(p.latest.final.standings.map((s) => [s.id, s.points, s.rank])));
  check(new Set(finals).size === 1, 'all four players see exactly the same final leaderboard');

  section('Play Again (same room, new questions)');
  check((await bob.post('rematch')).status === 403, 'only the host can restart');
  check((await alice.post('rematch')).status === 200, 'host presses Play Again');
  await Promise.all(players.map((p) => p.waitFor((s) => s.room.phase === 'lobby')));
  check(alice.latest.players.length === 4 && alice.latest.players.every((p) => p.connected), 'all 4 players are still in the room, lobby is back');
  cara.close(); await sleep(2600); // longer than the (test) grace period
  await alice.waitFor((x) => x.players.find((y) => y.id === cara.pid && !y.connected));
  check(alice.toasts.some((t) => /Cara disconnected/.test(t.text)), 'host is notified when a player disconnects');
  await cara.connect();
  await alice.waitFor((x) => x.players.find((y) => y.id === cara.pid && y.connected));
  check(alice.toasts.some((t) => /Cara reconnected/.test(t.text)) && cara.latest.room.phase === 'lobby', 'reconnecting player is welcomed back and lands in the lobby');
  check((await alice.post('settings', { category: 'sports', numQuestions: 10 })).status === 200, 'host switches to Sports / 10 questions');
  const g1set = new Set(questionTexts);
  check((await alice.post('start')).status === 202, 'host starts game 2');
  await Promise.all(players.map((p) => p.waitFor((s) => s.room.phase === 'intro' && s.room.gameNo === 2)));
  const g2 = {};
  await Promise.all(players.map(async (p, pi) => {
    for (let q = 0; q < 10; q++) {
      const st = await p.waitFor((s) => s.room.phase === 'question' && s.room.gameNo === 2 && s.question.index === q, 45000);
      if (!g2[q]) g2[q] = st.question;
      await sleep(800 + pi * 150);
      await p.post('answer', { qIndex: q, choice: p.name === 'Alice' ? correctIdxFor(st.question) : 0 });
      await p.waitFor((s) => (s.room.phase === 'reveal' && s.reveal.index === q) || s.room.phase === 'finished', 45000);
    }
  }));
  await Promise.all(players.map((p) => p.waitFor((s) => s.room.phase === 'finished' && s.room.gameNo === 2)));
  const g2texts = Object.values(g2).map((q) => q.text);
  check(g2texts.length === 10 && g2texts.every((t) => BANK.find((b) => b.text === t).category === 'sports'), 'game 2 has 10 questions, all from the Sports category');
  check(g2texts.every((t) => !g1set.has(t)), 'game 2 questions are different from game 1');
  const fin2 = alice.latest.final;
  check(fin2.gameNo === 2 && fin2.standings[0].nickname === 'Alice' && fin2.standings[0].points === 1500, 'game 2 scores start from zero; Alice wins with 10 x 150 = 1500');
  check(fin2.standings.every((s, i, a) => i === 0 || a[i - 1].points >= s.points), 'game 2 leaderboard is sorted by points');

  section('Server restart mid-game (session + game state survive)');
  await alice.post('rematch');
  await alice.waitFor((s) => s.room.phase === 'lobby');
  await alice.post('settings', { category: 'history', numQuestions: 10 });
  await alice.post('start');
  const aq = await alice.waitFor((s) => s.room.phase === 'question' && s.question.index === 0, 15000);
  const endsAt = aq.question.endsAt;
  players.forEach((p) => p.close());
  await stopServer();
  await startServer();
  await alice.connect(); // same pid/token as before the restart
  const resumed = alice.latest;
  check(resumed.room.phase === 'question' && resumed.question.index === 0 && resumed.question.endsAt === endsAt, 'after a server restart the player reconnects to the same question with the same deadline');
  const ar = await alice.waitFor((s) => s.room.phase === 'reveal', 30000);
  check(ar.reveal.index === 0, 'the game keeps running on its own after the restart (timer re-armed from the database)');
  alice.close();

  await stopServer();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length) { console.log('FAILED:\n - ' + failures.join('\n - ')); process.exit(1); }
}

main().catch(async (e) => { console.error('\nTEST CRASHED:', e); await stopServer(); process.exit(2); });
