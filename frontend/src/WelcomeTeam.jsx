import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { useChurch } from './ChurchContext.js';
import { StaffOnly } from './ChurchStates.jsx';
import Icon from './Icon.jsx';
import { MAX_GUEST_NAME, checkInChoices, enterAction } from './welcomeCheckIn.js';

const HOST_KEY = 'belong.hostName';

function readHostName() {
  try { return localStorage.getItem(HOST_KEY) ?? ''; } catch { return ''; }
}
function writeHostName(name) {
  try { localStorage.setItem(HOST_KEY, name); } catch { /* ignore */ }
}

function minutesSince(timestamp) {
  if (!timestamp) return null;
  return Math.max(0, Math.round((Date.now() - new Date(timestamp).getTime()) / 60000));
}

const notificationsSupported = () => typeof window !== 'undefined' && 'Notification' in window;
const readPermission = () => notificationsSupported() ? Notification.permission : 'unsupported';

// Pops a browser notification for a guest who just tapped "I'm here". Never includes their contact details.
function announceArrival(v) {
  if (readPermission() !== 'granted') return;
  try {
    const n = new Notification('Guest arrived', {
      body: `${v.name} (party of ${v.party_size}) · ${v.service}` + (v.wants_host ? '' : ' · prefers not to be met'),
      tag: 'visit-' + v.visit_id,
    });
    n.onclick = () => { window.focus(); n.close(); };
  } catch { /* some browsers refuse page-level notifications; the queue still updates */ }
}

// Guests names and arrival times: staff only, including on the demo church.
export default function WelcomeTeam() {
  const church = useChurch();
  return church.staff ? <WelcomeQueue /> : <StaffOnly what="The welcome team screen" />;
}

function WelcomeQueue() {
  const [waiting, setWaiting] = useState([]),
    [planned, setPlanned] = useState([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [hostName, setHostName] = useState(readHostName),
    [permission, setPermission] = useState(readPermission),
    [guestName, setGuestName] = useState(''),
    [checkedIn, setCheckedIn] = useState(''),
    seen = useRef(null);

  async function load() {
    try {
      const data = await api('/visits');
      // The first load only records who is already here; after that, anyone new gets announced.
      if (seen.current) data.waiting.filter(v => v.status === 'arrived' && !seen.current.has(v.visit_id)).forEach(announceArrival);
      seen.current = new Set(data.waiting.map(v => v.visit_id));
      setWaiting(data.waiting); setPlanned(data.planned); setError('');
    } catch (err) { setError('Could not load the guest queue. ' + err.message); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    load();
    const poll = setInterval(load, 5000);
    return () => clearInterval(poll);
  }, []);

  useEffect(() => { writeHostName(hostName); }, [hostName]);

  async function enableAlerts() {
    try { setPermission(await Notification.requestPermission()); } catch { setPermission(readPermission()); }
  }

  // A planned guest (visit) or, with no visit, the typed name as a new guest. Both land in Guests waiting.
  async function checkIn(visit, newName = '') {
    setBusy(true); setError(''); setCheckedIn('');
    try {
      const done = visit
        ? await api(`/visits/${visit.visit_id}/checkin`, { method: 'POST' })
        : await api('/visits/new/checkin', { method: 'POST', body: JSON.stringify({ name: newName }) });
      setCheckedIn(done.name); setGuestName('');
      await load();
    }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  const choices = checkInChoices(planned, guestName, waiting);
  function submitGuest(e) {
    e.preventDefault();
    const action = busy ? null : enterAction(choices);
    if (action) checkIn(action.visit, action.newGuest ? choices.name : '');
  }

  async function claim(visitId) {
    setBusy(true); setError('');
    try { await api(`/visits/${visitId}/claim`, { method: 'POST', body: JSON.stringify({ host: hostName }) }); await load(); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  async function markMet(visitId) {
    setBusy(true); setError('');
    try { await api(`/visits/${visitId}/met`, { method: 'POST' }); await load(); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  if (loading) return <p role="status" className="muted">Loading…</p>;

  return <div className="welcome-team">
    {error && <div className="api-message" role="alert">{error}</div>}

    <section className="card visit-section">
      <label className="field">Your name
        <input maxLength={60} value={hostName} onChange={e => setHostName(e.target.value)} placeholder="Enter your name to claim guests" />
      </label>
    </section>

    <section className="card visit-section welcome-checkin">
      <div className="eyebrow">CHECK IN</div>
      <h2>Check in a guest</h2>
      <form onSubmit={submitGuest}>
        <label className="field">Guest name
          <input maxLength={MAX_GUEST_NAME} value={guestName} autoComplete="off"
            onChange={e => { setGuestName(e.target.value); setCheckedIn(''); }} placeholder="Type a guest's name" />
        </label>
      </form>
      {checkedIn && <div className="give-applied" role="status"><Icon name="check" size={20} /><div><b>{checkedIn} is checked in.</b><p>They&rsquo;re in Guests waiting below.</p></div></div>}
      {choices.name && <>
        {choices.matches.length > 0 && <div className="guest-list">
          {choices.matches.map(v => <article className="card guest-card" key={v.visit_id}>
            <h3>{v.name} <small>· party of {v.party_size}</small></h3>
            <p>Signed up for {v.service}{v.kids && ' · ' + v.kids}</p>
            <button className="btn primary" disabled={busy} onClick={() => checkIn(v)}>Check in {v.name}</button>
          </article>)}
        </div>}
        {choices.here.map(v => <p key={v.visit_id}><b>{v.name}</b> is already checked in.</p>)}
        {choices.offerNew && <>
          {!choices.matches.length && <p>No one who signed up matches &ldquo;{choices.name}&rdquo;.</p>}
          <button className={'btn ' + (choices.matches.length ? 'secondary' : 'primary')} disabled={busy} onClick={() => checkIn(null, choices.name)}>
            Check in &ldquo;{choices.name}&rdquo; as a new guest
          </button>
        </>}
      </>}
    </section>

    <section className="card visit-section">
      <div className="eyebrow">ARRIVAL ALERTS</div>
      {permission === 'granted' && <p>● Alerts are on. You'll get a notification when a guest taps "I'm here". Keep this page open.</p>}
      {permission === 'default' && <>
        <p>Get a browser notification the moment a guest arrives. Keep this page open while you're on duty.</p>
        <button className="btn secondary" onClick={enableAlerts}>Turn on arrival alerts</button>
      </>}
      {permission === 'denied' && <p>Alerts are blocked for this site. Allow notifications in your browser's site settings, then reload this page.</p>}
      {permission === 'unsupported' && <p>This browser can't show notifications. Watch the queue below instead.</p>}
    </section>

    <section className="card visit-section">
      <div className="eyebrow">GUESTS WAITING</div>
      <h2 aria-live="polite">Guests waiting {waiting.length > 0 && <span className="badge urgent">{waiting.length}</span>}</h2>
      {!waiting.length ? <div className="empty">No one is waiting right now. Guests show up here when they tap “I’m here” on their phone, or when you check them in above or below.</div> : <div className="guest-list">
        {waiting.map(v => <article className={'card guest-card' + (v.status === 'arrived' ? ' just-arrived' : '')} key={v.visit_id}>
          <div className="card-top">
            <span className="tag">{v.status === 'arrived' ? '● Just arrived' : 'On the way'}</span>
            <small>{minutesSince(v.arrived_at)} min ago</small>
          </div>
          <h3>{v.name} <small>· party of {v.party_size}</small></h3>
          <p>{v.service}{v.kids && ' · ' + v.kids}</p>
          {!v.wants_host
            ? <><p>Prefers not to be met. Just letting you know they're here.</p><button className="btn secondary" disabled={busy} onClick={() => markMet(v.visit_id)}>Got it</button></>
            : v.status === 'arrived'
            ? <button className="btn primary" disabled={busy || !hostName.trim()} onClick={() => claim(v.visit_id)}>On my way</button>
            : <><p><b>{v.host}</b> is on the way</p><button className="btn secondary" disabled={busy} onClick={() => markMet(v.visit_id)}>Met them</button></>}
        </article>)}
      </div>}
    </section>

    <section className="card visit-section">
      <div className="eyebrow">EXPECTED GUESTS</div>
      <h2>Planned visits</h2>
      {!planned.length ? <div className="empty">No upcoming sign-ups yet.</div> : <div className="guest-list">
        {planned.map(v => <article className="card guest-card" key={v.visit_id}>
          <h3>{v.name} <small>· party of {v.party_size}</small></h3>
          <p>{v.service}{v.kids && ' · ' + v.kids}</p>
          {/* A guest at the door without their phone: a greeter checks them in. */}
          <button className="btn secondary" disabled={busy} onClick={() => checkIn(v)}>They&rsquo;re here</button>
        </article>)}
      </div>}
    </section>
  </div>;
}
