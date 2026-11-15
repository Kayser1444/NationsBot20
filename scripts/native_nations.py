"""Render Tabony's MIT-licensed canvas client against the local transport."""
from pathlib import Path, PurePosixPath
import mimetypes
import re
from threading import Lock
from urllib.parse import quote
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / 'scripts/nations-browser/native/match.html'
CACHE = ROOT / '.data/nations-native-assets'
_template = None
_locks = {}
_locks_guard = Lock()


def native_page(username='You', player_count=2):
    global _template
    from django.conf import settings
    if not settings.configured:
        settings.configure(STATIC_URL='/static/', INSTALLED_APPS=[], USE_I18N=False)
        import django
        django.setup()
    if _template is None:
        from django.template import Engine
        source = TEMPLATE.read_text(encoding='utf-8').split('{% block content %}', 1)[1].rsplit('{% endblock %}', 1)[0]
        _template = Engine(libraries={'static': 'django.templatetags.static'}).from_string('{% load static %}' + source)
    from django.template import Context
    from nations.abbr import abbrs
    content = _template.render(Context({
        'IN_PRODUCTION': True, 'user': {'is_authenticated': True, 'username': username, 'is_superuser': False},
        'match': {'match_id': 'local', 'player_count': player_count, 'growth_resources': 2,
                  'title': 'Local evaluation', 'match_type': f'{player_count}-Player'},
        'player_preferences': {'colors': 'Blue, Red, Green, Yellow, Purple, Orange, Cyan, Pink', 'symbols': False},
        'abbrs': abbrs,
    }))
    # Native chat is a local notebook; there is no connection to the live site.
    content = content.replace('Consider all chat permanently public.', 'Local notes only — not sent to Tabony.')
    shell = (ROOT / 'scripts/nations-browser/native-shell.html').read_text(encoding='utf-8')
    return shell.replace('__NATIVE_BOARD__', content).encode('utf-8')


def cached_asset(path):
    """Cache only the renderer's public images and one pinned stylesheet."""
    if path == '/native-assets/bootstrap.min.css':
        relative = 'bootstrap-5.1.0.min.css'
        url = 'https://cdn.jsdelivr.net/npm/bootstrap@5.1.0/dist/css/bootstrap.min.css'
    else:
        prefix = '/static/public/Nations/'
        if not path.startswith(prefix):
            raise ValueError('Unknown asset.')
        relative = path.removeprefix(prefix)
        parts = PurePosixPath(relative).parts
        if not parts or any(part in ('.', '..') for part in parts) or chr(92) in relative or chr(0) in relative or Path(relative).suffix.lower() not in ('.png', '.jpg'):
            raise ValueError('Invalid asset path.')
        url = 'https://games.tabony.net/static/public/Nations/' + quote(relative, safe='/')
    target = CACHE / relative
    if not target.resolve().is_relative_to(CACHE.resolve()):
        raise ValueError('Invalid asset path.')
    with _locks_guard:
        lock = _locks.setdefault(relative, Lock())
    with lock:
        if not target.is_file():
            with urlopen(Request(url, headers={'User-Agent': 'NationsBot local board asset cache'}), timeout=20) as response:
                content = response.read(12 * 1024 * 1024 + 1)
                media = response.headers.get_content_type()
            if len(content) > 12 * 1024 * 1024 or media not in ('image/png', 'image/jpeg', 'text/css'):
                raise ValueError('Unexpected native asset response.')
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_suffix(target.suffix + '.tmp')
            temporary.write_bytes(content)
            temporary.replace(target)
    return target.read_bytes(), mimetypes.guess_type(target)[0] or 'application/octet-stream'
