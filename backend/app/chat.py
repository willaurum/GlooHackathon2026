"""Website chat agent: chat completions (Gloo AI, with an optional backup provider)
plus tools over the church database.

Each user message runs a loop: send the conversation and tool definitions to the model,
execute any tools the model asks for, feed the results back, and repeat until the
model answers in plain text. Every step is written to the chat_log table.
"""

import json
import logging
import os
import re

from . import db, matching

log = logging.getLogger(__name__)

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


# Demo mode: with no AI key, answer by keyword matching and a single tool call.
DEMO_MENU = ("I can help with upcoming events, small groups, ministries, or connecting you with the church team. "
             "What sounds good?")
DEMO_ERROR = "Sorry, something went wrong looking that up. Can you rephrase?"
DEMO_CRISIS = ("If you're in danger or thinking about harming yourself, please call or text 988 "
               "(Suicide & Crisis Lifeline, US) right now, or call 911 in an emergency.")
CRISIS_WORDS = ['suicid', 'kill myself', 'hurt myself', 'end my life', 'self-harm', 'want to die']
# Checked in order; the first intent with a matching keyword wins.
DEMO_INTENTS = [
    ('list_events', ['event', 'coming', 'upcoming', 'schedule', "what's on"]),
    ('list_small_groups', ['small group', 'group', 'community', 'connect with people']),
    ('search_ministries', ['ministry', 'volunteer', 'help', 'serve', 'music', 'kids', 'youth', 'teach', 'worship']),
    ('get_church_info', ['info', 'about', 'who are you', 'what is this', 'tell me']),
    ('hand_off_to_staff', ['talk to', 'someone', 'struggling', 'crisis', 'help me', 'worried', 'sad']),
    ('request_connection', ['connect', 'sign me up', 'request', 'join', 'interested']),
]
DEMO_SKILLS = {
    'Music': ['music', 'sing', 'guitar', 'band', 'piano', 'worship'],
    'Teaching': ['teach', 'kids', 'youth', 'children'],
    'Technology': ['tech', 'sound', 'video', 'camera', 'computer'],
    'Hospitality': ['greet', 'welcome', 'hospitality', 'coffee'],
    'Creativity': ['art', 'design', 'creative', 'photo'],
    'Organization': ['organiz', 'admin', 'plan'],
    'Listening': ['listen'],
    'Encouragement': ['encourag'],
}
DEMO_DAYS = {'Sunday mornings': ['sunday'], 'Saturday mornings': ['saturday'],
             'Weekday evenings': ['weekday', 'evening', 'weeknight', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday']}


def demo_tools(session_id, actions):
    """The chat tools with keyword-friendly arguments for demo_reply. Calls are logged like the AI path,
    and filed requests are added to `actions`."""
    def use(tool, **args):
        result = call_tool(tool, json.dumps(args))
        db.log_chat(session_id, 'tool', {'name': tool, 'arguments': args, 'result': result, 'provider': 'demo'})
        if 'request_id' in result:
            actions.append({'tool': tool, 'request_id': result['request_id'], 'status': result['status']})
        return result

    def search(query):
        text = query.lower()
        skills = [skill for skill, words in DEMO_SKILLS.items() if any(w in text for w in words)]
        day = next((d for d, words in DEMO_DAYS.items() if any(w in text for w in words)), None)
        result = use('search_ministries', skills=skills, day=day)
        return result.get('matches', result.get('ministries', []))

    def hand_off(reason):
        kind = 'crisis' if any(w in reason.lower() for w in CRISIS_WORDS) else 'pastoral_care'
        return use('hand_off_to_staff', reason=kind, summary=reason[:500])

    def connect(name, details):
        text = details.lower()
        ministry = next((m for m in db.list_ministries() if m['name'].lower() in text), None)
        contact = re.search(r'[\w.+-]+@[\w-]+\.[\w.]+|\+?\d[\d\s().-]{6,}\d', details)
        given = re.search(r"(?:my name is|i'm|i am)\s+([A-Z][a-z]+(?: [A-Z][a-z]+)?)", details)
        if ministry is None or contact is None:
            return {'message': "Happy to connect you! Tell me which ministry you're interested in, "
                               "plus your name and an email or phone number."}
        return use('request_connection', ministry_id=ministry['id'], name=given.group(1) if given else name,
                   contact=contact.group(0), note=details[:500])

    return {
        'get_church_info': lambda: use('get_church_info'),
        'list_events': lambda: use('list_events')['events'],
        'list_small_groups': lambda: use('list_small_groups')['groups'],
        'search_ministries': search,
        'hand_off_to_staff': hand_off,
        'request_connection': connect,
    }


def describe(item):
    """One line for a list result: its name plus the most useful detail."""
    if 'open_spots' in item:
        detail = f"{item['day']}, {item['open_spots']} open spots"
    else:
        detail = ', '.join(item[key] for key in ('when', 'where') if item.get(key))
    return f"• {item.get('name') or item.get('title')}" + (f': {detail}' if detail else '')


def format_demo_result(result):
    if isinstance(result, list):
        if not result:
            return "I couldn't find anything for that right now."
        return f'Here are {len(result)} results:\n' + '\n'.join(describe(item) for item in result)
    if 'church' in result:
        info = result['church']
        services = ', '.join(f"{s['day']} {s['time']}" for s in info['services'])
        return (f"{info['name']} is at {info['address']}. Services are {services}. "
                f"You can reach the office at {info['phone']} or {info['email']} ({info['office_hours']}).")
    if 'error' in result:
        return result['error']
    return result.get('message', DEMO_MENU)


def demo_reply(message: str, tools: dict) -> str:
    """Answer without an AI model: match the message to an intent, run that tool, and format the result."""
    try:
        text = message.lower()
        # Safety first: crisis language always gets 988/911 and a staff hand-off.
        if any(w in text for w in CRISIS_WORDS):
            tools['hand_off_to_staff'](reason=message)
            return f"{DEMO_CRISIS} I've also let our staff know."
        intent = next((name for name, words in DEMO_INTENTS if any(w in text for w in words)), None)
        if intent is None:
            return DEMO_MENU
        if intent == 'search_ministries':
            result = tools[intent](query=message)
        elif intent == 'hand_off_to_staff':
            result = tools[intent](reason=message)
        elif intent == 'request_connection':
            result = tools[intent](name='Guest', details=message)
        else:
            result = tools[intent]()
        reply = format_demo_result(result)
        if intent == 'search_ministries' and result:
            reply += ("\nIf one sounds good, tell me which one plus your name and an email or phone, "
                      "and I'll ask staff to connect you.")
        if intent == 'hand_off_to_staff' and 'request_id' in result:
            reply = f"I'm sorry you're going through that. I've passed this to our care team. {reply}"
        if intent == 'request_connection' and 'request_id' in result:
            reply = (f"Thanks! I've asked staff to connect you with {result['ministry']}. "
                     "A staff member reviews every request before anyone reaches out.")
        return reply
    except Exception:
        log.exception('demo reply failed')
        return DEMO_ERROR


def run(messages, session_id, clients=None):
    """Answer the latest user message. `messages` is the visible user/assistant history.
    `clients` is [(name, model, extra_body, client), ...]; tests pass fakes here."""
    db.log_chat(session_id, 'user', messages[-1])
    # Demo mode: no key configured, use local intent-matching
    if clients is None and not os.environ.get("GLOO_API_KEY") and not os.environ.get("OPENAI_API_KEY") and not os.environ.get("ANTHROPIC_API_KEY"):
        actions = []
        reply = demo_reply(messages[-1]['content'], demo_tools(session_id, actions))
        db.log_chat(session_id, 'assistant', {'content': reply, 'provider': 'demo'})
        return {'reply': reply, 'configured': False, 'actions': actions, 'provider': 'demo'}
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
