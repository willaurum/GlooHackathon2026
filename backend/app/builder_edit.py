"""Changes asked in plain words, and where each fact came from.

A request like "Put service times above ministries" or "Hide the youth ministry" becomes a short list of
operations (move or hide a section of a page, change a detail, include or leave out a list entry). Plain rules
read the common requests instantly; anything else goes to the AI as one forced tool call whose operations are
checked by code here: unknown sections, fields or entries are dropped, and the AI never writes page content.
Every change can be undone. The Home and Plan your visit pages honor the stored order (site.layout).
"""
import copy
import logging
import re

log = logging.getLogger(__name__)

PAGES = {
    'home': {'features': 'Serve, Sermon Notes and Give cards', 'about': 'Get to know us', 'ministries': 'Ministries',
             'sermons': 'Recent sermons', 'service_times': 'Service times', 'leaders': 'For church leaders'},
    'visit': {'service_times': 'Service times', 'what_to_expect': 'What to expect', 'map': 'Where we meet',
              'locations': 'Campuses', 'faqs': 'Questions people ask', 'next_steps': 'A good place to start',
              'sign_up': 'Plan your visit form'},
}
PAGE_NAMES = {'home': 'Home', 'visit': 'Plan your visit'}
# The words people use for each section, most specific first.
ALIASES = [
    ('service_times', r'service ?times?|services|worship times?|times'),
    ('what_to_expect', r'what to expect|before you arrive|first visit'),
    ('map', r'map|directions|where we meet|address'),
    ('locations', r'campus(?:es)?|locations?|places we meet'),
    ('faqs', r'faqs?|questions(?: people ask)?|good to know'),
    ('next_steps', r'next steps?|a good place to start|newcomer events?'),
    ('sign_up', r'(?:visit |sign[- ]?up |rsvp )?form|plan your visit form|sign[- ]?up|rsvp'),
    ('ministries', r'ministr(?:y|ies)|serving teams?|teams'),
    ('sermons', r'(?:recent )?sermons?|messages?|watch(?: and| &) listen'),
    ('features', r'(?:feature )?cards|serve,? sermon notes and give(?: cards)?|features'),
    ('about', r'get to know us|about(?: us)?|our story'),
    ('leaders', r'(?:for )?(?:church )?leaders(?: section)?'),
]
COLLECTIONS = ('events', 'ministries', 'groups', 'staff', 'locations', 'sermons')
STEMS = {'events': 'event', 'ministries': 'ministr', 'groups': 'group', 'staff': 'staff|pastor|elder|deacon',
         'locations': 'location|campus', 'sermons': 'sermon|message'}
MAX_OPS = 6
UNDO_DEPTH = 5


def default_layout():
    return {'home': list(PAGES['home']), 'visit': list(PAGES['visit']), 'hidden': []}


def clean_layout(layout):
    """Every known section once, in the stored order, then any new ones; hidden ones as 'page:section'."""
    layout = layout if isinstance(layout, dict) else {}
    out = {}
    for page, sections in PAGES.items():
        order = [k for k in dict.fromkeys(layout.get(page) or []) if k in sections]
        out[page] = order + [k for k in sections if k not in order]
    out['hidden'] = sorted({h for h in layout.get('hidden') or [] if isinstance(h, str) and h.split(':', 1)[0] in PAGES
                            and h.split(':', 1)[-1] in PAGES[h.split(':', 1)[0]]})
    return out


def section_key(words, page=None):
    """The section a phrase names, e.g. "the service times" -> 'service_times', on `page` if given."""
    words = re.sub(r'\b(the|our|my|section|block|part|area|list|on (?:the )?(?:home|visit|plan your visit) page)\b', ' ', words.lower())
    words = ' '.join(re.sub(r'[^a-z&, -]', ' ', words).split())
    for key, pattern in ALIASES:
        if re.fullmatch(pattern, words) and (page is None or key in PAGES[page]):
            return key
    return None


def _page_for(*keys, hint=None):
    if hint in PAGES and all(k in PAGES[hint] for k in keys):
        return hint
    return next((page for page in PAGES if all(k in PAGES[page] for k in keys)), None)


PAGE_HINT = re.compile(r'\bon (?:the )?(home|visit|plan your visit)(?: page)?\b', re.I)


def rule_ops(request):
    """Operations for the common requests, or None when the rules do not understand it (the AI is asked then)."""
    text = ' '.join(request.strip().rstrip('.!').split())
    hint = PAGE_HINT.search(text)
    hint = None if not hint else 'home' if hint.group(1).lower() == 'home' else 'visit'
    text = PAGE_HINT.sub('', text).strip()
    m = re.fullmatch(r'(?:please )?(?:put|move|place|show|have)\s+(.+?)\s+(above|before|over|ahead of|on top of|below|after|under|beneath)\s+(.+)', text, re.I)
    if m:
        a, b = section_key(m.group(1)), section_key(m.group(3))
        if a and b and a != b:
            page = _page_for(a, b, hint=hint)
            if page:
                where = 'before' if m.group(2).lower() in ('above', 'before', 'over', 'ahead of', 'on top of') else 'after'
                return [{'op': 'move', 'page': page, 'section': a, where: b}]
    m = re.fullmatch(r'(?:please )?(?:put|move)\s+(.+?)\s+(?:at|to)\s+the\s+(top|bottom|end)(?: of the page)?', text, re.I)
    if m and section_key(m.group(1)):
        key = section_key(m.group(1))
        page = _page_for(key, hint=hint)
        return [{'op': 'move', 'page': page, 'section': key, 'to': 'top' if m.group(2).lower() == 'top' else 'bottom'}]
    m = re.fullmatch(r'(?:please )?(hide|remove|take out|leave out|drop|show|bring back|add back|unhide)\s+(.+)', text, re.I)
    if m:
        show = m.group(1).lower() in ('show', 'bring back', 'add back', 'unhide')
        key = section_key(m.group(2))
        if key:
            return [{'op': 'show' if show else 'hide', 'page': _page_for(key, hint=hint), 'section': key}]
        name = re.sub(r'^(?:the|our)\s+', '', m.group(2), flags=re.I)
        collection = next((c for c, stem in STEMS.items() if re.search(rf'\b(?:{stem})', name, re.I)), None)
        name = re.sub(r'\s+(ministry|ministries|group|event|sermon|campus|location)$', '', name, flags=re.I)
        return [{'op': 'include' if show else 'exclude', 'collection': collection or '', 'name': name}]
    m = re.fullmatch(r'(?:please )?(?:change|set|update|make)\s+(?:the |our )?(phone(?: number)?|email(?: address)?|address|office hours|service times)\s+(?:to|be)\s+(.+)', text, re.I)
    if m:
        field = {'phone': 'phone', 'email': 'email', 'address': 'address', 'office': 'office_hours', 'service': 'services'}[m.group(1).split()[0].lower()]
        return [{'op': 'set_field', 'field': field, 'value': m.group(2).strip()}]
    return None


EDIT_TOOL = {'type': 'function', 'function': {
    'name': 'change_site',
    'description': 'Turn the church\'s request into changes to its new site. Only use sections, fields and entries listed.',
    'parameters': {'type': 'object', 'additionalProperties': False, 'required': ['operations', 'reply'], 'properties': {
        'reply': {'type': 'string', 'description': 'One short sentence to the church saying what changed, or why nothing could.'},
        'operations': {'type': 'array', 'maxItems': MAX_OPS, 'items': {'type': 'object', 'additionalProperties': False,
            'required': ['op'], 'properties': {
                'op': {'type': 'string', 'enum': ['move', 'hide', 'show', 'set_field', 'include', 'exclude']},
                'page': {'type': 'string', 'enum': list(PAGES)},
                'section': {'type': 'string'}, 'before': {'type': 'string'}, 'after': {'type': 'string'},
                'to': {'type': 'string', 'enum': ['top', 'bottom']},
                'field': {'type': 'string'}, 'value': {'type': 'string'},
                'collection': {'type': 'string', 'enum': list(COLLECTIONS)}, 'name': {'type': 'string'},
            }}},
    }}}}


def ai_ops(session, request, complete, field_labels):
    """(operations, reply) from one AI call, or ([], reason)."""
    layout = clean_layout(session.get('layout'))
    lists = []
    for name in COLLECTIONS:
        entries = session.get('collections', {}).get(name) or []
        if entries:
            names = ', '.join(str(e['value'].get('name') or e['value'].get('title') or '')[:60] for e in entries[:40])
            lists.append(f'- {name}: {names}')
    pages = '\n'.join(f'- {page} ({PAGE_NAMES[page]}): ' + ', '.join(f'{k} ({PAGES[page][k]})' for k in layout[page])
                      for page in PAGES)
    fields = ', '.join(f'{k} ({v})' for k, v in field_labels.items())
    messages = [
        {'role': 'system', 'content': 'You change a church\'s new website only through change_site. Sections can be moved '
            '(before/after another section of the same page, or to top/bottom), hidden or shown again; a detail field can be '
            'set to a value the church gave in its request; a list entry can be included or left out by its name. Never '
            'invent content: a set_field value must come from the request. If the request asks for something else '
            '(new text, colors, theology), return no operations and say so in reply.'},
        {'role': 'user', 'content': f'Pages and their sections, in order:\n{pages}\n\nDetail fields: {fields}\n\n'
            f'Lists:\n' + ('\n'.join(lists) or '(none)') + f'\n\nThe church asks: {request}'},
    ]
    try:
        args = complete(messages, [EDIT_TOOL]) or {}
    except Exception as error:
        log.warning('builder: edit request failed: %s', error)
        return [], 'The AI could not be reached for that request. Try “Put service times above ministries”.'
    ops = args.get('operations') if isinstance(args, dict) else None
    return (ops if isinstance(ops, list) else [])[:MAX_OPS], str(args.get('reply', '') if isinstance(args, dict) else '')[:300]


def _match(entries, name):
    """The entries whose name or title contains `name` (case and punctuation ignored)."""
    norm = lambda t: ' '.join(re.sub(r'[^a-z0-9]+', ' ', str(t or '').lower()).split())  # noqa: E731
    want = norm(name)
    if len(want) < 3:
        return []
    exact = [e for e in entries if norm(e['value'].get('name') or e['value'].get('title')) == want]
    return exact or [e for e in entries if want in norm(e['value'].get('name') or e['value'].get('title'))]


def check_op(session, op):
    """The operation in a canonical shape, or None when it does not fit this draft."""
    if not isinstance(op, dict):
        return None
    kind = op.get('op')
    if kind in ('move', 'hide', 'show'):
        page = op.get('page') if op.get('page') in PAGES else _page_for(*(k for k in (op.get('section'),) if k))
        section = op.get('section') if page and op.get('section') in PAGES[page] else None
        if not section:
            return None
        if kind != 'move':
            return {'op': kind, 'page': page, 'section': section}
        for where in ('before', 'after'):
            if op.get(where) in PAGES[page] and op[where] != section:
                return {'op': 'move', 'page': page, 'section': section, where: op[where]}
        if op.get('to') in ('top', 'bottom'):
            return {'op': 'move', 'page': page, 'section': section, 'to': op['to']}
        return None
    if kind == 'set_field':
        value = str(op.get('value') or '').strip()
        return {'op': kind, 'field': op.get('field'), 'value': value[:300]} if value and op.get('field') else None
    if kind in ('include', 'exclude'):
        name = str(op.get('name') or '').strip()
        lists = [op['collection']] if op.get('collection') in COLLECTIONS else list(COLLECTIONS)
        for collection in lists:
            if _match(session.get('collections', {}).get(collection) or [], name):
                return {'op': kind, 'collection': collection, 'name': name}
        return None
    return None


def _snapshot(session):
    return copy.deepcopy({k: session.get(k) for k in ('fields', 'questions', 'status', 'collections', 'layout')})


def apply_ops(session, ops, answer):
    """Apply checked operations to the draft; `answer(session, field, value)` sets a detail. Returns what changed,
    in words, and keeps a copy of the draft before the change for undo."""
    before = _snapshot(session)
    layout = clean_layout(session.get('layout'))
    changes = []
    for op in ops:
        if op['op'] in ('move', 'hide', 'show'):
            page, key = op['page'], op['section']
            label = f'{PAGES[page][key]} on {PAGE_NAMES[page]}'
            if op['op'] == 'move':
                order = [k for k in layout[page] if k != key]
                if op.get('before') or op.get('after'):
                    other = op.get('before') or op.get('after')
                    at = order.index(other) + (1 if op.get('after') else 0)
                    order.insert(at, key)
                    changes.append(f'Moved {label} {"above" if op.get("before") else "below"} {PAGES[page][other]}')
                else:
                    order.insert(0 if op['to'] == 'top' else len(order), key)
                    changes.append(f'Moved {label} to the {op["to"]}')
                layout[page] = order
                layout['hidden'] = [h for h in layout['hidden'] if h != f'{page}:{key}']
            else:
                hidden = set(layout['hidden'])
                (hidden.add if op['op'] == 'hide' else hidden.discard)(f'{page}:{key}')
                layout['hidden'] = sorted(hidden)
                changes.append(f'{"Hid" if op["op"] == "hide" else "Showed"} {label}')
        elif op['op'] == 'set_field':
            answer(session, op['field'], op['value'])
            changes.append(f'Changed {op["field"].replace("_", " ")} to {op["value"]}')
        else:
            entries = _match(session['collections'][op['collection']], op['name'])
            for entry in entries:
                entry['include'] = op['op'] == 'include'
            title = entries[0]['value'].get('name') or entries[0]['value'].get('title')
            changes.append(f'{"Included" if op["op"] == "include" else "Left out"} {title}'
                           + (f' and {len(entries) - 1} more' if len(entries) > 1 else ''))
    if not changes:
        raise ValueError('Nothing to change.')
    session['layout'] = layout
    session['undo'] = (session.get('undo') or [])[-(UNDO_DEPTH - 1):] + [{'before': before, 'changes': changes}]
    return changes


def undo(session):
    stack = session.get('undo') or []
    if not stack:
        raise ValueError('There is nothing to undo.')
    last = stack.pop()
    session.update(last['before'])
    session['undo'] = stack
    return '; '.join(last['changes'])


def provenance(session, sources_by_id, claims_by_id, evidence):
    """{'info': {field: [source]}, 'items': {collection: {name key: [source]}}}: what the preview shows when a
    visitor hovers a fact. A detail the church typed shows as confirmed by the church."""
    info = {}
    for field, value in (session.get('fields') or {}).items():
        if value.get('status') == 'confirmed':
            info[field] = [{'title': 'You confirmed this', 'url': '', 'quote': ''}]
        elif value.get('status') == 'prefilled' and value.get('candidates'):
            info[field] = evidence(value['candidates'][0], claims_by_id, sources_by_id)[:3]
    items = {}
    for collection, entries in (session.get('collections') or {}).items():
        for entry in entries:
            name = entry['value'].get('name') or entry['value'].get('title')
            if entry.get('include') and name:
                key = ' '.join(re.sub(r'[^a-z0-9]+', ' ', name.lower()).split())
                items.setdefault(collection, {})[key] = [
                    {k: e.get(k, '') for k in ('title', 'url', 'quote', 'prefix', 'suffix')}
                    for e in (entry.get('evidence') or [])[:2]] or [{'title': 'You added this', 'url': '', 'quote': ''}]
    return {'info': info, 'items': items}
