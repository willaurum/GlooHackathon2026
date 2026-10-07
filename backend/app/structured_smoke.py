"""Does a Gloo model honor structured output? One extraction, sent the way Tekton's readers send it.

    GLOO_API_KEY=... python -m backend.app.structured_smoke gloo-openai-gpt-4.1-mini
    GLOO_API_KEY=... python -m backend.app.structured_smoke gloo-google-gemini-2.5-flash gloo-anthropic-claude-haiku-4.5

For each model it posts a short church page to the direct chat completions endpoint (BUILDER_STRUCTURED_ENDPOINT)
with `response_format` json_schema built from the staff reader's tool, and prints the HTTP status, how long it took,
any parameters Gloo says it ignored, the finish reason, and whether the answer is JSON that matches the schema's
top-level fields. The key is read from the environment and never printed.
"""
import json
import os
import sys
import time

import httpx

from . import builder, builder_agents

PAGE = ('Our Staff\nPastor Dan Whitfield\nSenior Pastor\ndan@cedarhollow.example\nEllen Price\nWorship Director\n'
        'Kyle Moore\nYouth Pastor')


def smoke(model, key, endpoint):
    tool = builder_agents.SPECIALISTS['staff']['tool']
    source = {'id': 's1', 'url': 'https://church.test/staff', 'title': 'Our Staff', 'text': PAGE}
    body = {'model': model, 'temperature': 0, 'messages': builder._json_messages(builder_agents.messages('staff', source)),
            'response_format': builder.response_format(tool)}
    started = time.monotonic()
    try:
        response = httpx.post(endpoint.rstrip('/') + '/chat/completions', json=body, timeout=60,
                              headers={'Authorization': f'Bearer {key}'})
    except httpx.HTTPError as error:
        return {'model': model, 'error': type(error).__name__}
    out = {'model': model, 'status': response.status_code, 'seconds': round(time.monotonic() - started, 2),
           'mode tekton would use': builder.output_mode('gloo', model, tool['function']['name'])}
    try:
        data = response.json()
    except ValueError:
        return {**out, 'valid': False, 'body': response.text[:200]}
    out['ignored_params'] = data.get('ignored_params') or data.get('ignored') or []
    if response.status_code >= 400:
        return {**out, 'valid': False, 'error': str(data.get('error') or data)[:300]}
    choice = (data.get('choices') or [{}])[0]
    out['finish_reason'] = choice.get('finish_reason')
    content = (choice.get('message') or {}).get('content')
    try:
        answer = json.loads(content) if isinstance(content, str) else None
    except ValueError:
        answer = None
    out['valid'] = isinstance(answer, dict) and all(k in answer for k in tool['function']['parameters']['required'])
    out['items'] = len(answer.get('items', [])) if isinstance(answer, dict) else 0
    out['tokens'] = data.get('usage')
    return out


def main(models):
    key = os.environ.get('GLOO_API_KEY', '').strip()
    if not key:
        sys.exit('Set GLOO_API_KEY in the environment first.')
    endpoint = os.environ.get('BUILDER_STRUCTURED_ENDPOINT') or builder.DIRECT_ENDPOINT
    for model in models or ['gloo-openai-gpt-4.1-mini']:
        print(json.dumps(smoke(model, key, endpoint), indent=2))


if __name__ == '__main__':
    main(sys.argv[1:])
