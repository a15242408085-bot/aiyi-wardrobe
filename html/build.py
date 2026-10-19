"""Build the self-contained HTML experience using the repository's sample assets."""
from pathlib import Path
import base64
import json
from html.parser import HTMLParser

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
seed = json.loads((ROOT / 'site/ui/seed.json').read_text(encoding='utf-8'))
seed['assets']['hero'] = 'data:image/png;base64,' + base64.b64encode((ROOT / 'site/public/studio/model-outfit-cutout.png').read_bytes()).decode('ascii')
seed['example']['description'] = '这是此前已经生成的五件套试穿案例。包袋比例、牛仔裤褶皱和鞋面线条仍有偏差，可对照原图查看。新搭配可以保存组合；这个 HTML 文件不连接 AI 生成服务。'
payload = json.dumps(seed, ensure_ascii=False, separators=(',', ':')).replace('&', '\\u0026').replace('<', '\\u003c').replace('>', '\\u003e')
styles = (HERE / 'base.css').read_text(encoding='utf-8') + '\n' + (HERE / 'theme.css').read_text(encoding='utf-8')
script = (HERE / 'app.js').read_text(encoding='utf-8')
document = (HERE / 'template.html').read_text(encoding='utf-8').replace('/*__STYLE__*/', styles).replace('__DATA__', payload).replace('/*__SCRIPT__*/', script)

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
output = ROOT / '爱衣橱-暖奶茶网页版.html'
output.write_text(document, encoding='utf-8')
print(f'Built {output.name} ({output.stat().st_size:,} bytes).')
