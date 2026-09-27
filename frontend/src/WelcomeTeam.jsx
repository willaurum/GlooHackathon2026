import { useEffect, useState } from 'react';
import { api } from './api.js';

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

export default function WelcomeTeam() {
  const [waiting, setWaiting] = useState([]),
    [planned, setPlanned] = useState([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [hostName, setHostName] = useState(readHostName);

  async function load() {
    try {
      const data = await api('/visits');
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

  if (loading) return <p role="status">Loading…</p>;

  return <div className="welcome-team">
    {error && <div className="api-message" role="alert">{error}</div>}

    <section className="panel visit-section">
      <label className="field">Your name
        <input maxLength={60} value={hostName} onChange={e => setHostName(e.target.value)} placeholder="Enter your name to claim guests" />
      </label>
    </section>

    <section className="panel visit-section">
      <div className="eyebrow">GUESTS WAITING</div>
      <h2>Guests waiting {waiting.length > 0 && <span className="badge urgent">{waiting.length}</span>}</h2>
      {!waiting.length ? <div className="empty">No one is waiting right now.</div> : <div className="guest-list">
        {waiting.map(v => <article className={'panel guest-card ' + (v.status === 'arrived' ? 'just-arrived' : '')} key={v.visit_id}>
          <div className="card-top">
            <span className="tag">{v.status === 'arrived' ? '● Just arrived' : 'On the way'}</span>
            <small>{minutesSince(v.arrived_at)} min ago</small>
          </div>
          <h3>{v.name} <small>· party of {v.party_size}</small></h3>
          <p>{v.service}{v.kids && ' · ' + v.kids}</p>
          {v.status === 'arrived'
            ? <button className="primary" disabled={busy || !hostName.trim()} onClick={() => claim(v.visit_id)}>On my way</button>
            : <><p><b>{v.host}</b> is on the way</p><button className="secondary" disabled={busy} onClick={() => markMet(v.visit_id)}>Met them ✓</button></>}
        </article>)}
      </div>}
    </section>

    <section className="panel visit-section">
      <div className="eyebrow">EXPECTED GUESTS</div>
      <h2>Planned visits</h2>
      {!planned.length ? <div className="empty">No upcoming sign-ups yet.</div> : <div className="guest-list">
        {planned.map(v => <article className="panel guest-card" key={v.visit_id}>
          <h3>{v.name} <small>· party of {v.party_size}</small></h3>
          <p>{v.service}{v.kids && ' · ' + v.kids}</p>
        </article>)}
      </div>}
    </section>
  </div>;
}
