import { useEffect, useState } from 'react';
import { api } from './api.js';
import { useChurch } from './ChurchContext.js';
import { SetUpThis, StaffOnly } from './ChurchStates.jsx';
import Icon from './Icon.jsx';
import { PageHeader, SubNav } from './Layout.jsx';

const urgent = m => m.total > 0 && (m.total - m.filled) / m.total >= .35;
const TABS = [['serve', 'Ministries', 'grid'], ['serve/find', 'Find a place', 'compass'], ['serve/saved', 'Saved', 'bookmark']];
const HEADERS = {
  'serve': ['Many teams. One purpose.', 'See where help is needed and meet the people who lead each team.'],
  'serve/find': ['Good gifts. The right place.', 'Tell us about yourself and discover where you could belong.'],
  'serve/saved': ['Keep the connection going.', 'A shortlist for your next conversation, plus requests from the website chat.'],
};

export default function Serve({ route, go, requestsVersion, onCount }) {
  const church = useChurch();
  // Saved connections and chat requests carry names and contacts: staff only, including on the demo church.
  const staffView = church.staff;
  const [query, setQuery] = useState(''),
    [filter, setFilter] = useState(false),
    [detail, setDetail] = useState(null),
    [description, setDescription] = useState(''),
    [availabilityNote, setAvailabilityNote] = useState(''),
    [connectionNote, setConnectionNote] = useState(''),
    [matching, setMatching] = useState(false),
    [matchError, setMatchError] = useState(''),
    [results, setResults] = useState(null),
    [saved, setSaved] = useState([]),
    [teams, setTeams] = useState([]),
    [requests, setRequests] = useState([]),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function load() {
    setLoading(true); setError('');
    try {
      const [ministries, connections, filed] = await Promise.all([api('/ministries'), staffView ? api('/connections') : [], staffView ? api('/requests') : []]);
      setTeams(ministries); setSaved(connections); setRequests(filed);
    } catch (err) { setError('Could not load church data. ' + err.message); }
    finally { setLoading(false); }
  }
  useEffect(() => {
    if (!staffView) { setSaved([]); setRequests([]); }
    load();
  }, [staffView]);
  // The chat widget filed a request; refresh the staff queue.
  useEffect(() => { if (requestsVersion && staffView) api('/requests').then(setRequests).catch(() => {}); }, [requestsVersion, staffView]);
  const pending = requests.filter(r => r.status === 'pending');
  useEffect(() => { onCount(saved.length + pending.length); }, [saved.length, pending.length]);
  useEffect(() => {
    if (detail) document.getElementById('team-detail')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [detail]);

  async function remove(connectionId) {
    setBusy(true); setError('');
    try {
      await api('/connections/' + connectionId, { method: 'DELETE' });
      setSaved(previous => previous.filter(s => s.connection_id !== connectionId));
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  async function removeRequest(requestId) {
    setBusy(true); setError('');
    try {
      await api('/requests/' + requestId, { method: 'DELETE' });
      setRequests(previous => previous.filter(r => r.request_id !== requestId));
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  async function review(requestId, status) {
    setBusy(true); setError('');
    try {
      await api('/requests/' + requestId, { method: 'PATCH', body: JSON.stringify({ status }) });
      const [connections, filed] = await Promise.all([api('/connections'), api('/requests')]);
      setSaved(connections); setRequests(filed);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  async function match(e) {
    e.preventDefault();
    if (matching) return;
    setMatching(true); setMatchError(''); setResults(null);
    // The answers go to the AI as one labeled description; blank answers are left out.
    const answers = [['Interests and experience', description], ['General availability', availabilityNote], ['Anything else to share', connectionNote]]
      .filter(([, answer]) => answer.trim()).map(([label, answer]) => `${label}: ${answer.trim()}`).join('\n\n');
    try { setResults(await api('/matches', { method: 'POST', body: JSON.stringify({ description: answers }) })); }
    catch (err) { setMatchError(err.message); }
    finally { setMatching(false); }
  }
  function exploreMatch() {
    setResults(null); setDetail(null);
    go('serve/find');
  }

  const visible = teams.filter(m => (m.name + ' ' + m.description).toLowerCase().includes(query.toLowerCase()) && (!filter || urgent(m)));
  const [title, text] = HEADERS[route] ?? HEADERS.serve;
  return <div className="page">
    <PageHeader eyebrow="Serve" title={title} text={text}
      action={route !== 'serve/find' && <button className="primary" onClick={() => go('serve/find')}><Icon name="compass" size={18} />Find a place to serve</button>} />
    <SubNav tabs={TABS} route={route} go={go} counts={{ 'serve/saved': saved.length + pending.length }} />
    {error && <div className="banner error" role="alert"><span>{error}</span><button className="secondary" onClick={load} disabled={loading || busy}>Reload</button></div>}
    {loading && <p className="muted" role="status">Loading church data…</p>}

    {route === 'serve' && !loading && !error && !teams.length && <SetUpThis icon="users" title="No serving teams listed yet."
      text={church.name + ' has not listed its serving teams yet. Ask Tekton or the church office how to get involved.'}
      staffText="Add your teams, what they do and who leads them, and people can find a place to serve here." />}
    {route === 'serve' && teams.length > 0 && <>
      <div className="stats">
        {[['Filled shift positions', teams.reduce((sum, t) => sum + t.filled, 0), 'Across the listed shifts', 'users'],
          ['Open spots', teams.reduce((sum, t) => sum + t.total - t.filled, 0), `Across ${teams.length} ministry teams`, 'plus'],
          ['Teams needing help', teams.filter(urgent).length, '35% or more roles unfilled', 'clock']].map(([label, value, caption, icon]) =>
          <article className="card stat" key={label}><div>{label}<Icon name={icon} size={18} /></div><strong>{value}</strong><small>{caption}</small></article>)}
      </div>
      <div className="toolbar">
        <div className="filters">
          <button className={!filter ? 'selected' : ''} onClick={() => setFilter(false)}>All ministries</button>
          <button className={filter ? 'selected' : ''} onClick={() => setFilter(true)}>Needs extra help</button>
        </div>
        <label className="search"><Icon name="search" size={18} /><input aria-label="Search ministries" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search ministries" /></label>
      </div>
      <div className="grid">
        {visible.map(m => <article className="card team" key={m.id}>
          <div className="card-top"><span className={'icon color' + m.id}>{m.icon}</span><span className={'badge' + (urgent(m) ? ' urgent' : '')}>{urgent(m) ? 'Needs extra help' : 'Welcoming volunteers'}</span></div>
          <div className="category">{m.category}</div>
          <h3>{m.name}</h3>
          <p>{m.description}</p>
          <div className="coverage"><span><b>{m.total - m.filled}</b> open spots</span><span>{m.filled} / {m.total} filled</span></div>
          <div className="progress" role="meter" aria-label={m.name + ' volunteer coverage'} aria-valuenow={m.filled} aria-valuemin={0} aria-valuemax={m.total}><span style={{ width: (m.total ? m.filled / m.total * 100 : 0) + '%' }} /></div>
          <Shifts ministry={m} />
          <div className="card-bottom"><span><Icon name="clock" size={16} />{m.day}</span><button className="link" onClick={() => setDetail(m)}>View team<Icon name="arrow" size={16} /></button></div>
        </article>)}
      </div>
      {!loading && !error && !visible.length && <div className="empty">No ministries match. Try another search or clear the filter.</div>}
      <div id="team-detail">{detail && <section className="card team-detail" aria-live="polite">
        <button className="close" aria-label="Close team details" onClick={() => setDetail(null)}><Icon name="x" /></button>
        <div className="eyebrow">Meet the team</div>
        <h2>{detail.name}</h2>
        <p>{detail.description}</p>
        <p><b>{detail.total - detail.filled} openings · {detail.day}</b></p>
        <Shifts ministry={detail} />
        <p>{detail.note}</p>
        {/* The contact, with Explore a match beside it on the right (below it on phones). */}
        <div className="team-contact">
          <div>
            <div className="team-contact-label">Contact us here:</div>
            <Contact m={detail} />
          </div>
          <button className="secondary" onClick={exploreMatch}>Explore a match<Icon name="arrow" size={18} /></button>
        </div>
      </section>}</div>
    </>}

    {route === 'serve/find' && <div className="matching">
      <form className="card match-form" onSubmit={match} aria-busy={matching}>
        <div className="form-title"><span className="icon color1"><Icon name="compass" size={22} /></span><div><h2>Let’s get connected.</h2><p>Start a conversation with someone who can help you find your place.</p></div></div>
        <p id="connection-help" className="form-note">All questions are optional. Share as much or as little as you like, or skip straight to the teams. You can work out the details with a person.</p>
        <label className="field">What do you enjoy, and how would you like to get involved?
          <textarea value={description} onChange={e => setDescription(e.target.value)} maxLength={1000} rows={3} disabled={matching} aria-describedby="connection-help" placeholder="Tell us a little about your interests, experience, or what you’re curious to try." /></label>
        <label className="field">What might serving look like in your life?
          <textarea value={availabilityNote} onChange={e => setAvailabilityNote(e.target.value)} maxLength={1000} rows={3} disabled={matching} aria-describedby="connection-help" placeholder="Maybe an occasional Sunday, something during the week, or you’re still figuring it out. No exact schedule needed." /></label>
        <label className="field">Anything else you’d like the team to know?
          <textarea value={connectionNote} onChange={e => setConnectionNote(e.target.value)} maxLength={1000} rows={3} disabled={matching} aria-describedby="connection-help" placeholder="Share a question, what you’re hoping for, or anything that would help start the conversation." /></label>
        <button className="primary wide" disabled={loading || matching || !teams.length}>{matching ? 'Finding teams to talk to…' : <>Explore teams to connect with<Icon name="arrow" size={18} /></>}</button>
        <p className="disclaimer">Your answers help suggest teams. Nothing is sent automatically; you choose who to contact.</p>
        {matchError && <p className="match-error" role="alert">{matchError}</p>}
      </form>
      <section aria-live="polite" aria-busy={matching}>
        {matching ? <div className="placeholder" role="status">
          <Icon name="sparkle" size={48} />
          <h2>Finding where you could belong…</h2>
          <p>We’re considering your answers and the ministries with open opportunities.</p>
        </div> : !results ? <div className="placeholder">
          <Icon name="sparkle" size={48} />
          <div className="eyebrow">Everyone has something to give</div>
          <h2>Let’s find your place.</h2>
          <p>Your recommended ministries, reasons for each match, and team contacts will appear here.</p>
          <ol className="placeholder-steps"><li>Share a little</li><li>Explore the fit</li><li>Talk with a person</li></ol>
        </div> : <>
          <div className="results-heading">
            <div className="eyebrow">{results.engine === 'browse' ? 'Meet the teams' : results.matches.length ? 'Teams to explore' : 'Your next step'}</div>
            <h2>{results.matches.length ? 'People to start a conversation with.' : 'Let’s explore the possibilities.'}</h2>
            <p>{results.summary}</p>
          </div>
          {results.matches.map((m, i) => <article className="card recommendation" key={m.id}>
            <div className="card-top"><span className={'icon color' + m.id}>{m.icon}</span><span className="badge">{results.engine === 'browse' ? 'Meet the team' : i === 0 ? 'Top recommendation' : 'Recommendation ' + (i + 1)}</span></div>
            <h3>{m.name}</h3>
            <p>{m.description}</p>
            <div className="reason"><b>{results.engine === 'browse' ? 'Start a conversation' : 'Why it could fit you'}</b><p>{m.reason}</p></div>
            <p className="match-schedule">{m.day} · {m.total - m.filled} open spots</p>
            <div className="match-considerations"><b>Talk it through with the team</b><p>{m.considerations}</p></div>
            <div className="contact-row"><Contact m={m} /></div>
            <small className="requirement">{m.note}</small>
          </article>)}
        </>}
      </section>
    </div>}

    {route === 'serve/saved' && !staffView && <StaffOnly what="Saved connections and chat requests" />}
    {route === 'serve/saved' && staffView && <section>
      {saved.length ? saved.map(m => <article className="card saved" key={m.id + '-' + m.member}>
        <span className={'icon color' + m.id}>{m.icon}</span>
        <div><h3>{m.member} → {m.name}</h3><Contact m={m} /><small>Introduction not yet sent</small></div>
        <button className="secondary" disabled={busy} onClick={() => remove(m.connection_id)}>Remove</button>
      </article>) : !loading && <div className="card empty">
        <h2>Every connection starts somewhere.</h2>
        <p>Approved connection requests from the website chat show up here.</p>
        <button className="primary" onClick={() => go('serve/find')}>Find a place to serve<Icon name="arrow" size={18} /></button>
      </div>}
      <Requests requests={requests} busy={busy} review={review} removeRequest={removeRequest} />
    </section>}
  </div>;
}

function Shifts({ ministry }) {
  const { demo } = useChurch();
  if (!ministry.shifts?.length) return <p className="shift-empty">Contact the team for upcoming shifts.</p>;
  const time = value => {
    const [hours, minutes] = value.split(':').map(Number);
    return `${hours % 12 || 12}:${String(minutes).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`;
  };
  return <div className="shifts"><h4>Scheduled shifts</h4><small>{demo ? 'Sample schedule · ' : ''}Local church time</small><ul>{ministry.shifts.map(shift => <li key={shift.id}>
    <strong>{new Date(`${shift.date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</strong>
    <span>{time(shift.start_time)}–{time(shift.end_time)}</span>
    <span className="shift-capacity">{shift.filled} of {shift.total} positions filled{shift.filled >= shift.total ? ' · Full' : ''}</span>
  </li>)}</ul></div>;
}

function Contact({ m }) {
  const { demo } = useChurch();
  if (!m.head && !m.email) return null;
  return <div className="contact"><strong>{m.head}</strong><small>{demo ? 'Ministry lead · Sample contact' : 'Team leader'}</small>{m.email && <a href={'mailto:' + m.email}><Icon name="mail" size={16} />{m.email}</a>}</div>;
}

const requestLabels = { connection: 'Connection', pastoral_care: 'Pastoral care', prayer: 'Prayer', crisis: 'Crisis', other: 'Question' };

function Requests({ requests, busy, review, removeRequest }) {
  if (!requests.length) return null;
  return <div className="requests">
    <div className="eyebrow">From the website chat</div>
    <h2>Requests waiting on a person</h2>
    <p>Requests are saved here for review. Approval saves a connection; staff must contact the person separately. No notifications are sent automatically.</p>
    {requests.map(r => <article className="card request" key={r.request_id}>
      <div>
        <span className={'tag' + (r.kind === 'crisis' ? ' crisis' : '')}>{requestLabels[r.kind] ?? r.kind}</span>
        {r.status !== 'pending' && <span className="tag done">{r.status}</span>}
        <h3>{r.name}{r.ministry_name ? ' → ' + r.ministry_name : ''}</h3>
        {r.details && <p>{r.details}</p>}
        <small>{r.contact || 'No contact shared'} · {new Date(r.created_at).toLocaleString()}</small>
      </div>
      {r.status === 'pending' && <div className="actions">
        <button className="secondary" disabled={busy} onClick={() => review(r.request_id, 'declined')}>{r.kind === 'connection' ? 'Decline' : 'Dismiss'}</button>
        <button className="primary" disabled={busy} onClick={() => review(r.request_id, 'approved')}>{r.kind === 'connection' ? 'Approve' : 'Mark handled'}</button>
      </div>}
      {r.status !== 'pending' && <div className="actions">
        <button className="secondary" disabled={busy} onClick={() => removeRequest(r.request_id)}>Remove</button>
      </div>}
    </article>)}
  </div>;
}
