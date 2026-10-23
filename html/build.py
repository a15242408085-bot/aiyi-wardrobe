"""Package the current Site UI and its public media into one offline HTML file.

Only source files from site/ui and media from site/public are read. Neither
research downloads nor local user databases are inputs to this builder.
"""
from pathlib import Path
from html.parser import HTMLParser
import base64
import json
import re

ROOT = Path(__file__).resolve().parent.parent
UI = ROOT / 'site/ui'
PUBLIC = (ROOT / 'site/public').resolve()
OUTPUT = ROOT / '爱衣橱-暖奶茶网页版.html'
MIME_TYPES = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
}
MEDIA_FOLDERS = ('video-reference', 'studio', 'model-assets', 'wardrobe-assets')
MEDIA_PREFIXES = tuple('/' + folder + '/' for folder in MEDIA_FOLDERS)
MEDIA_DIRECTORY = '(?:' + '|'.join(re.escape(folder) for folder in MEDIA_FOLDERS) + ')'
MEDIA_REF = re.compile(r'^/' + MEDIA_DIRECTORY + r'/[A-Za-z0-9_./-]+$')
MEDIA_LITERAL = re.compile(r'''(?P<quote>["'])(?P<ref>/''' + MEDIA_DIRECTORY + r'''/[A-Za-z0-9_./-]+)(?P=quote)''')
media_cache = {}


def inline_media(ref):
    """Read an explicitly referenced public asset, with no network or traversal."""
    if ref in media_cache:
        return media_cache[ref]
    assert MEDIA_REF.fullmatch(ref), 'Unsupported media reference: ' + ref
    assert '..' not in ref.split('/') and '//' not in ref, 'Unsafe media path: ' + ref
    path = (PUBLIC / ref.lstrip('/')).resolve()
    assert path.is_relative_to(PUBLIC), 'Media is outside site/public: ' + ref
    assert path.is_file(), 'Missing public media: ' + ref
    mime = MIME_TYPES.get(path.suffix.lower())
    assert mime, 'Unsupported media type: ' + ref
    media_cache[ref] = f'data:{mime};base64,' + base64.b64encode(path.read_bytes()).decode('ascii')
    return media_cache[ref]


def inline_seed(value):
    """Reference looks contain nested garment, poster and video asset paths."""
    if isinstance(value, dict):
        return {key: inline_seed(child) for key, child in value.items()}
    if isinstance(value, list):
        return [inline_seed(child) for child in value]
    if isinstance(value, str) and value.startswith(MEDIA_PREFIXES):
        return inline_media(value)
    return value


def inline_literals(source):
    # Also retain support for an asset used directly in script, CSS or HTML.
    return MEDIA_LITERAL.sub(lambda match: match['quote'] + inline_media(match['ref']) + match['quote'], source)


def inline_css(source):
    source = inline_literals(source)
    return re.sub(
        r'url\(\s*(/' + MEDIA_DIRECTORY + r'/[A-Za-z0-9_./-]+)\s*\)',
        lambda match: 'url("' + inline_media(match[1]) + '")', source,
    )


seed = inline_seed(json.loads((UI / 'seed.json').read_text(encoding='utf-8')))
payload = json.dumps(seed, ensure_ascii=False, separators=(',', ':')).replace('&', '\\u0026').replace('<', '\\u003c').replace('>', '\\u003e')
script = '\n\n'.join((UI / name).read_text(encoding='utf-8') for name in ('storage.js', 'api.js', 'studio.js'))
script = re.sub(r'</script', r'<\\/script', inline_literals(script), flags=re.IGNORECASE)
css = inline_css((UI / 'styles.css').read_text(encoding='utf-8'))
document = inline_literals((UI / 'template.html').read_text(encoding='utf-8'))
for marker, content in [('/*__STYLE__*/', css), ('__DATA__', payload), ('/*__SCRIPT__*/', script)]:
    assert document.count(marker) == 1, 'Expected one template marker: ' + marker
    document = document.replace(marker, content, 1)

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

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)

Audit().feed(document)
assert not any(marker in document for marker in ('/*__STYLE__*/', '__DATA__', '/*__SCRIPT__*/', '/*__WARDROBE_EXTENSION__*/'))
assert not MEDIA_LITERAL.search(document), 'Some public media was not inlined.'
assert not re.search(r'\bsk-[A-Za-z0-9_-]{16,}', document), 'A credential-like value must not be packaged.'
assert '/Users/' not in document and 'xwechat_files/' not in document, 'A private source path must not be packaged.'
for url in re.findall(r'url\(\s*["\']?([^"\')\s]+)', css):
    assert url.startswith(('data:', '#')), 'External CSS asset: ' + url
OUTPUT.write_text(document, encoding='utf-8')
print(f'Built {OUTPUT.name} ({OUTPUT.stat().st_size:,} bytes, {len(media_cache)} embedded public assets).')
