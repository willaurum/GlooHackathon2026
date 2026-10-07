import { Fragment, useEffect, useState } from 'react';
import { api } from './api.js';
import ChurchMap from './ChurchMap.jsx';
import { useChurch } from './ChurchContext.js';
import { directionsHref, nextSteps as pickNextSteps, orderedSections } from './churchSite.js';
import Sourced from './Sourced.jsx';
import { ALLOWED_PARKING_IDS, EXAMPLE_CAMPUS, MAP_SPOTS, geocodeAddress, parkingFaq } from './visitMap.js';

const TOKEN_KEY = 'belong.visitToken';
// The Plan your visit sections in their usual order; a church can reorder or hide them by asking Tekton (site.layout,
// the keys of backend builder_edit.PAGES['visit']).
export const VISIT_SECTIONS = ['service_times', 'what_to_expect', 'map', 'locations', 'faqs', 'next_steps', 'sign_up'];

// Each church keeps its own visit token (the demo church keeps the original key).
function readToken(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeToken(key, token) {
  try {
    if (token) localStorage.setItem(key, token);
    else localStorage.removeItem(key);
  } catch { /* ignore */ }
}

export default function VisitPage() {
  const site = useChurch();
  const tokenKey = site.demo ? TOKEN_KEY : TOKEN_KEY + ':' + site.slug;
  const [church, setChurch] = useState(null),
    [visit, setVisit] = useState(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [name, setName] = useState(''),
    [contact, setContact] = useState(''),
    [service, setService] = useState(''),
    [partySize, setPartySize] = useState(1),
    [kids, setKids] = useState(''),
    [wantsHost, setWantsHost] = useState(true),
    [spotId, setSpotId] = useState(null),
    [location, setLocation] = useState(null);

  useEffect(() => {
    let live = true;
    setLocation(null);
    if (!site.demo && church?.info?.address) geocodeAddress(church.info.address, church.info.city).then(result => { if (live) setLocation(result); });
    return () => { live = false; };
  }, [site.demo, church?.info?.address, church?.info?.city]);

  useEffect(() => {
    (async () => {
      try {
        const data = await api('/church');
        // An API build from before the guest-visits merge answers /church with the
        // sermon-notes config ({ name, timezone, default_language }), which has no info.
        if (!Array.isArray(data?.info?.services)) throw new Error('The church API returned an unexpected response.');
        const list = key => Array.isArray(data[key]) ? data[key] : [];
        setChurch({ ...data, events: list('events'), faqs: list('faqs'), locations: list('locations') });
        const first = data.info.services[0];
        if (first) setService(prev => prev || `${first.day} ${first.time}`);
        const token = readToken(tokenKey);
        if (token) {
          try { setVisit(await api('/visits/' + token)); }
          catch (err) {
            if (err.status === 404) writeToken(tokenKey, null);
            else setError('Could not load your visit. Refresh to try again.');
          }
        }
      } catch (err) { setError('Could not load church info. ' + err.message); }
      finally { setLoading(false); }
    })();
  }, []);

  useEffect(() => {
    if (!visit || (visit.status !== 'arrived' && visit.status !== 'on_the_way')) return;
    let cancelled = false;
    const poll = setInterval(async () => {
      try {
        const latest = await api('/visits/' + visit.token);
        if (!cancelled) setVisit(latest);
      } catch { /* keep last known state */ }
    }, 5000);
    return () => { cancelled = true; clearInterval(poll); };
  }, [visit?.token, visit?.status]);

  async function signUp(e) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const created = await api('/visits', {
        method: 'POST',
        body: JSON.stringify({ name, contact, service, party_size: partySize, kids, wants_host: wantsHost })
      });
      writeToken(tokenKey, created.token);
      setVisit(created);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  async function imHere() {
    setBusy(true); setError('');
    try { setVisit(await api('/visits/' + visit.token + '/arrive', { method: 'POST' })); }
    catch (err) {
      if (err.status === 409) setVisit(await api('/visits/' + visit.token).catch(() => visit));
      else setError(err.message);
    }
    finally { setBusy(false); }
  }

  function planAnother() {
    writeToken(tokenKey, null);
    setVisit(null);
  }

  if (loading) return <p role="status" className="muted">Loading…</p>;
  if (error && !church) return <div className="api-message" role="alert">{error}</div>;
  const info = church.info;
  // Only the demo church uses the illustrated campus; imported churches use their own address.
  const place = site.demo ? EXAMPLE_CAMPUS.directionsQuery : [info.address, info.city].filter(Boolean).join(', ') || info.map_query || '';
  const directions = encodeURIComponent(place);
  const nextSteps = pickNextSteps(church.events, site.demo);
  // The demo church's own questions are about Grace Community, so they stay in the chat; other churches show theirs.
  const parking = site.demo ? [] : church.faqs.filter(parkingFaq);
  const faqs = site.demo ? [] : church.faqs.filter(f => !parkingFaq(f));

  return <div className="visit-page">
    {error && <div className="api-message" role="alert">{error}</div>}

    {/* In the order the church asked Tekton for (site.layout). The demo church's illustrated map takes the map's place. */}
    {orderedSections(site.site?.layout, 'visit', VISIT_SECTIONS).map(key => <Fragment key={key}>{{
      service_times: <section className="card visit-section" id="visit-service-times">
        <div className="eyebrow">SERVICE TIMES</div>
        <h2>Join us this week</h2>
        {info.services.length ? <div className="service-cards">
          {info.services.map(s => <article key={s.day + s.time} className="service-card">
            <strong><Sourced field="services">{s.day} {s.time}</Sourced></strong>
            <p>{s.note}</p>
          </article>)}
        </div> : <p className="muted">Service times are coming soon. {site.staff ? 'Add them in Church setup.' : 'Ask Tekton or the church office in the meantime.'}</p>}
      </section>,
      what_to_expect: (info.first_visit && <section className="card visit-section" id="visit-what-to-expect">
        <div className="eyebrow">WHAT TO EXPECT</div>
        <h2>Before you arrive</h2>
        <p><Sourced field="first_visit">{info.first_visit}</Sourced></p>
      </section>),
      map: <>{!site.demo && <div className={'visit-location' + (place && parking.length ? ' has-parking' : '')}>
      {place && <section className="card visit-section" id="visit-map">
        <div className="eyebrow">FIND YOUR WAY</div>
        <h2>Where we meet</h2>
        <p>{info.address ? <Sourced field="address">{info.address}</Sourced> : place}</p>
        {location && <>
          <ChurchMap center={location.center} approximate={location.approximate} name={info.name} />
          {location.approximate && <p className="map-address">Approximate location</p>}
        </>}
        <div className="map-links">
          <a className="btn primary" href={`https://www.google.com/maps/dir/?api=1&destination=${directions}`} target="_blank" rel="noopener noreferrer">Get directions</a>
          <a className="btn secondary" href={`https://maps.apple.com/?daddr=${directions}`} target="_blank" rel="noopener noreferrer">Open in Apple Maps</a>
        </div>
      </section>}
      {parking.length > 0 && <section className="card visit-section" id="visit-parking">
        <div className="eyebrow">BEFORE YOU ARRIVE</div>
        <h2>Parking &amp; accessibility</h2>
        <div className="faq-list">
          {parking.map(f => <details key={f.id ?? f.question} className="faq"><summary>{f.question}</summary><p>{f.answer}</p></details>)}
        </div>
      </section>}
      </div>}
      {site.demo && <section className="card visit-section" id="visit-map">
        <div className="eyebrow">FIND YOUR WAY</div>
        <h2>Parking, entrances &amp; kids check-in</h2>
        <p>Tap a spot to see it on the map.</p>
        <div className="find-your-way">
          <ul className="spot-list">
            {MAP_SPOTS.map(s => <li key={s.id}>
              <button type="button" className={'spot' + (s.id === spotId ? ' active' : '')} aria-pressed={s.id === spotId} onClick={() => setSpotId(s.id === spotId ? null : s.id)}>
                <span className={'spot-icon ' + s.kind} style={{ '--spot': s.color }} aria-hidden="true" />
                <span><strong>{s.label}</strong>{s.id === spotId && <small>{s.text}</small>}</span>
              </button>
            </li>)}
          </ul>
          <ChurchMap building={EXAMPLE_CAMPUS.building} spots={MAP_SPOTS} activeId={spotId} onSelect={setSpotId} maskIds={ALLOWED_PARKING_IDS} />
        </div>
        <div className="map-links">
          <a className="btn primary" href={`https://www.google.com/maps/dir/?api=1&destination=${directions}`} target="_blank" rel="noopener noreferrer">Get directions</a>
          <a className="btn secondary" href={`https://maps.apple.com/?daddr=${directions}`} target="_blank" rel="noopener noreferrer">Open in Apple Maps</a>
        </div>
        <p className="map-address">Example campus: {EXAMPLE_CAMPUS.name}, {EXAMPLE_CAMPUS.address}. Parking and door labels are illustrative.</p>
      </section>}</>,
      locations: (church.locations.length > 0 && <section className="card visit-section" id="visit-locations">
        <div className="eyebrow">OUR CAMPUSES</div>
        <h2>Places we meet</h2>
        <div className="service-cards">
          {church.locations.map(loc => <article key={loc.id ?? loc.name} className="service-card campus-card">
            <strong><Sourced list="locations" name={loc.name}>{loc.name}</Sourced></strong>
            {loc.address && <p>{loc.address}</p>}
            {loc.service_times && <p>{loc.service_times}</p>}
            {loc.note && <p>{loc.note}</p>}
            {(loc.map_query || loc.address) && <a className="link" href={directionsHref(loc.map_query || loc.address)} target="_blank" rel="noopener noreferrer">Get directions</a>}
          </article>)}
        </div>
      </section>),
      faqs: (faqs.length > 0 && <section className="card visit-section" id="visit-good-to-know">
        <div className="eyebrow">GOOD TO KNOW</div>
        <h2>Questions people ask</h2>
        <div className="faq-list">
          {faqs.map(f => <details key={f.id ?? f.question} className="faq">
            <summary>{f.question}</summary>
            <p>{f.answer}</p>
          </details>)}
        </div>
      </section>),
      next_steps: (nextSteps.length > 0 && <section className="card visit-section" id="visit-next-steps">
        <div className="eyebrow">YOUR NEXT STEP</div>
        <h2>A good place to start</h2>
        <div className="service-cards">
          {nextSteps.map(ev => <article key={ev.id} className="service-card">
            <strong>{ev.name}</strong>
            <p>{[ev.when, ev.where].filter(Boolean).join(' · ')}</p>
            <p>{ev.description}</p>
          </article>)}
        </div>
      </section>),
      sign_up: <>{/* Guests pick a service time, so the form waits until the church has one. */}
      {(info.services.length > 0 || visit) && <section className="card visit-section" id="visit-sign-up">
        {!visit ? <>
          <div className="eyebrow">LET US KNOW YOU'RE COMING</div>
          <h2>Plan your visit</h2>
          <form className="visit-form" onSubmit={signUp}>
            <label className="field">Name
              <input required maxLength={100} value={name} onChange={e => setName(e.target.value)} placeholder="Jamie Parker" />
            </label>
            <label className="field">Email or phone <small>Optional</small>
              <input maxLength={200} value={contact} onChange={e => setContact(e.target.value)} placeholder="jamie@example.com" />
            </label>
            <label className="field">Service
              <select value={service} onChange={e => setService(e.target.value)}>
                {info.services.map(s => <option key={s.day + s.time} value={`${s.day} ${s.time}`}>{s.day} {s.time}</option>)}
              </select>
            </label>
            <label className="field">Party size
              <input type="number" min={1} max={20} value={partySize} onChange={e => setPartySize(Number(e.target.value))} />
            </label>
            <label className="field">Kids <small>Optional</small>
              <input maxLength={200} value={kids} onChange={e => setKids(e.target.value)} placeholder="2 kids, ages 4 and 7" />
            </label>
            <label className="field checkbox">
              <input type="checkbox" checked={wantsHost} onChange={e => setWantsHost(e.target.checked)} />
              I'd like someone to meet me
            </label>
            <button className="primary wide" disabled={busy}>{busy ? 'Working…' : "I'm coming"}</button>
          </form>
        </> : <div className="visit-status" aria-live="polite">
          {visit.status === 'planned' && <>
            <div className="eyebrow">YOU'RE ON THE LIST</div>
            <h2>See you {visit.service}, {visit.name}</h2>
            <p>{visit.wants_host
              ? 'When you arrive, tap the button below and the welcome team will be looking for you.'
              : 'When you arrive, tap the button below so we know you made it.'}</p>
            <button className="primary wide" disabled={busy} onClick={imHere}>{busy ? 'Working…' : "I'm here"}</button>
          </>}
          {visit.status === 'arrived' && (visit.wants_host ? <>
            <div className="eyebrow">YOU'RE HERE</div>
            <h2>The welcome team has been notified…</h2>
            <p>Hang tight. Someone will come find you at the main entrance shortly.</p>
          </> : <>
            <div className="eyebrow">YOU'RE HERE</div>
            <h2>Thanks for letting us know. Enjoy the service!</h2>
            <p>If you need anything, stop by the Welcome desk in the lobby.</p>
          </>)}
          {visit.status === 'on_the_way' && <>
            <div className="eyebrow">ON THE WAY</div>
            <h2>{visit.host} is coming to meet you at the main entrance.</h2>
          </>}
          {visit.status === 'met' && <>
            <div className="eyebrow">WELCOME</div>
            <h2>Welcome! We're glad you're here.</h2>
          </>}
          <button type="button" className="plan-another" onClick={planAnother}>Plan a different visit</button>
        </div>}
      </section>}</>,
    }[key]}</Fragment>)}
  </div>;
}
