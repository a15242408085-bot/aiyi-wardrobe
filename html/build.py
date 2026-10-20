"""Package the shared web UI into a portable, offline HTML file."""
from pathlib import Path
from html.parser import HTMLParser
import base64
import json

ROOT = Path(__file__).resolve().parent.parent
UI = ROOT / 'site/ui'
seed = json.loads((UI / 'seed.json').read_text(encoding='utf-8'))
seed['assets']['hero'] = 'data:image/png;base64,' + base64.b64encode(
    (ROOT / 'site/public/studio/model-outfit-cutout.png').read_bytes()
).decode('ascii')
payload = json.dumps(seed, ensure_ascii=False, separators=(',', ':')).replace('&', '\\u0026').replace('<', '\\u003c').replace('>', '\\u003e')
script = (UI / 'app.js').read_text(encoding='utf-8').replace(
    "'/studio/model-outfit-cutout.png'", "asset('seed:hero')"
).replace('</script', '<\\/script')
document = (UI / 'template.html').read_text(encoding='utf-8').replace(
    '/*__STYLE__*/', (UI / 'styles.css').read_text(encoding='utf-8')
).replace('__DATA__', payload).replace('/*__SCRIPT__*/', script)

class Audit(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = set()
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if attrs.get('id'):
            assert attrs['id'] not in self.ids, 'Duplicate ID: ' + attrs['id']
            self.ids.add(attrs['id'])
        for name in ('src', 'href', 'poster'):
            value = attrs.get(name, '')
            assert not value or value.startswith(('#', 'data:', 'blob:')), 'External asset: ' + value

Audit().feed(document)
assert not any(marker in document for marker in ('/*__STYLE__*/', '__DATA__', '/*__SCRIPT__*/'))
assert '/studio/model-outfit-cutout.png' not in script
output = ROOT / '爱衣橱-暖奶茶网页版.html'
output.write_text(document, encoding='utf-8')
print(f'Built {output.name} ({output.stat().st_size:,} bytes).')
