"""FastAPI app: a little CRUD over the SQL table."""

from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field, ConfigDict
from typing import Literal

from . import db


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
    ranked = []
    for ministry in db.list_ministries():
        if ministry['filled'] >= ministry['total']:
            continue
        overlap = sorted(set(body.skills).intersection(ministry['skills']))
        score = len(overlap) * 3 + (3 if ministry['style'] == body.style else 0) + (4 if ministry['day'] == body.day else 0)
        score += (ministry['total'] - ministry['filled']) / ministry['total']
        ranked.append({**ministry, 'overlap': overlap, 'score': score})
    ranked.sort(key=lambda m: (-m['score'], m['id']))
    return {'name': body.name or 'this member', 'style': body.style, 'day': body.day,
            'engine': 'rules', 'matches': ranked[:3]}


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
