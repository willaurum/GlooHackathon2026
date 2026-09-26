"""Website chat agent: chat completions (Gloo AI, with an optional backup provider)
plus tools over the church database.

Each user message runs a loop: send the conversation and tool definitions to the model,
execute any tools the model asks for, feed the results back, and repeat until the
model answers in plain text. Every step is written to the chat_log table.
"""

import json
import os
import re

from . import db, matching

# Each provider speaks the OpenAI chat-completions format. AI_PROVIDER is tried
# first; if it has no key or a call fails, AI_FALLBACK takes over.
PROVIDERS = {
    'gloo': {'base_url': 'https://platform.ai.gloo.com/ai/v2/guarded', 'key': 'GLOO_API_KEY',
             'model': ('GLOO_MODEL', 'gloo-anthropic-claude-haiku-4.5'), 'extra_body': {'auto_routing': False}},
    'openai': {'base_url': 'https://api.openai.com/v1', 'key': 'OPENAI_API_KEY',
               'model': ('OPENAI_MODEL', 'gpt-5-mini'), 'extra_body': {}},
    'anthropic': {'base_url': 'https://api.anthropic.com/v1/', 'key': 'ANTHROPIC_API_KEY',
                  'model': ('ANTHROPIC_MODEL', 'claude-haiku-4-5'), 'extra_body': {}},
}
MAX_STEPS = 6

NOT_CONFIGURED = ("The AI assistant isn't switched on yet: no AI provider key is configured. "
                  "Add GLOO_API_KEY (or OPENAI_API_KEY / ANTHROPIC_API_KEY) to your .env file and restart the backend.")
GAVE_UP = ("Sorry, I couldn't finish that. You can reach the church office at {phone} "
           "or {email}, and someone will be glad to help.")

SYSTEM_PROMPT = """You are Belong, the website assistant for {church}. You help visitors and members learn about the church and find a place to serve or connect.

How to work:
- Use the tools for every fact about the church: service times, events, groups, ministries, and contacts. If the tools don't have the answer, say you don't know and offer the church office contact. Never invent names, times, places, or contact details.
- To recommend a ministry, first learn what they enjoy or are good at, how they like to serve, and when they're free. Ask at most two short questions at a time. Then call search_ministries and briefly explain why each suggestion could fit.
- Only call request_connection after the person clearly says yes to being connected and has given their name and an email or phone number. Tell them a staff member reviews every request before anyone reaches out.
- You are not a pastor or counselor. Do not counsel, diagnose, give spiritual direction, or make pastoral judgments. If someone shares grief, illness, a family crisis, or a prayer need, or asks for pastoral care, respond with brief kindness and offer to pass it to the care team with hand_off_to_staff. Ask for their name and contact first, but hand off without them if they'd rather not share.
- If someone may be in danger, or talks about harming themselves or someone else, tell them right away to call or text 988 (Suicide & Crisis Lifeline, US), or call 911 in an emergency. Then call hand_off_to_staff with reason "crisis". Do not try to handle it yourself.
- Only quote Scripture if asked. Give the reference and translation, and never make up verses.
- If a tool returns an error, fix the problem (for example, ask the person for the missing detail) instead of giving up.
- Keep replies short and warm: two to four sentences or a short list. Plain text only, no markdown headings or tables."""

TOOLS = [
    {'type': 'function', 'function': {
        'name': 'get_church_info',
        'description': 'Church name, address, contact details, office hours, service times, what to expect on a first visit, the care team, and frequently asked questions (parking, kids check-in, students, accessibility, membership, online services).',
        'parameters': {'type': 'object', 'properties': {}},
    }},
    {'type': 'function', 'function': {
        'name': 'list_events',
        'description': 'Upcoming church events and classes, with dates, times, and locations.',
        'parameters': {'type': 'object', 'properties': {}},
    }},
    {'type': 'function', 'function': {
        'name': 'list_small_groups',
        'description': 'Weekly small groups and support groups, with meeting times, places, and who each group is for.',
        'parameters': {'type': 'object', 'properties': {}},
    }},
    {'type': 'function', 'function': {
        'name': 'search_ministries',
        'description': 'Find volunteer ministries with open spots that fit a person. Returns the top three with responsibilities, schedule, open spots, and the ministry lead. Call with no arguments to see every ministry.',
        'parameters': {'type': 'object', 'properties': {
            'skills': {'type': 'array', 'items': {'type': 'string', 'enum': matching.SKILLS},
                       'description': 'Gifts or skills the person mentioned.'},
            'style': {'type': 'string', 'enum': matching.STYLES, 'description': 'How they like to serve.'},
            'day': {'type': 'string', 'enum': matching.DAYS, 'description': 'When they are available.'},
        }},
    }},
    {'type': 'function', 'function': {
        'name': 'request_connection',
        'description': 'File a request for a staff member to introduce the person to a ministry lead. Staff review it first; nothing is sent automatically. Only call after the person agrees and has given their name and an email or phone number.',
        'parameters': {'type': 'object', 'properties': {
            'ministry_id': {'type': 'integer', 'description': 'The id returned by search_ministries.'},
            'name': {'type': 'string', 'description': "The person's name."},
            'contact': {'type': 'string', 'description': 'Their email address or phone number.'},
            'note': {'type': 'string', 'description': 'Anything useful for the ministry lead, such as their gifts and availability.'},
        }, 'required': ['ministry_id', 'name', 'contact']},
    }},
    {'type': 'function', 'function': {
        'name': 'hand_off_to_staff',
        'description': 'Pass a conversation to church staff: pastoral care, prayer requests, crisis situations, or questions the tools cannot answer.',
        'parameters': {'type': 'object', 'properties': {
            'reason': {'type': 'string', 'enum': ['pastoral_care', 'prayer', 'crisis', 'other']},
            'summary': {'type': 'string', 'description': 'One or two factual sentences on what the person needs. No advice or judgment.'},
            'name': {'type': 'string', 'description': "The person's name, if they shared it."},
            'contact': {'type': 'string', 'description': 'Their email or phone, if they shared it.'},
        }, 'required': ['reason', 'summary']},
    }},
]


def provider_chain():
    """Configured providers in the order to try them: [(name, model, extra_body, api_key), ...]."""
    chain = []
    for name in (os.environ.get('AI_PROVIDER', 'gloo'), os.environ.get('AI_FALLBACK', '')):
        name = name.strip().lower()
        spec = PROVIDERS.get(name)
        key = os.environ.get(spec['key'], '').strip() if spec else ''
        if key and name not in [c[0] for c in chain]:
            chain.append((name, os.environ.get(*spec['model']), spec['extra_body'], key))
    return chain


def status():
    chain = provider_chain()
    return {'configured': bool(chain), 'providers': [f'{name}:{model}' for name, model, _, _ in chain]}


def make_clients():
    from openai import OpenAI
    return [(name, model, extra_body, OpenAI(api_key=key, base_url=PROVIDERS[name]['base_url'], timeout=60, max_retries=1))
            for name, model, extra_body, key in provider_chain()]


def looks_like_contact(value):
    return '@' in value or len(re.sub(r'\D', '', value)) >= 7


def summarize_ministry(m):
    return {key: m[key] for key in ('id', 'name', 'category', 'description', 'skills', 'style', 'day', 'head', 'email', 'note')} | {
        'open_spots': m['total'] - m['filled']}


def search_ministries(skills=None, style=None, day=None):
    skills = [s for s in (skills or []) if s in matching.SKILLS]
    ministries = db.list_ministries()
    if not skills and not style and not day:
        return {'ministries': [summarize_ministry(m) for m in ministries]}
    ranked = matching.rank(ministries, skills, style if style in matching.STYLES else None,
                           day if day in matching.DAYS else None)
    return {'matches': [summarize_ministry(m) | {'matching_skills': m['overlap']} for m in ranked]}


def request_connection(ministry_id, name, contact, note=''):
    name, contact = name.strip(), contact.strip()
    ministry = db.get_ministry(ministry_id)
    if ministry is None:
        return {'error': f'No ministry has id {ministry_id}. Call search_ministries to get valid ids.'}
    if not name:
        return {'error': "The person's name is missing. Ask them for it."}
    if not looks_like_contact(contact):
        return {'error': 'Contact must be an email address or phone number. Ask the person for one.'}
    if ministry['filled'] >= ministry['total']:
        return {'error': f"{ministry['name']} has no open spots right now. Suggest another ministry."}
    if db.find_pending_request('connection', ministry_id, name):
        return {'status': 'already_pending', 'message': f"{name} already has a pending request for {ministry['name']}."}
    row = db.create_request('connection', name, contact, note.strip(), ministry_id)
    return {'request_id': row['request_id'], 'status': 'pending_staff_review', 'ministry': ministry['name'],
            'message': 'Saved for staff review. A staff member will introduce them to the ministry lead.'}


def hand_off_to_staff(reason, summary, name='', contact=''):
    if reason not in ('pastoral_care', 'prayer', 'crisis', 'other'):
        return {'error': 'reason must be one of pastoral_care, prayer, crisis, other.'}
    if not summary.strip():
        return {'error': 'Add a short summary of what the person needs.'}
    row = db.create_request(reason, name.strip() or 'Anonymous website visitor', contact.strip(), summary.strip())
    info = db.get_church_info()
    return {'request_id': row['request_id'], 'status': 'sent_to_staff',
            'message': f"Staff respond within one business day. Office: {info['phone']}, {info['email']}."}


def call_tool(name, arguments):
    """Run one tool. Errors go back to the model as data so it can correct itself."""
    try:
        args = json.loads(arguments or '{}')
    except json.JSONDecodeError:
        return {'error': 'Arguments were not valid JSON. Try the call again.'}
    try:
        if name == 'get_church_info':
            return {'church': db.get_church_info(), 'faqs': db.list_content('faqs')}
        if name == 'list_events':
            return {'events': db.list_content('events')}
        if name == 'list_small_groups':
            return {'groups': db.list_content('groups')}
        if name == 'search_ministries':
            return search_ministries(args.get('skills'), args.get('style'), args.get('day'))
        if name == 'request_connection':
            return request_connection(int(args['ministry_id']), str(args['name']), str(args['contact']), str(args.get('note') or ''))
        if name == 'hand_off_to_staff':
            return hand_off_to_staff(str(args['reason']), str(args['summary']), str(args.get('name') or ''),
                                     str(args.get('contact') or ''))
        return {'error': f'Unknown tool {name}.'}
    except (KeyError, ValueError, TypeError) as err:
        return {'error': f'Bad or missing argument: {err}. Check the tool description and try again.'}


def complete(clients, convo, session_id):
    """One model call, falling through to the next provider if one fails.
    A provider that fails is dropped for the rest of this turn."""
    while clients:
        name, model, extra_body, client = clients[0]
        try:
            response = client.chat.completions.create(
                model=model, messages=convo, tools=TOOLS, tool_choice='auto', extra_body=extra_body)
            return response, f'{name}:{model}'
        except Exception as err:
            db.log_chat(session_id, 'provider_error', {'provider': name, 'model': model, 'error': repr(err)[:500]})
            clients.pop(0)
            if not clients:
                raise


def run(messages, session_id, clients=None):
    """Answer the latest user message. `messages` is the visible user/assistant history.
    `clients` is [(name, model, extra_body, client), ...]; tests pass fakes here."""
    db.log_chat(session_id, 'user', messages[-1])
    clients = list(clients if clients is not None else make_clients())
    if not clients:
        db.log_chat(session_id, 'not_configured', {})
        return {'reply': NOT_CONFIGURED, 'configured': False, 'actions': []}

    info = db.get_church_info()
    convo = [{'role': 'system', 'content': SYSTEM_PROMPT.format(church=info['name'])}, *messages]
    actions = []
    for _ in range(MAX_STEPS):
        response, provider = complete(clients, convo, session_id)
        message = response.choices[0].message
        if not message.tool_calls:
            reply = (message.content or '').strip() or GAVE_UP.format(**info)
            db.log_chat(session_id, 'assistant', {'content': reply, 'provider': provider})
            return {'reply': reply, 'configured': True, 'actions': actions, 'provider': provider}

        convo.append({'role': 'assistant', 'content': message.content or '', 'tool_calls': [
            {'id': c.id, 'type': 'function', 'function': {'name': c.function.name, 'arguments': c.function.arguments}}
            for c in message.tool_calls]})
        for call in message.tool_calls:
            result = call_tool(call.function.name, call.function.arguments)
            db.log_chat(session_id, 'tool', {'name': call.function.name, 'arguments': call.function.arguments,
                                             'result': result, 'provider': provider})
            if 'request_id' in result:
                actions.append({'tool': call.function.name, 'request_id': result['request_id'], 'status': result['status']})
            convo.append({'role': 'tool', 'tool_call_id': call.id, 'content': json.dumps(result, default=str)})

    reply = GAVE_UP.format(**info)
    db.log_chat(session_id, 'gave_up', {'content': reply})
    return {'reply': reply, 'configured': True, 'actions': actions}
