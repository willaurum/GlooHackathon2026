"""A church as one JSON document: the import shape.

GET /api/church/content returns everything a church shows, and PUT /api/church/content
replaces the sections it is sent (staff only; the Worker checks the staff session).
The shape is exactly the seed files the demo church starts from:

    {"info": ..., "faqs": [...], "events": [...], "groups": [...]}   backend/app/church.json
    {"ministries": [...]}                                            backend/app/ministries.json
    {"calendar": [...]}                                              backend/app/events.json
    {"regions": [...]}                                               backend/app/regions.json
    {"staff": [...], "locations": [...], "sermons": [...]}           filled by the site builder (builder.py)
    {"site": {...}, "pages": [...]}                                  the imported website's menu, pages, links,
                                                                     forms, media and look (builder_site.py)

so anything that can write those files (the Church setup screens today, a site importer
later) can set up a church. Every section is optional; one that is sent replaces that
section. Items without an id get one.
"""

import re
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator

from . import db

router = APIRouter()

Text = lambda n: Field(default='', max_length=n)  # noqa: E731


class Loose(BaseModel):
    # Extra fields are kept, so content from a newer importer is not thrown away.
    model_config = ConfigDict(str_strip_whitespace=True, extra='allow')


class Service(Loose):
    day: str = Field(min_length=1, max_length=40)
    time: str = Field(min_length=1, max_length=40)
    note: str = Text(300)


class Info(Loose):
    name: str = Field(min_length=1, max_length=120)
    city: str = Text(120)
    address: str = Text(300)
    phone: str = Text(60)
    email: str = Text(200)
    office_hours: str = Text(200)
    services: list[Service] = Field(default_factory=list, max_length=30)
    about: str = Text(4000)
    # The big headline at the top of Home; empty shows the template's own ("A place to belong, grow and give.").
    tagline: str = Text(160)
    first_visit: str = Text(4000)
    care_team: str = Text(4000)
    map_query: str = Text(300)


class Faq(Loose):
    id: int | None = Field(default=None, ge=0)
    question: str = Field(min_length=1, max_length=300)
    answer: str = Field(min_length=1, max_length=4000)


class Highlight(Loose):
    """church.json events and groups: short listings the visit page and the chat use."""
    id: int | None = Field(default=None, ge=0)
    name: str = Field(min_length=1, max_length=200)
    when: str = Text(200)
    where: str = Text(200)
    description: str = Text(2000)
    audience: str = Text(100)


def _date(value):
    from datetime import date
    date.fromisoformat(value)
    return value


def _clock(value):
    from datetime import time
    time.fromisoformat(value)
    return value[:5]


class Shift(Loose):
    id: str = Field(default='', max_length=40)
    date: str
    start_time: str
    end_time: str
    filled: int = Field(default=0, ge=0, le=10000)
    total: int = Field(default=1, ge=1, le=10000)
    services: list[str] = Field(default_factory=list, max_length=10)
    frequencies: list[Literal['one-time', 'weekly', 'monthly']] = Field(default_factory=lambda: ['one-time', 'weekly', 'monthly'])

    @field_validator('date')
    @classmethod
    def _valid_date(cls, value):
        return _date(value)

    @field_validator('start_time', 'end_time')
    @classmethod
    def _valid_time(cls, value):
        return _clock(value)


class Ministry(Loose):
    id: int | None = Field(default=None, ge=0)
    name: str = Field(min_length=1, max_length=120)
    category: str = Text(80)
    icon: str = Field(default='\u2726', max_length=4)
    description: str = Text(2000)
    skills: list[str] = Field(default_factory=list, max_length=20)
    style: str = Text(80)
    day: str = Text(120)
    head: str = Text(120)
    email: str = Text(200)
    note: str = Text(500)
    filled: int = Field(default=0, ge=0, le=10000)
    total: int = Field(default=0, ge=0, le=10000)
    shifts: list[Shift] = Field(default_factory=list, max_length=100)
    requirements: list[str] = Field(default_factory=list, max_length=10)


class CalendarEvent(Loose):
    id: int | None = Field(default=None, ge=0)
    title: str = Field(min_length=1, max_length=200)
    category: str = Field(default='General', min_length=1, max_length=100)
    date: str
    time: str = Field(default='', max_length=100)
    location: str = Text(200)
    ministry_name: str | None = Field(default=None, max_length=120)
    description: str = Text(4000)
    ai_summary: str | None = Field(default=None, max_length=4000)

    @field_validator('date')
    @classmethod
    def _valid_date(cls, value):
        return _date(value)


class FieldUpdate(Loose):
    """One dated "From the field" entry for a region. Ids are assigned by the database."""
    id: int | None = Field(default=None, ge=0)
    date: str
    title: str = Text(200)
    body: str = Field(min_length=1, max_length=4000)
    author: str = Text(120)

    @field_validator('date')
    @classmethod
    def _valid_date(cls, value):
        return _date(value)


class Region(Loose):
    """A country the church prays for and serves in. Only the whole country is ever shown, never a point."""
    id: int | None = Field(default=None, ge=0)
    country: str = Field(min_length=1, max_length=80)
    country_code: str = Field(pattern=r'^[A-Z]{3}$')
    codename: str = Field(min_length=1, max_length=120)
    field_of_ministry: str = Text(300)
    since: int | None = Field(default=None, ge=1900, le=2100)
    team_size: int = Field(default=0, ge=0, le=10000)
    updates: list[FieldUpdate] = Field(default_factory=list, max_length=300)


class Person(Loose):
    """A staff or leadership directory entry."""
    id: int | None = Field(default=None, ge=0)
    name: str = Field(min_length=1, max_length=120)
    role: str = Text(120)
    group: str = Text(80)  # "Elders", "Deacons": the list a leader appears under on the church's site
    email: str = Text(200)
    phone: str = Text(60)
    bio: str = Text(2000)
    photo: str = Text(500)


class Location(Loose):
    """A campus or meeting place. The church's main address stays in info.address."""
    id: int | None = Field(default=None, ge=0)
    name: str = Field(min_length=1, max_length=120)
    address: str = Text(300)
    map_query: str = Text(300)
    service_times: str = Text(300)
    note: str = Text(500)


class Sermon(Loose):
    """A sermon or message the church has published (a link, not a Sermon Notes transcript)."""
    id: int | None = Field(default=None, ge=0)
    title: str = Field(min_length=1, max_length=200)
    date: str = ''
    speaker: str = Text(120)
    series: str = Text(120)
    scripture: str = Text(120)
    url: str = Field(default='', max_length=500, pattern=r'^(https?://\S+)?$')

    @field_validator('date')
    @classmethod
    def _valid_date(cls, value):
        return _date(value) if value else value


WEB_URL = r'^(https?://[^\s<>"]{1,490})?$'
WebUrl = lambda: Field(default='', max_length=500, pattern=WEB_URL)  # noqa: E731
SLUG = r'^[a-z0-9][a-z0-9-]{0,79}$'
COLOR = r'^(#[0-9a-fA-F]{6})?$'


class Strict(BaseModel):
    # What a church's pages render (addresses, players, colors) keeps only the fields defined here.
    model_config = ConfigDict(str_strip_whitespace=True, extra='ignore')


class PageLink(Strict):
    text: str = Text(120)
    url: str = Field(pattern=WEB_URL, min_length=1, max_length=500)


class PageSection(Strict):
    heading: str = Text(200)
    level: int = Field(default=2, ge=0, le=6)
    text: str = Text(4000)
    links: list[PageLink] = Field(default_factory=list, max_length=20)
    embeds: list[str] = Field(default_factory=list, max_length=10)

    @field_validator('embeds')
    @classmethod
    def _web_embeds(cls, value):
        return [url for url in value if re.fullmatch(WEB_URL, url) and url]


class SitePage(Strict):
    """A page of the church's own website, recreated as headed sections of text, buttons and players."""
    id: int | None = Field(default=None, ge=0)
    slug: str = Field(pattern=SLUG)
    title: str = Field(min_length=1, max_length=200)
    page_type: str = Text(30)
    source_url: str = WebUrl()
    sections: list[PageSection] = Field(default_factory=list, max_length=40)


class MenuItem(Strict):
    """A menu entry: one of the church's pages (`page`, a slug), an address, or a label over a submenu."""
    label: str = Field(min_length=1, max_length=80)
    page: str = Field(default='', pattern=r'^([a-z0-9][a-z0-9-]{0,79})?$')
    url: str = WebUrl()
    children: list['MenuItem'] = Field(default_factory=list, max_length=30)


class Navigation(Strict):
    main: list[MenuItem] = Field(default_factory=list, max_length=60)
    footer: list[MenuItem] = Field(default_factory=list, max_length=60)


class SiteLink(Strict):
    url: str = Field(pattern=WEB_URL, min_length=1, max_length=500)
    text: str = Text(120)
    kind: str = Text(20)
    provider: str = Text(80)
    cta: bool = False
    context: str = Text(200)


class FormField(Strict):
    name: str = Text(80)
    type: str = Text(20)
    label: str = Text(120)
    required: bool = False


class SiteForm(Strict):
    """A form on the old site: where it sent answers and what it asked. Recreated as a link, never re-posted."""
    action: str = WebUrl()
    name: str = Text(120)
    fields: list[FormField] = Field(default_factory=list, max_length=30)
    submit: str = Text(60)
    provider: str = Text(80)
    embedded: bool = False
    page: str = Field(default='', pattern=r'^([a-z0-9][a-z0-9-]{0,79})?$')


class SiteMedia(Strict):
    url: str = Field(pattern=WEB_URL, min_length=1, max_length=500)
    title: str = Text(200)
    kind: str = Text(20)
    provider: str = Text(80)


class Theme(Strict):
    """Colors and fonts read from the site's public styles; the church's pages use them over the defaults."""
    primary: str = Field(default='', pattern=COLOR)
    accent: str = Field(default='', pattern=COLOR)
    background: str = Field(default='', pattern=COLOR)
    text: str = Field(default='', pattern=COLOR)
    heading_font: str = Field(default='', max_length=60, pattern=r"^[A-Za-z0-9 '\-]*$")
    body_font: str = Field(default='', max_length=60, pattern=r"^[A-Za-z0-9 '\-]*$")
    logo: str = WebUrl()
    favicon: str = WebUrl()


class Asset(Strict):
    """An image on the old site, referenced by its address (not copied). `rights` is the church confirming it may
    use it; only confirmed images are shown."""
    url: str = Field(pattern=WEB_URL, min_length=1, max_length=500)
    role: str = Text(20)
    alt: str = Text(200)
    rights: bool = False


# The parts of the church site Layout.hidden_pages may hide (frontend routes; Layout.jsx SECTIONS).
HIDEABLE_PAGES = ('serve', 'serve/find', 'notes', 'calendar', 'give', 'give/trips', 'prayer',
                  'guests/welcome', 'about/beliefs', 'about/news', 'about/directory', 'about/connect')


class Layout(Strict):
    """The order of the Home and Plan your visit sections, and the ones hidden ('page:section'), set by a request
    to Tekton ("Put service times above ministries"). The keys are builder_edit.PAGES."""
    home: list[str] = Field(default_factory=list, max_length=20)
    visit: list[str] = Field(default_factory=list, max_length=20)
    hidden: list[str] = Field(default_factory=list, max_length=40)
    # Parts of the site the church does not use ("We don't have a calendar"), as routes: left out of the menus,
    # Home's cards and links, and opening one goes Home. Home and Plan your visit cannot be hidden.
    hidden_pages: list[str] = Field(default_factory=list, max_length=20)

    @field_validator('home', 'visit', 'hidden')
    @classmethod
    def _keys(cls, value):
        return [key for key in value if re.fullmatch(r'[a-z_]{1,30}(:[a-z_]{1,30})?', key)]

    @field_validator('hidden_pages')
    @classmethod
    def _pages(cls, value):
        return list(dict.fromkeys(key for key in value if key in HIDEABLE_PAGES))


class Site(Strict):
    navigation: Navigation = Field(default_factory=Navigation)
    layout: Layout | None = None
    links: list[SiteLink] = Field(default_factory=list, max_length=150)
    forms: list[SiteForm] = Field(default_factory=list, max_length=20)
    media: list[SiteMedia] = Field(default_factory=list, max_length=40)
    theme: Theme = Field(default_factory=Theme)
    assets: list[Asset] = Field(default_factory=list, max_length=40)
    source_url: str = WebUrl()


class ChurchContent(BaseModel):
    model_config = ConfigDict(extra='forbid')
    info: Info | None = None
    faqs: list[Faq] | None = Field(default=None, max_length=100)
    events: list[Highlight] | None = Field(default=None, max_length=100)
    groups: list[Highlight] | None = Field(default=None, max_length=100)
    ministries: list[Ministry] | None = Field(default=None, max_length=60)
    calendar: list[CalendarEvent] | None = Field(default=None, max_length=500)
    regions: list[Region] | None = Field(default=None, max_length=60)
    staff: list[Person] | None = Field(default=None, max_length=200)
    locations: list[Location] | None = Field(default=None, max_length=30)
    sermons: list[Sermon] | None = Field(default=None, max_length=200)
    site: Site | None = None
    pages: list[SitePage] | None = Field(default=None, max_length=60)


class ContentError(ValueError):
    pass


def public_info(content):
    return content.get('info', {})


def public_church(content):
    return {'info': public_info(content), 'faqs': content.get('faqs', []), 'events': content.get('events', []),
            'groups': content.get('groups', []), 'staff': content.get('staff', []),
            'locations': content.get('locations', []), 'sermons': content.get('sermons', []),
            'site': public_site_model(content), 'pages': page_summaries(content.get('pages', []))}


def public_site_model(content):
    """The site model without images the church has not confirmed it may use."""
    site = content.get('site')
    if not site:
        return None
    return {**site, 'assets': [a for a in site.get('assets', []) if a.get('rights')]}


def page_summaries(pages):
    """The menu needs each page's slug and title; a page's sections come from GET /api/church/pages/{slug}."""
    return [{'id': p['id'], 'slug': p['slug'], 'title': p['title'], 'page_type': p.get('page_type', ''), 'source_url': p.get('source_url', '')} for p in pages]


def public_ministries(content):
    return [db.with_shift_coverage(m) for m in sorted(content.get('ministries', []), key=lambda m: m['id'])]


def public_events(content):
    return [{key: event.get(key) for key in ('id', *db.EVENT_COLUMNS)}
            for event in sorted(content.get('calendar', []), key=lambda e: (e.get('date') or '', e.get('time') or ''))]


def public_site(content):
    """The public site responses, without reading or writing a church database. A preview also carries every
    page in full, so it can be shown without asking for each page."""
    return {'info': public_info(content), 'church': public_church(content),
            'ministries': public_ministries(content), 'events': public_events(content),
            'pages': content.get('pages', [])}


def with_ids(items, label):
    """Give items without an id the next free one, keeping the ids they have."""
    given = [item['id'] for item in items if item.get('id') is not None]
    if len(given) != len(set(given)):
        raise ContentError(f'Two {label} have the same id.')
    used, next_id, out = set(given), 0, []
    for item in items:
        if item.get('id') is None:
            while next_id in used:
                next_id += 1
            item = {**item, 'id': next_id}
            used.add(next_id)
        out.append(item)
    return out


def normalize(body):
    """The validated document as plain data with ids, ready for db.replace_content."""
    content = {key: value for key, value in body.model_dump().items() if value is not None}
    if 'info' in content:
        info = content['info']
        info['map_query'] = info['map_query'] or info['address'] or info['city']
    for kind, label in (('faqs', 'FAQs'), ('events', 'events'), ('groups', 'groups'), ('calendar', 'calendar events'),
                        ('staff', 'staff members'), ('locations', 'locations'), ('sermons', 'sermons'),
                        ('pages', 'pages')):
        if kind in content:
            content[kind] = with_ids(content[kind], label)
    slugs = [p['slug'] for p in content.get('pages', [])]
    if len(slugs) != len(set(slugs)):
        raise ContentError('Two pages have the same address.')
    for location in content.get('locations', []):
        location['map_query'] = location['map_query'] or location['address']
    if 'regions' in content:
        regions = with_ids(content['regions'], 'regions')
        codes = [r['country_code'] for r in regions]
        if len(codes) != len(set(codes)):
            raise ContentError('Each country can only be added once. Put all its updates under one entry.')
        content['regions'] = regions
    if 'ministries' in content:
        ministries = with_ids(content['ministries'], 'ministries')
        for m in ministries:
            m['shifts'] = [{**shift, 'id': shift['id'] or f"{m['id']}-{n + 1}"} for n, shift in enumerate(m['shifts'])]
            if m['shifts']:
                m['filled'] = sum(shift['filled'] for shift in m['shifts'])
                m['total'] = sum(shift['total'] for shift in m['shifts'])
            else:
                # Without a schedule, the helpers needed are just `total` (db.with_shift_coverage
                # would count an empty schedule as zero).
                del m['shifts']
        content['ministries'] = ministries
    return content


@router.get('/api/church/pages/{slug}')
def get_page(slug: str):
    """One page of the church's recreated website."""
    page = db.get_page(slug)
    if not page:
        raise HTTPException(status_code=404, detail='Page not found')
    return page


@router.get('/api/church/content')
def get_content():
    return db.export_content()


@router.put('/api/church/content')
def put_content(body: ChurchContent):
    try:
        content = normalize(body)
    except ContentError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return db.replace_content(content)
