"""The church's website as a whole, so it can be recreated: the menu, each page's sections, the links and calls to
action (giving, sign-ups, livestreams, apps, social), forms and embedded media.

Everything here is plain code over what the crawler already read. Page text is data: it is copied (capped) into
sections, never followed as instructions, and nothing here fetches anything. Links are classified by their address
alone, and only http(s) addresses are kept. Each record has an `id` and an `include` flag the church reviews.
"""
import re
from collections import Counter
from urllib.parse import urldefrag, urlparse

from . import builder_crawl, builder_structured

MAX_SECTION_CHARS = 4000
MAX_SECTIONS = 40
MAX_LINKS = 150
MAX_MEDIA = 40
MAX_FORMS = 20
MAX_MENU = 60

# (kind, provider, host pattern, path pattern or None), most specific first.
PROVIDERS = (
    ('giving', 'Church Center', r'(^|\.)churchcenter\.com$', r'^/giving'),
    ('groups', 'Church Center', r'(^|\.)churchcenter\.com$', r'^/groups'),
    ('calendar', 'Church Center', r'(^|\.)churchcenter\.com$', r'^/calendar'),
    ('form', 'Church Center', r'(^|\.)churchcenter\.com$', r'^/(registrations|people/forms)'),
    ('app', 'Church Center', r'(^|\.)churchcenter\.com$', r'^/?$|^/setup'),
    ('giving', 'Subsplash', r'(^|\.)subsplash\.com$', r'give|giving|/\+'),
    ('app', 'Subsplash', r'(^|\.)subsplash\.com$', None),
    ('giving', 'Pushpay', r'(^|\.)pushpay\.com$', None),
    ('giving', 'Tithe.ly', r'(^|\.)tithe\.ly$', None),
    ('giving', 'Givelify', r'(^|\.)givelify\.com$', None),
    ('giving', 'Vanco', r'(^|\.)(vancopayments|myvanco|eservicepayments)\.com$', None),
    ('giving', 'Online Giving', r'(^|\.)(onlinegiving\.org|easytithe\.com|kindrid\.com|givingfire\.com)$', None),
    ('giving', 'PayPal', r'(^|\.)paypal\.(com|me)$', None),
    ('form', 'Evite', r'(^|\.)evite\.com$', None),
    ('form', 'Eventbrite', r'(^|\.)eventbrite\.[a-z.]+$', None),
    ('form', 'Google Forms', r'^docs\.google\.com$', r'^/forms'),
    ('form', 'Google Forms', r'^forms\.gle$', None),
    ('form', 'JotForm', r'(^|\.)jotform\.com$', None),
    ('form', 'Typeform', r'(^|\.)typeform\.com$', None),
    ('form', 'SignUpGenius', r'(^|\.)signupgenius\.com$', None),
    ('form', 'Form', r'(^|\.)(wufoo|formstack|cognitoforms|formsite|123formbuilder)\.com$', None),
    ('form', 'Church software', r'(^|\.)(ccbchurch\.com|breezechms\.com|elvanto\.[a-z.]+|fellowshipone\.com|'
                                r'onrealm\.org|shelbynextchms\.com)$', None),
    ('calendar', 'Google Calendar', r'^calendar\.google\.com$', None),
    ('livestream', 'Castr', r'(^|\.)castr\.(io|com)$', None),
    ('livestream', 'BoxCast', r'(^|\.)boxcast\.(tv|com)$', None),
    ('livestream', 'Resi', r'(^|\.)(resi\.io|livingasone\.com|resi\.media)$', None),
    ('livestream', 'Church Online', r'(^|\.)churchonline\.org$', None),
    ('livestream', 'YouTube', r'(^|\.)youtube\.com$', r'/live(/|$)|/streams'),
    ('livestream', 'Facebook', r'(^|\.)facebook\.com$', r'/live(/|$)|/videos/live'),
    ('livestream', 'Vimeo', r'(^|\.)vimeo\.com$', r'^/event/'),
    ('video', 'YouTube', r'(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be)$', None),
    ('video', 'Vimeo', r'(^|\.)vimeo\.com$', None),
    ('podcast', 'Apple Podcasts', r'^podcasts\.apple\.com$', None),
    ('podcast', 'Spotify', r'^open\.spotify\.com$', None),
    ('podcast', 'Podcast', r'(^|\.)(soundcloud\.com|anchor\.fm|podbean\.com|buzzsprout\.com|libsyn\.com)$', None),
    ('app', 'App Store', r'^apps\.apple\.com$', None),
    ('app', 'Google Play', r'^play\.google\.com$', None),
    ('map', 'Google Maps', r'(^|\.)google\.[a-z.]+$', r'^/maps'),
    ('map', 'Google Maps', r'^(maps\.google\.[a-z.]+|maps\.app\.goo\.gl|goo\.gl)$', None),
    ('map', 'Apple Maps', r'^maps\.apple\.com$', None),
    ('social', 'Facebook', r'(^|\.)(facebook\.com|fb\.me)$', None),
    ('social', 'Instagram', r'(^|\.)instagram\.com$', None),
    ('social', 'X', r'(^|\.)(twitter\.com|x\.com)$', None),
    ('social', 'TikTok', r'(^|\.)tiktok\.com$', None),
    ('social', 'LinkedIn', r'(^|\.)linkedin\.com$', None),
    ('social', 'Threads', r'(^|\.)threads\.net$', None),
)
_PROVIDERS = [(kind, name, re.compile(host, re.I), re.compile(path, re.I) if path else None)
              for kind, name, host, path in PROVIDERS]
DOCUMENT_RE = re.compile(r'\.(pdf|docx?|pptx?|xlsx?)$', re.I)
# The order links are listed in for review: what a church most needs to carry over first.
KIND_ORDER = ('giving', 'livestream', 'form', 'groups', 'calendar', 'app', 'video', 'podcast', 'social', 'map',
              'document', 'page', 'external')
CTA_WORDS = re.compile(r'\b(give|giving|donate|plan (a|your) visit|i\'?m new|register|sign ?up|join|watch|listen|'
                       r'connect|get (started|involved|connected)|learn more|rsvp|apply|subscribe|download|contact)\b', re.I)
EMBED_LINE = re.compile(r'\[embed (\d+)\]')
SEARCH_FIELDS = {'q', 's', 'search', 'query', 'keyword', 'keywords'}


def classify(url, origin):
    """(kind, provider) for a link, from its address alone."""
    parsed = urlparse(url)
    host, path = (parsed.hostname or '').lower(), parsed.path or '/'
    for kind, name, host_re, path_re in _PROVIDERS:
        if host_re.search(host) and (path_re is None or path_re.search(path)):
            return kind, name
    if DOCUMENT_RE.search(path):
        return 'document', ''
    if builder_crawl.same_site(url, origin):
        return ('giving', '') if builder_crawl.page_type(url, '') == 'give' else ('page', '')
    if re.search(r'(^|/)(give|giving|donate)(/|$)', path, re.I):
        return 'giving', host
    return 'external', host


def _web(url):
    return urlparse(url).scheme in ('http', 'https')


def _norm(text):
    return ' '.join(str(text or '').split()).lower()


def navigation(home, pages_by_url):
    """The main menu as a tree [{label, url, page_id, children}], and the footer links, from the home page's
    <nav>/<header> lists. A site without list menus falls back to its navigation links, flat."""
    nav = home.get('nav') or []
    blocks = Counter(b for b, tag, *_ in nav if tag != 'footer')
    main_block = max(blocks, key=lambda b: (blocks[b], -b)) if blocks else None
    footer_blocks = Counter(b for b, tag, *_ in nav if tag == 'footer')

    def node(label, url):
        url = url if url and _web(url) else ''
        return {'label': label, 'url': url, 'page_id': pages_by_url.get(url, ''), 'children': []}

    main, stack, seen = [], [], set()
    for block, _, depth, label, url in nav:
        if block != main_block:
            continue
        depth = min(depth, 3)
        stack = stack[:depth - 1]
        if depth == 1:
            if (label, url) in seen:  # a second (mobile) copy of the same menu
                break
            seen.add((label, url))
            item = node(label, url)
            main.append(item)
            stack = [item]
        elif stack and len(stack) >= depth - 1:
            item = node(label, url)
            stack[depth - 2]['children'].append(item)
            stack.append(item)
        if len(main) >= MAX_MENU:
            break
    if not main:
        for url, label, in_nav in home.get('anchors', []):
            if in_nav and label and _web(url) and (label, url) not in seen and len(main) < MAX_MENU:
                seen.add((label, url))
                main.append(node(label, url))
    footer = []
    if footer_blocks:
        block = max(footer_blocks, key=lambda b: footer_blocks[b])
        footer = [{'label': label, 'url': url} for b, _, _, label, url in nav if b == block and url and _web(url)]
    return {'main': main, 'footer': footer[:MAX_MENU]}


def _boilerplate(sources):
    """Lines (menus, footers) that most pages repeat: not part of any one page's content."""
    if len(sources) < 3:
        return {label for s in sources for *_, label, _ in s.get('nav', [])}
    counts = Counter(line for s in sources for line in set(s['text'].split('\n')))
    return {line for line, n in counts.items() if n > len(sources) / 2}


def sections(source, boilerplate=frozenset()):
    """The page's content split at its headings: [{heading, level, text, links, embeds}]. `links` ({text, url})
    are the page's links whose text is in a line of that section (buttons and calls to action); `embeds` are the
    players and forms embedded there."""
    headings = list(source.get('headings') or [])
    anchors = {}
    for url, text, in_nav in source.get('anchors', []):
        if text and not in_nav and _web(url):
            anchors.setdefault(_norm(text), (url, text))
    embeds = source.get('embeds') or []

    def fresh(heading='', level=0):
        return {'heading': heading, 'level': level, 'lines': [], 'links': [], 'embeds': []}
    out, current, pos = [], fresh(), 0
    for line in source['text'].split('\n'):
        if pos < len(headings) and _norm(line) == _norm(headings[pos][1]):
            if current['lines'] or current['heading'] or current['embeds']:
                out.append(current)
            current = fresh(headings[pos][1], headings[pos][0])
            pos += 1
            continue
        marker = EMBED_LINE.fullmatch(line)
        if marker:
            index = int(marker.group(1)) - 1
            if index < len(embeds) and _web(embeds[index][0]):
                current['embeds'].append(builder_structured.canonical_video(embeds[index][0]))
            continue
        if line in boilerplate:
            continue
        current['lines'].append(line)
        found = _norm(line)
        for text, (url, label) in anchors.items():
            if url not in [l['url'] for l in current['links']] and (text == found or len(text) >= 4 and text in found):
                current['links'].append({'text': label, 'url': url})
    out.append(current)
    result = []
    for section in out:
        text = '\n'.join(section['lines'])[:MAX_SECTION_CHARS]
        if text or section['heading'] or section['embeds']:
            result.append({'heading': section['heading'], 'level': section['level'], 'text': text,
                           'links': section['links'][:20], 'embeds': section['embeds'][:10]})
    return result[:MAX_SECTIONS]


def _heading_of(source_sections, text):
    for section in source_sections:
        if text and any(_norm(text) == _norm(line) for line in section['text'].split('\n')):
            return section['heading']
    return ''


def build(sources, start_url):
    """The site model for a crawled site. Only page sources take part."""
    pages = [s for s in sources if s.get('kind', 'page') == 'page' and s.get('url')]
    if not pages:
        return {'navigation': {'main': [], 'footer': []}, 'pages': [], 'links': [], 'forms': [], 'media': []}
    origin = urlparse(start_url).netloc
    pages_by_url = {p['url']: p['id'] for p in pages}
    menu = navigation(pages[0], pages_by_url)
    in_menu = set()

    def walk(items):
        for item in items:
            in_menu.add(item['url'])
            walk(item['children'])
    walk(menu['main'])
    boilerplate = _boilerplate(pages)

    site_pages, links, forms, media = [], {}, {}, {}
    for page in pages:
        page_sections = sections(page, boilerplate)
        post = builder_crawl.is_post(page['url'])
        site_pages.append({
            'id': page['id'], 'url': page['url'], 'path': urlparse(page['url']).path or '/',
            'title': page.get('title', ''), 'page_type': page.get('page_type', 'other'),
            'in_menu': page['url'] in in_menu or page is pages[0], 'sections': page_sections,
            'section_count': len(page_sections),
            'include': not post})
        ctas = set(page.get('ctas', []))
        for url, text, in_nav in page.get('anchors', []):
            if not _web(url):
                continue
            kind, provider = classify(url, origin)
            cta = url in ctas or bool(text and len(text) <= 40 and CTA_WORDS.search(text))
            if kind == 'page' and not cta:
                continue
            entry = links.setdefault(url, {'url': url, 'text': '', 'kind': kind, 'provider': provider,
                                          'pages': [], 'cta': False, 'in_menu': False, 'context': ''})
            entry['text'] = entry['text'] or text
            entry['cta'] = entry['cta'] or cta
            entry['in_menu'] = entry['in_menu'] or in_nav
            entry['context'] = entry['context'] or _heading_of(page_sections, text)
            if page['id'] not in entry['pages'] and len(entry['pages']) < 10:
                entry['pages'].append(page['id'])
        for form in page.get('forms', []):
            names = {f['name'].lower() for f in form['fields']}
            if not form['fields'] or names <= SEARCH_FIELDS or 'search' in form['action'].lower():
                continue
            key = (urldefrag(form['action'])[0], tuple(sorted(names)))
            entry = forms.setdefault(key, {
                'action': form['action'] if _web(form['action']) else '', 'method': form['method'],
                'name': form.get('name', ''), 'fields': form['fields'], 'submit': form.get('submit', ''),
                'provider': classify(form['action'], origin)[1] if _web(form['action']) else '',
                'embedded': False, 'pages': [], 'context': ''})
            if page['id'] not in entry['pages'] and len(entry['pages']) < 10:
                entry['pages'].append(page['id'])
        for src, title in page.get('embeds', []):
            if not _web(src):
                continue
            kind, provider = classify(src, origin)
            url = builder_structured.canonical_video(src) if kind == 'video' else src
            if kind == 'form':
                entry = forms.setdefault((url, ()), {
                    'action': url, 'method': 'get', 'name': title, 'fields': [], 'submit': '', 'provider': provider,
                    'embedded': True, 'pages': [], 'context': ''})
            else:
                entry = media.setdefault(url, {'url': url, 'title': title, 'kind': kind if kind != 'page' else 'embed',
                                               'provider': provider, 'pages': []})
            if page['id'] not in entry['pages'] and len(entry['pages']) < 10:
                entry['pages'].append(page['id'])

    ordered = sorted(links.values(), key=lambda l: (KIND_ORDER.index(l['kind']), not l['cta'], l['url']))[:MAX_LINKS]
    return {
        'source_url': start_url if _web(start_url) else '',
        'navigation': menu,
        'pages': site_pages,
        'links': [{'id': f'l{n}', **l, 'include': True} for n, l in enumerate(ordered, 1)],
        'forms': [{'id': f'f{n}', **f, 'include': True} for n, f in enumerate(list(forms.values())[:MAX_FORMS], 1)],
        'media': [{'id': f'm{n}', **m, 'include': True} for n, m in enumerate(list(media.values())[:MAX_MEDIA], 1)],
    }


def slug(path, taken):
    """A page address on the new site from the old one: "/" is home, "/about-us/" is about-us."""
    base = re.sub(r'[^a-z0-9]+', '-', urlparse(path).path.lower().removesuffix('.html').removesuffix('.htm')).strip('-')
    base = (base or 'home')[:70].strip('-') or 'home'
    name, n = base, 2
    while name in taken:
        name, n = f'{base}-{n}', n + 1
    taken.add(name)
    return name


def page_title(page, church_name=''):
    """"Plan a Visit - Harvest Point Church" is "Plan a Visit"; a title that is only the church's name falls back
    to the page's first heading."""
    from .builder import TITLE_SPLIT, CHURCH_WORDS
    parts = [p.strip() for p in TITLE_SPLIT.split(page.get('title') or '') if p.strip()]
    own = [p for p in parts if _norm(p) != _norm(church_name) and not (len(parts) > 1 and CHURCH_WORDS.search(p))]
    heading = next((s['heading'] for s in page.get('sections', []) if s['heading']), '')
    title = (own[0] if own else '') or heading or (parts[0] if parts else '') or page.get('path', '/')
    return 'Home' if page.get('page_type') == 'home' and not own else title[:200]


def content(site, church_name=''):
    """ChurchContent `site` and `pages` sections for what the church kept. Page sections must be loaded."""
    kept = [p for p in site.get('pages', []) if p.get('include')]
    taken, slugs = set(), {}
    for page in kept:
        slugs[page['id']] = slug(page['path'], taken)
    dropped = {l['url'] for l in site.get('links', []) if not l.get('include')}
    left_out = {p['id'] for p in site.get('pages', []) if not p.get('include')}

    def menu(items):
        out = []
        for item in items:
            children = menu(item.get('children', []))
            page = slugs.get(item.get('page_id', ''), '')
            url = '' if page else item.get('url', '')
            if url in dropped or item.get('page_id') in left_out:
                url = ''  # the church left this page or link out; the menu does not send people back to it
            if page or url or children:
                out.append({'label': item['label'], 'page': page, 'url': url, 'children': children})
        return out

    pages = []
    for page in kept:
        sections = [{'heading': s['heading'], 'level': s['level'], 'text': s['text'],
                     'links': [l for l in s.get('links', []) if l['url'] not in dropped],
                     'embeds': [e for e in s.get('embeds', []) if e not in dropped]}
                    for s in page.get('sections', [])]
        pages.append({'slug': slugs[page['id']], 'title': page_title(page, church_name),
                      'page_type': page.get('page_type', ''), 'source_url': page['url'], 'sections': sections})
    forms = [{'action': f['action'], 'name': f['name'], 'fields': f['fields'], 'submit': f['submit'],
              'provider': f['provider'], 'embedded': f['embedded'],
              'page': next((slugs[p] for p in f['pages'] if p in slugs), '')}
             for f in site.get('forms', []) if f.get('include')]
    navigation = site.get('navigation', {})
    assets = [a for a in site.get('assets', []) if a.get('include')]
    # The logo and icon are only used once the church has said it may use them.
    allowed_images = {role: next((a['url'] for a in assets if a['role'] == role and a.get('rights')), '')
                      for role in ('logo', 'favicon')}
    return {
        'site': {'navigation': {'main': menu(navigation.get('main', [])),
                                'footer': menu([{**f, 'children': []} for f in navigation.get('footer', [])])},
                 'links': [{k: l[k] for k in ('url', 'text', 'kind', 'provider', 'cta', 'context')}
                           for l in site.get('links', []) if l.get('include')],
                 'forms': forms,
                 'media': [{k: m[k] for k in ('url', 'title', 'kind', 'provider')}
                           for m in site.get('media', []) if m.get('include')],
                 'theme': {**site.get('theme', {}), **allowed_images},
                 'assets': [{k: a[k] for k in ('url', 'role', 'alt', 'rights')} for a in assets],
                 'source_url': site.get('source_url', '')},
        'pages': pages,
    }
