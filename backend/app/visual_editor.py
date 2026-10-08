"""Visual editor backend: AI edit assistant and preview validation for church staff."""

import copy
import json
import logging
import re
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from . import ai_client, builder_customize, church_content, db
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

    return None


def _apply_special_op(content: dict, op: dict) -> str:
    kind = op.get('op')
    if kind == 'set_bottom_section_text':
        # Put text in info.about or the last section
        info = content.setdefault('info', {})
        info['about'] = op['text']
        return f"Updated the section text at the bottom to: “{op['text']}”"

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
    """Generate operations and a friendly reply using rule ops or the AI client."""
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
                if op.get('op') in ('set_bottom_section_text', 'adjust_header_size'):
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

    # If no rule matched, check if an AI provider is configured
    try:
        status = await ai_client.get_status()
        if status.get('connected'):
            # Call AI client for natural language assistance
            prompt = (
                "You are an assistant helping church staff visually edit their website.\n"
                f"The user says: \"{request_text}\"\n"
                f"Currently viewing: {viewing or 'home'}\n"
                "Return a JSON object with:\n"
                "- reply: friendly short summary of changes to the user\n"
                "- changes: list of strings describing changes\n"
                "- operations: list of operations to perform (e.g. set_detail, edit_person, set_theme, move, hide)\n"
                "Operations format:\n"
                "- {'op': 'edit_person', 'name': 'old or role', 'new_name': 'new name'}\n"
                "- {'op': 'set_detail', 'field': 'tagline|about|name|phone', 'value': 'new value'}\n"
                "- {'op': 'set_theme', 'primary': '#hex', 'accent': '#hex'}\n"
                "- {'op': 'move', 'page': 'home', 'section': 'ministries', 'to': 'top|bottom'}\n"
            )
            raw = await ai_client.generate_text(prompt)
            data = None
            if raw:
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
