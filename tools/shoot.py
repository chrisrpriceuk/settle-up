import asyncio, sys, http.server, threading, functools
from playwright.async_api import async_playwright
root = sys.argv[1]
h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=root)
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 8765), h)
threading.Thread(target=srv.serve_forever, daemon=True).start()
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width':390,'height':844}, device_scale_factor=2, is_mobile=True, has_touch=True)
        pg = await ctx.new_page()
        errs = []
        pg.on('pageerror', lambda e: errs.append('PAGEERROR '+str(e)))
        pg.on('console', lambda m: errs.append('CONSOLE '+m.text) if m.type=='error' else None)
        await pg.goto('http://127.0.0.1:8765/index.html')
        await pg.wait_for_selector('.card')
        await pg.screenshot(path='/tmp/s1_home.png')
        txt = await pg.inner_text('#view'); print('HOME:', txt.replace('\n',' | ')[:400])
        # add an expense
        await pg.click('nav [data-tab=add]')
        await pg.fill('#amt','24.50'); await pg.fill('#desc','Pizza night')
        await pg.click('text=60%')
        await pg.screenshot(path='/tmp/s2_add.png')
        print('PREVIEW:', await pg.inner_text('.preview'))
        await pg.click('button[type=submit]')
        await pg.wait_for_selector('.toast')
        print('TOAST:', await pg.inner_text('.toast'))
        await pg.click('nav [data-tab=home]')
        print('HOME2:', (await pg.inner_text('#view')).replace('\n',' | ')[:300])
        # settle Main
        await pg.click('text=Settle up Main')
        await pg.wait_for_selector('dialog[open]')
        await pg.screenshot(path='/tmp/s3_settle.png')
        print('SETTLE:', (await pg.inner_text('dialog')).replace('\n',' | '))
        await pg.click('text=Mark as paid')
        await pg.wait_for_timeout(300)
        print('HOME3:', (await pg.inner_text('#view')).replace('\n',' | ')[:300])
        await pg.click('nav [data-tab=history]')
        await pg.screenshot(path='/tmp/s4_hist.png')
        # void a settlement then check debt returns
        await pg.click('.item >> nth=0'); await pg.wait_for_selector('dialog[open]')
        print('DETAIL:', (await pg.inner_text('dialog')).replace('\n',' | '))
        await pg.click('dialog >> text=Void'); await pg.click('dialog >> button:has-text("Void")')
        await pg.wait_for_timeout(300)
        await pg.click('nav [data-tab=home]')
        print('HOME4:', (await pg.inner_text('#view')).replace('\n',' | ')[:200])
        # switch person
        await pg.click('#who'); await pg.wait_for_timeout(200)
        print('AS NATALIE:', (await pg.inner_text('#view')).replace('\n',' | ')[:200])
        await pg.screenshot(path='/tmp/s5_natalie.png')
        # dark mode
        await pg.emulate_media(color_scheme='dark'); await pg.screenshot(path='/tmp/s6_dark.png')
        print('ERRORS:', errs)
        await b.close()
asyncio.run(main())
