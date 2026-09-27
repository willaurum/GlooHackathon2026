"""Belong prototype API with persistent ministries and connections."""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field, ConfigDict
from typing import Literal

from . import chat, db, matching

log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.pool.open()
    db.pool.wait(timeout=30)
    try:
        db.initialize()
        yield
    finally:
        db.pool.close()


app = FastAPI(title="Belong API", lifespan=lifespan)


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


class VisitRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=100)
    contact: str = Field(default='', max_length=200)
    service: str
    party_size: int = Field(ge=1, le=20)
    kids: str = Field(default='', max_length=200)
    wants_host: bool = True


class ClaimRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    host: str = Field(min_length=1, max_length=60)


@app.get('/api/church')
def church():
    return {'info': db.get_church_info(), 'faqs': db.list_content('faqs'), 'events': db.list_content('events')}


@app.post('/api/visits', status_code=201)
def create_visit(body: VisitRequest):
    services = {f"{s['day']} {s['time']}" for s in db.get_church_info()['services']}
    if body.service not in services:
        raise HTTPException(status_code=400, detail='Unknown service time')
    return db.create_visit(body.name, body.contact, body.service, body.party_size, body.kids, body.wants_host)


@app.get('/api/visits/{token}')
def get_visit(token: str):
    visit = db.get_visit_by_token(token)
    if visit is None:
        raise HTTPException(status_code=404, detail='Visit not found')
    return visit


@app.post('/api/visits/{token}/arrive')
def arrive_visit(token: str):
    visit = db.mark_arrived(token)
    if visit is None:
        if db.get_visit_by_token(token) is None:
            raise HTTPException(status_code=404, detail='Visit not found')
        raise HTTPException(status_code=409, detail='This visit already checked in')
    return visit


@app.get('/api/visits')
def visits_queue():
    return {'waiting': db.list_visits(['arrived', 'on_the_way']), 'planned': db.list_planned_visits()}


@app.post('/api/visits/{visit_id}/claim')
def claim_visit(visit_id: int, body: ClaimRequest):
    visit = db.set_visit_host(visit_id, body.host)
    if visit is None:
        raise HTTPException(status_code=409, detail='This guest is not waiting to be claimed')
    return visit


@app.post('/api/visits/{visit_id}/met')
def met_visit(visit_id: int):
    visit = db.mark_met(visit_id)
    if visit is None:
        raise HTTPException(status_code=409, detail='This guest cannot be marked met right now')
    return visit


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
