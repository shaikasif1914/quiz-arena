'use strict';
/* QUIZ ARENA client. All game state comes from the server over Server-Sent Events;
   localStorage only holds this device's identity and room session. */

const $app = document.getElementById('app');
const AVATARS = [['🦊', '#fb923c', '#ef4444'], ['🐼', '#94a3b8', '#475569'], ['🐯', '#fbbf24', '#f97316'], ['🦄', '#f0abfc', '#8b5cf6'], ['🐸', '#4ade80', '#16a34a'], ['🐙', '#fb7185', '#be185d'], ['🦉', '#a78bfa', '#4f46e5'], ['🐲', '#22d3ee', '#0ea5e9']];
const CATS = [['general', '🧠', 'General Knowledge'], ['science', '🔬', 'Science & Technology'], ['sports', '⚽', 'Sports'], ['movies', '🎬', 'Movies & Entertainment'], ['history', '🏛️', 'History'], ['geography', '🌍', 'Geography'], ['computers', '💻', 'Computers'], ['ml', '🤖', 'Machine Learning'], ['telugu', '🎥', 'Telugu Movies'], ['mixed', '🎲', 'Mixed Questions']];
const LETTERS = ['A', 'B', 'C', 'D'];

const S = { view: null, offset: 0, session: null, code: null, es: null, localChoice: null, localQ: -1, screenKey: '', raf: 0, offline: false, lastConfetti: '', prefs: { category: 'mixed', n: 12 } };

/* ---------------------------------------------------------------- storage */
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};
function clientId() {
  let id = store.get('qa.clientId', null);
  if (!id) { const a = new Uint8Array(18); crypto.getRandomValues(a); id = Array.from(a, (b) => b.toString(16).padStart(2, '0')).join(''); store.set('qa.clientId', id); }
  return id;
}
const sessions = () => store.get('qa.sessions', {});
const saveSession = (code, s) => { const all = sessions(); all[code] = s; store.set('qa.sessions', all); store.set('qa.lastRoom', code); };
const dropSession = (code) => { const all = sessions(); delete all[code]; store.set('qa.sessions', all); if (store.get('qa.lastRoom') === code) store.set('qa.lastRoom', null); };

/* ---------------------------------------------------------------- helpers */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const serverNow = () => Date.now() + S.offset;
const inviteUrl = (code) => `${location.origin}/r/${code}`;
const catLabel = (id) => (CATS.find((c) => c[0] === id) || [0, 0, id])[2];
const fmtDur = (ms) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const fmtSec = (ms) => (ms == null ? '–' : `${(ms / 1000).toFixed(1)}s`);

function avatar(idx, size = 44, host = false) {
  const a = AVATARS[idx % AVATARS.length];
  return `<span class="av" style="--s:${size}px;--a:${a[1]};--b:${a[2]}" aria-hidden="true">${a[0]}${host ? '<span class="crown">👑</span>' : ''}</span>`;
}
function logo(link = true) {
  const svg = `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="25" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="8"/><path d="M32 7a25 25 0 1 1-24.6 29.5" fill="none" stroke="url(#ringGrad)" stroke-width="8" stroke-linecap="round"/><circle cx="32" cy="32" r="6.5" fill="#fff"/></svg>`;
  return `<a class="logo" ${link ? 'href="/" data-nav="/"' : ''} aria-label="QUIZ ARENA home">${svg}<b>QUIZ <i>ARENA</i></b></a>`;
}
function ringHtml(id, extra = '') {
  return `<div class="ring ${extra}" id="${id}"><svg viewBox="0 0 120 120"><circle class="ring-bg" cx="60" cy="60" r="52"/><circle class="ring-fg" cx="60" cy="60" r="52"/></svg><div class="num">20</div></div>`;
}

async function api(method, path, body) {
  let res;
  try { res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined }); }
  catch { throw Object.assign(new Error('Cannot reach the server. Check your internet connection.'), { status: 0 }); }
  let data = {}; try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong. Please try again.'), { status: res.status });
  return data;
}
const roomPost = (action, extra = {}) => api('POST', `/api/rooms/${S.code}/${action}`, { ...S.session, ...extra });

function toast(text, kind = 'info') {
  const box = $('#toasts'); const el = document.createElement('div');
  el.className = `toast ${kind}`; el.textContent = text; box.appendChild(el);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, 3200);
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back */ }
  const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(ta); ta.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch { /* ignore */ } ta.remove(); return ok;
}
async function shareOrCopy(data, okMsg) {
  if (navigator.share) { try { await navigator.share(data); return; } catch (e) { if (e && e.name === 'AbortError') return; } }
  toast((await copyText(data.url ? `${data.text}\n${data.url}` : data.text)) ? okMsg : 'Could not copy. Copy it manually.', 'info');
}

/* ---------------------------------------------------------------- routing */
function go(path, replace = false) { (replace ? history.replaceState : history.pushState).call(history, {}, '', path); route(); }
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-nav]');
  if (a && !e.metaKey && !e.ctrlKey) { e.preventDefault(); go(a.dataset.nav); }
});
addEventListener('popstate', route);

function mount(html, key) {
  stopLoop();
  const same = S.screenKey === key;
  S.screenKey = key;
  $app.innerHTML = `<div class="screen ${same ? 'still' : ''}">${html}</div>`;
}

function route() {
  const path = location.pathname;
  const m = path.match(/^\/r\/([A-Za-z0-9]{6})\/?$/);
  if (m) return openRoom(m[1].toUpperCase());
  disconnect();
  S.view = null;
  if (path === '/create') return screenCreate();
  if (path === '/join') return screenJoin('');
  return screenHome();
}

async function openRoom(code) {
  const saved = sessions()[code];
  if (saved) { S.session = saved; S.code = code; return connect(); }
  disconnect(); S.view = null;
  screenJoin(code);
}

/* ------------------------------------------------------------------- home */
async function screenHome() {
  const last = store.get('qa.lastRoom', null);
  mount(`
    <div class="topbar">${logo(false).replace('class="logo"', 'class="logo xl"')}</div>
    <section class="hero">
      <div>
        <h1>Outthink<span>your friends.</span></h1>
        <p class="tagline">Challenge Your Friends. Test Your Knowledge.</p>
        <div class="actions">
          <button class="btn lg" data-nav="/create">Create new room</button>
          <button class="btn lg ghost" data-nav="/join">Join existing room</button>
        </div>
        <div id="resume"></div>
      </div>
      <div class="glass demo" aria-hidden="true">
        <div class="ringwrap"><div class="ring"><svg viewBox="0 0 120 120"><circle class="ring-bg" cx="60" cy="60" r="52"/><circle class="ring-fg" cx="60" cy="60" r="52"/></svg><div class="num" style="font-size:1.7rem">⚡</div></div></div>
        <p class="q">Which planet is known as the Red Planet?</p>
        <div class="opts">
          <div class="o" style="--c:#22d3ee"><b>A</b>Venus</div>
          <div class="o hit" style="--c:#a78bfa"><b>B</b>Mars</div>
          <div class="o" style="--c:#60a5fa"><b>C</b>Jupiter</div>
          <div class="o" style="--c:#fbbf24"><b>D</b>Mercury</div>
        </div>
      </div>
    </section>
    <h2 class="center" style="margin-top:44px;font-size:1.3rem">How to play</h2>
    <ol class="how" style="margin-top:16px">
      <li class="glass"><b>Create a room</b><p>Pick a category and 10, 12 or 15 questions. You become the host.</p></li>
      <li class="glass"><b>Invite friends</b><p>Share the link or 6-letter code. Up to 5 players per room.</p></li>
      <li class="glass"><b>Answer fast</b><p>You get 20 seconds per question. Everyone sees the same ones.</p></li>
      <li class="glass"><b>Win the arena</b><p>Points for correct answers plus a speed bonus. Top score is champion.</p></li>
    </ol>
    <div class="glass scoring small"><b>Scoring</b><span class="chip">Correct = 100</span><span class="chip">≤5s +50</span><span class="chip">≤10s +30</span><span class="chip">≤15s +15</span><span class="chip">≤20s +5</span><span class="chip">Wrong or no answer = 0</span></div>`, 'home');
  if (last && sessions()[last]) {
    try {
      const info = await api('GET', `/api/rooms/${last}`);
      const box = $('#resume'); if (!box || location.pathname !== '/') return;
      box.innerHTML = `<div class="resume"><div class="grow"><b>You're in room ${esc(last)}</b><div class="small muted">${info.phase === 'lobby' ? 'Waiting in the lobby' : info.phase === 'finished' ? 'Game finished' : 'Game in progress'}</div></div><button class="btn sm" data-nav="/r/${esc(last)}">Return</button></div>`;
    } catch (e) { if (e.status === 404) dropSession(last); }
  }
}

/* ----------------------------------------------------------------- create */
function screenCreate() {
  const p = S.prefs;
  mount(`
    <div class="topbar">${logo()}<button class="back" data-nav="/">Back</button></div>
    <form class="glass pad formcard" id="f" autocomplete="off">
      <h2>Create a room</h2>
      <p class="muted">You'll get a link to share with friends.</p>
      <div class="stack">
        <label class="field"><span>Your nickname</span><input type="text" id="nick" maxlength="16" placeholder="e.g. Aarav" required value="${esc(store.get('qa.nick', ''))}"></label>
        <div class="field"><span>Number of questions</span>
          <div class="seg" role="group" aria-label="Number of questions">${[10, 12, 15].map((n) => `<button type="button" data-n="${n}" aria-pressed="${p.n === n}">${n}</button>`).join('')}</div></div>
        <div class="field"><span>Category</span>
          <div class="cats" role="group" aria-label="Category">${CATS.map((c) => `<button type="button" class="cat" data-c="${c[0]}" aria-pressed="${p.category === c[0]}"><span class="ic">${c[1]}</span>${c[2]}</button>`).join('')}</div></div>
        <div id="err"></div>
        <button class="btn lg block" id="go" type="submit">Create room</button>
      </div>
    </form>`, 'create');
  bindPickers($('#f'), p);
  $('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#go'); btn.disabled = true; btn.textContent = 'Creating…';
    const nickname = $('#nick').value.trim(); store.set('qa.nick', nickname);
    try {
      const r = await api('POST', '/api/rooms', { nickname, clientId: clientId(), category: p.category, numQuestions: p.n });
      saveSession(r.code, { pid: r.pid, token: r.token });
      go(`/r/${r.code}`);
    } catch (er) { $('#err').innerHTML = `<div class="err" role="alert">${esc(er.message)}</div>`; btn.disabled = false; btn.textContent = 'Create room'; }
  });
  $('#nick').focus();
}
function bindPickers(root, target, onChange) {
  root.addEventListener('click', (e) => {
    const n = e.target.closest('[data-n]'); const c = e.target.closest('[data-c]');
    if (n) { target.n = Number(n.dataset.n); $$('[data-n]', root).forEach((b) => b.setAttribute('aria-pressed', b === n)); onChange && onChange(); }
    if (c) { target.category = c.dataset.c; $$('[data-c]', root).forEach((b) => b.setAttribute('aria-pressed', b === c)); onChange && onChange(); }
  });
}

/* ------------------------------------------------------------------- join */
async function screenJoin(code) {
  mount(`
    <div class="topbar">${logo()}<button class="back" data-nav="/">Back</button></div>
    <form class="glass pad formcard" id="f" autocomplete="off">
      <h2>Join a room</h2>
      <p class="muted" id="sub">${code ? 'Checking room…' : 'Enter the 6-letter code from your host.'}</p>
      <div class="stack">
        <label class="field"><span>Room code</span><input type="text" id="code" class="code" maxlength="6" placeholder="ABC123" required value="${esc(code)}" ${code ? 'readonly' : ''} inputmode="text" autocapitalize="characters" spellcheck="false"></label>
        <label class="field"><span>Your nickname</span><input type="text" id="nick" maxlength="16" placeholder="e.g. Meera" required value="${esc(store.get('qa.nick', ''))}"></label>
        <div id="err"></div>
        <button class="btn lg block" id="go" type="submit">Join room</button>
      </div>
    </form>`, 'join');
  const codeEl = $('#code');
  codeEl.addEventListener('input', () => { codeEl.value = codeEl.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
  (code ? $('#nick') : codeEl).focus();
  if (code) {
    try {
      const info = await api('GET', `/api/rooms/${code}`);
      if (!$('#sub')) return;
      $('#sub').textContent = info.hostName ? `${info.hostName} invited you · ${info.categoryLabel} · ${info.numQuestions} questions · ${info.players}/${info.maxPlayers} players` : 'You were invited to a room.';
      if (!info.joinable) {
        const why = info.phase !== 'lobby' ? 'This game has already started. Ask the host to start a new round, then use the link again.' : 'This room is full (5/5).';
        $('#err').innerHTML = `<div class="err" role="alert">${esc(why)}</div>`; $('#go').disabled = true;
      }
    } catch (e) { if ($('#sub')) { $('#sub').textContent = ''; $('#err').innerHTML = `<div class="err" role="alert">${esc(e.message)}</div>`; $('#go').disabled = true; } }
  }
  $('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#go'); btn.disabled = true; btn.textContent = 'Joining…';
    const c = codeEl.value.trim().toUpperCase(); const nickname = $('#nick').value.trim(); store.set('qa.nick', nickname);
    if (!/^[A-Z0-9]{6}$/.test(c)) { $('#err').innerHTML = '<div class="err" role="alert">Room codes have 6 letters or numbers.</div>'; btn.disabled = false; btn.textContent = 'Join room'; return; }
    try {
      const r = await api('POST', `/api/rooms/${c}/join`, { nickname, clientId: clientId() });
      saveSession(c, { pid: r.pid, token: r.token });
      go(`/r/${c}`, !!code);
    } catch (er) { $('#err').innerHTML = `<div class="err" role="alert">${esc(er.message)}</div>`; btn.disabled = false; btn.textContent = 'Join room'; }
  });
}

/* ------------------------------------------------------------- connection */
function disconnect() { if (S.es) { S.es.close(); S.es = null; } $('#net').hidden = true; S.offline = false; }

function connect() {
  disconnect();
  mount(`<div class="interstitial"><div><span class="spin"></span> Connecting to room…</div></div>`, 'connecting');
  const es = new EventSource(`/api/rooms/${S.code}/events?pid=${encodeURIComponent(S.session.pid)}&token=${encodeURIComponent(S.session.token)}`);
  S.es = es;
  es.addEventListener('state', (e) => { S.offline = false; $('#net').hidden = true; onState(JSON.parse(e.data)); });
  es.addEventListener('toast', (e) => { const t = JSON.parse(e.data); toast(t.text, t.kind); });
  es.addEventListener('kicked', (e) => { const d = JSON.parse(e.data); es.close(); dropSession(S.code); S.session = null; S.view = null; history.replaceState({}, '', '/'); screenHome(); toast(d.reason, 'error'); });
  es.onerror = async () => {
    if (S.es !== es) return;
    if (es.readyState === EventSource.CLOSED) {
      // The server refused the stream (bad session / removed). Find out why.
      try { await roomPost('resume'); es.close(); setTimeout(() => S.es === es && connect(), 1500); }
      catch (er) {
        if (er.status === 0) { setTimeout(() => S.es === es && connect(), 2000); return; }
        es.close(); const code = S.code; dropSession(code); S.session = null; history.replaceState({}, '', '/'); screenHome(); toast(er.message, 'error');
      }
      return;
    }
    S.offline = true; $('#net').hidden = false;
  };
}

function onState(v) {
  S.offset = v.serverNow - Date.now();
  S.view = v;
  const ph = v.room.phase;
  if (ph === 'lobby') return screenLobby(v);
  if (ph === 'starting') return screenStarting(v);
  if (ph === 'intro') return screenIntro(v);
  if (ph === 'question') return screenQuestion(v);
  if (ph === 'reveal') return screenReveal(v);
  if (ph === 'finished') return screenFinal(v);
}

/* ------------------------------------------------------------------ lobby */
function playerItem(p, v) {
  const canKick = v.me.isHost && p.id !== v.me.id;
  return `<li class="pitem" data-pid="${p.id}">${avatar(p.avatar, 44, p.isHost)}<div class="grow"><div class="nm">${esc(p.nickname)}${p.id === v.me.id ? ' <span class="muted">(you)</span>' : ''}</div><div class="st"><span class="dot ${p.connected ? '' : 'off'}"></span>${p.isHost ? 'Host · ' : ''}${p.connected ? 'Online' : 'Offline'}</div></div>${canKick ? `<button class="btn sm danger" data-kick="${p.id}" aria-label="Remove ${esc(p.nickname)}">Remove</button>` : ''}</li>`;
}
function lobbyPlayers(v) {
  const slots = Math.max(0, v.room.maxPlayers - v.players.length);
  return v.players.map((p) => playerItem(p, v)).join('') + Array.from({ length: slots }, () => `<li class="pitem slot">Waiting for a player…</li>`).join('');
}
function screenLobby(v) {
  const r = v.room; const host = v.me.isHost;
  const enough = v.players.length >= r.minPlayers;
  if (S.screenKey === 'lobby' && $('#plist')) {
    $('#plist').innerHTML = lobbyPlayers(v);
    $('#pcount').textContent = `${v.players.length}/${r.maxPlayers}`;
    const go = $('#start'); if (go) { go.disabled = !enough; $('#hint').textContent = enough ? '' : `Need at least ${r.minPlayers} players to start.`; }
    if (!host) { const sel = $('#sel'); if (sel) sel.innerHTML = settingsReadonly(v); }
    else syncSettings(v);
    return;
  }
  mount(`
    <div class="topbar">${logo(false)}<button class="back" id="leave">Leave room</button></div>
    <div class="lobby">
      <div class="stack">
        <section class="glass codebox">
          <div class="muted small">Room code</div>
          <div class="code" aria-label="Room code ${r.code.split('').join(' ')}">${r.code}</div>
          <p class="link-line">${esc(inviteUrl(r.code))}</p>
          <div class="btns"><button class="btn" id="copy">Copy invite link</button><button class="btn ghost" id="share">Share</button></div>
        </section>
        <section class="glass pad" id="sel">${host ? settingsEditable(v) : settingsReadonly(v)}</section>
      </div>
      <section class="glass pad">
        <div class="row"><h3 class="grow">Players</h3><span class="counter" id="pcount">${v.players.length}/${r.maxPlayers}</span></div>
        <ul class="plist" id="plist">${lobbyPlayers(v)}</ul>
        <div style="margin-top:18px">${host
          ? `<button class="btn lg block" id="start" ${enough ? '' : 'disabled'}>Start game</button><p class="small muted center" id="hint" style="margin-top:8px">${enough ? '' : `Need at least ${r.minPlayers} players to start.`}</p>`
          : `<div class="waitnote"><span class="spin"></span>Waiting for the host to start…</div>`}</div>
      </section>
    </div>`, 'lobby');
  $('#copy').onclick = async () => toast((await copyText(inviteUrl(r.code))) ? 'Invite link copied' : 'Could not copy. Select the link and copy it.', 'info');
  $('#share').onclick = () => shareOrCopy({ title: 'QUIZ ARENA', text: `Join my QUIZ ARENA room! Code: ${r.code}`, url: inviteUrl(r.code) }, 'Invite copied');
  $('#leave').onclick = leaveRoom;
  $('#plist').onclick = async (e) => {
    const b = e.target.closest('[data-kick]'); if (!b) return;
    try { await roomPost('kick', { targetId: b.dataset.kick }); } catch (er) { toast(er.message, 'error'); }
  };
  if (host) {
    $('#start').onclick = async (e) => { e.target.disabled = true; try { await roomPost('start'); } catch (er) { toast(er.message, 'error'); e.target.disabled = false; } };
    bindSettings();
  }
}
function settingsEditable(v) {
  return `<h3 style="margin-bottom:12px">Game settings</h3><div class="settingsrow"><div class="seg" role="group" aria-label="Number of questions">${[10, 12, 15].map((n) => `<button type="button" data-n="${n}" aria-pressed="${v.room.numQuestions === n}">${n}</button>`).join('')}</div><div class="cats" role="group" aria-label="Category">${CATS.map((c) => `<button type="button" class="cat" data-c="${c[0]}" aria-pressed="${v.room.category === c[0]}"><span class="ic">${c[1]}</span>${c[2]}</button>`).join('')}</div></div>`;
}
function settingsReadonly(v) {
  return `<h3 style="margin-bottom:12px">Game settings</h3><div class="row wrap"><span class="chip">${catLabel(v.room.category)}</span><span class="chip">${v.room.numQuestions} questions</span><span class="chip">20s each</span></div><p class="muted small" style="margin-top:12px">The host picks the category and length.</p>`;
}
function bindSettings() {
  const root = $('#sel'); const t = {};
  root.addEventListener('click', async (e) => {
    const n = e.target.closest('[data-n]'); const c = e.target.closest('[data-c]'); if (!n && !c) return;
    const v = S.view.room;
    t.n = n ? Number(n.dataset.n) : v.numQuestions; t.category = c ? c.dataset.c : v.category;
    try { await roomPost('settings', { category: t.category, numQuestions: t.n }); } catch (er) { toast(er.message, 'error'); }
  });
}
function syncSettings(v) {
  $$('#sel [data-n]').forEach((b) => b.setAttribute('aria-pressed', Number(b.dataset.n) === v.room.numQuestions));
  $$('#sel [data-c]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.c === v.room.category));
}
async function leaveRoom() {
  const code = S.code;
  try { await roomPost('leave'); } catch { /* best effort */ }
  disconnect(); dropSession(code); S.session = null; S.view = null; go('/', true);
}

/* ----------------------------------------------------------- interstitials */
function screenStarting() {
  mount(`<div class="interstitial"><h2>Preparing your questions…</h2><p class="muted">Picking fresh questions for everyone.</p><div><span class="spin"></span></div></div>`, 'starting');
}
function screenIntro(v) {
  mount(`<div class="interstitial"><p class="muted">${esc(catLabel(v.room.category))} · ${v.room.numQuestions} questions</p><h2>Get ready!</h2><div class="bignum tick" id="cd">3</div><div class="strip">${v.players.map((p) => `<span class="sp">${avatar(p.avatar, 30)}<span class="n">${esc(p.nickname)}</span></span>`).join('')}</div></div>`, 'intro');
  const end = v.room.endsAt; let last = 0;
  loop(() => { const n = Math.max(1, Math.ceil((end - serverNow()) / 1000)); if (n !== last) { last = n; const el = $('#cd'); if (el) { el.textContent = n; el.classList.remove('tick'); void el.offsetWidth; el.classList.add('tick'); } } });
}

/* ------------------------------------------------------------------- loop */
function loop(fn) { stopLoop(); const t = () => { fn(); S.raf = requestAnimationFrame(t); }; S.raf = requestAnimationFrame(t); }
function stopLoop() { cancelAnimationFrame(S.raf); S.raf = 0; }
const CIRC = 2 * Math.PI * 52;

function runRing(ringId, startedAt, endsAt) {
  const ring = $(`#${ringId}`); if (!ring) return;
  const fg = $('.ring-fg', ring); const num = $('.num', ring); fg.style.strokeDasharray = CIRC;
  const total = endsAt - startedAt; let lastN = -1;
  loop(() => {
    const left = Math.max(0, endsAt - serverNow());
    fg.style.strokeDashoffset = String(CIRC * (1 - left / total));
    const n = Math.ceil(left / 1000);
    if (n !== lastN) { lastN = n; num.textContent = n; ring.classList.toggle('warn', n <= 10 && n > 5); ring.classList.toggle('danger', n <= 5); }
    if (left <= 0) { const b = $('#opts'); if (b && b.classList.contains('live')) { b.classList.remove('live'); $$('.opt', b).forEach((o) => { o.disabled = true; }); const st = $('#status'); if (st && S.localChoice == null) st.textContent = "Time's up! Revealing the answer…"; } }
  });
}

/* --------------------------------------------------------------- question */
function stripHtml(v) {
  return v.players.map((p) => `<span class="sp ${p.answered ? 'done' : ''} ${p.id === v.me.id ? 'me' : ''} ${p.connected ? '' : 'off'}" title="${esc(p.nickname)}">${avatar(p.avatar, 30)}<span class="n">${esc(p.nickname)}</span>${p.answered ? '<span class="tk" aria-label="answered">✓</span>' : `<span class="pt">${p.points}</span>`}</span>`).join('');
}
function screenQuestion(v) {
  const q = v.question; const me = v.players.find((p) => p.id === v.me.id);
  if (S.localQ !== q.index || S.localGame !== v.room.gameNo) { S.localQ = q.index; S.localGame = v.room.gameNo; S.localChoice = null; }
  const choice = q.myChoice != null ? q.myChoice : S.localChoice;
  const key = `q${v.room.gameNo}-${q.index}`;
  const expired = serverNow() >= q.endsAt;
  const live = choice == null && !expired;
  if (S.screenKey === key && $('#opts')) {
    $('#strip').innerHTML = stripHtml(v);
    paintOptions(choice, live);
    paintStatus(v, choice);
    return;
  }
  mount(`
    <div class="qhead">
      <div class="l"><span class="qnum">Question ${q.index + 1} <small>/ ${q.total}</small></span><span class="chip ${q.difficulty}">${q.difficulty}</span></div>
      ${ringHtml('ring')}
      <div class="r"><span class="muted small">Your score</span><span class="myscore" id="myscore">${me ? me.points : 0}</span></div>
    </div>
    <div class="progress" aria-hidden="true"><i style="width:${(q.index / q.total) * 100}%"></i></div>
    <div class="strip" id="strip">${stripHtml(v)}</div>
    <section class="glass qcard"><h2>${esc(q.text)}</h2></section>
    <div class="opts ${live ? 'live' : ''}" id="opts" role="group" aria-label="Answer options">${q.options.map((o, i) => `<button class="opt" data-i="${i}"><span class="lt">${LETTERS[i]}</span><span class="tx">${esc(o)}</span></button>`).join('')}</div>
    <div class="status" id="status" aria-live="polite"></div>`, key);
  $('#opts').addEventListener('click', (e) => { const b = e.target.closest('.opt'); if (b) submit(Number(b.dataset.i)); });
  paintOptions(choice, live); paintStatus(v, choice);
  runRing('ring', q.startedAt, q.endsAt);
}
function paintOptions(choice, live) {
  const box = $('#opts'); if (!box) return;
  box.classList.toggle('live', live);
  $$('.opt', box).forEach((b, i) => {
    b.disabled = !live; b.classList.toggle('mine', choice === i); b.classList.toggle('dim', choice != null && choice !== i);
  });
}
function paintStatus(v, choice) {
  const st = $('#status'); if (!st) return;
  const q = v.question; const left = q.participants - q.answeredCount;
  if (choice != null) st.innerHTML = left > 0 ? `<span class="ok">Answer locked.</span> Waiting for ${left} more ${left === 1 ? 'player' : 'players'}…` : '<span class="ok">Answer locked.</span> Everyone has answered!';
  else if (serverNow() >= q.endsAt) st.textContent = "Time's up! Revealing the answer…";
  else st.textContent = 'Pick your answer. Faster answers earn more points.';
}
async function submit(i) {
  const v = S.view; if (!v || v.room.phase !== 'question' || S.localChoice != null || v.question.myChoice != null) return;
  if (serverNow() >= v.question.endsAt) return;
  const qi = v.question.index; S.localChoice = i; paintOptions(i, false); paintStatus(v, i);
  try { await roomPost('answer', { qIndex: qi, choice: i }); }
  catch (er) {
    if (er.status === 409 && /already answered/i.test(er.message)) return;
    S.localChoice = null; if (S.view && S.view.room.phase === 'question' && S.view.question.index === qi) { paintOptions(null, serverNow() < S.view.question.endsAt); paintStatus(S.view, null); }
    toast(er.message, 'error');
  }
}
addEventListener('keydown', (e) => {
  if (!S.view || S.view.room.phase !== 'question' || e.target.matches('input')) return;
  const i = '1234'.indexOf(e.key); const j = 'abcd'.indexOf(e.key.toLowerCase());
  const k = i >= 0 ? i : j; if (k >= 0) submit(k);
});

/* ----------------------------------------------------------------- reveal */
function screenReveal(v) {
  const r = v.reveal; const me = r.me; const key = `r${v.room.gameNo}-${r.index}`;
  if (S.screenKey === key) return;
  const sorted = v.players; // already ranked by the server
  const prev = r.picks.reduce((m, p) => { m[p.playerId] = p.points; return m; }, {});
  const kind = me.choice == null ? 'none' : me.correct ? 'good' : 'bad';
  const headline = me.choice == null ? "Time's up!" : me.correct ? 'Correct!' : 'Not quite';
  const brk = me.correct ? `100 base + ${me.bonus} speed bonus · answered in ${fmtSec(me.timeMs)}` : me.choice == null ? 'You did not answer in time' : 'Wrong answer';
  const mine = sorted.find((p) => p.id === v.me.id);
  mount(`
    <div class="qhead">
      <div class="l"><span class="qnum">Question ${r.index + 1} <small>/ ${r.total}</small></span><span class="chip ${r.difficulty}">${r.difficulty}</span></div>
      <div></div>
      <div class="r"><span class="chip tally">${r.correctCount} of ${r.participants} got it right</span></div>
    </div>
    <div class="verdict ${kind}"><div><div class="big">${headline}</div><div class="brk">${brk}</div></div><div class="pts">${me.points > 0 ? '+' : ''}${me.points}</div></div>
    <section class="glass qcard" style="padding:18px"><h2 style="font-size:clamp(1.05rem,3.4vw,1.4rem)">${esc(r.text)}</h2></section>
    <div class="opts" id="opts">${r.options.map((o, i) => {
      const cls = i === r.correctIdx ? 'right' : me.choice === i ? 'wrong' : 'dim';
      return `<div class="opt ${cls}" data-i="${i}"><span class="lt">${LETTERS[i]}</span><span class="tx">${esc(o)}${me.choice === i ? ' <small class="muted">(your pick)</small>' : ''}</span><span class="cnt" title="players who chose this">${r.counts[i]}</span></div>`;
    }).join('')}</div>
    <div class="revgrid">
      <section class="glass board"><h3>Standings</h3>${sorted.map((p) => {
        const d = prev[p.id] || 0;
        return `<div class="brow ${p.id === v.me.id ? 'me' : ''}"><span class="rk">${p.rank}</span>${avatar(p.avatar, 32)}<span class="nm">${esc(p.nickname)}<small>${p.correct} correct</small></span><span class="dl ${d ? '' : 'z'}">${d ? '+' + d : '0'}</span><span class="tot">${p.points}</span></div>`;
      }).join('')}</section>
      <section class="glass"><div class="mystats"><div><b>${mine ? mine.points : 0}</b><span>Total score</span></div><div><b>${mine ? mine.correct : 0}</b><span>Correct</span></div><div><b>${mine ? mine.wrong + mine.missed : 0}</b><span>Incorrect</span></div><div><b>${mine ? mine.accuracy : 0}%</b><span>Accuracy</span></div></div>
        <div style="padding:0 16px 16px"><p class="small muted center">${r.isLast ? 'Final results coming up…' : 'Next question starting…'}</p><div class="countbar"><i id="cb"></i></div></div></section>
    </div>`, key);
  const bar = $('#cb'); const total = r.endsAt - r.startedAt;
  loop(() => { const f = Math.max(0, (r.endsAt - serverNow()) / total); if (bar) bar.style.transform = `scaleX(${f})`; });
}

/* ------------------------------------------------------------------ final */
const TITLES = ['Quiz Champion', 'Runner-up', 'Third Place'];
const MEDALS = ['🥇', '🥈', '🥉'];
function screenFinal(v) {
  const f = v.final; const key = `f${f.gameNo}`;
  if (S.screenKey === key) { updateEndButtons(v); return; }
  const top = f.standings[0]; const iWon = top && top.id === v.me.id; const host = v.me.isHost;
  const podium = [1, 0, 2].map((i) => f.standings[i]).filter(Boolean);
  mount(`
    <div class="topbar">${logo(false)}<span class="chip">${esc(f.categoryLabel)}</span></div>
    <section class="glass champ">
      <div class="trophy" aria-hidden="true">🏆</div>
      <h1>QUIZ CHAMPION!</h1>
      ${top ? `<div class="who">${avatar(top.avatar, 46, true)}<span>${iWon ? 'You won, ' : ''}${esc(top.nickname)}</span></div><div class="score">${top.points}</div><div class="muted">points</div>` : ''}
    </section>
    <div class="podium">${podium.map((p) => `<div class="glass pod p${p.rank}"><div class="medal">${MEDALS[p.rank - 1]}</div><div class="ttl">${TITLES[p.rank - 1]}</div>${avatar(p.avatar, 44)}<div class="nm">${esc(p.nickname)}</div><div class="pt">${p.points}</div></div>`).join('')}</div>
    <div class="glass tablewrap"><table class="lb"><thead><tr><th>Rank</th><th>Player</th><th class="n">Points</th><th class="n">Correct</th><th class="n">Accuracy</th><th class="n">Avg. time</th></tr></thead><tbody>
      ${f.standings.map((p) => `<tr class="${p.id === v.me.id ? 'me' : ''}"><td class="rk">${p.rank <= 3 ? MEDALS[p.rank - 1] : p.rank}</td><td class="pl">${avatar(p.avatar, 30)}${esc(p.nickname)}${p.id === v.me.id ? ' <span class="muted">(you)</span>' : ''}</td><td class="n pts">${p.points}</td><td class="n">${p.correct}/${f.totalQuestions}</td><td class="n">${p.accuracy}%</td><td class="n">${fmtSec(p.avgMs)}</td></tr>`).join('')}
    </tbody></table></div>
    <div class="facts"><div class="glass fact"><b>${f.totalQuestions}</b><span>Questions played</span></div><div class="glass fact"><b>${fmtDur(f.durationMs)}</b><span>Game duration</span></div><div class="glass fact"><b>${f.standings.length}</b><span>Players</span></div></div>
    <div class="endbtns" id="endbtns"></div>`, key);
  updateEndButtons(v);
  if (S.lastConfetti !== `${S.code}-${f.gameNo}`) { S.lastConfetti = `${S.code}-${f.gameNo}`; confetti(iWon ? 'big' : 'small'); }
}
function updateEndButtons(v) {
  const box = $('#endbtns'); if (!box) return;
  const host = v.me.isHost; const f = v.final;
  const sig = host ? 'h' : 'p'; if (box.dataset.sig === sig) return; box.dataset.sig = sig;
  box.innerHTML = `${host ? '<button class="btn lg" id="again">Play again</button>' : '<div class="waitnote" style="width:100%;max-width:420px"><span class="spin"></span>Waiting for the host to start a new round</div>'}<button class="btn lg ghost" id="home">Back to home</button><button class="btn lg ghost" id="shareRes">Share results</button>`;
  if (host) $('#again').onclick = async (e) => { e.target.disabled = true; try { await roomPost('rematch'); } catch (er) { toast(er.message, 'error'); e.target.disabled = false; } };
  $('#home').onclick = leaveRoom;
  $('#shareRes').onclick = () => {
    const lines = f.standings.map((p) => `${MEDALS[p.rank - 1] || p.rank + '.'} ${p.nickname} – ${p.points} pts (${p.correct}/${f.totalQuestions})`);
    shareOrCopy({ title: 'QUIZ ARENA results', text: `QUIZ ARENA – ${f.categoryLabel}\n${lines.join('\n')}`, url: location.origin }, 'Results copied to clipboard');
  };
}

/* --------------------------------------------------------------- confetti */
function confetti(mode) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const cv = $('#confetti'); const ctx = cv.getContext('2d'); const dpr = Math.min(devicePixelRatio || 1, 2);
  cv.width = innerWidth * dpr; cv.height = innerHeight * dpr; ctx.scale(dpr, dpr);
  const colors = ['#22d3ee', '#8b5cf6', '#4f8bff', '#fbbf24', '#fb4f8a', '#34d399'];
  const n = mode === 'big' ? 170 : 50; const dur = mode === 'big' ? 6000 : 2500; const t0 = performance.now();
  const ps = Array.from({ length: n }, (_, i) => ({ x: Math.random() * innerWidth, y: -20 - Math.random() * innerHeight * 0.6, vx: (Math.random() - 0.5) * 3, vy: 2 + Math.random() * 4, s: 6 + Math.random() * 7, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3, c: colors[i % colors.length], w: Math.random() * 0.6 + 0.4 }));
  (function frame(now) {
    const el = now - t0; ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of ps) { p.x += p.vx + Math.sin((el + p.y) / 300) * 0.8; p.y += p.vy; p.r += p.vr; ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c; ctx.globalAlpha = Math.max(0, 1 - el / dur); ctx.fillRect(-p.s / 2, -p.s * p.w / 2, p.s, p.s * p.w); ctx.restore(); }
    if (el < dur) requestAnimationFrame(frame); else ctx.clearRect(0, 0, innerWidth, innerHeight);
  })(t0);
}

route();
