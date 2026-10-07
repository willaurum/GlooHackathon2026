"""A builder result as church seed files, and the inverse import."""
import argparse
import json
from pathlib import Path

from pydantic import ValidationError

from .church_content import ChurchContent, ContentError, normalize

SECTIONS = {
    'church.json': ('info', 'faqs', 'events', 'groups'),
    'ministries.json': ('ministries',),
    'events.json': ('calendar',),
    'builder.json': ('staff', 'locations', 'sermons', 'site', 'pages'),
    'regions.json': ('regions',),
}


def files(content) -> dict[str, dict]:
    if isinstance(content, ChurchContent):
        content = normalize(content)
    unknown = content.keys() - {key for keys in SECTIONS.values() for key in keys}
    if unknown:
        raise ContentError('Unknown content sections: ' + ', '.join(sorted(unknown)))
    return {name: {key: content[key] for key in keys if key in content}
            for name, keys in SECTIONS.items() if name != 'regions.json' or 'regions' in content}


def load(files) -> dict:
    content = {}
    for name, data in files.items():
        if name not in SECTIONS:
            raise ContentError('Unknown content file: ' + name)
        keys = SECTIONS[name]
        # The demo's older single-section seed files are bare arrays.
        if isinstance(data, list) and len(keys) == 1:
            data = {keys[0]: data}
        if not isinstance(data, dict) or data.keys() - set(keys):
            raise ContentError('Invalid sections in ' + name)
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
