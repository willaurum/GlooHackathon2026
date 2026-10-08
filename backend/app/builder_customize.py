"""Tekton's preview agent: the church asks for a change in plain words while looking at its new site.

Each change is a checked operation stored on the draft (`draft['custom']`) and applied on top of the content the
draft builds or loaded from JSON files, so it works the same for both, survives answering a question later, and
undo just drops the last one. Plain rules read the common requests; anything else goes to the AI as one tool call
whose operations are checked here. The AI never writes the page itself: an operation names a known part of the
content, and the result must still validate as ChurchContent.
"""
import copy
import re

from . import builder_edit, builder_theme
from .church_content import HIDEABLE_PAGES, ChurchContent, normalize

MAX_OPS = 6
DEFAULT_TAGLINE = 'A place to belong, grow and give.'
# The site's own pages (Give, Serve, Calendar…) are a shared template: their fixed wording is not the church's to
# change one by one. What a church can change is its own content (DETAILS, FAQs, lists, imported pages) and layout.
CANNOT_EDIT = ('Tekton can change the headline and text at the top of Home, your church details, questions people '
               'ask, your lists, and the pages imported from your old website. The wording built into the site '
               '(like “Give with confidence”) stays the same for every church.')
MAX_CUSTOM = 60
LISTS = ('events', 'ministries', 'groups', 'staff', 'locations', 'sermons', 'calendar')
DETAILS = {'tagline': 'headline at the top of Home', 'name': 'church name', 'city': 'town or city', 'address': 'street address', 'phone': 'phone number',
           'email': 'email', 'office_hours': 'office hours', 'about': 'about text', 'first_visit': 'what to expect',
           'services': 'service times'}
THEME_COLORS = ('primary', 'accent', 'background', 'text')
COLOR_WORDS = {'main': 'primary', 'primary': 'primary', 'brand': 'primary', 'header': 'primary', 'accent': 'accent',
               'button': 'accent', 'buttons': 'accent', 'highlight': 'accent', 'background': 'background',
               'text': 'text'}
# Plain color names a person types; the AI sends hex.
NAMED = {'green': '#3e6b3a', 'dark green': '#2f4a2a', 'forest green': '#2f5d34', 'sage': '#7d9a78', 'olive': '#5f6b2e',
         'blue': '#2d5c9e', 'navy': '#1f3a5f', 'dark blue': '#1f3a5f', 'light blue': '#cfe2f3', 'sky blue': '#6aa6d8',
         'teal': '#1f6f6b', 'red': '#a32d2d', 'maroon': '#6e1f2a', 'burgundy': '#6d1f33', 'purple': '#5b3c88',
         'plum': '#6a3f63', 'gold': '#b8860b', 'yellow': '#c9a227', 'orange': '#c2571a', 'brown': '#6b4a2f',
         'tan': '#d9c7a3', 'cream': '#faf6ea', 'beige': '#f2ead8', 'gray': '#5c5f66', 'grey': '#5c5f66',
         'charcoal': '#33363b', 'black': '#111111', 'white': '#ffffff', 'pink': '#b8577a'}


class Refused(ValueError):
    """A change that cannot be made, with a reason for the church."""


def _name(item):
    return str(item.get('name') or item.get('title') or item.get('question') or '')


def _find(items, name, key=_name):
    """The entry whose name is `name`, else the one that contains it, else None."""
    name = ' '.join(str(name or '').lower().split())
    if not name:
        return None
    exact = [i for i in items if ' '.join(key(i).lower().split()) == name]
    if exact:
        return exact[0]
    partial = [i for i in items if name in key(i).lower()]
    return partial[0] if len(partial) == 1 else None


def _color(value):
    value = str(value or '').strip().lower()
    found = builder_theme.color(value) or NAMED.get(value) or NAMED.get(value.replace('-', ' '), '')
    if not found:
        raise Refused(f'“{value}” is not a color Tekton knows. Try a name like navy or a code like #3e6b3a.')
    return found


def _theme(content, op):
    site = content.setdefault('site', {})
    theme = {**(site.get('theme') or {})}
    for key in THEME_COLORS:
        if op.get(key):
            theme[key] = _color(op[key])
    for key in ('heading_font', 'body_font'):
        if op.get(key):
            # Any plain family name the church asks for (the importer skips common system fonts; a request does not).
            font = ' '.join(str(op[key]).strip().strip('"\'').split())
            if not builder_theme.FONT_RE.match(font) or font.lower() in ('inherit', 'initial'):
                raise Refused(f'“{op[key]}” is not a font name Tekton can use.')
            theme[key] = font
    # Buttons carry white text and the site is light: keep both readable.
    for key in ('primary', 'accent'):
        if op.get(key):
            readable = builder_theme.readable_on_white(theme[key])
            if not readable:
                raise Refused('That color is too light for buttons with white text. Try a darker shade.')
            theme[key] = readable
    if op.get('background') and builder_theme._luminance(theme['background']) < 0.6:
        raise Refused('Your site uses a light page background so text stays readable. Try a lighter color.')
    if op.get('text') and builder_theme.contrast(theme['text'], theme.get('background') or '#ffffff') < 4.5:
        raise Refused('That text color would be hard to read on your background.')
    site['theme'] = theme


def _detail(content, op):
    field = op.get('field')
    if field not in DETAILS:
        raise Refused('Tekton can change the church name, address, phone, email, office hours, about text, '
                      'what to expect and service times.')
    value = op.get('value')
    info = content.setdefault('info', {})
    if field == 'services':
        from .builder import _parse_services, _twelve
        parsed = _parse_services(str(value or ''))
        if not parsed:
            raise Refused('Tekton could not read those service times. Try “Sundays 9:00 AM and 11:00 AM”.')
        info['services'] = [{'day': s['day'], 'time': _twelve(s['time']), 'note': ''} for s in parsed]
    else:
        info[field] = ' '.join(str(value or '').split()) if field not in ('about', 'first_visit') else str(value or '').strip()


def _layout(content, op):
    site = content.setdefault('site', {})
    layout = _clean_layout(site.get('layout'))
    page, section = op.get('page'), op.get('section')
    if page not in builder_edit.PAGES:
        page = builder_edit._page_for(section) if section else None
    if not page or section not in builder_edit.PAGES[page]:
        raise Refused('Tekton could not find that section on Home or Plan your visit.')
    tag = f'{page}:{section}'
    if op['op'] == 'hide':
        layout['hidden'] = sorted(set(layout['hidden']) | {tag})
    elif op['op'] == 'show':
        layout['hidden'] = [h for h in layout['hidden'] if h != tag]
    else:
        order = [k for k in layout[page] if k != section]
        anchor = op.get('before') or op.get('after')
        if op.get('to') == 'top':
            order.insert(0, section)
        elif op.get('to') == 'bottom':
            order.append(section)
        elif anchor in order:
            order.insert(order.index(anchor) + (1 if op.get('after') else 0), section)
        else:
            raise Refused('Tekton could not tell where to move that section.')
        layout[page] = order
    site['layout'] = layout


def _faq(content, op):
    faqs = content.setdefault('faqs', [])
    if op['op'] == 'add_faq':
        question, answer = str(op.get('question') or '').strip(), str(op.get('answer') or '').strip()
        if not question or not answer:
            raise Refused('A question people ask needs both the question and its answer.')
        faqs.append({'question': question, 'answer': answer})
        return
    faq = _find(faqs, op.get('question'))
    if not faq:
        raise Refused('Tekton could not find that question on your site.')
    if op['op'] == 'remove_faq':
        faqs.remove(faq)
    else:
        if op.get('answer'):
            faq['answer'] = str(op['answer']).strip()
        if op.get('new_question'):
            faq['question'] = str(op['new_question']).strip()


def _remove_item(content, op):
    # The list named first, then the others: "the youth ministry" is often a group ("Youth Group").
    named = [op['list']] if op.get('list') in LISTS else []
    names = named + [n for n in LISTS if content.get(n) and n not in named]
    for name in names:
        item = _find(content.get(name) or [], op.get('name'))
        if item:
            content[name].remove(item)
            op['list'] = name
            return
    raise Refused(f'Tekton could not find “{op.get("name")}” on your site.')


# Words that mean a person, not the church: a request with one never renames the church.
PERSON_RE = re.compile(r'\b(?:pastors?|minister|reverend|rev|priest|father|elders?|deacons?|directors?|leaders?|'
                       r'coordinator|admin(?:istrator)?|secretary|staff|worship leader|youth pastor|music director)\b', re.I)
PERSON_FIELDS = ('name', 'role', 'email', 'phone', 'bio')


def _person(content, op):
    """Change a staff entry found by its name or its role ("the pastor"), or add one when no one has that role."""
    staff = content.setdefault('staff', [])
    who = ' '.join(str(op.get('name') or '').lower().split())
    person = _find(staff, who) if who else None
    if person is None and who:
        by_role = [p for p in staff if who in str(p.get('role') or '').lower()
                   or str(p.get('role') or '').lower() in who and p.get('role')]
        person = by_role[0] if len(by_role) == 1 else None
    changes = {k: ' '.join(str(op[k]).split()) if k != 'bio' else str(op[k]).strip()
               for k in PERSON_FIELDS[1:] if op.get(k)}
    if op.get('new_name'):
        changes['name'] = ' '.join(str(op['new_name']).split())
    if not changes:
        raise Refused('What should Tekton change about that person?')
    if person is None:
        if not changes.get('name'):
            raise Refused(f'Tekton could not find “{op.get("name")}” among your staff.')
        # "Change the pastor to Dr. Lee Brown" with no pastor listed yet: add them in that role.
        person = {'name': changes['name'], 'role': changes.get('role') or (op.get('name') or '').strip().title()}
        staff.append(person)
        op['added'] = True
    person.update(changes)
    op['list'] = 'staff'


# Text an operation would put on the site. The church writes it; Tekton only places it.
WORDING = {'set_detail': 'value', 'edit_page_section': 'text', 'add_faq': 'answer', 'edit_faq': 'answer',
           'edit_person': 'bio'}
PROSE_FIELDS = ('about', 'first_visit', 'tagline', 'office_hours')
NOT_WRITTEN = ('Tekton does not write new wording for your site. Tell it the exact words you want, like '
               '“Change the about text to: We are a small church that loves our town.”')


def _words(text):
    return re.findall(r"[a-z0-9']{3,}", str(text or '').lower())


def written_by_ai(op, request):
    """Whether an AI-planned operation brings wording the church did not give: most of its words must be in the
    request. Short details (a name, a phone number, a time) are not prose and are checked elsewhere."""
    key = WORDING.get(op.get('op'))
    if not key or (op['op'] == 'set_detail' and op.get('field') not in PROSE_FIELDS):
        return False
    words = _words(op.get(key))
    if len(words) < 4:
        return False
    asked = set(_words(request))
    return sum(w in asked for w in words) < 0.7 * len(words)


def _page(content, op):
    pages = content.get('pages') or []
    page = _find(pages, op.get('page'), key=lambda p: p.get('title', '')) or next(
        (p for p in pages if p.get('slug') == op.get('page')), None)
    if not page:
        raise Refused(CANNOT_EDIT)
    if op['op'] == 'rename_page':
        title = ' '.join(str(op.get('title') or '').split())
        if not title:
            raise Refused('What should the page be called?')
        page['title'] = title
        return
    sections = page.get('sections') or []
    section = _find(sections, op.get('heading'), key=lambda s: s.get('heading', '')) if op.get('heading') else (
        sections[0] if sections else None)
    if not section:
        raise Refused(CANNOT_EDIT)
    if op.get('text'):
        section['text'] = str(op['text']).strip()
    if op.get('new_heading'):
        section['heading'] = ' '.join(str(op['new_heading']).split())


def _clean_layout(layout):
    """builder_edit's cleaned Home/Plan your visit layout, keeping the hidden site pages it does not know about."""
    return {**builder_edit.clean_layout(layout),
            'hidden_pages': list((layout or {}).get('hidden_pages') or []) if isinstance(layout, dict) else []}


# The words people use for each part of the site, most specific first (Layout.hidden_pages keys).
SITE_PAGES = [
    ('serve/find', 'Find a place', r'find a place(?: to serve)?'),
    ('give/trips', 'Mission trips', r'mission trips?|trips?'),
    ('guests/welcome', 'Welcome team', r'welcome team|greeters?(?: screen)?'),
    ('about/beliefs', 'Beliefs', r'beliefs?|what we believe|statement of faith'),
    ('about/news', 'News', r'news|announcements'),
    ('about/directory', 'Directory', r'(?:staff )?directory'),
    ('about/connect', 'Connect', r'connect(?: card)?'),
    ('notes', 'Sermon Notes', r'sermon notes|notes|sermons? page'),
    ('calendar', 'Calendar', r'calendar|events? calendar|events? page'),
    ('prayer', 'Prayer map', r'prayer(?: map)?|map of prayer'),
    ('give', 'Give', r'give|giving|online giving|donations?|donate|tithes?|offerings?'),
    ('serve', 'Serve', r'serve|serving|volunteer(?:ing)?|ministries page|serve page'),
]
PAGE_LABELS = {key: label for key, label, _ in SITE_PAGES}
assert set(PAGE_LABELS) == set(HIDEABLE_PAGES)


def site_page_key(words):
    """The part of the site a phrase names ("the calendar", "giving page"), or None."""
    words = re.sub(r"\b(?:the|our|my|your|a|an|whole|entire|page|pages|tab|tabs|section|area|part|feature|link)\b", ' ', words.lower())
    words = ' '.join(re.sub(r"[^a-z' -]", ' ', words).split())
    return next((key for key, _, pattern in SITE_PAGES if re.fullmatch(pattern, words)), None)


def _site_page(content, op):
    site = content.setdefault('site', {})
    layout = _clean_layout(site.get('layout'))
    key = op.get('page') if op.get('page') in PAGE_LABELS else site_page_key(str(op.get('page') or ''))
    if not key:
        raise Refused('Tekton can hide or show Serve, Sermon Notes, Calendar, Give, Mission trips, the Prayer map, '
                      'the Welcome team, Beliefs, News, Directory and Connect. Home and Plan your visit always stay.')
    op['page'] = key
    hidden = [k for k in layout['hidden_pages'] if k != key]
    layout['hidden_pages'] = hidden + [key] if op['op'] == 'hide_page' else hidden
    site['layout'] = layout


HANDLERS = {'set_theme': _theme, 'set_detail': _detail, 'move': _layout, 'hide': _layout, 'show': _layout,
            'add_faq': _faq, 'edit_faq': _faq, 'remove_faq': _faq, 'remove_item': _remove_item,
            'rename_page': _page, 'edit_page_section': _page, 'hide_page': _site_page, 'show_page': _site_page,
            'edit_person': _person}


def _one(content, op):
    handler = HANDLERS.get(op.get('op'))
    if not handler:
        raise Refused('Tekton cannot make that kind of change yet.')
    handler(content, op)


def apply(content, ops):
    """`content` with every stored change made, skipping any that no longer fits (the draft changed under it)."""
    out = copy.deepcopy(content)
    for op in ops or []:
        trial = copy.deepcopy(out)
        try:
            _one(trial, copy.deepcopy(op))
            out = normalize(ChurchContent(**trial))
        except Exception:
            continue
    return out


def check(content, op):
    """(op as it will be stored, content after it), or Refused with the reason."""
    op = {k: v for k, v in op.items() if v not in (None, '', [])}
    trial = copy.deepcopy(content)
    _one(trial, op)
    try:
        return op, normalize(ChurchContent(**trial))
    except Exception as error:
        raise Refused('That change would not fit your site.') from error


def describe(op):
    kind = op['op']
    if kind == 'set_theme':
        parts = [f'{k.replace("_", " ")} {op[k]}' for k in (*THEME_COLORS, 'heading_font', 'body_font') if op.get(k)]
        parts = [p.replace('primary ', 'main color to ').replace('accent ', 'button color to ').replace('background ', 'background to ')
                 .replace('text ', 'text color to ').replace('font ', 'font to ') for p in parts]
        return 'Changed the ' + ', '.join(parts)
    if kind == 'set_detail':
        return f'Changed the {DETAILS[op["field"]]}'
    if kind in ('move', 'hide', 'show'):
        page = builder_edit.PAGE_NAMES.get(op.get('page'), '')
        label = builder_edit.PAGES.get(op.get('page'), {}).get(op.get('section'), op.get('section'))
        verb = {'move': 'Moved', 'hide': 'Hid', 'show': 'Showed'}[kind]
        return f'{verb} “{label}” on {page}' if page else f'{verb} “{label}”'
    if kind == 'add_faq':
        return f'Added the question “{op["question"]}”'
    if kind == 'edit_faq':
        return f'Changed the answer to “{op["question"]}”'
    if kind == 'remove_faq':
        return f'Removed the question “{op["question"]}”'
    if kind in ('hide_page', 'show_page'):
        return f'{"Hid" if kind == "hide_page" else "Showed"} {PAGE_LABELS[op["page"]]} on your site'
    if kind == 'edit_person':
        who = op.get('new_name') or op.get('name')
        if op.get('added'):
            return f'Added {who} to your staff'
        return f'Changed “{op["name"]}” to {who} on your staff list' if op.get('new_name') else f'Updated {who} on your staff list'
    if kind == 'remove_item':
        return f'Removed “{op["name"]}”'
    if kind == 'rename_page':
        return f'Renamed the page to “{op["title"]}”'
    return 'Changed part of a page'


# ---------------------------------------------------------------- reading the request

COLOR_RE = re.compile(r'(?:please )?(?:make|change|set|turn|use)\s+(?:the |our |my )?(?:site\'?s? |website\'?s? )?'
                      r'(main|primary|brand|header|accent|button|buttons|highlight|background|text)?\s*colou?rs?\s+'
                      r'(?:to |be |into )?(.+)', re.I)


VAGUE_COLOR_RE = re.compile(r'.*\b(?:change|update|fix|different|new|pick|choose)\b.*\bcolou?rs?\b.*'
                            r'|.*\bcolou?rs?\b.*\b(?:change|different)\b.*', re.I)
PERSON_CHANGE_RE = re.compile(r"(?:(?:can|could|would) you |please )*(?:change|update|set|make|replace)\s+"
                              r"(?:(?:the )?name\s+)?(?:of\s+)?(?:the |our )?(.+?)(?:'s name)?\s+(?:to|be)\s+(.+)$", re.I)
TAGLINE_RE = re.compile(r'(?:(?:can|could|would) you |please )*(?:change|set|make|update|replace)\s+(?:the |our )?'
                        r'(?:top of (?:the )?home(?: page)?|home(?: page)? (?:headline|heading|title|tagline)|'
                        r'headline|tagline|main heading|big heading|hero(?: text| heading)?|welcome (?:headline|heading))'
                        r'(?:\s+(?:on|of) (?:the )?home(?: page)?)?(?:\s+from\s+.+?)?\s+(?:to|say|read|into)\s+(.+)$', re.I)
VAGUE_COLOR_REPLY = ('Which colors would you like? For example “Make the main color navy and the buttons gold”, '
                     'or give a color code like #3e6b3a.')


def _viewed_page(viewing):
    viewing = (viewing or '').lower()
    return 'visit' if 'visit' in viewing else 'home' if 'home' in viewing or not viewing else None


def rule_ops(request, viewing=''):
    """Operations for the common requests, or None for the AI."""
    text = ' '.join(request.strip().rstrip('.!?').split())
    m = COLOR_RE.fullmatch(text)
    if m:
        target = COLOR_WORDS.get((m.group(1) or 'main').lower(), 'primary')
        values = [v.strip() for v in re.split(r'\s+and\s+|,', m.group(2)) if v.strip()]
        try:
            colors = [_color(v) for v in values[:2]]
        except Refused:
            return None
        op = {'op': 'set_theme', target: colors[0]}
        if len(colors) > 1 and target == 'primary':
            op['accent'] = colors[1]
        return [op]
    m = PERSON_CHANGE_RE.match(text)
    if m and PERSON_RE.fullmatch(m.group(1).strip()):
        return [{'op': 'edit_person', 'name': m.group(1).strip(), 'new_name': m.group(2).strip().strip('"“”\'')}]
    m = TAGLINE_RE.match(text)
    if m:
        # With quotes ("from "A place to belong" to "B""), the new wording is the last quoted part.
        quoted = re.findall(r'"([^"]+)"|“([^”]+)”', text)
        value = ''.join(quoted[-1]) if quoted else m.group(1)
        value = value.strip().strip('"“”\'').strip()
        if value:
            return [{'op': 'set_detail', 'field': 'tagline', 'value': value}]
    # "Can you hide the calendar, our church does not have one": a whole part of the site, with or without a reason.
    m = re.match(r"(?:(?:can|could|would) you |please |i'd like to |we want to |let's )*(hide|remove|take out|leave out|"
                 r"get rid of|drop|turn off|disable|show|bring back|add back|unhide|turn on)\s+(.+?)"
                 r"(?:\s*(?:,|\.|;|-|\bbecause\b|\bsince\b|\bas\b|\bwe\b|\bour\b|\bit\b|\bthat\b|\bfrom\b|\bplease\b|\bagain\b|\bback\b|\btoo\b).*)?$", text, re.I)
    if m:
        key = site_page_key(m.group(2))
        if key:
            show = m.group(1).lower() in ('show', 'bring back', 'add back', 'unhide', 'turn on')
            return [{'op': 'show_page' if show else 'hide_page', 'page': key}]
    m = re.fullmatch(r"(?:we|our church|the church) (?:do not|don't|doesn't|does not) (?:have|use|need|do) (?:a |an |any )?(.+)", text, re.I)
    if m and site_page_key(m.group(1)):
        return [{'op': 'hide_page', 'page': site_page_key(m.group(1))}]
    ops = builder_edit.rule_ops(request)
    if not ops:
        return None
    page = _viewed_page(viewing)
    named = builder_edit.PAGE_HINT.search(request)
    out = []
    for op in ops:
        if op['op'] in ('move', 'hide', 'show'):
            # A section on both pages goes to the page the church is looking at, unless it named one.
            if not named and page and op.get('section') in builder_edit.PAGES[page]:
                op['page'] = page
            out.append(op)
        elif op['op'] == 'set_field':
            out.append({'op': 'set_detail', 'field': op['field'], 'value': op['value']})
        elif op['op'] == 'exclude':
            out.append({'op': 'remove_item', 'list': op.get('collection') or '', 'name': op['name']})
        else:
            return None  # "show" for a list entry: ask the AI with the whole site in view
    return out


TOOL = {'type': 'function', 'function': {
    'name': 'customize_site',
    'description': 'Turn the church\'s request into changes to its new site, or ask one short question when it is unclear.',
    'parameters': {'type': 'object', 'additionalProperties': False, 'required': ['operations', 'reply'], 'properties': {
        'reply': {'type': 'string', 'description': 'One or two short sentences to the church: what changed, or the question to ask.'},
        'needs_answer': {'type': 'boolean', 'description': 'True when the reply is a question and no change was made.'},
        'operations': {'type': 'array', 'maxItems': MAX_OPS, 'items': {'type': 'object', 'additionalProperties': False,
            'required': ['op'], 'properties': {
                'op': {'type': 'string', 'enum': list(HANDLERS)},
                'primary': {'type': 'string', 'description': 'set_theme: main color as #rrggbb'},
                'accent': {'type': 'string', 'description': 'set_theme: button color as #rrggbb'},
                'background': {'type': 'string', 'description': 'set_theme: page background (light) as #rrggbb'},
                'text': {'type': 'string', 'description': 'set_theme: text color; edit_page_section: new section text'},
                'heading_font': {'type': 'string'}, 'body_font': {'type': 'string'},
                'field': {'type': 'string', 'enum': list(DETAILS)}, 'value': {'type': 'string'},
                'page': {'type': 'string', 'description': 'move/hide/show: home or visit; hide_page/show_page: one of '
                         + ', '.join(HIDEABLE_PAGES) + '; rename_page/edit_page_section: the page title'},
                'section': {'type': 'string'}, 'before': {'type': 'string'}, 'after': {'type': 'string'},
                'to': {'type': 'string', 'enum': ['top', 'bottom']},
                'question': {'type': 'string'}, 'answer': {'type': 'string'}, 'new_question': {'type': 'string'},
                'list': {'type': 'string', 'enum': list(LISTS)}, 'name': {'type': 'string'},
                'title': {'type': 'string'}, 'heading': {'type': 'string'}, 'new_heading': {'type': 'string'},
                'new_name': {'type': 'string', 'description': 'edit_person: the person\'s new name'},
                'role': {'type': 'string'}, 'email': {'type': 'string'}, 'phone': {'type': 'string'},
                'bio': {'type': 'string'},
            }}},
    }}}}


def _summary(content, viewing):
    info = content.get('info') or {}
    theme = (content.get('site') or {}).get('theme') or {}
    layout = builder_edit.clean_layout((content.get('site') or {}).get('layout'))
    lines = [f'The church is looking at: {viewing or "the home page"}.',
             f'The top of Home shows the headline (tagline, now "{info.get("tagline") or DEFAULT_TAGLINE}") and under '
             f'it the about text. Change them with set_detail field tagline or about; never with edit_page_section.',
             'set_detail field name is the CHURCH name only. A person (pastor, elder, staff) is changed with '
             'edit_person: name = their current name or role ("pastor"), new_name/role/email/phone as asked.',
             'Details: ' + '; '.join(f'{k}={str(info.get(k) or "")[:80]}' for k in DETAILS if k != 'services'),
             'Service times: ' + ', '.join(f'{s.get("day")} {s.get("time")}' for s in info.get('services') or []),
             'Theme: ' + ', '.join(f'{k}={theme.get(k) or "default"}' for k in (*THEME_COLORS, 'heading_font', 'body_font'))]
    for page, sections in builder_edit.PAGES.items():
        lines.append(f'{page} sections in order: ' + ', '.join(
            f'{k} ({sections[k]}){" [hidden]" if f"{page}:{k}" in layout["hidden"] else ""}' for k in layout[page]))
    hidden_pages = ((content.get('site') or {}).get('layout') or {}).get('hidden_pages') or []
    lines.append('Parts of the site (hide_page/show_page; Home and Plan your visit always stay): ' + ', '.join(
        f'{key} ({label}){" [hidden]" if key in hidden_pages else ""}' for key, label, _ in SITE_PAGES))
    lines.append('Questions people ask: ' + '; '.join(f.get('question', '') for f in (content.get('faqs') or [])[:30]))
    for name in LISTS:
        if content.get(name):
            lines.append(f'{name}: ' + ', '.join(_name(i)[:60] for i in content[name][:40]))
    for page in (content.get('pages') or [])[:30]:
        lines.append(f'page "{page.get("title")}": sections ' + ', '.join(
            f'"{s.get("heading") or "(untitled)"}"' for s in (page.get('sections') or [])[:15]))
    return '\n'.join(lines)


def ai_ops(content, request, history, viewing, complete):
    """(operations, reply, needs_answer) from one AI call."""
    messages = [{'role': 'system', 'content': (
        'You customize a church\'s new website for its staff. Use the customize_site tool. Only change what they '
        'asked; use only the sections, pages, questions and entries listed. Colors are #rrggbb; keep the page '
        'background light. Never write theology, statements of faith or facts the church did not give you. If the '
        'request is unclear (for example which color), make no operations and ask one short question.\n\n'
        + _summary(content, viewing))}]
    for turn in history[-4:]:
        messages += [{'role': 'user', 'content': turn['request']}, {'role': 'assistant', 'content': turn['reply']}]
    messages.append({'role': 'user', 'content': request})
    result = complete(messages, [TOOL]) or {}
    ops = [op for op in result.get('operations') or [] if isinstance(op, dict)][:MAX_OPS]
    return ops, str(result.get('reply') or '').strip(), bool(result.get('needs_answer'))
