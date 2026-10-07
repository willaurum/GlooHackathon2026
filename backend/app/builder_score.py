"""Score builder drafts against human answer keys; run fixtures without network or AI.

Keys contain single-answer field values, plus lists of `conflicts` and `missing` fields,
and an optional `label`. Only keyed fields are scored. FAQ claims are not reconcile() fields.
Prose is compared literally after the builder's whitespace/case normalization, not semantically.

    python -m backend.app.builder_score backend/tests/fixtures/builder/cedar-hollow-static
"""
import argparse
import json
import os
from pathlib import Path
from unittest import mock
from urllib.parse import urlparse

from . import builder

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
    values = {f: v for f, v in expected.items() if f not in ('label', 'conflicts', 'missing')}
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


def import_fixture(fixture_dir):
    """Use the same injected-fetch session as builder tests, with all external readers disabled."""
    root = Path(fixture_dir).resolve()

    def fetch(url):
        path = (root / (urlparse(url).path.lstrip('/') or 'index.html')).resolve()
        if not path.is_relative_to(root) or path.suffix not in ('.html', '.htm') or not path.is_file():
            raise FileNotFoundError(url)
        return url, 'text/html; charset=utf-8', path.read_text(encoding='utf-8')

    with mock.patch.dict(os.environ, {'BUILDER_ALLOW_PRIVATE': '1'}):
        return builder.new_session('https://church.test/', fetch=fetch, complete=lambda m, t: None, describe=False)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('fixture_dir', type=Path)
    args = parser.parse_args()
    expected = json.loads((args.fixture_dir / 'expected.json').read_text(encoding='utf-8'))
    result = score(import_fixture(args.fixture_dir), expected)
    print(f"{'Field':<16} Outcome")
    for field, outcome in result['fields'].items():
        print(f'{field:<16} {outcome}')
    print(result['summary'])
    totals = result['totals']
    print(f"Overall: {totals['successful']}/{totals['total']} checks correct ({totals['accuracy']:.0%})")


if __name__ == '__main__':
    main()
