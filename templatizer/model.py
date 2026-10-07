"""The future agent's output contract; runtime church content stays authoritative."""
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, field_validator, model_validator

from backend.app.church_content import ChurchContent, normalize


class Contract(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)


class Evidence(Contract):
    path: str = Field(pattern=r'^/content/', max_length=300)
    source_url: HttpUrl
    excerpt: str = Field(min_length=1, max_length=1000)


class ReviewIssue(Contract):
    path: str = Field(pattern=r'^/content/', max_length=300)
    kind: Literal['missing', 'conflict', 'unverified']
    message: str = Field(min_length=1, max_length=1000)
    candidates: list[str] = Field(default_factory=list, max_length=20)


def reject_extra_fields(value, path='content'):
    """The API allows newer fields; agent output only uses fields this template knows."""
    if isinstance(value, BaseModel):
        if value.model_extra:
            raise ValueError(f'{path}: unsupported fields: {", ".join(value.model_extra)}')
        for name in type(value).model_fields:
            reject_extra_fields(getattr(value, name), f'{path}.{name}')
    elif isinstance(value, list):
        for index, item in enumerate(value):
            reject_extra_fields(item, f'{path}.{index}')


def pointer(document, path):
    """Resolve a JSON pointer without guessing a missing field or array item."""
    value = document
    for part in path.split('/')[1:]:
        if '~' in part.replace('~0', '').replace('~1', ''):
            raise ValueError(f'Invalid JSON pointer: {path}')
        key = part.replace('~1', '/').replace('~0', '~')
        if isinstance(value, list):
            if not key.isdigit() or (len(key) > 1 and key.startswith('0')):
                raise ValueError(f'Invalid array index: {path}')
            value = value[int(key)]
        else:
            value = value[key]
    return value


class SiteBlueprint(Contract):
    schema_version: Literal[1]
    template: Literal['tekton-church-v1']
    church_slug: str = Field(pattern=r'^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$', max_length=40)
    source_urls: list[HttpUrl] = Field(default_factory=list, max_length=100)
    content: ChurchContent
    evidence: list[Evidence] = Field(default_factory=list, max_length=2000)
    review: list[ReviewIssue] = Field(default_factory=list, max_length=300)

    @field_validator('schema_version', mode='before')
    @classmethod
    def integer_version(cls, value):
        if type(value) is not int:
            raise ValueError('schema_version must be an integer')
        return value

    @model_validator(mode='after')
    def compatible_content(self):
        if self.content.info is None:
            raise ValueError('content.info with a church name is required')
        if self.church_slug in {'admin', 'api', 'new', 'start', 'give', 'church', 'churches', 'demo', 'www', 'app', 'mail', 'setup', 'staff', 'static'}:
            raise ValueError('church_slug is reserved by the template')
        reject_extra_fields(self.content)
        normalize(self.content)  # Duplicate ids, invalid dates and other runtime rules.
        return self

    def validate_evidence(self, raw_document):
        sources = {str(url) for url in self.source_urls}
        for item in self.evidence:
            if str(item.source_url) not in sources:
                raise ValueError(f'{item.path}: evidence URL must be listed in source_urls')
            try:
                value = pointer(raw_document, item.path)
            except (KeyError, IndexError, TypeError, ValueError) as error:
                raise ValueError(f'{item.path}: evidence points to a missing field') from error
            if value in (None, '', [], {}) or isinstance(value, str) and not value.strip():
                raise ValueError(f'{item.path}: evidence points to an empty field')

    def report(self):
        info = self.content.info
        warnings = []
        if not info.address:
            warnings.append('Street address is missing; keep it blank until confirmed.')
        if not info.services:
            warnings.append('Service times are missing; visit signup stays unavailable until added.')
        if not self.evidence:
            warnings.append('No source evidence supplied; this content still needs factual review.')
        blocking = [issue.model_dump() for issue in self.review if issue.kind in {'conflict', 'unverified'}]
        return {
            'church_slug': self.church_slug,
            'template': self.template,
            'status': 'needs_review' if blocking else 'ready_to_prepare',
            'sections': list(normalize(self.content)),
            'warnings': warnings,
            'blocking_issues': blocking,
            'review': [issue.model_dump() for issue in self.review],
        }


def schema():
    document = SiteBlueprint.model_json_schema()
    document['$schema'] = 'https://json-schema.org/draft/2020-12/schema'
    document['$id'] = 'https://example.org/tekton/schemas/site-blueprint-v1.json'
    # Match reject_extra_fields without duplicating the existing content models.
    def close_objects(value):
        if isinstance(value, dict):
            if 'properties' in value:
                value['additionalProperties'] = False
            for nested in value.values():
                close_objects(nested)
        elif isinstance(value, list):
            for nested in value:
                close_objects(nested)
    close_objects(document)
    return document
