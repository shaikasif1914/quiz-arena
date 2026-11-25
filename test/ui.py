"""
Real-browser test: 1 desktop host + 3 phone-sized players play a full game through the actual UI.
Run:  python3 test/ui.py [screenshot_dir]
"""
import os, re, subprocess, sys, tempfile, time, random, shutil
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = sys.argv[1] if len(sys.argv) > 1 else os.path.join(tempfile.gettempdir(), 'qa-shots')
os.makedirs(SHOTS, exist_ok=True)
PORT = 4900 + random.randint(0, 80)
BASE = f'http://127.0.0.1:{PORT}'
TMP = tempfile.mkdtemp(prefix='qa-ui-')
env = dict(os.environ, PORT=str(PORT), DATABASE_PATH=os.path.join(TMP, 'ui.db'), QUESTION_SECONDS='10', REVEAL_SECONDS='2', INTRO_SECONDS='3', NODE_NO_WARNINGS='1')
env.pop('ANTHROPIC_API_KEY', None)
srv = subprocess.Popen(['node', 'server.js'], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
passed, failed = 0, []

def check(cond, label):
    global passed
    if cond: passed += 1; print('  PASS ', label)
    else: failed.append(label); print('  FAIL ', label)

for _ in range(60):
    try:
        import urllib.request; urllib.request.urlopen(BASE + '/healthz'); break
    except Exception: time.sleep(0.1)

def wait_until(fn, timeout=10, label='condition'):
    # Poll from Python: Playwright's string evaluation would be blocked by the app's strict CSP.
    end = time.time() + timeout
    while time.time() < end:
        try:
            if fn(): return
        except Exception: pass
        time.sleep(0.1)
    raise AssertionError(f'timed out waiting for {label}')

def shot(page, name): page.screenshot(path=os.path.join(SHOTS, name + '.png'))

try:
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        def block_fonts(ctx): ctx.route(re.compile(r'https://fonts\.(googleapis|gstatic)\.com/.*'), lambda r: r.abort())
        host_ctx = browser.new_context(viewport={'width': 1280, 'height': 820}, device_scale_factor=1); block_fonts(host_ctx)
        host = host_ctx.new_page()
        errors = []
        host.on('pageerror', lambda e: errors.append(str(e)))
        host.on('console', lambda m: errors.append(m.text) if m.type == 'error' and 'fonts' not in m.text and 'ERR_FAILED' not in m.text else None)

        print('\n== Home / create / lobby')
        host.goto(BASE + '/')
        check('Challenge Your Friends. Test Your Knowledge.' in host.inner_text('body'), 'home shows the tagline')
        check(host.locator('text=Create new room').count() == 1 and host.locator('text=Join existing room').count() == 1, 'home has Create and Join buttons')
        shot(host, '01-home-desktop')
        host.click('text=Create new room'); host.wait_for_selector('#nick')
        host.fill('#nick', 'Aarav'); check(host.locator('button[data-c="ml"]').count() == 1 and host.locator('button[data-c="telugu"]').count() == 1, 'create screen offers Machine Learning and Telugu Movies')
        check(host.locator('.cat').count() == 10, 'create screen shows all 10 categories')
        host.click('button[data-n="10"]'); host.click('button[data-c="telugu"]')
        shot(host, '02-create-desktop')
        host.click('#go'); host.wait_for_selector('.codebox .code')
        code = host.inner_text('.codebox .code').strip()
        check(re.fullmatch(r'[A-HJ-NP-Z2-9]{6}', code) is not None, f'lobby shows a 6-char room code ({code})')
        check(host.url.endswith('/r/' + code), 'URL is the shareable room link')
        check('1/5' in host.inner_text('#pcount'), 'player count shows 1/5')
        check(host.locator('#start').is_disabled(), 'Start is disabled until 2 players are in')

        print('\n== Friends join from phones via the invite link')
        iphone = pw.devices['iPhone 13']
        names = ['Meera', 'Kabir', 'Zoya']; phones = []
        for i, n in enumerate(names):
            ctx = browser.new_context(**iphone); block_fonts(ctx)
            pg = ctx.new_page(); pg.on('pageerror', lambda e, n=n: errors.append(f'{n}: {e}'))
            pg.goto(f'{BASE}/r/{code}'); pg.wait_for_selector('#nick')
            if i == 0:
                check(pg.input_value('#code') == code, 'invite link pre-fills the room code on the join screen')
                shot(pg, '03-join-mobile')
            pg.fill('#nick', n); pg.click('#go'); pg.wait_for_selector('#plist')
            phones.append(pg)
        wait_until(lambda: host.inner_text('#pcount').strip() == '4/5', 10, 'host to see 4/5')
        check(host.locator('.pitem[data-pid]').count() == 4, 'host sees all 4 players in the lobby')
        check(host.locator('[data-kick]').count() == 3, 'host sees Remove buttons for the other 3 players')
        check(phones[0].locator('[data-kick]').count() == 0 and phones[0].locator('#start').count() == 0, 'guests cannot see Remove or Start controls')
        check(phones[0].locator('text=Waiting for the host to start').count() == 1, 'guests see a waiting message')
        check(not host.locator('#start').is_disabled(), 'Start is enabled with 4 players')
        check('Telugu Movies' in phones[0].inner_text('#sel'), 'guests see the chosen category (Telugu Movies) in the lobby')
        shot(host, '04-lobby-desktop'); shot(phones[1], '05-lobby-mobile')
        # duplicate name from another browser identity is refused
        dctx = browser.new_context(**iphone); block_fonts(dctx); dp = dctx.new_page(); dp.goto(f'{BASE}/r/{code}'); dp.wait_for_selector('#nick')
        dp.fill('#nick', 'meera'); dp.click('#go'); dp.wait_for_selector('.err')
        check('already taken' in dp.inner_text('.err'), 'duplicate nickname shows a clear error')
        dctx.close()

        print('\n== Game: 10 questions, 4 browsers')
        pages = [host] + phones
        host.click('#start')
        for p in pages: p.wait_for_selector('#cd', timeout=15000)
        shot(host, '06-intro')
        # late joiner after start
        lctx = browser.new_context(**iphone); block_fonts(lctx); lp = lctx.new_page(); lp.goto(f'{BASE}/r/{code}'); lp.wait_for_selector('.err', timeout=8000)
        check('already started' in lp.inner_text('.err'), 'late joiner is told the game has started')
        lctx.close()

        sync_ok, timer_ok, leak = True, True, False
        seen = []
        for q in range(10):
            for p in pages: p.wait_for_selector(f'.qnum:has-text("Question {q + 1} ")', timeout=20000)
            try:
                for p in pages: p.wait_for_selector('#opts.live', timeout=5000)
            except Exception:
                for i, p in enumerate(pages):
                    print(f'   DEBUG q={q} page{i}:', p.evaluate("() => ({k: document.querySelector('.screen')?.className, opts: document.querySelector('#opts')?.className, status: document.querySelector('#status')?.innerText, ring: document.querySelector('#ring .num')?.innerText, t: document.querySelector('.qnum')?.innerText})"))
                    shot(p, f'debug-q{q}-p{i}')
                raise
            texts = [p.inner_text('.qcard h2') for p in pages]
            opts = [tuple(x.inner_text() for x in p.locator('.opt .tx').all()) for p in pages]
            if len(set(texts)) != 1 or len(set(opts)) != 1: sync_ok = False
            seen.append(texts[0])
            nums = [int(p.inner_text('#ring .num')) for p in pages]
            if max(nums) - min(nums) > 1: timer_ok = False
            if any('correctIdx' in p.content() for p in pages): leak = True
            if q == 0:
                shot(host, '07-question-desktop'); shot(phones[0], '08-question-mobile')
            # answer: stagger, one player sometimes lets the timer run out
            for i, p in enumerate(pages):
                if i == 3 and q == 4: continue
                time.sleep(0.25)
                p.click(f'.opt[data-i="{random.randint(0, 3)}"]')
                if q == 0 and i == 0:
                    check(host.locator('.opt.mine').count() == 1 and host.locator('#opts.live').count() == 0 and host.locator('.opt:not([disabled])').count() == 0, 'after answering, the choice is locked and every button is disabled')
                    check('Answer locked' in host.inner_text('#status'), 'locked player sees a waiting indicator')
                    host.locator('.opt.dim').first.click(force=True)
                    time.sleep(0.2)
                    check(host.locator('.opt.mine').count() == 1, 'clicking another option cannot change a locked answer')
            for p in pages: p.wait_for_selector('.verdict', timeout=20000)
            if q == 0:
                check(host.locator('.opt.right').count() == 1, 'reveal highlights exactly one correct answer')
                check(re.search(r'\d of 4 got it right', host.inner_text('.qhead')) is not None, 'reveal shows how many players answered correctly')
                shot(host, '09-reveal-desktop'); shot(phones[0], '10-reveal-mobile')
        check(sync_ok, 'all 4 browsers showed identical question text and option order for all 10 questions')
        check(timer_ok, 'countdown timers agreed across all 4 browsers (within 1s) on every question')
        check(not leak, 'no answer key present in any page while questions were open')
        check(len(set(seen)) == 10, '10 distinct questions were played')
        
        print('\n== Final leaderboard')
        for p in pages: p.wait_for_selector('.champ', timeout=20000)
        time.sleep(1.0)
        check('QUIZ CHAMPION!' in host.inner_text('.champ'), 'celebration heading "QUIZ CHAMPION!" is shown')
        rows = [[c.inner_text().strip() for c in r.locator('td').all()] for r in host.locator('table.lb tbody tr').all()]
        check(len(rows) == 4, 'leaderboard lists all 4 players')
        pts = [int(r[2]) for r in rows]
        check(pts == sorted(pts, reverse=True), f'leaderboard is sorted by points {pts}')
        heads = host.locator('table.lb th').all_inner_texts()
        check([h.strip() for h in heads] == ['Rank', 'Player', 'Points', 'Correct', 'Accuracy', 'Avg. time'], 'leaderboard has Rank, Player, Points, Correct, Accuracy, Avg. time')
        def table_values(p):
            # Compare values, not layout: phones hide the avatar column to fit the table.
            out = []
            for r in p.locator('table.lb tbody tr').all():
                c = [x.inner_text().strip() for x in r.locator('td').all()]
                name = [ln.strip() for ln in re.sub(r'\(you\)', '', c[1]).split('\n') if ln.strip()][-1]
                out.append((name, c[2], c[3], c[4], c[5]))
            return out
        tables = [table_values(p) for p in pages]
        same = all(t == tables[0] for t in tables)
        if not same:
            for i, t in enumerate(tables): print(f'   DEBUG table page{i}:', t)
        check(same, 'all 4 browsers display the same final table')
        check('Quiz Champion' in host.inner_text('.podium') and 'Runner-up' in host.inner_text('.podium') and 'Third Place' in host.inner_text('.podium'), 'podium shows Champion, Runner-up and Third Place')
        body = host.inner_text('.facts')
        check('10' in body and re.search(r'\d+:\d\d', body) is not None, 'questions played and game duration are shown')
        check(host.locator('#again').count() == 1 and phones[0].locator('#again').count() == 0, 'only the host sees Play Again')
        check(host.locator('#home').count() == 1 and host.locator('#shareRes').count() == 1, 'Back to Home and Share Results buttons are present')
        shot(host, '11-final-desktop'); shot(phones[0], '12-final-mobile')
        winner = rows[0][1].replace('(you)', '').strip()

        print('\n== Play again')
        host.click('#again')
        for p in pages: p.wait_for_selector('#plist', timeout=8000)
        check(host.locator('.pitem[data-pid]').count() == 4, 'after Play Again all 4 players are still in the room lobby')
        host.click('button[data-c="geography"]'); host.click('button[data-n="12"]')
        wait_until(lambda: host.get_attribute('button[data-n="12"]', 'aria-pressed') == 'true', 10, 'host settings to update')
        wait_until(lambda: '12 questions' in phones[0].inner_text('#sel'), 10, 'guest to see new settings')
        check('Geography' in phones[0].inner_text('#sel'), 'guests see the host\'s new settings live (Geography, 12 questions)')
        host.click('#start')
        for p in pages: p.wait_for_selector('text=Question 1', timeout=20000)
        check(all('/ 12' in p.inner_text('.qnum') for p in pages), 'game 2 has 12 questions')
        g2 = host.inner_text('.qcard h2'); check(g2 not in seen, 'game 2 question 1 is new')

        print('\n== Refresh mid-game restores the session')
        before = phones[1].inner_text('.qcard h2')
        phones[1].reload(); phones[1].wait_for_selector('.qcard', timeout=10000)
        check(phones[1].inner_text('.qcard h2') == before and 'Question 1' in phones[1].inner_text('.qhead'), 'a refreshed phone returns to the same live question')

        check(not errors, f'no JavaScript errors in the console ({errors[:3]})')
        browser.close()
finally:
    srv.terminate()
    try: srv.wait(3)
    except Exception: srv.kill()
    shutil.rmtree(TMP, ignore_errors=True)

print(f'\n{passed} checks passed, {len(failed)} failed.  Screenshots: {SHOTS}')
if failed: print('FAILED:\n - ' + '\n - '.join(failed)); sys.exit(1)
