'use strict';
/**
 * Optional AI question generation (server-side only; the key never reaches the browser).
 *
 *   ANTHROPIC_API_KEY   required to enable AI generation
 *   QUIZ_AI_MODEL       default: claude-sonnet-5-5
 *   ANTHROPIC_BASE_URL  default: https://api.anthropic.com (override for proxies / tests)
 *   AI_TIMEOUT_MS       default: 15000
 *
 * Any failure (no key, HTTP error, timeout, unparsable output) throws, and
 * questions.js falls back to the built-in bank.
 */

const isConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY);

function buildPrompt({ label, categoryId, n, counts, avoid }) {
  const scope =
    categoryId === 'mixed'
      ? 'a broad mix across General Knowledge, Science & Technology, Sports, Movies & Entertainment, History, Geography, Computers, Machine Learning and Telugu Movies (include a "category" field per question using one of: general, science, sports, movies, history, geography, computers, ml, telugu)'
      : `the category "${label}"`;
  const seed = Math.random().toString(36).slice(2, 8);
  return [
    `Write exactly ${n} multiple-choice trivia questions about ${scope}, for a friendly online quiz game.`,
    `Difficulty mix, exactly: ${counts.easy} easy, ${counts.medium} medium, ${counts.hard} hard.`,
    'Rules:',
    '- Each question has exactly 4 answer options and exactly one correct option.',
    '- Facts must be well established, unambiguous and stable over time. No opinion questions, no trick questions, no "which of the following is NOT".',
    '- Wrong options must be plausible but clearly wrong. All four options must be different.',
    '- Keep questions under 200 characters and options under 60 characters.',
    '- Vary subtopics widely so this set feels fresh; do not repeat any question.',
    `- Variety seed: ${seed}`,
    avoid.length ? `- Do NOT reuse these recent questions:\n${avoid.map((t) => `  * ${t}`).join('\n')}` : '',
    'Respond with ONLY a JSON array, no prose and no code fences. Each element:',
    '{"text": "question", "options": ["A","B","C","D"], "correct": <index 0-3 of the right option>, "difficulty": "easy|medium|hard"}',
  ]
    .filter(Boolean)
    .join('\n');
}

function extractJsonArray(text) {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) throw new Error('no JSON array in AI response');
  const parsed = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error('AI response is not an array');
  return parsed;
}

async function generate(args) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');
  const base = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
  const model = process.env.QUIZ_AI_MODEL || 'claude-sonnet-5-5';
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 4096, messages: [{ role: 'user', content: buildPrompt(args) }] }),
    signal: AbortSignal.timeout(Number(process.env.AI_TIMEOUT_MS) || 15000),
  });
  if (!res.ok) throw new Error(`AI HTTP ${res.status}`);
  const data = await res.json();
  const text = (data.content || []).map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('');
  return extractJsonArray(text);
}

module.exports = { isConfigured, generate, extractJsonArray };
