import { useEffect, useState } from 'react';
import { api } from './api.js';
import Icon from './Icon.jsx';
import { PageHeader, SubNav } from './Layout.jsx';

const gifts = ['Hospitality', 'Teaching', 'Technology', 'Creativity', 'Music', 'Organization', 'Listening', 'Encouragement'];
const urgent = m => (m.total - m.filled) / m.total >= .35;
const TABS = [['serve', 'Ministries', 'grid'], ['serve/find', 'Find a place', 'compass'], ['serve/saved', 'Saved', 'bookmark']];
const HEADERS = {
  'serve': ['Many teams. One purpose.', 'See where help is needed and meet the people who lead each team.'],
  'serve/find': ['Good gifts. The right place.', 'Start a conversation, discover their gifts, and find a meaningful next step.'],
  'serve/saved': ['Keep the connection going.', 'A shortlist for your next conversation, plus requests from the website chat.'],
};

export default function Serve({ route, go, requestsVersion, onCount }) {
  const [query, setQuery] = useState(''),
    [filter, setFilter] = useState(false),
    [detail, setDetail] = useState(null),
    [name, setName] = useState(''),
    [skills, setSkills] = useState(['Hospitality', 'Encouragement']),
    [style, setStyle] = useState('Working with people'),
    [day, setDay] = useState('Sunday mornings'),
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
      const [ministries, connections, filed] = await Promise.all([api('/ministries'), api('/connections'), api('/requests')]);
      setTeams(ministries); setSaved(connections); setRequests(filed);
    } catch (err) { setError('Could not load church data. ' + err.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);
  // The chat widget filed a request; refresh the staff queue.
  useEffect(() => { if (requestsVersion) api('/requests').then(setRequests).catch(() => {}); }, [requestsVersion]);
  const pending = requests.filter(r => r.status === 'pending');
  useEffect(() => { onCount(saved.length + pending.length); }, [saved.length, pending.length]);
  useEffect(() => {
    if (detail) document.getElementById('team-detail')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [detail]);

  async function save(m) {
    setBusy(true); setError('');
    try {
      const connection = await api('/connections', { method: 'POST', body: JSON.stringify({ ministry_id: m.id, member: results.name }) });
      setSaved(previous => [...previous.filter(s => s.connection_id !== connection.connection_id), connection]);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  async function remove(connectionId) {
    setBusy(true); setError('');
    try {
      await api('/connections/' + connectionId, { method: 'DELETE' });
      setSaved(previous => previous.filter(s => s.connection_id !== connectionId));
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
    e.preventDefault(); setBusy(true); setError(''); setResults(null);
    try { setResults(await api('/matches', { method: 'POST', body: JSON.stringify({ name, skills, style, day }) })); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  function exploreMatch(team) {
    setSkills(team.skills); setDay(team.day); setStyle(team.style); setResults(null); setDetail(null);
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

    {route === 'serve' && <>
      <div className="stats">
        {[['Active volunteers', teams.reduce((sum, t) => sum + t.filled, 0), 'People making a difference', 'users'],
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
          <div className="progress" role="meter" aria-label={m.name + ' volunteer coverage'} aria-valuenow={m.filled} aria-valuemin={0} aria-valuemax={m.total}><span style={{ width: m.filled / m.total * 100 + '%' }} /></div>
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
        <p>{detail.note}</p>
        <Contact m={detail} />
        <button className="primary" onClick={() => exploreMatch(detail)}>Explore a match<Icon name="arrow" size={18} /></button>
      </section>}</div>
    </>}

    {route === 'serve/find' && <div className="matching">
      <form className="card match-form" onSubmit={match}>
        <div className="form-title"><span className="icon color1"><Icon name="compass" size={22} /></span><div><h2>Meet the member</h2><p>A few details can open the right door.</p></div></div>
        <label className="field">Member’s name <small>Optional</small><input value={name} maxLength={100} onChange={e => setName(e.target.value)} placeholder="e.g. Jamie Parker" /></label>
        <fieldset>
          <legend>What are their gifts and skills?</legend>
          <p>Choose all that feel like a good fit.</p>
          <div className="chips">{gifts.map(s => <button type="button" key={s} aria-pressed={skills.includes(s)} className={skills.includes(s) ? 'chosen' : ''}
            onClick={() => setSkills(skills.includes(s) ? skills.filter(v => v !== s) : [...skills, s])}><Icon name={skills.includes(s) ? 'check' : 'plus'} size={16} />{s}</button>)}</div>
        </fieldset>
        <label className="field">How would they like to serve?<select value={style} onChange={e => setStyle(e.target.value)}>{['Working with people', 'Behind the scenes', 'Hands-on service'].map(v => <option key={v}>{v}</option>)}</select></label>
        <label className="field">When are they available?<select value={day} onChange={e => setDay(e.target.value)}>{['Sunday mornings', 'Saturday mornings', 'Weekday evenings'].map(v => <option key={v}>{v}</option>)}</select></label>
        <button className="primary wide" disabled={loading || busy || !teams.length}>{busy ? 'Working…' : <>Discover opportunities<Icon name="arrow" size={18} /></>}</button>
      </form>
      <section aria-live="polite">
        {!results ? <div className="placeholder">
          <Icon name="sparkle" size={48} />
          <div className="eyebrow">Everyone has something to give</div>
          <h2>Let’s find their place.</h2>
          <p>Tell us a little about the member. Suggested ministries and team contacts will appear here.</p>
          <ol className="placeholder-steps"><li>Get to know them</li><li>Explore the fit</li><li>Make an introduction</li></ol>
        </div> : <>
          <div className="results-heading"><div className="eyebrow">Suggested ministries</div><h2>A few places for {results.name}</h2><p>Conversation starters, not commitments. Confirm availability with each team.</p></div>
          {results.matches.map((m, i) => {
            const exists = saved.some(s => s.id === m.id && s.member === results.name);
            return <article className="card recommendation" key={m.id}>
              <div className="card-top"><span className={'icon color' + m.id}>{m.icon}</span><span className="badge">{i === 0 ? 'Top suggestion' : 'Suggestion ' + (i + 1)}</span></div>
              <h3>{m.name}</h3>
              <p>{m.description}</p>
              <div className="reason"><b>Why it could fit</b><p>{m.overlap.length ? 'Connects with gifts in ' + m.overlap.join(', ').toLowerCase() + '.' : 'An opportunity to explore a new area of service.'} {m.style === results.style ? 'Matches their preferred serving style.' : 'Serving style: ' + m.style.toLowerCase() + '.'} {m.day === results.day ? 'Fits their availability.' : 'Schedule differs: ' + m.day.toLowerCase() + '.'} {m.total - m.filled} open spots.</p></div>
              <div className="contact-row"><Contact m={m} /><button className="secondary" disabled={exists || busy} onClick={() => save(m)}>{exists ? <><Icon name="check" size={16} />Saved</> : 'Save connection'}</button></div>
              <small className="requirement">{m.note}</small>
            </article>;
          })}
        </>}
      </section>
    </div>}

    {route === 'serve/saved' && <section>
      {saved.length ? saved.map(m => <article className="card saved" key={m.id + '-' + m.member}>
        <span className={'icon color' + m.id}>{m.icon}</span>
        <div><h3>{m.member} → {m.name}</h3><Contact m={m} /><small>Introduction not yet sent</small></div>
        <button className="secondary" disabled={busy} onClick={() => remove(m.connection_id)}>Remove</button>
      </article>) : !loading && <div className="card empty">
        <h2>Every connection starts somewhere.</h2>
        <p>Find opportunities for a member, then save a team to follow up with.</p>
        <button className="primary" onClick={() => go('serve/find')}>Find a place to serve<Icon name="arrow" size={18} /></button>
      </div>}
      <Requests requests={requests} busy={busy} review={review} />
    </section>}
  </div>;
}

function Contact({ m }) {
  return <div className="contact"><strong>{m.head}</strong><small>Ministry lead · Sample contact</small><a href={'mailto:' + m.email}><Icon name="mail" size={16} />{m.email}</a></div>;
}

const requestLabels = { connection: 'Connection', pastoral_care: 'Pastoral care', prayer: 'Prayer', crisis: 'Crisis', other: 'Question' };

function Requests({ requests, busy, review }) {
  if (!requests.length) return null;
  return <div className="requests">
    <div className="eyebrow">From the website chat</div>
    <h2>Requests waiting on a person</h2>
    <p>The assistant files these. Nothing is sent to anyone until staff approve.</p>
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
    </article>)}
  </div>;
}
