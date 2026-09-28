import asyncio
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field, ConfigDict
from typing import Literal

from . import db
from . import ai_client


async def auto_summarize_background():
    """Background task to summarize events if AI endpoint is accessible and model is available."""
    await asyncio.sleep(5)
    status = await ai_client.get_status()
    if status.get("connected"):
        model = status.get("default_model")
        available = status.get("available_models", [])
        if ai_client.find_matching_model(model, available):
            events = db.list_events()
            for ev in events:
                if not ev.get("ai_summary"):
                    try:
                        summary = await ai_client.summarize_event(
                            title=ev["title"],
                            category=ev["category"],
                            description=ev["description"],
                            date=ev["date"],
                            time=ev["time"],
                            location=ev["location"],
                            model=model,
                        )
                        db.update_event_summary(ev["id"], summary)
                    except Exception:
                        pass


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.pool.open()
    db.pool.wait(timeout=30)
    try:
        db.initialize()
        asyncio.create_task(auto_summarize_background())
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


class EventCreate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    title: str = Field(min_length=1, max_length=200)
    category: str = Field(min_length=1, max_length=100)
    date: str = Field(min_length=10, max_length=10)
    time: str = Field(min_length=1, max_length=100)
    location: str = Field(min_length=1, max_length=200)
    description: str = Field(min_length=1)
    ministry_name: str | None = None


@app.get('/api/events')
def get_events():
    return db.list_events()


@app.get('/api/events/{event_id}')
def get_event(event_id: int):
    event = db.get_event(event_id)
    if not event:
        raise HTTPException(status_code=404, detail='Event not found')
    return event


@app.post('/api/events', status_code=201)
def post_event(body: EventCreate):
    return db.create_event(
        title=body.title,
        category=body.category,
        date=body.date,
        time=body.time,
        location=body.location,
        description=body.description,
        ministry_name=body.ministry_name,
    )


class ModelUpdateRequest(BaseModel):
    model: str = Field(min_length=1, max_length=100)


class SummarizeAllRequest(BaseModel):
    model: str | None = None
    only_missing: bool = False


@app.get('/api/ai/status')
@app.get('/api/ollama/status')
async def get_ai_status():
    return await ai_client.get_status()


@app.post('/api/ai/model')
@app.post('/api/ollama/model')
def set_ai_model(body: ModelUpdateRequest):
    ai_client.set_default_model(body.model)
    return {"default_model": ai_client.get_default_model()}


@app.post('/api/events/{event_id}/summarize')
async def summarize_event(event_id: int, model: str | None = None):
    event = db.get_event(event_id)
    if not event:
        raise HTTPException(status_code=404, detail='Event not found')
    try:
        summary = await ai_client.summarize_event(
            title=event['title'],
            category=event['category'],
            description=event['description'],
            date=event['date'],
            time=event['time'],
            location=event['location'],
            model=model,
        )
        updated = db.update_event_summary(event_id, summary)
        return updated
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"AI summarization failed: {exc}")


@app.post('/api/events/summarize-all')
async def summarize_all_events(
    body: SummarizeAllRequest | None = None,
    only_missing: bool = False,
    model: str | None = None,
):
    target_model = body.model if (body and body.model) else model
    filter_missing = body.only_missing if body else only_missing

    events = db.list_events()
    if filter_missing:
        events = [ev for ev in events if not ev.get('ai_summary')]

    results = []
    errors = []
    headers = ai_client._get_headers()
    async with httpx.AsyncClient(timeout=120.0, headers=headers) as client:
        for ev in events:
            try:
                summary = await ai_client.summarize_event(
                    title=ev['title'],
                    category=ev['category'],
                    description=ev['description'],
                    date=ev['date'],
                    time=ev['time'],
                    location=ev['location'],
                    model=target_model,
                    client=client,
                )
                updated = db.update_event_summary(ev['id'], summary)
                results.append(updated)
            except Exception as exc:
                errors.append({"event_id": ev['id'], "title": ev['title'], "error": str(exc)})
    return {
        "updated": len(results),
        "errors": errors,
        "events": db.list_events(),
        "only_missing": filter_missing,
    }


