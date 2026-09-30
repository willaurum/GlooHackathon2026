import { useEffect, useState } from 'react';
import ChatWidget from './ChatWidget.jsx';
async function api(path, options = {}) {
  const response = await fetch('/api' + path, { ...options, headers: { 'Content-Type': 'application/json' } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(typeof body.detail === 'string' ? body.detail : `Request failed (${response.status}). Please try again.`);
  }
  return response.status === 204 ? null : response.json();
}
const urgent = m => (m.total - m.filled) / m.total >= .35;
const vision = 'Belong helps large churches turn a desire to serve into a meaningful connection. Leaders can monitor volunteer needs, explore each department’s responsibilities, and find the people leading those teams. Visitors can share their interests and serving preferences. The AI compares their interests, experience, and availability with current ministry needs and recommends teams, with ministry leads’ contact information for the next step. The goal: help more people move from attending church to actively belonging.';
export default function App() {
  const [page, setPage] = useState('Overview'),
    [query, setQuery] = useState(''),
    [filter, setFilter] = useState(false),
    [detail, setDetail] = useState(null),
    [description, setDescription] = useState(''),
    [preferences, setPreferences] = useState({ days_and_times: '', preferred_service: '', frequency: '', earliest_start_date: '' }),
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
      const [ministries, connections, filed] = await Promise.all([api('/ministries'), api('/connections'), api('/requests')]);
      setTeams(ministries); setSaved(connections); setRequests(filed);
    } catch (err) { setError('Could not load church data. Check that the backend is running. ' + err.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);
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
  const refreshRequests = () => api('/requests').then(setRequests).catch(() => {});
  const pending = requests.filter(r => r.status === 'pending');
  useEffect(() => {
    if (detail) document.getElementById('team-detail')?.scrollIntoView({
      behavior: 'smooth',
      block: 'center'
    });
  }, [detail]);
  const go = p => {
    setPage(p);
    setDetail(null);
    window.scrollTo({
      top: 0,
      behavior: 'smooth'
    });
  };
  async function match(e) {
    e.preventDefault();
    if (matching || !description.trim()) return;
    setMatching(true); setMatchError(''); setResults(null);
    try { setResults(await api('/matches', { method: 'POST', body: JSON.stringify({ description: description.trim(), preferences: { ...preferences, frequency: preferences.frequency || null, earliest_start_date: preferences.earliest_start_date || null } }) })); }
    catch (err) { setMatchError(err.message); }
    finally { setMatching(false); }
  }
  const visible = teams.filter(m => (m.name + ' ' + m.description).toLowerCase().includes(query.toLowerCase()) && (!filter || urgent(m)));
  const titles = {
    'Overview': 'A place for everyone.',
    'Ministries': 'Many teams. One purpose.',
    'Find a place': 'Good gifts. The right place.',
    'Saved connections': 'Keep the connection going.',
    'Our vision': 'From attending to belonging.'
  };
  return <div className="shell"><aside><a className="brand" href="#" onClick={e => {
        e.preventDefault();
        go('Overview');
      }}><b>b</b>belong<span>.</span></a><div className="church"><span>G</span><div><strong>Grace Community</strong><small>Church workspace</small></div><i>⌄</i></div><div className="eyebrow nav-label">WORKSPACE</div><nav>{[['Overview', '▦'], ['Ministries', '◈'], ['Find a place', '✧'], ['Saved connections', '♡'], ['Our vision', '☼']].map(([p, icon]) => <button className={page === p ? 'active' : ''} key={p} onClick={() => go(p)}><span>{icon}</span>{p}{p === 'Saved connections' && saved.length + pending.length > 0 && <b>{saved.length + pending.length}</b>}</button>)}</nav><div className="sidebar-bottom"><div className="ai-note"><span>✧</span><strong>People first. AI assisted.</strong><p>Meaningful connections, with Gloo AI at the heart of the vision.</p><div className="eyebrow">INTERACTIVE MOCKUP</div></div><div className="profile"><span className="avatar">AL</span><div><strong>Alex Lewis</strong><small>Church leadership · Demo</small></div></div></div></aside><div className="workspace"><header><div>Workspace <span>/</span><strong>{page}</strong></div><div className="header-right"><span className="demo">● Demo workspace</span><span className="avatar">AL</span></div></header><main>{error && <div className="api-message" role="alert">{error} <button onClick={load} disabled={loading || busy}>Reload data</button></div>}{loading && <p role="status">Loading church data…</p>}<div className="heading"><div><div className="eyebrow">GRACE COMMUNITY CHURCH</div><h1>{titles[page]}</h1><p>{page === 'Overview' ? 'See where help is needed. Connect people with a purpose.' : page === 'Find a place' ? 'Tell us about yourself and discover where you could belong.' : page === 'Saved connections' ? 'A shortlist for your next conversation. Saved in your church workspace.' : 'Help a growing church grow closer, one connection at a time.'}</p></div>{page !== 'Find a place' && <button className="primary" onClick={() => go('Find a place')}>✧ &nbsp; Find a place to serve &nbsp; ↗</button>}</div>
 {page === 'Overview' && <><section className="hero"><div><div className="eyebrow">LESS SEARCHING. MORE BELONGING.</div><h2>The next right step<br />starts with a person.</h2><p>Everyone brings something unique. Help them discover where their gifts meet your church’s needs.</p><button onClick={() => go('Find a place')}>Make a connection &nbsp; ↗</button></div><div className="art" aria-hidden="true"><div className="orbit" /><div className="orbit outer" /><span className="flower">✳</span><span className="art-tag one">♡ A heart to serve</span><span className="art-tag two">✦ A place to belong</span></div></section><div className="stats">{[['Filled shift positions', teams.reduce((sum, team) => sum + team.filled, 0), 'Across the listed shifts', '♧'], ['Open opportunities', teams.reduce((sum, team) => sum + team.total - team.filled, 0), `Across ${teams.length} ministry teams`, '↗'], ['Teams needing extra help', teams.filter(urgent).length, '35% or more roles unfilled', '◷'], ['One shared mission', 'Belonging', 'More than filling a schedule', '♡']].map(([label, value, caption, icon]) => <article key={label}><div>{label}<span>{icon}</span></div><strong>{value}</strong><small>{caption}</small></article>)}</div></>}
 {(page === 'Overview' || page === 'Ministries') && <section><div className="section-heading"><h2>Where you can make a difference <small>{teams.length} ministries</small></h2><p>A little of your time can make a lasting impact.</p></div><div className="toolbar"><div className="filters"><button className={!filter ? 'selected' : ''} onClick={() => setFilter(false)}>All ministries</button><button className={filter ? 'selected' : ''} onClick={() => setFilter(true)}>∙ Needs extra help</button></div><label className="search">⌕ <input aria-label="Search ministries" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search ministries..." /></label></div><div className="grid">{visible.map(m => <article className="team" key={m.id}><div className="card-top"><span className={'icon color' + m.id}>{m.icon}</span><span className={'badge ' + (urgent(m) ? 'urgent' : '')}>{urgent(m) ? '● Needs extra help' : 'Welcoming volunteers'}</span></div><div className="category">{m.category}</div><h3>{m.name}</h3><p>{m.description}</p><div className="coverage"><span><b>{m.total - m.filled}</b> open spots</span><span>{m.filled} / {m.total} filled</span></div><div className="progress" role="meter" aria-label={m.name + ' volunteer coverage'} aria-valuenow={m.filled} aria-valuemin={0} aria-valuemax={m.total}><span style={{
                  width: m.filled / m.total * 100 + '%'
                }} /></div><Shifts ministry={m} /><div className="card-bottom"><span>◷ {m.day}</span><button onClick={() => {
                  setDetail(m);
                }}>View team ↗</button></div></article>)}</div>{!loading && !error && !visible.length && <div className="empty">No ministries match. Try another search or clear the filter.</div>}<div id="team-detail">{detail && <section className="panel team-detail" aria-live="polite"><button className="close" aria-label="Close team details" onClick={() => setDetail(null)}>×</button><div className="eyebrow">MEET THE TEAM</div><h2>{detail.name}</h2><p>{detail.description}</p><p><b>{detail.total - detail.filled} openings · {detail.day}</b></p><Shifts ministry={detail} /><p>{detail.note}</p><Contact m={detail} /><button className="primary" onClick={() => {
                setResults(null);
                go('Find a place');
              }}>Explore a match →</button></section>}</div></section>}
 {page === 'Find a place' && <div className="matching">
   <form className="panel match-form" onSubmit={match} aria-busy={matching}>
     <div className="form-title"><span className="icon color1">✧</span><div><h2>Your story. Your place.</h2><p>A little about you can open the right door.</p></div></div>
     <label className="field" htmlFor="member-story">What do you enjoy, and how would you like to help?</label>
     <p id="story-help" className="story-help">A sentence or two about your interests or experience is enough.</p>
     <textarea id="member-story" className="story-input short-answer" value={description} onChange={e => setDescription(e.target.value)} maxLength={1000} rows={3} required disabled={matching} aria-describedby="story-help" placeholder="I enjoy welcoming people and organizing events. I’d love to help families feel at home." />
     <fieldset className="serving-preferences" disabled={matching}>
       <legend>When would you like to serve?</legend>
       <p className="story-help">These details are optional. Use local church time; leave anything you’re unsure about blank.</p>
       <label className="field" htmlFor="days-and-times">Days and time windows</label>
       <textarea id="days-and-times" className="story-input short-answer" rows={2} maxLength={500} value={preferences.days_and_times} onChange={e => setPreferences(p => ({ ...p, days_and_times: e.target.value }))} placeholder="Sundays 8 AM–noon, or Tuesdays after 6 PM" />
       <label className="field" htmlFor="preferred-service">Which service would you prefer to serve at?</label>
       <input id="preferred-service" maxLength={200} value={preferences.preferred_service} onChange={e => setPreferences(p => ({ ...p, preferred_service: e.target.value }))} placeholder="Sunday 9 AM, any service, or outside services" />
       <div className="preference-row">
         <div><label className="field" htmlFor="serving-frequency">How often?</label>
           <select id="serving-frequency" value={preferences.frequency} onChange={e => setPreferences(p => ({ ...p, frequency: e.target.value }))}>
             <option value="">Not sure yet</option><option value="one-time">One-time</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option>
           </select>
         </div>
         <div><label className="field" htmlFor="earliest-start">Earliest start date</label>
           <input id="earliest-start" type="date" value={preferences.earliest_start_date} onChange={e => setPreferences(p => ({ ...p, earliest_start_date: e.target.value }))} />
         </div>
       </div>
     </fieldset>
     <button type="submit" className="primary wide" disabled={matching || !description.trim()}>{matching ? 'Finding your place…' : '✧ Find my ministries →'}</button>
     <p className="disclaimer">AI considers your answers alongside current ministry opportunities. You decide who to contact.</p>
     {matchError && <p className="match-error" role="alert">{matchError}</p>}
   </form>
   <section aria-live="polite" aria-busy={matching}>
     {matching ? <div className="placeholder" role="status"><span>✧</span><h2>Finding where you could belong…</h2><p>We’re considering your answers and the ministries with open opportunities.</p></div>
       : !results ? <div className="placeholder"><span>✳</span><div className="eyebrow">EVERYONE HAS SOMETHING TO GIVE</div><h2>Let’s find your place.</h2><p>Your recommended ministries, reasons for each match, and team contacts will appear here.</p></div>
       : <><div className="results-heading"><div className="eyebrow">{results.matches.length ? 'RECOMMENDED FOR YOU' : 'YOUR NEXT STEP'}</div><h2>{results.matches.length ? 'Places you could belong.' : 'Let’s explore the possibilities.'}</h2><p>{results.summary}</p></div>
         {results.matches.map((m, i) => <article className="panel recommendation" key={m.id}>
           <div className="card-top"><span className={'icon color' + m.id}>{m.icon}</span><span className="badge">{i === 0 ? 'Top recommendation' : 'Recommendation ' + (i + 1)}</span></div>
           <h3>{m.name}</h3><p>{m.description}</p>
           <div className="reason"><b>Why it could fit you</b><p>{m.reason}</p></div>
           <p className="match-schedule">{m.day} · {m.total - m.filled} open spots</p>
           <Shifts ministry={m} /><div className="match-considerations"><b>Before you get started</b><p>{m.considerations}</p></div>
           <div className="contact-row"><Contact m={m} /></div><small className="requirement">{m.note}</small>
         </article>)}
       </>}
   </section>
 </div>}
 {page === 'Saved connections' && <section>{saved.length ? saved.map((m) => <article className="panel saved" key={m.id + '-' + m.member}><span className={'icon color' + m.id}>{m.icon}</span><div><h3>{m.member} → {m.name}</h3><Contact m={m} /><small>Introduction not yet sent</small></div><button className="secondary" disabled={busy} onClick={() => remove(m.connection_id)}>Remove</button></article>) : <div className="panel empty"><h2>Every connection starts somewhere.</h2><p>Find opportunities for a member, then save a team to follow up with.</p><button className="primary" onClick={() => go('Find a place')}>Find a place to serve →</button></div>}<Requests requests={requests} busy={busy} review={review} /></section>}
 {(page === 'Overview' || page === 'Our vision') && <section className={'vision ' + (page === 'Our vision' ? 'expanded' : '')}><span>✧</span><div><div className="eyebrow">THE IDEA BEHIND BELONG</div><h2>A big church can still feel personal.</h2><p>{vision}</p>{page === 'Our vision' && <div className="steps">{[['01 / See the need', 'A shared view of volunteer coverage and responsibilities.'], ['02 / Know the person', 'Start with their gifts, interests, and time.'], ['03 / Connect with care', 'Gloo AI suggests possibilities. People lead the relationship.']].map(([title, text]) => <div key={title}><b>{title}</b><p>{text}</p></div>)}</div>}</div>{page === 'Overview' && <button onClick={() => go('Our vision')}>Our vision ↗</button>}</section>}
 <ChatWidget onRequestFiled={refreshRequests} /><footer><b>belong.</b><span>Helping people find their people.</span><span>Prototype · All church data and contacts are fictional</span></footer></main></div></div>;
}
function Shifts({ ministry }) {
  if (!ministry.shifts?.length) return <p className="shift-empty">Contact the team for upcoming shifts.</p>;
  const time = value => {
    const [hours, minutes] = value.split(':').map(Number);
    return `${hours % 12 || 12}:${String(minutes).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`;
  };
  return <div className="shifts"><h4>Scheduled shifts</h4><small>Sample schedule · Local church time</small><ul>{ministry.shifts.map(shift => <li key={shift.id}>
    <strong>{new Date(`${shift.date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</strong>
    <span>{time(shift.start_time)}–{time(shift.end_time)}</span>
    <span className="shift-capacity">{shift.filled} of {shift.total} positions filled{shift.filled >= shift.total ? ' · Full' : ''}</span>
  </li>)}</ul></div>;
}
function Contact({
  m
}) {
  return <div className="contact"><strong>{m.head}</strong><small>Ministry lead · Sample contact</small><a href={'mailto:' + m.email}>{m.email}</a></div>;
}
const requestLabels = { connection: 'Connection', pastoral_care: 'Pastoral care', prayer: 'Prayer', crisis: 'Crisis', other: 'Question' };
function Requests({
  requests,
  busy,
  review
}) {
  if (!requests.length) return null;
  return <div className="requests"><div className="eyebrow">FROM THE WEBSITE CHAT</div><h2>Requests waiting on a person</h2><p>Requests are saved here for review. Approval saves a connection; staff must contact the person separately. No notifications are sent automatically.</p>{requests.map(r => <article className="panel request" key={r.request_id}><div><span className={'tag ' + (r.kind === 'crisis' ? 'crisis' : '')}>{requestLabels[r.kind] ?? r.kind}</span>{r.status !== 'pending' && <span className="tag done">{r.status}</span>}<h3>{r.name}{r.ministry_name ? ' → ' + r.ministry_name : ''}</h3>{r.details && <p>{r.details}</p>}<small>{r.contact || 'No contact shared'} · {new Date(r.created_at).toLocaleString()}</small></div>{r.status === 'pending' && <div className="actions"><button className="secondary" disabled={busy} onClick={() => review(r.request_id, 'declined')}>{r.kind === 'connection' ? 'Decline' : 'Dismiss'}</button><button className="primary" disabled={busy} onClick={() => review(r.request_id, 'approved')}>{r.kind === 'connection' ? 'Approve' : 'Mark handled'}</button></div>}</article>)}</div>;
}
