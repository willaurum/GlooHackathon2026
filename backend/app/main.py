"""Belong prototype API with persistent ministries and connections, plus Pastor Notes."""

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field, ConfigDict
from typing import Literal

from . import ai_client, chat, db, matching, pastor_notes

log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.initialize()
    pastor_notes.start_worker()
    task = asyncio.create_task(auto_summarize_background())
    try:
        yield
    finally:
        task.cancel()
        db.close()


app = FastAPI(title="Belong API", lifespan=lifespan)
app.include_router(pastor_notes.router)


class MatchRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    name: str = Field(default='', max_length=100)
    skills: list[Literal['Hospitality', 'Teaching', 'Technology', 'Creativity', 'Music', 'Organization', 'Listening', 'Encouragement']] = Field(default_factory=list, max_length=8)
    style: Literal['Working with people', 'Behind the scenes', 'Hands-on service']
    day: Literal['Sunday mornings', 'Saturday mornings', 'Weekday evenings']


class ConnectionRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    ministry_id: int = Field(ge=0)
    member: str = Field(min_length=1, max_length=100)


@app.get('/api/info')
def church_info():
    # Public church details (address, service times) for the home page.
    return db.get_church_info()


@app.get('/api/ministries')
def ministries():
    return db.list_ministries()


@app.post('/api/matches')
def matches(body: MatchRequest):
    # Deliberately simple placeholder: replace this ranking with Gloo AI later.
    ranked = matching.rank(db.list_ministries(), body.skills, body.style, body.day)
    return {'name': body.name or 'this member', 'style': body.style, 'day': body.day,
            'engine': 'rules', 'matches': ranked}


@app.get('/api/connections')
def connections():
    return db.list_connections()


@app.post('/api/connections', status_code=201)
def save_connection(body: ConnectionRequest):
    result = db.save_connection(body.ministry_id, body.member)
    if result is None:
        raise HTTPException(status_code=404, detail='Ministry not found')
    return result


@app.delete('/api/connections/{connection_id}', status_code=204)
def remove_connection(connection_id: int):
    if not db.remove_connection(connection_id):
        raise HTTPException(status_code=404, detail='Connection not found')


class ChatMessage(BaseModel):
    role: Literal['user', 'assistant']
    content: str = Field(min_length=1, max_length=2000)


class ChatRequest(BaseModel):
    session_id: str = Field(min_length=1, max_length=64)
    messages: list[ChatMessage] = Field(min_length=1, max_length=40)


class RequestStatus(BaseModel):
    status: Literal['approved', 'declined']


@app.get('/api/chat/status')
def chat_status():
    return chat.status()


@app.post('/api/chat')
def chat_turn(body: ChatRequest):
    if body.messages[-1].role != 'user':
        raise HTTPException(status_code=400, detail='The last message must come from the user')
    # Keep recent history, starting on a user turn; some models reject a leading assistant turn.
    messages = [m.model_dump() for m in body.messages][-20:]
    while messages[0]['role'] != 'user':
        messages.pop(0)
    try:
        return chat.run(messages, body.session_id)
    except Exception:
        log.exception('chat turn failed')
        db.log_chat(body.session_id, 'error', {})
        raise HTTPException(status_code=502, detail='The assistant is unavailable right now. Please try again in a moment.')


@app.get('/api/chat/log/{session_id}')
def chat_log(session_id: str):
    return db.get_chat_log(session_id)


@app.get('/api/requests')
def requests():
    return db.list_requests()


@app.patch('/api/requests/{request_id}')
def update_request(request_id: int, body: RequestStatus):
    row = db.set_request_status(request_id, body.status)
    if row is None:
        raise HTTPException(status_code=404, detail='Request not found')
    return row


class NewItem(BaseModel):
    title: str


class DoneFlag(BaseModel):
    done: bool


@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/items")
def get_items():
    return db.list_items()


@app.post("/api/items", status_code=201)
def post_item(body: NewItem):
    title = body.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="title is required")
    return db.add_item(title)


@app.patch("/api/items/{item_id}")
def patch_item(item_id: int, body: DoneFlag):
    row = db.set_item_done(item_id, body.done)
    if row is None:
        raise HTTPException(status_code=404, detail="no such item")
    return row


@app.delete("/api/items/{item_id}", status_code=204)
def delete_item(item_id: int):
    if not db.delete_item(item_id):
        raise HTTPException(status_code=404, detail="no such item")

# --- Calendar events + AI summaries (ported to the Durable-Object stack) ---


class EventCreate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    title: str = Field(min_length=1, max_length=200)
    category: str = Field(min_length=1, max_length=100)
    date: str = Field(min_length=10, max_length=10)
    time: str = Field(min_length=1, max_length=100)
    location: str = Field(min_length=1, max_length=200)
    description: str = Field(min_length=1)
    ministry_name: str | None = None


class ModelUpdateRequest(BaseModel):
    model: str = Field(min_length=1, max_length=100)


class SummarizeAllRequest(BaseModel):
    model: str | None = None
    only_missing: bool = False


async def auto_summarize_background():
    """Draft a summary for events that lack one when an AI endpoint is reachable. No-op-safe otherwise."""
    try:
        await asyncio.sleep(5)
        status = await ai_client.get_status()
        if not status.get("connected"):
            return
        model = status.get("default_model")
        if not ai_client.find_matching_model(model, status.get("available_models", [])):
            return
        for ev in db.list_events():
            if not ev.get("ai_summary"):
                try:
                    summary = await ai_client.summarize_event(
                        title=ev["title"], category=ev["category"], description=ev["description"],
                        date=ev["date"], time=ev["time"], location=ev["location"], model=model)
                    db.update_event_summary(ev["id"], summary)
                except Exception:
                    pass
    except Exception:
        pass


@app.get("/api/events")
def get_events():
    return db.list_events()


@app.get("/api/events/{event_id}")
def get_event(event_id: int):
    event = db.get_event(event_id)
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    return event


@app.post("/api/events", status_code=201)
def post_event(body: EventCreate):
    return db.create_event(title=body.title, category=body.category, date=body.date,
                            time=body.time, location=body.location, description=body.description,
                            ministry_name=body.ministry_name)


@app.post("/api/events/{event_id}/summarize")
async def summarize_event(event_id: int, model: str | None = None):
    event = db.get_event(event_id)
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    status = await ai_client.get_status()
    if not status.get("connected"):
        raise HTTPException(status_code=503, detail="AI summaries are not configured on this server yet.")
    try:
        summary = await ai_client.summarize_event(
            title=event["title"], category=event["category"], description=event["description"],
            date=event["date"], time=event["time"], location=event["location"], model=model)
        return db.update_event_summary(event_id, summary)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"AI summarization failed: {exc}")


@app.post("/api/events/summarize-all")
async def summarize_all_events(body: SummarizeAllRequest | None = None, only_missing: bool = False, model: str | None = None):
    status = await ai_client.get_status()
    if not status.get("connected"):
        raise HTTPException(status_code=503, detail="AI summaries are not configured on this server yet.")
    target_model = body.model if (body and body.model) else model
    filter_missing = body.only_missing if body else only_missing
    events = db.list_events()
    if filter_missing:
        events = [e for e in events if not e.get("ai_summary")]
    results, errors = [], []
    for ev in events:
        try:
            summary = await ai_client.summarize_event(
                title=ev["title"], category=ev["category"], description=ev["description"],
                date=ev["date"], time=ev["time"], location=ev["location"], model=target_model)
            results.append(db.update_event_summary(ev["id"], summary))
        except Exception as exc:
            errors.append({"event_id": ev["id"], "title": ev["title"], "error": str(exc)})
    return {"updated": len(results), "errors": errors, "events": db.list_events(), "only_missing": filter_missing}


@app.get("/api/ai/status")
@app.get("/api/ollama/status")
async def get_ai_status():
    return await ai_client.get_status()


@app.post("/api/ai/model")
@app.post("/api/ollama/model")
def set_ai_model(body: ModelUpdateRequest):
    ai_client.set_default_model(body.model)
    return {"default_model": ai_client.get_default_model()}
