"""Score builder drafts against human answer keys; run fixtures without network or AI.

Keys contain single-answer field values, plus lists of `conflicts` and `missing` fields,
and an optional `label`. Only keyed fields are scored. FAQ claims are not reconcile() fields.
An optional `lists` key ({collection: [names]}) scores the imported lists (events, staff, ministries,
groups, locations, sermons) by precision and recall on normalized names; `today` pins the date
dated fixtures are read on. An optional `site` key scores the site model (menu, links by kind, forms, media)
by recall.
Prose is compared literally after the builder's whitespace/case normalization, not semantically.

    python -m backend.app.builder_score backend/tests/fixtures/builder/cedar-hollow-static
"""
import argparse
import json
import os
import re
from datetime import date
from pathlib import Path
from unittest import mock
from urllib.parse import urlparse

from . import builder, builder_structured

OUTCOMES = ('correct', 'wrong', 'missed', 'correctly_flagged_conflict', 'correctly_flagged_missing',
            'false_conflict')


def _normalized(field, value):
    if field == 'phone':
        return builder._digits(str(value))
    if field == 'services' and isinstance(value, list):
        # reconcile() orders days/times; order alone should not change the score.
        return sorted(builder._key(field, item) for item in value)
    return builder._key(field, value)


def score(draft, expected):
    """Return field outcomes, totals, accuracy (0–1), and a one-line summary without mutation.

    A flag requires both the field status and its open question, with no chosen value.
    Picking a value for a conflict/gap is wrong; failing to ask the right question is missed.
    Any question about a single-answer field is a false_conflict (including a missing question).
    Every expected field contributes one check to overall accuracy, including conflicts and gaps.
    """
    conflicts, missing = set(expected.get('conflicts', [])), set(expected.get('missing', []))
    values = {f: v for f, v in expected.items() if f not in ('label', 'conflicts', 'missing', 'lists', 'today', 'site')}
    if conflicts & missing or (conflicts | missing) & values.keys():
        raise ValueError('Each expected field must have exactly one value, conflict, or missing designation.')
    questions = {}
    for question in draft.get('questions', []):
        questions.setdefault(question['field'], set()).add(question['kind'])
    fields = {}
    totals = dict.fromkeys(OUTCOMES, 0)
    for field in sorted(values.keys() | conflicts | missing):
        info = draft.get('fields', {}).get(field, {})
        status, value = info.get('status'), info.get('value')
        kinds = questions.get(field, set())
        empty = value is None or value == '' or value == []
        if field in conflicts or field in missing:
            wanted = 'conflict' if field in conflicts else 'missing'
            if status == wanted and kinds == {wanted} and empty:
                outcome = 'correctly_flagged_' + wanted
            else:
                outcome = 'missed' if empty else 'wrong'
        elif kinds:
            outcome = 'false_conflict'
        elif empty or status in ('missing', 'conflict'):
            outcome = 'missed'
        else:
            outcome = 'correct' if _normalized(field, value) == _normalized(field, values[field]) else 'wrong'
        fields[field] = outcome
        totals[outcome] += 1
    totals.update(fields=len(values), conflicts=len(conflicts), gaps=len(missing), total=len(fields),
                  successful=totals['correct'] + totals['correctly_flagged_conflict'] + totals['correctly_flagged_missing'],
                  false_questions=totals['false_conflict'])
    totals['accuracy'] = totals['successful'] / totals['total'] if totals['total'] else 0.0
    parts = []
    if conflicts:
        parts.append(f"{totals['correctly_flagged_conflict']}/{len(conflicts)} conflicts flagged")
    if missing:
        parts.append(f"{totals['correctly_flagged_missing']}/{len(missing)} gaps flagged")
    parts += [f"{totals['correct']}/{len(values)} fields correct", f"{totals['false_questions']} false questions"]
    return {'fields': fields, 'totals': totals, 'summary': expected.get('label', 'Builder') + ': ' + ', '.join(parts)}


def _name(value):
    return re.sub(r'[^a-z0-9]', '', str(value).lower())


def score_lists(draft, expected):
    """{collection: {found, expected, matched, precision, recall}} for the keyed lists (included or not)."""
    out = {}
    for collection, names in expected.get('lists', {}).items():
        wanted = {_name(n) for n in names}
        found = {_name(e['value'].get('name') or e['value'].get('title', ''))
                 for e in draft.get('collections', {}).get(collection, [])}
        matched = len(wanted & found)
        out[collection] = {'found': len(found), 'expected': len(wanted), 'matched': matched,
                           'precision': matched / len(found) if found else 0.0,
                           'recall': matched / len(wanted) if wanted else 0.0}
    return out


def _menu_paths(items, parent=''):
    for item in items:
        path = f"{parent}/{item['label']}" if parent else item['label']
        yield path
        yield from _menu_paths(item.get('children', []), path)


def _recall(found, wanted):
    wanted = set(wanted)
    return {'expected': len(wanted), 'matched': len(wanted & set(found)),
            'recall': len(wanted & set(found)) / len(wanted) if wanted else 0.0}


def score_site(draft, expected):
    """Recall of the site model against an answer key's "site": menu paths ("About/Our Team"), links by kind,
    form actions and media addresses."""
    site, key = draft.get('site') or {}, expected.get('site') or {}
    out = {}
    if 'menu' in key:
        out['menu'] = _recall(list(_menu_paths(site.get('navigation', {}).get('main', []))), key['menu'])
    for kind, urls in key.get('links', {}).items():
        out[f'links:{kind}'] = _recall([l['url'] for l in site.get('links', []) if l['kind'] == kind], urls)
    if 'forms' in key:
        out['forms'] = _recall([f['action'] for f in site.get('forms', [])], key['forms'])
    if 'media' in key:
        out['media'] = _recall([m['url'] for m in site.get('media', [])], key['media'])
    return out


FEED_TYPES = {'.txt': 'text/plain', '.xml': 'application/xml', '.ics': 'text/calendar'}
ASSET_TYPES = {'.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml'}


def fixture_fetchers(fixture_dir):
    """(fetch, fetch_feed) serving one fixture directory as https://church.test/. Other hosts (an asset CDN) are
    served from `_hosts/<host>/`. "/about" is read from about.html, as sites without extensions serve it."""
    root = Path(fixture_dir).resolve()

    def path_of(url, suffixes):
        parsed = urlparse(url)
        base = root if parsed.hostname == 'church.test' else root / '_hosts' / (parsed.hostname or '_')
        relative = parsed.path.lstrip('/') or 'index.html'
        path = (base / relative).resolve()
        if not path.suffix and '.html' in suffixes:
            path = path.with_suffix('.html')
        if not path.is_relative_to(root) or path.suffix not in suffixes or not path.is_file():
            raise FileNotFoundError(url)
        return path

    def fetch(url):
        return url, 'text/html; charset=utf-8', path_of(url, ('.html', '.htm')).read_text(encoding='utf-8')

    def fetch_feed(url):
        path = path_of(url, tuple(FEED_TYPES))
        return url, FEED_TYPES[path.suffix], path.read_text(encoding='utf-8')

    def fetch_asset(url):
        path = path_of(url, tuple(ASSET_TYPES))
        return url, ASSET_TYPES[path.suffix], path.read_bytes()
    fetch.asset = fetch_asset
    return fetch, fetch_feed


def import_fixture(fixture_dir, complete=None, today=None):
    """Use the same injected-fetch session as builder tests, with all external readers disabled (or a fake `complete`).
    robots.txt, sitemaps and feeds in the fixture are read too."""
    fetch, fetch_feed = fixture_fetchers(fixture_dir)
    key = Path(fixture_dir) / 'expected.json'
    if today is None and key.is_file():
        pinned = json.loads(key.read_text(encoding='utf-8')).get('today')
        today = date.fromisoformat(pinned) if pinned else None
    with mock.patch.dict(os.environ, {'BUILDER_ALLOW_PRIVATE': '1'}), \
            mock.patch.object(builder_structured, '_today', lambda: today or date.today()):
        session = builder.new_session('https://church.test/', fetch=fetch, fetch_feed=fetch_feed,
                                      complete=complete or (lambda m, t: None), describe=False,
                                      fetch_css=lambda url: (url, 'text/css', fetch.asset(url)[2].decode('utf-8')))
        # Build while the date is pinned: dated events are kept or dropped against the same day.
        session['content'] = builder.collection_content(session['collections'])
    return session


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('fixture_dir', type=Path)
    args = parser.parse_args()
    expected = json.loads((args.fixture_dir / 'expected.json').read_text(encoding='utf-8'))
    draft = import_fixture(args.fixture_dir)
    result = score(draft, expected)
    print(f"{'Field':<16} Outcome")
    for field, outcome in result['fields'].items():
        print(f'{field:<16} {outcome}')
    print(result['summary'])
    totals = result['totals']
    print(f"Overall: {totals['successful']}/{totals['total']} checks correct ({totals['accuracy']:.0%})")
    lists = score_lists(draft, expected)
    if lists:
        print(f"\n{'List':<12} Found  Expected  Matched  Precision  Recall")
        for name, r in lists.items():
            print(f"{name:<12} {r['found']:>5}  {r['expected']:>8}  {r['matched']:>7}  {r['precision']:>9.0%}  {r['recall']:>6.0%}")
    site = score_site(draft, expected)
    if site:
        print(f"\n{'Site part':<16} Matched  Recall")
        for name, r in site.items():
            print(f"{name:<16} {r['matched']:>3}/{r['expected']:<3}  {r['recall']:>6.0%}")


if __name__ == '__main__':
    main()
