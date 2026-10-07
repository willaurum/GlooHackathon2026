"""The look of a church's site: colors and fonts from its public styles, and its logo, icon and sharing image.

Only signals a visitor's browser already gets are read: <meta name="theme-color">, the home page's <style> blocks
and up to MAX_STYLESHEETS linked stylesheets (each host's robots.txt is obeyed, like every other fetch). Values are
parsed by code into a few validated fields (hex colors, plain font names); no CSS from the old site is ever served.
Images are referenced, not copied, and stay hidden until the church confirms it may use them (Asset.rights).
"""
import re

MAX_STYLESHEETS = 3
MAX_CSS = 300_000
MIN_TEXT_CONTRAST = 4.5
MIN_BUTTON_CONTRAST = 3.0

HEX_RE = re.compile(r'#([0-9a-f]{3}|[0-9a-f]{6})\b', re.I)
RGB_RE = re.compile(r'rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})(?:[\s,/]+([\d.]+%?))?\s*\)', re.I)
NAMED = {'white': '#ffffff', 'black': '#000000'}
VAR_RE = re.compile(r'(--[\w-]+)\s*:\s*([^;}{]+)')
RULE_RE = re.compile(r'([^{}]+)\{([^{}]*)\}')
FONT_RE = re.compile(r"^[A-Za-z0-9 '\-]{1,60}$")
GENERIC_FONTS = {'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'inherit', 'initial',
                 '-apple-system', 'blinkmacsystemfont', 'ui-sans-serif', 'ui-serif', 'arial', 'helvetica',
                 'helvetica neue', 'times new roman', 'georgia', 'verdana', 'segoe ui', 'roboto'}
# Custom property names that name the brand colors, most telling first.
PRIMARY_VARS = ('primary', 'brand', 'main', 'theme')
ACCENT_VARS = ('accent', 'button', 'link', 'highlight', 'secondary')


def color(value):
    """'#rrggbb' for a CSS color written as hex, rgb()/rgba() (opaque) or white/black; else ''."""
    value = (value or '').strip().lower()
    if value in NAMED:
        return NAMED[value]
    match = HEX_RE.fullmatch(value)
    if match:
        digits = match.group(1)
        if len(digits) == 3:
            digits = ''.join(ch * 2 for ch in digits)
        return '#' + digits.lower()
    match = RGB_RE.match(value)
    if match:
        alpha = match.group(4)
        if alpha and (float(alpha.rstrip('%')) / (100 if alpha.endswith('%') else 1)) < 0.9:
            return ''
        channels = [int(c) for c in match.groups()[:3]]
        if all(0 <= c <= 255 for c in channels):
            return '#' + ''.join(f'{c:02x}' for c in channels)
    return ''


def _luminance(hex_color):
    def channel(c):
        c = c / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (int(hex_color[i:i + 2], 16) for i in (1, 3, 5))
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)


def contrast(a, b):
    la, lb = sorted((_luminance(a), _luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def darken(hex_color, amount):
    r, g, b = (int(hex_color[i:i + 2], 16) for i in (1, 3, 5))
    return '#' + ''.join(f'{max(0, round(c * (1 - amount))):02x}' for c in (r, g, b))


def readable_on_white(hex_color, minimum=MIN_BUTTON_CONTRAST):
    """The color, darkened just enough for white text on it (buttons) to be readable; '' if it never gets there."""
    for step in range(0, 11):
        candidate = darken(hex_color, step * 0.08)
        if contrast(candidate, '#ffffff') >= minimum:
            return candidate
    return ''


def font(value):
    """The first named font family in a font-family list, if it is a plain name; else ''."""
    for name in (value or '').split(','):
        name = name.strip().strip('"\'').strip()
        if name and name.lower() not in GENERIC_FONTS and not name.lower().startswith('var(') and FONT_RE.match(name):
            return name
    return ''


def _strip_comments(css):
    return re.sub(r'/\*.*?\*/', '', css, flags=re.S)


def read_css(css):
    """{variables, rules} from CSS text: custom properties, and declarations per selector (no nesting kept)."""
    css = _strip_comments(css or '')[:MAX_CSS]
    css = re.sub(r'@(import|charset|namespace)\b(?:url\([^)]*\)|"[^"]*"|\'[^\']*\'|[^;{}"\'])*;', '', css)
    css = re.sub(r'@(media|supports|layer)[^{]*\{', '', css)  # read rules inside @media as if they were not
    variables, rules = {}, []
    for selector, body in RULE_RE.findall(css):
        declarations = {}
        for prop, value in re.findall(r'([\w-]+)\s*:\s*([^;]+)', body):
            declarations[prop.strip().lower()] = value.strip().removesuffix('!important').strip()
        for name, value in VAR_RE.findall(body):
            variables.setdefault(name.strip().lower(), value.strip())
        rules.append((' '.join(selector.split()).lower(), declarations))
    return {'variables': variables, 'rules': rules}


def _resolve(value, variables, depth=0):
    match = re.fullmatch(r'var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)', (value or '').strip())
    if not match or depth > 3:
        return value
    return _resolve(variables.get(match.group(1).lower(), match.group(2) or ''), variables, depth + 1)


def _declared(rules, variables, selectors, props):
    """The first color or font declared for any of `selectors` (exact selector-list members)."""
    for selector, declarations in rules:
        members = {s.strip() for s in selector.split(',')}
        if members & selectors:
            for prop in props:
                if prop in declarations:
                    yield _resolve(declarations[prop], variables)


def _first_color(values):
    for value in values:
        # "background: #1f4e5f url(...)" names its color among other parts.
        for part in [value, *re.split(r'\s+(?![^(]*\))', value or '')]:
            found = color(part)
            if found:
                return found
        # A gradient ("linear-gradient(#5d7a4a, #3e5631)") is the brand color too: take its last, deepest stop.
        if 'gradient(' in (value or '').lower():
            stops = [color(m.group(0)) for m in re.finditer(r'#[0-9a-f]{3,6}\b|rgba?\([^)]*\)', value, re.I)]
            stops = [s for s in stops if s]
            if stops:
                return stops[-1]
    return ''


# Site builders name their parts their own way (SnapPages: "#sp-header", ".sp-scheme-0 .sp-button"), so beyond the
# usual selectors a header, menu or button is recognized by the last part of a selector, ignoring hover and other states.
HEADER_PART = re.compile(r'(?:^|[\s>+~])(?:header|nav|[#.][\w-]*(?:header|navbar|topbar|masthead|nav))$', re.I)
BUTTON_PART = re.compile(r'(?:^|[\s>+~])(?:button|[#.][\w-]*(?:button|btn|cta)(?:-primary)?)$', re.I)
# Colors that say nothing about a brand: near white, near black and grays.
def _saturation(hex_color):
    r, g, b = (int(hex_color[i:i + 2], 16) / 255 for i in (1, 3, 5))
    high, low = max(r, g, b), min(r, g, b)
    return 0 if high == 0 else (high - low) / high


def _matching(rules, variables, part, props):
    """Colors declared for selectors whose last part matches `part` (states like :hover left out), in order."""
    for selector, declarations in rules:
        if any(':' not in member and part.search(member.strip()) for member in selector.split(',')):
            for prop in props:
                if prop in declarations:
                    yield _resolve(declarations[prop], variables)


def _brand_colors(css_texts):
    """Saturated colors by how often the site's CSS uses them, most used first: the last resort for a brand color."""
    counts = {}
    for text in css_texts:
        for match in re.finditer(r'#[0-9a-f]{3,6}\b|rgba?\([^)]*\)', _strip_comments(text or '')[:MAX_CSS], re.I):
            found = color(match.group(0))
            if found and _saturation(found) >= 0.35 and 0.03 <= _luminance(found) <= 0.75:
                counts[found] = counts.get(found, 0) + 1
    return sorted(counts, key=lambda c: -counts[c])


def theme(meta, css_texts):
    """Theme fields (church_content.Theme) from a home page's meta tags and CSS texts. Empty fields keep the
    church site's own defaults."""
    variables, rules = {}, []
    for text in css_texts:
        parsed = read_css(text)
        for name, value in parsed['variables'].items():
            variables.setdefault(name, value)
        rules += parsed['rules']

    def var_color(words):
        for word in words:
            pattern = re.compile(rf'^--(?:[\w-]*-)?{word}(?:-color|-colour|-bg|-background)?$', re.I)
            for name, value in variables.items():
                found = color(_resolve(value, variables)) if pattern.match(name) else ''
                if found and _luminance(found) < 0.8:  # a near-white "secondary" is a background, not a brand color
                    return found
        return ''

    primary = (color(meta.get('theme-color', '')) or var_color(PRIMARY_VARS)
               or _first_color(_declared(rules, variables, {'header', '.site-header', '.header', '#header', 'nav', '#nav',
                                                            '.nav', '.navbar', '#navbar', '.topbar', '#topbar'},
                                         ('background-color', 'background')))
               or _first_color(_matching(rules, variables, HEADER_PART, ('background-color', 'background')))
               or _first_color(_declared(rules, variables, {'h1', 'h2', 'h1, h2', 'h3', 'h2, h3', 'h1, h2, h3'}, ('color',))))
    # A menu's hover color is the site's highlight when it has no buttons; a plain link color is the last resort.
    accent = (var_color(ACCENT_VARS)
              or _first_color(_declared(rules, variables, {'.btn', '.button', 'button', '.btn-primary', '.cta'},
                                        ('background-color', 'background')))
              or _first_color(_matching(rules, variables, BUTTON_PART, ('background-color', 'background')))
              or _first_color(_declared(rules, variables, {'#nav a:hover', 'nav a:hover', '.nav a:hover', '#nav a:hover, #nav a:focus',
                                                           '.navbar a:hover', '#menu a:hover', '.menu a:hover'},
                                        ('background-color', 'background')))
              or _first_color(_declared(rules, variables, {'a'}, ('color',))))
    # The page the content sits on: a centered wrapper's background when the body is only a backdrop around it.
    page = _first_color(_declared(rules, variables, {'#wrap', '#wrapper', '.wrapper', '#container', '.container', '#page',
                                                     '.page', '#site', '.site'}, ('background-color', 'background')))
    background = _first_color(_declared(rules, variables, {'body', 'html'}, ('background-color', 'background')))
    if page and _luminance(page) >= 0.6:
        background = page
    text = _first_color(_declared(rules, variables, {'body', 'html'}, ('color',)))
    body_font = next(filter(None, map(font, _declared(rules, variables, {'body', 'html'}, ('font-family',)))), '')
    heading_font = next(filter(None, map(font, _declared(rules, variables, {'h1', 'h2', 'h1, h2, h3', 'h1, h2'},
                                                         ('font-family',)))), '')
    # Nothing named a brand color: the saturated colors the site uses most (the first is the accent, a second the primary).
    brand = _brand_colors(css_texts)
    if not primary and not accent and brand:
        accent, primary = brand[0], (brand[1] if len(brand) > 1 else brand[0])
    elif not accent and brand:
        accent = next((c for c in brand if c != primary), primary)
    elif not primary and brand:
        primary = accent
    # Colors the church's pages can actually use: buttons carry white text, and text must read on the background.
    primary = readable_on_white(primary) if primary else ''
    accent = readable_on_white(accent) if accent else ''
    if background and _luminance(background) < 0.6:
        background = ''  # the new site is light; a dark page color would fight its cards
    if text and contrast(text, background or '#ffffff') < MIN_TEXT_CONTRAST:
        text = ''
    return {'primary': primary, 'accent': accent, 'background': background, 'text': text,
            'heading_font': heading_font, 'body_font': body_font, 'logo': '', 'favicon': ''}


def assets(home):
    """The logo, icon and sharing image of a crawled home page, as Asset records awaiting the church's say-so."""
    out, seen = [], set()

    def add(url, role, alt=''):
        if url and url.startswith(('http://', 'https://')) and url not in seen and len(url) <= 500:
            seen.add(url)
            out.append({'id': f'a{len(out) + 1}', 'url': url, 'role': role, 'alt': alt[:200], 'include': True,
                        'rights': False})
    for src, alt in home.get('logos', [])[:1]:
        add(src, 'logo', alt)
    icons = sorted(home.get('icons', []), key=lambda icon: ('apple-touch-icon' not in icon[1], icon[2] == ''))
    for href, _, _ in icons[:1]:
        add(href, 'favicon')
    meta = home.get('meta', {})
    add(meta.get('og:image', ''), 'share', meta.get('og:image:alt', ''))
    return out


def read(home, fetch_css=None, allowed=lambda url: True, notes=None):
    """(theme, assets) for a crawled home page. `fetch_css(url) -> text` reads linked stylesheets (skipped when
    None); `allowed(url)` is the robots.txt check for the stylesheet's host."""
    texts = [home.get('css', '')]
    skipped = 0
    for url in home.get('styles', [])[:MAX_STYLESHEETS] if fetch_css else []:
        if not url.startswith(('http://', 'https://')) or not allowed(url):
            skipped += 1
            continue
        try:
            texts.append(fetch_css(url)[:MAX_CSS])
        except Exception:
            skipped += 1
    if skipped and notes is not None:
        notes.append('Some of the site\'s style files could not be read, so its colors may need a check.')
    return theme(home.get('meta', {}), texts), assets(home)
