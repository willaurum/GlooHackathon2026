"""Local preparation only: no network access, provisioning, credentials or deployment."""
import argparse
import json
from pathlib import Path

from pydantic import ValidationError

from backend.app.church_content import normalize
from .model import SiteBlueprint, schema


def unique_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f'Duplicate JSON key: {key}')
        result[key] = value
    return result


def load_blueprint(path):
    raw = json.loads(Path(path).read_text(encoding='utf-8-sig'), object_pairs_hook=unique_keys)
    blueprint = SiteBlueprint.model_validate(raw, strict=True)
    blueprint.validate_evidence(raw)
    return blueprint


def json_text(document):
    return json.dumps(document, indent=2, ensure_ascii=False) + '\n'


def write_json(path, document):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json_text(document), encoding='utf-8', newline='\n')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    export = sub.add_parser('schema', help='Export the versioned JSON schema')
    export.add_argument('--output', type=Path)
    for command in ('validate', 'prepare'):
        p = sub.add_parser(command)
        p.add_argument('blueprint', type=Path)
        if command == 'prepare':
            p.add_argument('--output', type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == 'schema':
            if args.output:
                write_json(args.output, schema())
            else:
                print(json.dumps(schema(), indent=2))
            return 0
        blueprint = load_blueprint(args.blueprint)
        report = blueprint.report()
        print(json.dumps(report, indent=2, ensure_ascii=False))
        if report['blocking_issues']:
            return 3
        if args.command == 'prepare':
            content = normalize(blueprint.content)
            if len(json_text(content).encode('utf-8')) > 512 * 1024:
                raise ValueError('Prepared content exceeds the church API limit of 512 KiB.')
            output = args.output
            files = [output / 'church-content.json', output / 'review-report.json', output / 'manifest.json']
            if any(path.exists() for path in files):
                raise ValueError('Output files already exist. Choose a new output directory.')
            write_json(files[0], content)
            write_json(files[1], report)
            write_json(files[2], {
                'schema_version': 1,
                'template': blueprint.template,
                'church_slug': blueprint.church_slug,
                'content_file': 'church-content.json',
                'import_path': f'/api/churches/{blueprint.church_slug}/church/content',
                'method': 'PUT',
                'requires': 'existing church and verified staff session',
                'source_urls': [str(url) for url in blueprint.source_urls],
                'evidence': [item.model_dump(mode='json') for item in blueprint.evidence],
            })
        return 0
    except ValidationError as error:
        print(json.dumps({'status': 'invalid', 'errors': [
            {'path': '.'.join(map(str, issue['loc'])), 'message': issue['msg']}
            for issue in error.errors()
        ]}, indent=2))
    except (OSError, ValueError, TypeError) as error:
        print(json.dumps({'status': 'invalid', 'message': str(error)}))
    return 2
