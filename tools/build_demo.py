"""Builds a single self-contained demo page (no backend, no config) for previewing."""
import re, sys, pathlib
root = pathlib.Path(sys.argv[1])
html = (root / 'index.html').read_text()
ledger = (root / 'ledger.js').read_text()
html = html.replace('<script src="config.js" onerror="void 0"></script>\n', '')
html = html.replace('<script src="ledger.js"></script>', '<script>\n' + ledger + '\n</script>')
html = re.sub(r'<link rel="(manifest|apple-touch-icon)"[^>]*>\n', '', html)
html = html.replace("if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});", '')
pathlib.Path(sys.argv[2]).write_text(html)
print(len(html), 'bytes')
