"""Browser test of the instant-save behaviour. A fake API (with 1.5s latency) stands in for Apps Script.
Run: python3 -I tests/ui_live.py docs"""
import asyncio, base64, json, sys, time, http.server, threading, functools
from playwright.async_api import async_playwright

LAT = 1.5
A, B = 'chris@x.com', 'natalie@x.com'
USERS = [{'name': 'Chris', 'email': A}, {'name': 'Natalie', 'email': B}]
def jwt(exp): 
    enc = lambda o: base64.urlsafe_b64encode(json.dumps(o).encode()).decode().rstrip('=')
    return enc({'alg': 'none'}) + '.' + enc({'exp': exp}) + '.x'

class Server:
    def __init__(self):
        self.rows = [dict(id='seed1', type='expense', date='2026-11-01', description='Seed shop', amount_pence=10000,
                          paid_by=B, other_share_pct=50, pot='Main', status='active', created_by=B, created_at='2026-11-01T10:00:00Z', group_id='')]
        self.pots = ['Main']; self.log = []; self.online = True; self.drop_response_once = False; self.version = 3
    def net(self):
        out = {}
        for r in self.rows:
            if r['status'] == 'void': continue
            s = 1 if r['paid_by'] == A else -1
            d = r['amount_pence'] if r['type'] == 'settlement' else round(r['amount_pence'] * r['other_share_pct'] / 100 + 1e-9)
            out[r['pot']] = out.get(r['pot'], 0) + s * d
        return out
    def state(self):
        s = dict(me=A, users=USERS, currency='£', pots=self.pots, rows=self.rows)
        if self.version is not None: s['version'] = self.version     # an old script sends no version at all
        return s
    def handle(self, q):
        a = q['action']; self.log.append(a)
        if a == 'state': return dict(ok=True, state=self.state())
        if a == 'add':
            e = q['entry']
            if not any(r['id'] == e['id'] for r in self.rows):
                self.rows.append(dict(e, status='active', created_by=A, created_at='now', group_id=''))
                if e['pot'] not in self.pots: self.pots.append(e['pot'])
            return dict(ok=True)
        if a == 'void':
            for r in self.rows:
                if r['id'] == q['id']: r['status'] = 'void'
            return dict(ok=True)
        if a == 'addPot':
            if q['name'] not in self.pots: self.pots.append(q['name'])
            return dict(ok=True, pots=self.pots)
        if a == 'settle':
            if q.get('group') and any(r.get('group_id') == q['group'] for r in self.rows): return dict(ok=True, duplicate=True)
            net = self.net()
            for pot, n in q['expected'].items():
                if net.get(pot, 0) != n: return dict(ok=False, code='conflict', error='Balances changed, please review and try again', state=self.state())
            amounts = q.get('amounts', {}); settled = {}
            for pot, n in q['expected'].items():
                if not n: continue
                amt = amounts.get(pot, abs(n))
                if not (0 < amt <= abs(n)): return dict(ok=False, code='invalid', error='A payment must be more than zero and no more than what is owed')
                settled[pot] = amt
            for pot, amt in settled.items():
                n = q['expected'][pot]
                self.rows.append(dict(id=q['ids'][pot], type='settlement', date=q['date'], description='Part payment' if amt < abs(n) else 'Settle up', amount_pence=amt,
                                      paid_by=B if n > 0 else A, other_share_pct=100, pot=pot, status='active', created_by=A, created_at='now', group_id=q['group']))
            return dict(ok=True, settled=settled)
        return dict(ok=False, code='bad_request', error='?')

async def main(root):
    h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=root)
    http.server.ThreadingHTTPServer.allow_reuse_address = True
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 8766), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    S = Server(); fails = []
    def check(name, cond, extra=''):
        print(('PASS ' if cond else 'FAIL ') + name + (' ' + str(extra) if extra else ''))
        if not cond: fails.append(name)

    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, service_workers='block')
        await ctx.add_init_script("localStorage.setItem('su-token', %s)" % json.dumps(json.dumps(jwt(int(time.time()) + 3600))))
        pg = await ctx.new_page()
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.route('**/config.js', lambda r: r.fulfill(content_type='application/javascript',
            body="window.SETTLE_CONFIG={apiUrl:'https://api.test/exec',clientId:'x'}"))
        async def api(route):
            q = json.loads(route.request.post_data)
            await asyncio.sleep(LAT)
            if not S.online: return await route.abort()
            res = S.handle(q)
            if S.drop_response_once and q['action'] == 'add':      # server did the work, but the reply never arrives
                S.drop_response_once = False; return await route.abort()
            await route.fulfill(status=200, content_type='application/json', headers={'Access-Control-Allow-Origin': '*'}, body=json.dumps(res))
        await pg.route('https://api.test/exec', api)

        await pg.goto('http://127.0.0.1:8766/index.html'); await pg.wait_for_selector('.card', timeout=10000)
        txt = lambda: pg.inner_text('#view')
                # Chris is A: Natalie paid 100 at 50% => Chris owes Natalie 50
        check('balance direction', 'You owe Natalie £50.00' in await txt())
        check('up-to-date server: no warning banner', 'out of date' not in await txt())

        # 1. adding an expense is instant
        await pg.click('nav [data-tab=add]'); await pg.fill('#amt', '30'); await pg.fill('#desc', 'Pizza')
        t0 = time.time(); await pg.click('button[type=submit]'); await pg.wait_for_selector('.toast')
        dt = time.time() - t0
        check('add confirms instantly (<0.5s, server takes 1.5s)', dt < 0.5, f'{dt:.2f}s')
        await pg.click('nav [data-tab=home]')
        check('balance already updated before the server replied', 'You owe Natalie £35.00' in await txt(), (await txt())[:70])
        check('shows Saving… while in flight', 'Saving' in await pg.inner_text('#sync'))
        check('server has not got it yet', not any(r['description'] == 'Pizza' for r in S.rows))
        await pg.wait_for_function("document.querySelector('#sync').textContent.indexOf('Saving')<0", timeout=8000)
        check('server received exactly one add', sum(1 for r in S.rows if r['description'] == 'Pizza') == 1)

        # 2. settle up is instant and zeroes the balance
        await pg.click('text=Settle up Main'); await pg.wait_for_selector('dialog[open]')
        t0 = time.time(); await pg.click('text=Mark as paid'); await pg.wait_for_selector('.toast'); dt = time.time() - t0
        check('settle confirms instantly (<0.5s)', dt < 0.5, f'{dt:.2f}s')
        check('shows all settled immediately', 'All settled up' in await txt())
        await pg.wait_for_function("document.querySelector('#sync').textContent.indexOf('Saving')<0", timeout=8000)
        check('server balance is zero after settle', S.net().get('Main', 0) == 0, S.net())

        # 2b. typing while the previous item is still saving must not lose focus or characters
        idle = "document.querySelector('#sync').textContent.indexOf('Saving')<0"
        await pg.click('nav [data-tab=add]'); await pg.fill('#amt', '1'); await pg.fill('#desc', 'Tea')
        await pg.click('button.chip:text-is("0%")')                      # personal item: no effect on balances
        await pg.click('button[type=submit]'); await pg.wait_for_selector('.toast')
        check('previous item is still saving when the next one is started', 'Saving' in await pg.inner_text('#sync'))
        await pg.click('#amt'); await pg.keyboard.type('7')
        await pg.wait_for_function(idle, timeout=8000)                    # the background save finishes while the field is focused
        check('focus stays in the field after a background save', await pg.evaluate("document.activeElement.id") == 'amt', await pg.evaluate("document.activeElement.tagName"))
        await pg.keyboard.type('5')
        check('typing carries on without losing characters', await pg.input_value('#amt') == '75', await pg.input_value('#amt'))
        await pg.fill('#amt', ''); await pg.fill('#desc', '')

        # 3. offline: entry kept, flagged, then syncs on reconnect without duplicating
        S.online = False
        await pg.click('nav [data-tab=add]'); await pg.fill('#amt', '12'); await pg.fill('#desc', 'Offline coffee'); await pg.click('button[type=submit]')
        await pg.wait_for_function("document.querySelector('#sync').textContent.indexOf('waiting')>=0", timeout=8000)
        check('flags waiting to sync when offline', True)
        await pg.click('nav [data-tab=history]')
        check('offline entry visible with PENDING badge', 'PENDING' in await txt())
        await pg.reload(); await pg.wait_for_selector('.card')
        await pg.click('nav [data-tab=history]')
        check('queued entry survives a reload', 'Offline coffee' in await txt())
        S.online = True
        await pg.evaluate("window.dispatchEvent(new Event('online'))")
        await pg.wait_for_function("document.querySelector('#sync').textContent.trim()===''", timeout=10000)
        check('offline entry reached server once', sum(1 for r in S.rows if r['description'] == 'Offline coffee') == 1)

        # 4. reply lost after the server saved: the retry must not double-add
        S.drop_response_once = True
        await pg.click('nav [data-tab=add]'); await pg.fill('#amt', '5'); await pg.fill('#desc', 'Lost reply'); await pg.click('button[type=submit]')
        await pg.wait_for_function("document.querySelector('#sync').textContent.indexOf('waiting')>=0", timeout=8000)
        await pg.evaluate("window.dispatchEvent(new Event('online'))")
        await pg.wait_for_function("document.querySelector('#sync').textContent.trim()===''", timeout=10000)
        check('lost reply then retry gives exactly one row', sum(1 for r in S.rows if r['description'] == 'Lost reply') == 1)

        settles_before = sum(1 for r in S.rows if r['type'] == 'settlement')
        # 5. partner adds something while we settle: refuse stale settle, show truth
        await pg.click('nav [data-tab=home]')
        S.rows.append(dict(id='partner1', type='expense', date='2026-11-09', description='Partner buy', amount_pence=4000, paid_by=B, other_share_pct=50,
                           pot='Main', status='active', created_by=B, created_at='now', group_id=''))
        await pg.click('text=Settle up Main'); await pg.wait_for_selector('dialog[open]')
        # the app's view is stale (does not know about partner1): confirm
        await pg.click('text=Mark as paid')
        await pg.wait_for_selector('.toast.bad', timeout=8000)
        check('stale settle refused with message', 'changed' in (await pg.inner_text('.toast.bad')).lower())
        check('server did NOT record a stale settlement', sum(1 for r in S.rows if r['type'] == 'settlement') == settles_before)
        await pg.wait_for_timeout(300)
        check('screen now shows the true balance (you owe Natalie £11.50)', 'You owe Natalie £11.50' in await txt(), (await txt())[:90].replace(chr(10),' | '))
        check('server and screen agree', S.net()['Main'] == -1150, S.net())

        # 6. part payment: overtype a smaller amount
        await pg.click('nav [data-tab=home]')
        await pg.click('text=Settle up Main'); await pg.wait_for_selector('dialog[open]')
        inp = pg.locator('dialog input')
        check('confirmation pre-fills the full amount', await inp.input_value() == '11.50', await inp.input_value())
        await inp.fill('20')
        check('overpaying is flagged', 'more than' in (await pg.inner_text('dialog')).lower())
        check('overpaying disables the button', await pg.locator('dialog button.primary').is_disabled())
        await inp.fill('0')
        check('zero is rejected', await pg.locator('dialog button.primary').is_disabled())
        await inp.fill('5')
        check('part amount shows what remains', '£6.50 will still be owed' in await pg.inner_text('dialog'), (await pg.inner_text('dialog'))[-160:].replace(chr(10), ' | '))
        check('button says Record payment', 'Record payment' in await pg.locator('dialog button.primary').inner_text())
        t0 = time.time(); await pg.click('dialog button.primary'); await pg.wait_for_selector('.toast'); dt = time.time() - t0
        check('part payment confirms instantly', dt < 0.5, f'{dt:.2f}s')
        check('screen shows the reduced balance at once', 'You owe Natalie £6.50' in await txt(), (await txt())[:70].replace(chr(10), ' | '))
        await pg.wait_for_function("document.querySelector('#sync').textContent.indexOf('Saving')<0", timeout=8000)
        part = [r for r in S.rows if r['description'] == 'Part payment']
        check('server stored a £5.00 part payment', len(part) == 1 and part[0]['amount_pence'] == 500, part)
        check('server balance matches the screen', S.net()['Main'] == -650, S.net())
        # the rest, in full
        await pg.click('text=Settle up Main'); await pg.wait_for_selector('dialog[open]')
        check('next settle pre-fills the remainder', await pg.locator('dialog input').input_value() == '6.50')
        await pg.click('dialog button.primary'); await pg.wait_for_function("document.querySelector('#sync').textContent.indexOf('Saving')<0", timeout=8000)
        check('remainder settles to zero', S.net()['Main'] == 0, S.net())

        # 7. pot order: Main first even at zero; then pots with a balance; then settled; each A-Z
        S.pots += ['Zoo', 'Alpha', 'Holiday']
        S.rows.append(dict(id='z1', type='expense', date='2026-11-09', description='Zoo trip', amount_pence=4000, paid_by=A, other_share_pct=50, pot='Zoo', status='active', created_by=A, created_at='now', group_id=''))
        S.rows.append(dict(id='h1', type='expense', date='2026-11-09', description='Hotel', amount_pence=2000, paid_by=B, other_share_pct=50, pot='Holiday', status='active', created_by=B, created_at='now', group_id=''))
        await pg.reload(); await pg.wait_for_selector('.card')
        await pg.wait_for_function("document.querySelectorAll('.pot-name').length>=3", timeout=8000)
        order = [s.strip().lower() for s in await pg.locator('.pot-name').all_inner_texts()]
        check('Home: Main (settled) first, then pots with a balance A-Z; other settled pots hidden', order == ['main', 'holiday', 'zoo'], order)
        await pg.click('nav [data-tab=history]')
        chips = [s.strip().lower() for s in await pg.locator('.chip').all_inner_texts()]
        check('History filter uses the same order', chips == ['all', 'main', 'holiday', 'zoo', 'alpha'], chips)
        # keyboard behaviour: opening the confirmation must not focus the amount box; tapping it must
        await pg.click('nav [data-tab=home]')
        await pg.click('text=Settle up Zoo'); await pg.wait_for_selector('dialog[open]')
        active = await pg.evaluate("document.activeElement && document.activeElement.tagName")
        check('settle confirmation does not auto-focus the amount field (no keyboard)', active not in ('INPUT', 'TEXTAREA'), active)
        await pg.locator('dialog input').click()
        check('tapping the amount field focuses it', await pg.evaluate("document.activeElement.tagName") == 'INPUT')
        check('tapping selects the figure so typing replaces it', await pg.evaluate("document.activeElement.selectionStart===0 && document.activeElement.selectionEnd===document.activeElement.value.length"))
        await pg.keyboard.press('Escape')
        await pg.click('nav [data-tab=add]')
        await pg.click('text=+ New pot'); await pg.wait_for_selector('dialog[open]')
        await pg.wait_for_timeout(150)
        check('new-pot sheet DOES focus its field (you are about to type)', await pg.evaluate("document.activeElement.tagName") == 'INPUT')
        await pg.keyboard.press('Escape')
        chips = [s.strip().lower() for s in await pg.locator('label:has-text("Pot") + .chips .chip').all_inner_texts()]
        check('Add form pot chips use the same order', chips[:4] == ['main', 'holiday', 'zoo', 'alpha'], chips)
        # 8. an out-of-date server script is detected up front, and part payments are blocked (it would record the full amount)
        S.version = None
        await pg.reload(); await pg.wait_for_selector('.card')
        await pg.wait_for_function("document.body.innerText.indexOf('out of date')>=0", timeout=8000)
        check('old server: warning banner is shown', True)
        await pg.click('text=Settle up Zoo'); await pg.wait_for_selector('dialog[open]')
        await pg.locator('dialog input').fill('5')
        check('old server: part payment is blocked', await pg.locator('dialog button.primary').is_disabled() and 'Update the server script' in await pg.inner_text('dialog'))
        await pg.locator('dialog input').fill('20.00')
        check('old server: a full settle-up is still allowed', not await pg.locator('dialog button.primary').is_disabled())
        await pg.keyboard.press('Escape')
        S.version = 3
        await pg.reload(); await pg.wait_for_selector('.card')
        check('after the script is updated no stale warning flashes up from the cache', 'out of date' not in await txt())
        await pg.wait_for_timeout(1800)
        check('and it is still gone once fresh data arrives', 'out of date' not in await txt())
        # 9. newly deployed code is picked up: quiet reload when idle, an Update button when a form is half filled
        tweak = {'on': False}
        async def maybe_tweak(route):
            r = route.request
            if tweak['on'] and r.url.split('?')[0].endswith('/index.html') and 'v=' in r.url:
                resp = await route.fetch(); body = await resp.text()
                await route.fulfill(response=resp, body=body + '<!-- new build -->')
            else: await route.continue_()
        await pg.route('**/index.html*', maybe_tweak)
        await pg.reload(); await pg.wait_for_selector('.card'); await pg.wait_for_timeout(3600)   # baseline is taken ~3s after load
        await pg.evaluate("window.__marker = 1")
        await pg.click('nav [data-tab=add]'); await pg.locator('input[inputmode=decimal]').first.fill('9.99')
        tweak['on'] = True
        await pg.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
        await pg.wait_for_function("document.body.innerText.indexOf('new version is ready')>=0", timeout=8000)
        check('half-filled form: shows an Update button instead of reloading', await pg.evaluate("window.__marker") == 1)
        await pg.reload(); await pg.wait_for_selector('.card'); await pg.wait_for_timeout(3600)   # baseline now includes the tweak
        tweak['on'] = False
        await pg.evaluate("window.__marker = 1")
        await pg.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
        await pg.wait_for_function("window.__marker === undefined", timeout=8000)
        check('idle app reloads itself when new code is published', True)
        check('no JS errors', not errs, errs)
        await b.close()
    print('\nFAILED: ' + ', '.join(fails) if fails else '\nALL PASSED')
    sys.exit(1 if fails else 0)
asyncio.run(main(sys.argv[1]))
