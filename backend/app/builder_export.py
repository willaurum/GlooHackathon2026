"""A builder result as church seed files, and the inverse import."""
import argparse
import json
from pathlib import Path

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .church_content import ChurchContent, ContentError, normalize

SECTIONS = {
    'church.json': ('info', 'faqs', 'events', 'groups'),
    'ministries.json': ('ministries',),
    'events.json': ('calendar',),
    'builder.json': ('staff', 'locations', 'sermons', 'site', 'pages'),
    'regions.json': ('regions',),
}


def files(content, *, versioned=False, sources=None, calendars=None) -> dict[str, dict]:
    if isinstance(content, ChurchContent):
        content = normalize(content)
    unknown = content.keys() - {key for keys in SECTIONS.values() for key in keys}
    if unknown:
        raise ContentError('Unknown content sections: ' + ', '.join(sorted(unknown)))
    if versioned:
        header = {'schema_version': '1.0', 'generated_by': 'tekton'}
        out = {'church.json': {**header, 'kind': 'church',
               **{key: content[key] for key in CHURCH_FIELDS if key in content},
               'sources': sources or {'info': {}, 'items': {}}},
               'site.json': {**header, 'kind': 'site', 'site': content.get('site', {}), 'pages': content.get('pages', []), 'calendars': calendars or []}}
        if 'regions' in content:
            out['regions.json'] = {'regions': content['regions']}
        return out
    return {name: {key: content[key] for key in keys if key in content}
            for name, keys in SECTIONS.items() if name != 'regions.json' or 'regions' in content}



class _CalendarFile(BaseModel):
    model_config = ConfigDict(extra='forbid')
    id: str = Field(max_length=10)
    provider: str = Field(max_length=60)
    name: str = Field(default='', max_length=120)
    feed_url: str = Field(default='', max_length=500)
    page_url: str = Field(default='', max_length=500)
    page_title: str = Field(default='', max_length=300)
    embed_url: str = Field(default='', max_length=2000)
    robots_allowed: bool | None = None
    status: Literal['found', 'link', 'imported', 'declined', 'failed'] = 'found'
    count: int = Field(default=0, ge=0, le=10000)


def calendars(files):
    """Discovery metadata from site.json; importing JSON never fetches its feeds."""
    site = files.get('site.json') or {}
    data = site.get('calendars', []) if isinstance(site, dict) else []
    if not isinstance(data, list) or len(data) > 10:
        raise ContentError('Invalid calendars in site.json')
    try:
        return [_CalendarFile.model_validate(item).model_dump() for item in data]
    except ValidationError as error:
        raise ContentError(str(error)) from error


HEADERS = ('schema_version', 'generated_by', 'generated_at', 'source_url', 'kind')
CHURCH_FIELDS = ('info', 'faqs', 'events', 'groups', 'ministries', 'calendar', 'staff', 'locations', 'sermons')


def _versioned(name, data):
    kind = 'church' if name == 'church.json' else 'site'
    if data.get('schema_version') != '1.0' or data.get('generated_by') != 'tekton' or data.get('kind') != kind:
        raise ContentError('Unsupported version or file header in ' + name)
    for key, limit in (('generated_at', 40), ('source_url', 500)):
        if key in data and (not isinstance(data[key], str) or len(data[key]) > limit):
            raise ContentError('Invalid ' + key + ' in ' + name)
    return {key: value for key, value in data.items() if key not in HEADERS}


def sources(files):
    """Evidence from the versioned church file, validated separately from stored church content."""
    church = files.get('church.json') or {}
    if not isinstance(church, dict) or 'schema_version' not in church:
        return None
    source = church.get('sources', {})
    if not isinstance(source, dict) or source.keys() - {'info', 'items'}:
        raise ContentError('Invalid sources in church.json')
    info, items = source.get('info', {}), source.get('items', {})
    if not isinstance(info, dict) or not isinstance(items, dict) or any(not isinstance(v, dict) for v in items.values()):
        raise ContentError('Invalid source groups in church.json')
    limits = {'title': 300, 'url': 500, 'quote': 4000, 'prefix': 80, 'suffix': 80}
    for group in [info, *items.values()]:
        for evidence in group.values():
            if not isinstance(evidence, list):
                raise ContentError('Invalid source evidence in church.json')
            for entry in evidence:
                if not isinstance(entry, dict) or entry.keys() - limits.keys() or any(
                        not isinstance(value, str) or len(value) > limits[key] for key, value in entry.items()):
                    raise ContentError('Invalid source evidence in church.json')
    return {'info': info, 'items': items} if info or any(items.values()) else None


def load(files) -> dict:
    if not isinstance(files, dict) or not files:
        raise ContentError("Choose church seed files or a combined site-files JSON object.")
    content = {}
    for name, data in files.items():
        if name not in SECTIONS and name != 'site.json':
            raise ContentError('Unknown content file: ' + name)
        versioned = name in ('church.json', 'site.json') and isinstance(data, dict) and 'schema_version' in data
        if name == 'site.json' and not versioned:
            raise ContentError('site.json must include a supported schema_version.')
        if versioned:
            data = _versioned(name, data)
            if name == 'church.json':
                sources(files)
                data.pop('sources', None)
            else:
                calendars(files)
                data.pop('calendars', None)
        keys = CHURCH_FIELDS if versioned and name == 'church.json' else ('site', 'pages') if name == 'site.json' else SECTIONS[name]
        # The demo's older single-section seed files are bare arrays.
        if isinstance(data, list) and len(keys) == 1:
            data = {keys[0]: data}
        if not isinstance(data, dict) or data.keys() - set(keys):
            raise ContentError('Invalid sections in ' + name)
        if content.keys() & data.keys():
            raise ContentError('Content sections appear in more than one file.')
        content.update(data)
    try:
        return normalize(ChurchContent(**content))
    except ValidationError as error:
        raise ContentError(str(error)) from error


def main():
    from . import builder, builder_score, builder_structured
    from contextlib import ExitStack
    from datetime import date
    from unittest import mock

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', help='Fixture directory or website URL')
    parser.add_argument('out_dir', type=Path)
    parser.add_argument('--answers', type=Path)
    args = parser.parse_args()
    with ExitStack() as stack:
        if Path(args.source).is_dir():
            key = Path(args.source) / 'expected.json'
            today = json.loads(key.read_text(encoding='utf-8')).get('today') if key.is_file() else None
            if today:
                stack.enter_context(mock.patch.object(builder_structured, '_today', lambda: date.fromisoformat(today)))
            session = builder_score.import_fixture(args.source)
        else:
            session = builder.new_session(args.source)
        if args.answers:
            answers = json.loads(args.answers.read_text(encoding='utf-8'))
            if not isinstance(answers, dict):
                parser.error('Answers must be a JSON object of field: value pairs.')
            for field, value in answers.items():
                builder.apply_answer(session, field, value)
        result = files(builder.build_content(session, allow_unanswered=True))
    args.out_dir.mkdir(parents=True, exist_ok=True)
    for name, data in result.items():
        (args.out_dir / name).write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
