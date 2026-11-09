"""Renders favicon + app icons from the same two-arrows glyph. Usage: make_icons.py <docs-dir>"""
import asyncio, sys
from playwright.async_api import async_playwright
GLYPH = ("<g fill='none' stroke='#fff' stroke-width='6' stroke-linecap='round' stroke-linejoin='round'>"
         "<path d='M16 24H48M41 17L48 24L41 31'/><path d='M48 42H16M23 35L16 42L23 49'/></g>")
def svg(rounded):
    rx = " rx='14'" if rounded else ""
    return f"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64'{rx} fill='#0f766e'/>{GLYPH}</svg>"
async def main(out):
    async with async_playwright() as p:
        b = await p.chromium.launch()
        # full-bleed squares for home-screen icons (the OS applies its own rounding)
        for size, name, rounded in [(192,'icon-192.png',False),(512,'icon-512.png',False),(180,'apple-touch-icon.png',False),(32,'favicon-32.png',True)]:
            pg = await b.new_page(viewport={'width':size,'height':size})
            s = svg(rounded).replace('#','%23')
            await pg.set_content(f"<body style='margin:0;background:transparent'><img style='width:{size}px;height:{size}px;display:block' src=\"data:image/svg+xml;utf8,{s}\"></body>")
            await pg.screenshot(path=f"{out}/{name}", omit_background=True)
        await b.close()
asyncio.run(main(sys.argv[1]))
