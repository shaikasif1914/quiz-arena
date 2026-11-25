# QUIZ ARENA

Real-time multiplayer quiz game. One person creates a room, shares the link, up to five friends join from any phone or computer, and everyone plays 10 to 15 synchronized questions. The final leaderboard appears automatically.

## Run it

```bash
node --version      # needs Node 22.13 or newer
npm start           # http://localhost:3000
```

There is nothing to install: no npm dependencies and no external database. Open the page, create a room, and send the invite link to friends on the same network. For friends elsewhere, deploy it (below).

## Credentials

None are required. Optional:

| Variable | What it does |
|---|---|
| `ANTHROPIC_API_KEY` | Turns on AI-written questions. Get a key at console.anthropic.com. It stays on the server. If the AI call fails or returns bad data, the game silently falls back to the built-in bank. |
| `DATABASE_PATH` | SQLite file location. Use a persistent disk in production. |
| `TRUST_PROXY=1` | Set on any host that puts a proxy in front of the app. |
| `SESSION_SECRET` | Signs player tokens. Auto-generated if unset. |

See `.env.example` for all options.

## Deploy

The app is one Node process plus one SQLite file, so any host that can run a long-lived Node process and keep a small disk works: Render (`render.yaml` included), Railway, Fly.io, or any VPS with Docker.

```bash
docker build -t quiz-arena .
docker run -p 3000:3000 -v quiz-data:/data -e ANTHROPIC_API_KEY=sk-... quiz-arena
```

Requirements for the host:
- **Run exactly one instance.** Live connections and the question timers are held in memory. Do not scale horizontally or use serverless platforms (Vercel, Netlify functions, Cloud Functions); they cut long-lived connections.
- **Use HTTPS** (every PaaS does). The Copy and Share buttons need a secure context.
- **Keep a persistent disk** mounted at `DATABASE_PATH` if you want games to survive restarts. Without one the game still works, but a restart wipes rooms.
- Disable proxy response buffering for `/api/rooms/*/events` (the server already sends `X-Accel-Buffering: no`, which nginx honors).

## How it works

- **Server is the source of truth.** It owns the question timer, the questions, and all scoring. Browsers only render what they are sent and submit a choice.
- **Real-time sync:** Server-Sent Events push a per-player view of the room on every change. Each push includes the server's clock, so every device counts down against the same deadline regardless of its own clock.
- **Answer key protection:** the correct answer is stored only on the server and appears in a payload only after the question closes. Submitting an answer never reveals whether it was right.
- **Scoring:** 100 points for a correct answer, plus a speed bonus of +50 / +30 / +15 / +5 at 5 / 10 / 15 / 20 seconds. The server measures elapsed time from its own clock when the request arrives.
- **One answer per player per question** is enforced by the database primary key, so retries and double clicks cannot change or duplicate an answer.
- **Reconnection:** each device keeps an anonymous identity in `localStorage`; the server derives a signed session token from it. Refreshing, losing signal, or restarting the server puts you back in the same room, on the same question, with the same deadline and score. Timers are re-armed from the database on startup.
- **Questions** are generated once when the host presses Start, stored with the game, and sent identically to everyone. Mix is 40% easy, 40% medium, 20% hard. Play Again creates a new game in the same room and avoids repeating recent questions.

### Files

| File | Purpose |
|---|---|
| `server.js` | HTTP API, SSE, game engine, validation, rate limiting |
| `db.js` | SQLite schema (rooms, players, games, questions, game_players, answers) |
| `questions.js` | Question selection, 270-question bank, AI merge and validation |
| `ai.js` | Optional AI call (server-side key) |
| `public/` | Single-page client (`index.html`, `style.css`, `app.js`) |
| `test/` | `simulate.js` (4 players over HTTP/SSE), `ui.py` (4 real browsers), `ai.test.js` |

## Tests

```bash
node test/simulate.js          # 72 checks, ~3 min: 4 simulated players, full games, restart mid-game
node test/ai.test.js           # 11 checks: AI path, partial output, failures and timeouts
python3 test/ui.py             # 38 checks: real Chromium, 1 desktop + 3 phone-sized players (needs Playwright)
```

## Limits worth knowing

- Capacity is one room cluster per process; a small instance comfortably handles dozens of simultaneous rooms.
- Player identity is a per-browser anonymous id, not an account. Clearing site data or switching browsers means joining as a new player (the nickname is freed once the old one has left).
- The built-in bank has 30 questions per category. Rooms avoid repeats within a session, but long sessions in one category will eventually reuse questions unless the AI key is set.
