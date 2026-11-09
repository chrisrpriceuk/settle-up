import asyncio, sys
from playwright.async_api import async_playwright
SVG = """<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 512 512'>
<rect width='512' height='512' fill='#0f766e'/>
<g fill='none' stroke='#fff' stroke-width='34' stroke-linecap='round' stroke-linejoin='round'>
<path d='M150 205h190l-45-45M362 307H172l45 45'/></g>
<circle cx='256' cy='256' r='0' fill='#fff'/></svg>"""
async def main(out):
    async with async_playwright() as p:
        b = await p.chromium.launch()
        for size, name in [(192,'icon-192.png'),(512,'icon-512.png'),(180,'apple-touch-icon.png')]:
            pg = await b.new_page(viewport={'width':size,'height':size})
            await pg.set_content(f"<body style='margin:0'><img style='width:{size}px;height:{size}px;display:block' src='data:image/svg+xml;utf8,{SVG.replace('#','%23')}'></body>")
            await pg.screenshot(path=f"{out}/{name}")
        await b.close()
asyncio.run(main(sys.argv[1]))
