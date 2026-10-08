"""Tekton prototype API with persistent ministries and connections, plus Pastor Notes."""

import asyncio
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field, ConfigDict, field_validator, model_validator
from datetime import date, datetime
from typing import Literal

from . import ai_client, blog_ai, builder, chat, church_content, db, newsdata, pastor_notes, ratelimit, recommendations, site_editor
from . import contact as contacts
from .church_scope import ChurchScope

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


app = FastAPI(title="Tekton API", lifespan=lifespan)
# Every request runs against one church's database (X-Church); see church_scope.py.
app.add_middleware(ChurchScope)
# Editor request bodies are size-checked as they arrive (site_editor.BodyLimit).
app.add_middleware(site_editor.BodyLimit)
app.include_router(pastor_notes.router)
app.include_router(church_content.router)
app.include_router(site_editor.router)
app.include_router(builder.router)


class AvailabilityWindow(BaseModel):
    model_config = ConfigDict(extra='forbid')
    day: Literal['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
    start_time: str = Field(pattern=r'^([01][0-9]|2[0-3]):[0-5][0-9]$')
    end_time: str = Field(pattern=r'^([01][0-9]|2[0-3]):[0-5][0-9]$')

    @model_validator(mode='after')
    def ordered(self):
        if self.start_time >= self.end_time:
            raise ValueError('End time must be after start time; use separate windows for different days.')
        return self


class ServingPreferences(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra='forbid')
    availability: list[AvailabilityWindow] = Field(default_factory=list, max_length=21)
    unavailable_requirements: list[Literal['background_check', 'onboarding', 'shadowing', 'audition', 'midweek_rehearsal', 'care_training', 'confidentiality']] = Field(default_factory=list, max_length=7)
    days_and_times: str = Field(default='', max_length=500)
    preferred_service: str = Field(default='', max_length=200)
    frequency: Literal['one-time', 'weekly', 'monthly'] | None = None
    earliest_start_date: date | None = None


class MatchRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    description: str = Field(default='', max_length=4000)
    preferences: ServingPreferences = Field(default_factory=ServingPreferences)


class ConnectionRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    ministry_id: int = Field(ge=0)
    member: str = Field(min_length=1, max_length=100)


@app.get('/api/info')
def church_info():
    # Public church details (address, service times) for the home page.
    return church_content.public_info({'info': db.get_church_info()})


@app.get('/api/ministries')
def ministries():
    return church_content.public_ministries({'ministries': db.list_ministries()})


@app.post('/api/matches')
def matches(body: MatchRequest):
    ministries, preferences = db.list_ministries(), body.preferences.model_dump(mode='json')
    try:
        return recommendations.recommend(body.description, ministries, preferences=preferences)
    except recommendations.NotConfigured as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except recommendations.Unavailable:
        # Every model failed or timed out: show the fitting teams instead of an error.
        return recommendations.browse_fallback(ministries, preferences)


APPLICATION_MIN, APPLICATION_MAX = 250, 1000


class VolunteerApplication(BaseModel):
    """Only what the team needs: how to reach the person, and in their own words who they are,
    what they would like to do and why."""
    model_config = ConfigDict(str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=120)
    email: str = Field(max_length=200)
    phone: str = Field(default='', max_length=40)
    message: str = Field(min_length=APPLICATION_MIN, max_length=APPLICATION_MAX)

    @field_validator('email')
    @classmethod
    def email_shape(cls, value):
        if not contacts.is_email(value):
            raise ValueError(contacts.EMAIL_HINT)
        return value

    @field_validator('phone')
    @classmethod
    def phone_shape(cls, value):
        if value and not contacts.is_phone(value):
            raise ValueError(contacts.PHONE_HINT)
        return value


class VolunteerReview(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    status: Literal['new', 'accepted', 'waitlisted', 'declined'] | None = None
    note: str | None = Field(default=None, max_length=1000)


# Applying is public, so it is rate limited: a few applications per visitor, and a ceiling per church
# in case many addresses are used at once.
APPLY_PER_VISITOR = ratelimit.RateLimit(limit=5, window=10 * 60)
APPLY_PER_CHURCH = ratelimit.RateLimit(limit=100, window=60 * 60)
TOO_MANY_APPLICATIONS = 'Too many applications in a short time. Please try again in a few minutes.'


@app.post('/api/ministries/{ministry_id}/apply', status_code=201)
def apply_to_serve(ministry_id: int, body: VolunteerApplication, request: Request):
    church = db.current_church()
    if not APPLY_PER_VISITOR.allow((church, ratelimit.client_ip(request))) or not APPLY_PER_CHURCH.allow(church):
        raise HTTPException(status_code=429, detail=TOO_MANY_APPLICATIONS)
    ministry = db.get_ministry(ministry_id)
    if ministry is None:
        raise HTTPException(status_code=404, detail='That team is not listed any more.')
    # Applying twice while the first is still open keeps the first.
    application = db.find_open_application(ministry_id, email=body.email) or db.create_volunteer_application(
        ministry, body.name, email=body.email, phone=body.phone, message=body.message)
    # The applicant only learns it was received; what staff record stays with staff.
    return {'id': application['id'], 'team': application['ministry_name'], 'status': 'received'}


@app.get('/api/volunteers')
def volunteer_applications():
    return {'applications': db.list_volunteer_applications()}


@app.put('/api/volunteers/{application_id}')
def review_volunteer_application(application_id: int, body: VolunteerReview):
    current = db.review_volunteer_application(application_id)
    if current is None:
        raise HTTPException(status_code=404, detail='Application not found')
    # Every decision is explained: changing the status needs a note with it.
    if body.status and body.status != current['status'] and not body.note:
        raise HTTPException(status_code=400, detail='Add a note explaining why you are changing this application.')
    db.review_volunteer_application(application_id, status=body.status, note=body.note)
    return {'applications': db.list_volunteer_applications()}


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


ChatRequest = chat.ChatRequest


class RequestStatus(BaseModel):
    status: Literal['approved', 'declined']


@app.get('/api/chat/status')
def chat_status():
    return chat.status()


@app.post('/api/chat')
def chat_turn(body: ChatRequest):
    messages = chat.recent_messages(body)
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


@app.delete('/api/requests/{request_id}', status_code=204)
def remove_request(request_id: int):
    if not db.remove_request(request_id):
        raise HTTPException(status_code=404, detail='Request not found')


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

# --- First-time guest visits ---


class VisitRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=100)
    contact: str = Field(default='', max_length=200)
    service: str

    @field_validator('contact')
    @classmethod
    def contact_shape(cls, value):
        # Optional, but when given it is an email or a phone number the welcome team can use.
        if value and not contacts.is_email_or_phone(value):
            raise ValueError(contacts.EMAIL_OR_PHONE_HINT)
        return value
    party_size: int = Field(ge=1, le=20)
    kids: str = Field(default='', max_length=200)
    wants_host: bool = True


class ClaimRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    host: str = Field(min_length=1, max_length=60)


@app.get('/api/church')
def church():
    return church_content.public_church({'info': db.get_church_info(), 'site': db.get_site(),
                                         **{kind: db.list_content(kind) for kind in db.CONTENT_KINDS}})


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


@app.post('/api/visits/{visit_id}/checkin')
def check_in_visit(visit_id: int):
    visit = db.check_in_visit(visit_id)
    if visit is None:
        raise HTTPException(status_code=409, detail='This guest is not on the planned list')
    return visit


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


# --- Prayer map: regions, field updates, and news ---


class FieldUpdateOut(BaseModel):
    id: int
    date: str
    title: str
    body: str
    author: str


class RegionOut(BaseModel):
    id: int
    country: str
    country_code: str
    codename: str
    field_of_ministry: str = ''
    since: int | None = None
    team_size: int = 0
    updates: list[FieldUpdateOut]  # newest first


class NewsEventOut(BaseModel):
    model_config = ConfigDict(extra='forbid')
    id: int
    country: str
    country_code: str
    city: str
    lat: float
    lng: float
    headline: str
    source: str
    date: str
    url: str | None = None


@app.get('/api/regions', response_model=list[RegionOut])
def regions():
    return db.list_regions()


@app.get('/api/news', response_model=list[NewsEventOut])
def news():
    return db.list_news()


@app.post('/api/news/refresh')
def refresh_news():
    """Pull live headlines from NewsData.io and replace this church's news."""
    if not os.environ.get('NEWSDATA_API_KEY', '').strip():
        raise HTTPException(status_code=503, detail='NEWSDATA_API_KEY is not set; the news is unchanged.')
    items = newsdata.fetch_news()
    if not items:
        raise HTTPException(status_code=502, detail='NewsData returned no articles; the news is unchanged.')
    db.replace_news(items)
    return {'articles': len(items)}


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


# The calendar shows its own "Offline" pill from /api/ai/status; this is for direct calls.
AI_OFFLINE = "AI is offline right now (not configured, or the team AI bridge is off). Try again later."


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
    return church_content.public_events({'calendar': db.list_events()})


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


@app.delete("/api/events/{event_id}", status_code=204)
def delete_event(event_id: int):
    # Staff only: the API Worker allows DELETE /api/events/<id> for a staff session (api/churches.ts).
    if not db.delete_event(event_id):
        raise HTTPException(status_code=404, detail="Event not found")


@app.post("/api/events/{event_id}/summarize")
async def summarize_event(event_id: int, model: str | None = None):
    event = db.get_event(event_id)
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    status = await ai_client.get_status()
    if not status.get("connected"):
        raise HTTPException(status_code=503, detail=AI_OFFLINE)
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
        raise HTTPException(status_code=503, detail=AI_OFFLINE)
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
    """Which provider the AI features use and whether it answers. The calendar reads connected,
    default_model and available_models; the rest is for the team checking on the bridge."""
    status = await ai_client.get_status()
    return {**status, "team_bridge": bool(os.environ.get("TEAM_AI_BRIDGE")), "chat": chat.status()}


@app.post("/api/ai/model")
@app.post("/api/ollama/model")
def set_ai_model(body: ModelUpdateRequest):
    ai_client.set_default_model(body.model)
    return {"default_model": ai_client.get_default_model()}


# --- Blog Endpoints ---


# A news link is a page on this site (serve/find, about/connect) or a full http(s) address.
NEWS_LINK = r"^$|^https?://\S+$|^[a-z0-9][a-z0-9/_-]*$"


class BlogPostCreate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    title: str = Field(min_length=1, max_length=300)
    content: str = Field(min_length=1)
    author: str = Field(default="Church Staff", max_length=100)
    categories: list[str] = Field(default_factory=list)
    auto_categorize: bool = False
    auto_summarize: bool = False
    # 'update': a short post that points somewhere, never summarized. 'article': a longer read with key takeaways.
    kind: Literal["update", "article"] = "article"
    link_url: str = Field(default="", max_length=500, pattern=NEWS_LINK)
    link_label: str = Field(default="", max_length=80)


class CategorizeRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    title: str = Field(default="", max_length=300)
    content: str = Field(min_length=1)


class SummarizePostRequest(BaseModel):
    model: str | None = None


@app.get("/api/blog")
def get_blog_posts(category: str | None = None, kind: str | None = None):
    return db.list_blog_posts(category=category, kind=kind)


@app.get("/api/blog/categories")
def get_blog_categories():
    return db.list_blog_categories()


@app.get("/api/blog/{post_id}")
def get_single_blog_post(post_id: int):
    post = db.get_blog_post(post_id)
    if not post:
        raise HTTPException(status_code=404, detail="Blog post not found")
    return post


@app.post("/api/blog/categorize")
async def categorize_post_nlp(body: CategorizeRequest):
    """Suggest categories for a post using NLP / LLM."""
    categories = await blog_ai.categorize_blog_post(title=body.title, content=body.content)
    return {"categories": categories}


@app.post("/api/blog", status_code=201)
async def create_new_blog_post(body: BlogPostCreate):
    categories = body.categories
    # Auto-generate categories using NLP if none provided or auto_categorize is True
    if not categories or body.auto_categorize:
        nlp_cats = await blog_ai.categorize_blog_post(title=body.title, content=body.content)
        categories = list(dict.fromkeys(categories + nlp_cats))

    bullet_summary = None
    if body.auto_summarize and body.kind == "article":
        try:
            bullet_summary = await blog_ai.summarize_blog_bullets(title=body.title, content=body.content)
        except Exception as exc:
            log.warning("Auto-summarization failed on post creation: %s", exc)

    post = db.create_blog_post(
        title=body.title,
        content=body.content,
        author=body.author or "Church Staff",
        categories=categories,
        bullet_summary=bullet_summary,
        kind=body.kind,
        link_url=body.link_url,
        link_label=body.link_label if body.link_url else "",
    )
    return post


@app.post("/api/blog/{post_id}/summarize")
async def summarize_blog_post_endpoint(post_id: int, body: SummarizePostRequest | None = None):
    post = db.get_blog_post(post_id)
    if not post:
        raise HTTPException(status_code=404, detail="Blog post not found")
    if post["kind"] != "article":
        raise HTTPException(status_code=400, detail="Only articles have key takeaways")

    target_model = body.model if body else None
    try:
        bullets = await blog_ai.summarize_blog_bullets(
            title=post["title"],
            content=post["content"],
            model=target_model,
        )
        updated = db.update_blog_post_summary(post_id, bullets)
        return updated
    except Exception as exc:
        log.exception("Blog summarization failed for post %s", post_id)
        raise HTTPException(status_code=502, detail=f"LLM summarization failed: {exc}")


@app.delete("/api/blog/{post_id}", status_code=204)
def delete_blog_post_endpoint(post_id: int):
    if not db.delete_blog_post(post_id):
        raise HTTPException(status_code=404, detail="Blog post not found")

