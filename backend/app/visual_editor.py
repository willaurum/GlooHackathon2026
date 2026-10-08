"""Visual editor backend: AI edit assistant and preview validation for church staff."""

import asyncio
import copy
import json
import logging
import re
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from . import ai_client, builder_customize, church_content, db
from .builder import builder_model, GLOO_BUILDER_DEFAULT
from .church_content import ChurchContent, normalize

log = logging.getLogger(__name__)

router = APIRouter()


class EditAssistRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    request: str = Field(min_length=1, max_length=1000)
    viewing: str = Field(default='', max_length=120)
    content: dict[str, Any] | None = None


PASTOR_LEAVE_RE = re.compile(
    r"(?:we had\s+)?(?:pastor\s+)?([A-Za-z0-9 .'-]+?)\s+(?:leave|left|step down|retire|moved|gone)"
    r".*?(?:change|set|replace|update|make)\s+(?:the\s+)?(?:pastor(?:\s*name)?|name\s+of\s+(?:the\s+)?pastor)\s+(?:to|with|be)\s+(.+)",
    re.I,
)

PASTOR_NAME_CHANGE_RE = re.compile(
    r"(?:(?:can|could|would) you |please )*(?:change|set|replace|update|make)\s+"
    r"(?:the\s+)?(?:pastor(?:\s*name)?|lead pastor(?:\s*name)?|pastor's name)\s+(?:to|with|be)\s+(.+)$",
    re.I,
)

PASTOR_REPLACE_RE = re.compile(
    r"(?:(?:can|could|would) you |please )*(?:change|replace|update)\s+"
    r"(?:pastor\s+)?([A-Za-z0-9 .'-]+?)\s+(?:with|to)\s+(?:pastor\s+)?(.+)$",
    re.I,
)

BOTTOM_SECTION_RE = re.compile(
    r"(?:(?:can|could|would) you |please )*(?:change|move|set|put|switch)\s+"
    r"(?:the\s+)?section\s+at\s+the\s+bottom(?:\s+of\s+(?:the\s+)?home(?:\s+page)?)?\s+(?:to|be)\s+(.+)$",
    re.I,
)

HEADER_SIZE_RE = re.compile(
    r".*header\s+(?:does\s*not|doesn'?t)\s+look\s+(?:like\s+)?(?:the\s+)?right\s+size|"
    r".*(?:make|change|set)\s+(?:the\s+)?(?:header|heading|title|tagline)\s+(?:size\s+)?(?:to\s+be\s+)?(bigger|larger|smaller|huge|tiny|h1|h2|h3|h4).*",
    re.I,
)

SECTION_TEXT_RE = re.compile(
    r"(?:(?:can|could|would) you |please )*(?:change|set|update|make)\s+"
    r"(?:the\s+)?([A-Za-z0-9 _-]+?)\s+(?:section|card)?\s+(?:to\s+say|say|to|text\s+to|sub-?text\s+to)\s+"
    r"[\"“']?([^\"”']+)[\"”']?(?:\s+instead of.*)?$",
    re.I,
)


def get_visual_editor_model() -> tuple[str, str, dict, str]:
    """Return (provider, resolved_model, extra_body, api_key) using the builder's Haiku model instead of chat's Qwen model."""
    ep = ai_client.endpoint()
    provider = ep.get('provider', '')
    raw_model = ep.get('model', '')
    # Map to builder model (Claude Haiku 4.5 on Gloo, Claude Haiku on Anthropic)
    model = builder_model(provider, raw_model)
    return provider, model, ep.get('extra_body', {}), ep.get('api_key', '')


def _custom_rule_ops(request_text: str, content: dict, viewing: str = '') -> list[dict] | None:
    text = ' '.join(request_text.strip().rstrip('.!?').split())

    # 1. "we had X pastor leave, can you change the pastor name to Y"
    m = PASTOR_LEAVE_RE.search(text)
    if m:
        old_name = m.group(1).strip()
        new_name = m.group(2).strip().strip('"“”\'')
        return [{'op': 'edit_person', 'name': old_name or 'pastor', 'new_name': new_name}]

    # 2. "change the pastor name to Pastor Y"
    m = PASTOR_NAME_CHANGE_RE.match(text)
    if m:
        new_name = m.group(1).strip().strip('"“”\'')
        return [{'op': 'edit_person', 'name': 'pastor', 'new_name': new_name}]

    # 3. "change pastor X to Y" or "replace pastor X with Y"
    m = PASTOR_REPLACE_RE.match(text)
    if m and not builder_customize.COLOR_WORDS.get(m.group(1).lower()):
        old_name = m.group(1).strip()
        new_name = m.group(2).strip().strip('"“”\'')
        # Check if old_name matches someone on staff or is a role
        staff = content.get('staff') or []
        found = builder_customize._find(staff, old_name)
        if found or builder_customize.PERSON_RE.search(old_name) or 'pastor' in old_name.lower():
            return [{'op': 'edit_person', 'name': old_name, 'new_name': new_name}]

    # 4. "change the section at the bottom of the home page to X"
    m = BOTTOM_SECTION_RE.match(text)
    if m:
        target = m.group(1).strip().strip('"“”\'').lower()
        # Check if target is a known home section
        sections = ['features', 'about', 'ministries', 'sermons', 'service_times', 'leaders']
        matched_section = next((s for s in sections if s in target or target in s), None)
        if matched_section:
            return [{'op': 'move', 'page': 'home', 'section': matched_section, 'to': 'bottom'}]
        # If target has text to place in the bottom section
        return [{'op': 'set_bottom_section_text', 'text': m.group(1).strip().strip('"“”\'')}]

    # 5. "header doesn't look the right size" / "make header smaller/bigger"
    m = HEADER_SIZE_RE.match(text)
    if m:
        size = m.group(1).lower() if m.group(1) else 'smaller'
        level = 3 if size in ('smaller', 'h3') else 1 if size in ('bigger', 'larger', 'h1', 'huge') else 2
        return [{'op': 'adjust_header_size', 'level': level, 'size': size, 'viewing': viewing}]

    # 6. "change the serve section to say 'serve with your community' instead of the current sub-text"
    m = SECTION_TEXT_RE.match(text)
    if m:
        sec = m.group(1).strip().lower()
        new_text = m.group(2).strip().strip('"“”\'')
        return [{'op': 'set_section_text', 'section': sec, 'text': new_text}]

    return None


def _apply_special_op(content: dict, op: dict) -> str:
    kind = op.get('op')
    if kind == 'set_bottom_section_text':
        # Put text in info.about or the last section
        info = content.setdefault('info', {})
        info['about'] = op['text']
        return f"Updated the section text at the bottom to: “{op['text']}”"

    if kind == 'set_section_text':
        target = op.get('section', '').lower().strip()
        new_text = op.get('text', '').strip()
        updated = False

        # 1. Check pages and page sections
        pages = content.get('pages') or []
        for p in pages:
            p_slug = (p.get('slug') or '').lower()
            p_title = (p.get('title') or '').lower()
            if target == p_slug or target in p_title:
                if p.get('sections'):
                    p['sections'][0]['text'] = new_text
                    updated = True
                    break
            for sec in p.get('sections') or []:
                sec_head = (sec.get('heading') or '').lower()
                if target in sec_head or sec_head in target:
                    sec['text'] = new_text
                    updated = True
                    break
            if updated:
                break

        # 2. Check info fields
        info = content.setdefault('info', {})
        if target in ('about', 'our story'):
            info['about'] = new_text
            updated = True
        elif target in ('tagline', 'headline', 'title', 'header'):
            info['tagline'] = new_text
            updated = True

        # 3. Save in info.feature_text and site.feature_text for home feature cards (serve, notes, give)
        site = content.setdefault('site', {})
        site_features = site.setdefault('feature_text', {})
        info_features = info.setdefault('feature_text', {})
        if target in ('serve', 'notes', 'give', 'features') or not updated:
            feat_key = 'serve' if ('serve' in target or 'ministr' in target) else 'notes' if ('note' in target or 'sermon' in target) else 'give' if 'give' in target else target
            site_features[feat_key] = new_text
            info_features[feat_key] = new_text
            updated = True

        return f"Updated the {target} section text to: “{new_text}”"

    if kind == 'adjust_header_size':
        level = op.get('level', 2)
        viewing = op.get('viewing', '')
        # If looking at a specific page, update its first section heading level
        pages = content.get('pages') or []
        updated = False
        if viewing.startswith('p/'):
            slug = viewing[2:]
            page = next((p for p in pages if p.get('slug') == slug), None)
            if page and page.get('sections'):
                page['sections'][0]['level'] = level
                updated = True
        if not updated and pages:
            # Adjust the first page's first section heading level
            for p in pages:
                if p.get('sections'):
                    p['sections'][0]['level'] = level
                    updated = True
                    break
        size_word = 'smaller' if level >= 3 else 'larger' if level <= 1 else 'medium'
        return f"Adjusted heading level to H{level} ({size_word})."

    raise ValueError(f"Unknown special op: {kind}")


async def _run_ai_assist(content: dict, request_text: str, viewing: str) -> tuple[list[dict], str, list[str]]:
    """Generate operations and a friendly reply using rule ops or the builder AI model (Haiku)."""
    # First check our specific visual editor rules
    ops = _custom_rule_ops(request_text, content, viewing)

    # Next check builder_customize rules (colors, moves, hides, details)
    if ops is None:
        ops = builder_customize.rule_ops(request_text, viewing)

    # If rules matched, apply them
    if ops is not None:
        applied_ops = []
        changes = []
        refused = []
        for op in ops:
            try:
                if op.get('op') in ('set_section_text', 'set_bottom_section_text', 'adjust_header_size'):
                    desc = _apply_special_op(content, op)
                    applied_ops.append(op)
                    changes.append(desc)
                else:
                    clean_op, content = builder_customize.check(content, op)
                    applied_ops.append(clean_op)
                    changes.append(builder_customize.describe(clean_op))
            except builder_customize.Refused as err:
                refused.append(str(err))
            except Exception as err:
                refused.append(str(err))
        reply = ' '.join(changes) if changes else (refused[0] if refused else 'No changes could be made.')
        return applied_ops, reply, refused

    # If no rule matched, call AI using the builder model of Haiku instead of chat model Qwen
    try:
        provider, model, extra_body, api_key = get_visual_editor_model()
        system_prompt = (
            "You are an assistant helping church staff visually edit their website.\n"
            "Respond ONLY with a JSON object containing:\n"
            "- reply: friendly short summary of changes to the user\n"
            "- changes: list of strings describing changes\n"
            "- operations: list of operations to perform\n"
            "Supported operations:\n"
            "- {'op': 'set_section_text', 'section': 'serve|about|tagline|give|notes|page or section name', 'text': 'new text'}\n"
            "- {'op': 'edit_person', 'name': 'old name or role', 'new_name': 'new name'}\n"
            "- {'op': 'set_detail', 'field': 'tagline|about|name|phone', 'value': 'new value'}\n"
            "- {'op': 'set_theme', 'primary': '#hex', 'accent': '#hex'}\n"
            "- {'op': 'move', 'page': 'home', 'section': 'ministries', 'to': 'top|bottom'}\n"
            "- {'op': 'hide', 'page': 'home', 'section': 'sermons'}\n"
        )
        user_prompt = (
            f"User request: \"{request_text}\"\n"
            f"Currently viewing: {viewing or 'home'}\n"
        )

        raw = None
        # First attempt: chat.make_clients() with builder_model (Haiku)
        try:
            from . import chat
            clients = chat.make_clients()
            for name, client_model, extra, client in clients[:2]:
                m = builder_model(name, client_model)
                messages = [
                    {'role': 'system', 'content': system_prompt},
                    {'role': 'user', 'content': user_prompt},
                ]
                call_extra = {'extra_body': extra} if extra else {}
                def _call():
                    return client.chat.completions.create(
                        model=m,
                        messages=messages,
                        temperature=0,
                        max_tokens=800,
                        **call_extra,
                    )
                resp = await asyncio.to_thread(_call)
                if resp and resp.choices:
                    raw = resp.choices[0].message.content
                    break
        except Exception as e:
            log.info("Builder client call failed for %s, trying ai_client: %s", model, e)

        # Fallback attempt: ai_client.generate_text with builder model (Haiku)
        if not raw:
            status = await ai_client.get_status()
            if status.get('connected'):
                raw = await ai_client.generate_text(
                    system_prompt=system_prompt,
                    user_prompt=user_prompt,
                    model=model,
                    temperature=0.0,
                    max_tokens=800,
                )

        if raw:
            data = None
            try:
                data = json.loads(raw)
            except Exception:
                s, e = raw.find('{'), raw.rfind('}')
                if 0 <= s < e:
                    data = json.loads(raw[s : e + 1])
            if data and isinstance(data.get('operations'), list):
                applied_ops = []
                changes = []
                refused = []
                for op in data['operations']:
                    try:
                        if op.get('op') in ('set_section_text', 'set_bottom_section_text', 'adjust_header_size'):
                            desc = _apply_special_op(content, op)
                            applied_ops.append(op)
                            changes.append(desc)
                        else:
                            clean_op, content = builder_customize.check(content, op)
                            applied_ops.append(clean_op)
                            changes.append(builder_customize.describe(clean_op))
                    except Exception as err:
                        refused.append(str(err))
                reply = data.get('reply') or ' '.join(changes)
                return applied_ops, reply, refused
    except Exception as exc:
        log.warning("AI assist call failed: %s", exc)

    # Fallback when rules didn't match and AI couldn't parse
    return (
        [],
        (
            f"I wasn't sure how to make that change. You can try saying something like:\n"
            f"• “Change the pastor name to Pastor John”\n"
            f"• “Change the serve section to say Serve with your community”\n"
            f"• “Make the main color navy and buttons gold”\n"
            f"• “Move service times to the top of the home page”\n"
            f"• “Change the headline to Welcome Home”"
        ),
        ["Could not understand the requested edit."],
    )


@router.post('/api/church/edit-assist')
async def edit_assist(body: EditAssistRequest):
    """Processes a natural-language visual editing request from church staff.

    Returns the proposed changes and preview content for staff to verify before solidifying.
    """
    raw_content = body.content if body.content is not None else db.export_content()
    content_copy = copy.deepcopy(raw_content)

    ops, reply, refused = await _run_ai_assist(content_copy, body.request, body.viewing)

    # Validate resulting content
    try:
        validated = normalize(ChurchContent(**content_copy))
    except Exception as err:
        log.warning("Validation after edit-assist failed: %s", err)
        validated = raw_content

    changes = [builder_customize.describe(op) for op in ops if op.get('op') not in ('set_bottom_section_text', 'adjust_header_size')]
    for op in ops:
        if op.get('op') == 'set_bottom_section_text':
            changes.append(f"Changed bottom section text")
        elif op.get('op') == 'adjust_header_size':
            changes.append(f"Adjusted header size to H{op.get('level', 2)}")

    return {
        'reply': reply,
        'changes': changes,
        'operations': ops,
        'refused': refused,
        'content': validated,
    }


@router.post('/api/church/preview')
def validate_preview(body: ChurchContent):
    """Validates draft content for visual editor preview without saving to the database."""
    try:
        content = normalize(body)
        return {'ok': True, 'content': content}
    except church_content.ContentError as err:
        raise HTTPException(status_code=422, detail=str(err)) from err
