import { useEffect, useState } from 'react';
import { api } from './api.js';
import ChurchMap from './ChurchMap.jsx';
import { ALLOWED_PARKING_IDS, EXAMPLE_CAMPUS, MAP_SPOTS } from './visitMap.js';

const TOKEN_KEY = 'belong.visitToken';

function readToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
function writeToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* ignore */ }
}

export default function VisitPage() {
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
    [spotId, setSpotId] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const data = await api('/church');
        setChurch(data);
        setService(prev => prev || `${data.info.services[0].day} ${data.info.services[0].time}`);
        const token = readToken();
        if (token) {
          try { setVisit(await api('/visits/' + token)); }
          catch (err) {
            if (err.status === 404) writeToken(null);
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
      writeToken(created.token);
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
    writeToken(null);
    setVisit(null);
  }

  if (loading) return <p role="status" className="muted">Loading…</p>;
  if (error && !church) return <div className="api-message" role="alert">{error}</div>;
  const info = church.info;
  const directions = encodeURIComponent(EXAMPLE_CAMPUS.directionsQuery);
  const nextSteps = church.events.filter(ev => ev.audience === 'Newcomers' || ev.audience === 'Everyone' || ev.audience === 'Families').slice(0, 3);

  return <div className="visit-page">
    {error && <div className="api-message" role="alert">{error}</div>}

    <section className="card visit-section">
      <div className="eyebrow">SERVICE TIMES</div>
      <h2>Join us this week</h2>
      <div className="service-cards">
        {info.services.map(s => <article key={s.day + s.time} className="service-card">
          <strong>{s.day} {s.time}</strong>
          <p>{s.note}</p>
        </article>)}
      </div>
    </section>

    <section className="card visit-section">
      <div className="eyebrow">WHAT TO EXPECT</div>
      <h2>Before you arrive</h2>
      <p>{info.first_visit}</p>
    </section>

    <section className="card visit-section">
      <div className="eyebrow">FIND YOUR WAY</div>
      <h2>Parking, entrances &amp; kids check-in</h2>
      <p>Tap a spot to see it on the map.</p>
      <div className="find-your-way">
        <ul className="spot-list">
          {MAP_SPOTS.map(s => <li key={s.id}>
            <button type="button" className={'spot' + (s.id === spotId ? ' active' : '')} aria-pressed={s.id === spotId} onClick={() => setSpotId(s.id === spotId ? null : s.id)}>
              <span className={'spot-icon ' + s.kind} aria-hidden="true" />
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
    </section>

    {nextSteps.length > 0 && <section className="card visit-section">
      <div className="eyebrow">YOUR NEXT STEP</div>
      <h2>A good place to start</h2>
      <div className="service-cards">
        {nextSteps.map(ev => <article key={ev.id} className="service-card">
          <strong>{ev.name}</strong>
          <p>{ev.when} · {ev.where}</p>
          <p>{ev.description}</p>
        </article>)}
      </div>
    </section>}

    <section className="card visit-section">
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
          <p>Hang tight — someone will come find you at the main entrance shortly.</p>
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
    </section>
  </div>;
}
