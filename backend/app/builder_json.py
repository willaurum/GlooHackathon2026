"""church.json and site.json: the two files Tekton writes for a church, and the schemas they follow.

Tekton's extraction ends here: these files are its output. Loading them into a church (Create your church) is
the other half of the work and is not done in this module.

    church.json   who the church is: info (name, address, service times...), FAQs, events, groups, ministries,
                  calendar, staff, locations, sermons, and where each imported fact came from (`sources`)
    site.json     how its site looks and reads: theme (colors, fonts, logo), menu, section order (layout), links,
                  forms, media, images, the pages recreated from the old site, and the calendars it embeds

The schemas are generated from the Pydantic models below, which reuse church_content's models, so the files, the
schemas in schemas/*.schema.json and what a church stores cannot drift apart (backend/tests/test_builder_json.py
fails when the committed schemas are stale; `python -m backend.app.builder_json` rewrites them).

`sources` maps each imported fact to its evidence: `info.<field>` and `items.<section>.<name key>` (the name
lowercased, punctuation as spaces) to a list of {title, url, quote, prefix, suffix}. A fact the church typed has
one entry titled "You confirmed this" with no url.
"""
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from . import church_content as cc

SCHEMA_VERSION = '1.0'
SCHEMA_DIR = Path(__file__).resolve().parents[2] / 'schemas'
CHURCH_SECTIONS = ('faqs', 'events', 'groups', 'ministries', 'calendar', 'staff', 'locations', 'sermons')


class Source(BaseModel):
    """Where one fact came from: the page (title, url) and the exact words on it (quote, with a few words of
    context either side so a link can point at that spot)."""
    model_config = ConfigDict(extra='forbid')
    title: str = Field(default='', max_length=300)
    url: str = Field(default='', max_length=500)
    quote: str = Field(default='', max_length=4000)
    prefix: str = Field(default='', max_length=80)
    suffix: str = Field(default='', max_length=80)


class Sources(BaseModel):
    model_config = ConfigDict(extra='forbid')
    info: dict[str, list[Source]] = Field(default_factory=dict)
    items: dict[str, dict[str, list[Source]]] = Field(default_factory=dict)


class Header(BaseModel):
    model_config = ConfigDict(extra='forbid')
    schema_version: Literal['1.0'] = SCHEMA_VERSION
    generated_by: Literal['tekton'] = 'tekton'
    generated_at: str = Field(default='', max_length=40)
    source_url: str = Field(default='', max_length=500)


class ChurchFile(Header):
    """church.json"""
    kind: Literal['church'] = 'church'
    info: cc.Info
    faqs: list[cc.Faq] = Field(default_factory=list, max_length=100)
    events: list[cc.Highlight] = Field(default_factory=list, max_length=100)
    groups: list[cc.Highlight] = Field(default_factory=list, max_length=100)
    ministries: list[cc.Ministry] = Field(default_factory=list, max_length=60)
    calendar: list[cc.CalendarEvent] = Field(default_factory=list, max_length=500)
    staff: list[cc.Person] = Field(default_factory=list, max_length=200)
    locations: list[cc.Location] = Field(default_factory=list, max_length=30)
    sermons: list[cc.Sermon] = Field(default_factory=list, max_length=200)
    sources: Sources = Field(default_factory=Sources)


class Calendar(BaseModel):
    """A calendar the church's site embeds or links (builder_calendar.detect). `feed_url` is its public iCal feed
    when the provider has one; `status` says whether its events were imported (found, link, imported, declined,
    failed), and `count` how many."""
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


class SiteFile(Header):
    """site.json"""
    kind: Literal['site'] = 'site'
    site: cc.Site = Field(default_factory=cc.Site)
    pages: list[cc.SitePage] = Field(default_factory=list, max_length=60)
    calendars: list[Calendar] = Field(default_factory=list, max_length=10)


MODELS = {'church': ChurchFile, 'site': SiteFile}


def schemas():
    """{'church': JSON Schema, 'site': JSON Schema}, as committed in schemas/."""
    out = {}
    for name, model in MODELS.items():
        schema = model.model_json_schema()
        schema = {'$schema': 'https://json-schema.org/draft/2020-12/schema',
                  '$id': f'https://tekton.church/schemas/{name}.schema.json', **schema}
        out[name] = schema
    return out


def schema_text(name):
    return json.dumps(schemas()[name], indent=2, sort_keys=True, ensure_ascii=False) + '\n'


def write_schemas(directory=SCHEMA_DIR):
    directory.mkdir(parents=True, exist_ok=True)
    for name in MODELS:
        (directory / f'{name}.schema.json').write_text(schema_text(name), encoding='utf-8')


def files(session, content=None, sources=None):
    """{'church': church.json, 'site': site.json} for a draft. `content` is its built ChurchContent (built here
    from the draft when not given); `sources` its provenance (builder.provenance)."""
    from . import builder
    content = content if content is not None else builder.build_content(session, allow_unanswered=True)
    sources = _clean_sources(sources if sources is not None else builder.provenance(session))
    header = {'schema_version': SCHEMA_VERSION, 'generated_by': 'tekton',
              'generated_at': session.get('created_at') or datetime.now(timezone.utc).isoformat(),
              'source_url': session.get('url') or ''}
    church = {**header, 'kind': 'church', 'info': content.get('info', {}),
              **{key: content.get(key, []) for key in CHURCH_SECTIONS}, 'sources': sources}
    calendars = [{k: c.get(k) for k in Calendar.model_fields if k in c}
                 for c in (session.get('site') or {}).get('calendars', [])]
    site = {**header, 'kind': 'site', 'site': content.get('site') or {}, 'pages': content.get('pages', []),
            'calendars': calendars}
    return {'church': church, 'site': site}


SOURCE_FIELDS = tuple(Source.model_fields)


def _clean_sources(sources):
    pick = lambda evidence: [{k: str(e.get(k) or '') for k in SOURCE_FIELDS} for e in evidence]  # noqa: E731
    return {'info': {field: pick(ev) for field, ev in (sources.get('info') or {}).items()},
            'items': {section: {key: pick(ev) for key, ev in entries.items()}
                      for section, entries in (sources.get('items') or {}).items()}}


def _plain(text):
    return re.sub(r'[^a-z0-9]+', '', str(text or '').lower())


def _published(source):
    """Everything the page publishes that a fact can be read from: its title and text, and its structured data,
    link and embed titles and meta tags (an event's JSON-LD, a video's title)."""
    parts = [source.get('title') or '', source.get('text') or '', source.get('site_name') or '']
    parts.append(json.dumps(source.get('jsonld') or [], ensure_ascii=False))
    parts += [str(a[1]) for a in source.get('anchors') or [] if isinstance(a, (list, tuple)) and len(a) > 1]
    parts += [json.dumps(source.get(key) or [], ensure_ascii=False) for key in ('embeds', 'meta')]
    return ' '.join(parts)


def traces(quote, source):
    """True when the quote's words are on the page (see _published), ignoring case, spacing and punctuation: a
    pattern rule may have joined an address's lines with commas, and a name may come from the page title."""
    plain = _plain(quote)
    return len(plain) >= 3 and plain in _plain(_published(source))


def _where(error):
    return '.'.join(str(part) for part in error['loc']) or '(top)'


def validate(name, document):
    """Errors ('church.staff.0.name: Field required') for one file against its schema; [] when it is valid."""
    try:
        MODELS[name].model_validate(document)
    except ValidationError as error:
        return [f"{name}.{_where(e)}: {e['msg']}" for e in error.errors()[:20]]
    return []


def unsupported(session):
    """(checked, [fact]) for every imported fact in church.json whose quote is not on the page it cites. Needs the
    page texts, so it runs while the import still has them (builder.finish_run)."""
    texts = {s.get('url'): s for s in session.get('sources', []) if s.get('url') and s.get('text')}
    checked, missing = 0, []

    def check(label, evidence):
        """A fact is supported when one of its sources really says it."""
        nonlocal checked
        pages = [e for e in evidence if e.get('url') in texts]
        if not pages:
            return  # typed by the church, or a file upload: nothing on a page to check
        checked += 1
        if not any(traces(e.get('quote', ''), texts[e['url']]) for e in pages):
            missing.append(label)
    from . import builder
    sources = builder.provenance(session)
    for field, evidence in sources['info'].items():
        check(f'info.{field}', evidence)
    for section, entries in sources['items'].items():
        for key, evidence in entries.items():
            check(f'{section}: {key}', evidence)
    return checked, missing


def check(session):
    """The file check the review shows: both files against their schemas, and every fact against its page."""
    from . import builder
    try:
        out = files(builder._with_pages(session) if session.get('id') and _stored(session) else session)
        errors = validate('church', out['church']) + validate('site', out['site'])
    except Exception as error:  # a draft that cannot be built yet is reported, not raised
        errors = [f'church.json could not be built: {error}'[:300]]
    checked, missing = unsupported(session)
    return {'valid': not errors, 'errors': errors, 'facts_checked': checked, 'unsupported': missing[:20],
            'unsupported_count': len(missing), 'schema_version': SCHEMA_VERSION}


def _stored(session):
    """True when the draft's page sections live in the draft store rather than on the pages themselves."""
    pages = session.get('site', {}).get('pages') or []
    return bool(pages) and not any(p.get('sections') for p in pages)


def summary(result):
    """The step the progress feed shows."""
    if result['valid'] and not result['unsupported_count']:
        return ('Checking church.json and site.json against the schema… valid'
                + (f'; all {result["facts_checked"]} imported facts trace to their pages' if result['facts_checked'] else ''))
    parts = []
    if not result['valid']:
        parts.append(f'{len(result["errors"])} schema ' + ('problem' if len(result['errors']) == 1 else 'problems'))
    if result['unsupported_count']:
        n = result['unsupported_count']
        parts.append(f'{n} ' + ('fact does not trace to its page' if n == 1 else 'facts do not trace to their pages'))
    return 'Checking church.json and site.json against the schema… ' + ', '.join(parts)


def slug_key(name):
    return ' '.join(re.sub(r'[^a-z0-9]+', ' ', str(name).lower()).split())


if __name__ == '__main__':
    write_schemas()
    print('wrote', ', '.join(f'schemas/{n}.schema.json' for n in MODELS))
