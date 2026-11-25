'use strict';
/**
 * Tests AI question generation against a local mock of the Anthropic API:
 *  - valid AI output is used (source "ai")
 *  - malformed items are dropped and topped up from the bank (source "ai+bank")
 *  - HTTP errors / garbage / timeouts fall back to the bank (source "bank")
 * Run: node test/ai.test.js
 */
const http = require('http');
let passed = 0; const failed = [];
const check = (c, l) => { if (c) { passed++; console.log('  PASS ', l); } else { failed.push(l); console.log('  FAIL ', l); } };

function mock(handler) {
  return new Promise((res) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => res(s)); });
}
const reply = (res, text, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(status === 200 ? { content: [{ type: 'text', text }] } : { error: 'x' })); };
const good = (i) => ({ text: `AI question number ${i}: which option is right?`, options: [`right ${i}`, `wrong a${i}`, `wrong b${i}`, `wrong c${i}`], correct: 0, difficulty: i < 5 ? 'easy' : i < 10 ? 'medium' : 'hard' });

(async () => {
  let mode = 'good'; let lastBody = null;
  const server = await mock((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      lastBody = { headers: req.headers, json: JSON.parse(b || '{}') };
      if (mode === 'good') return reply(res, 'Here you go:\n' + JSON.stringify(Array.from({ length: 12 }, (_, i) => good(i))));
      if (mode === 'partial') return reply(res, JSON.stringify([good(1), good(2), { text: 'bad', options: ['a'], correct: 9 }, { ...good(3), options: ['same', 'same', 'x', 'y'] }, { ...good(4), correct: 7 }]));
      if (mode === 'garbage') return reply(res, 'Sorry, I cannot do that.');
      if (mode === 'http500') return reply(res, '', 500);
      if (mode === 'hang') return; // never respond
    });
  });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.AI_TIMEOUT_MS = '800';
  const { generateQuestions } = require('../questions');
  const sane = (qs, n) => qs.length === n && qs.every((q) => q.options.length === 4 && new Set(q.options).size === 4 && q.correctIdx >= 0 && q.correctIdx < 4);

  let r = await generateQuestions({ category: 'science', n: 12 });
  check(r.source === 'ai' && sane(r.questions, 12), 'valid AI output is used as-is');
  check(lastBody.headers['x-api-key'] === 'test-key' && /science/i.test(lastBody.json.messages[0].content), 'API key is sent server-side and the prompt names the category');
  const d = { easy: 0, medium: 0, hard: 0 }; r.questions.forEach((q) => d[q.difficulty]++);
  check(d.easy === 5 && d.medium === 5 && d.hard === 2, `AI result is trimmed to the 40/40/20 mix (${JSON.stringify(d)})`);

  mode = 'partial';
  r = await generateQuestions({ category: 'geography', n: 10 });
  check(r.source === 'ai+bank' && sane(r.questions, 10), 'malformed AI items are dropped and topped up from the question bank');
  check(new Set(r.questions.map((q) => q.text)).size === 10, 'no duplicates after mixing AI and bank questions');

  for (const m of ['garbage', 'http500', 'hang']) {
    mode = m; const t = Date.now();
    r = await generateQuestions({ category: 'sports', n: 15 });
    check(r.source === 'bank' && sane(r.questions, 15) && r.questions.every((q) => q.category === 'sports'), `AI failure (${m}) falls back to the bank with 15 sports questions`);
    if (m === 'hang') check(Date.now() - t < 3000, 'a hung AI request times out quickly instead of blocking the game');
  }
  delete process.env.ANTHROPIC_API_KEY;
  r = await generateQuestions({ category: 'history', n: 10 });
  check(r.source === 'bank', 'without an API key the bank is used directly');
  // freshness: avoid list is honoured across consecutive games
  const g1 = await generateQuestions({ category: 'computers', n: 10 });
  const g2 = await generateQuestions({ category: 'computers', n: 10, avoid: g1.questions.map((q) => q.text) });
  check(g2.questions.every((q) => !g1.questions.some((x) => x.text === q.text)), 'consecutive games in a room do not repeat questions while the bank has fresh ones');
  server.close();
  console.log(`\n${passed} checks passed, ${failed.length} failed.`);
  process.exit(failed.length ? 1 : 0);
})();
