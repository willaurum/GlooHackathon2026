import { useEffect, useState } from 'react';
import { api } from './api.js';
import PrayerMap from './PrayerMap.jsx';
const gifts = ['Hospitality', 'Teaching', 'Technology', 'Creativity', 'Music', 'Organization', 'Listening', 'Encouragement'];
const urgent = m => (m.total - m.filled) / m.total >= .35;
const vision = 'Belong helps large churches turn a desire to serve into a meaningful connection. Leaders can monitor volunteer needs, explore each department’s responsibilities, and find the people leading those teams. During a conversation with a member, a leader enters their skills, interests, and preferred ways to serve. The planned Gloo AI backend will compare those details with current ministry needs and recommend departments, with department heads’ contact information for the next step. The goal: help more people move from attending church to actively belonging.';
export default function App() {
  const [page, setPage] = useState('Overview'),
    [query, setQuery] = useState(''),
    [filter, setFilter] = useState(false),
    [detail, setDetail] = useState(null),
    [name, setName] = useState(''),
    [skills, setSkills] = useState(['Hospitality', 'Encouragement']),
    [style, setStyle] = useState('Working with people'),
    [day, setDay] = useState('Sunday mornings'),
    [results, setResults] = useState(null),
    [saved, setSaved] = useState([]),
    [teams, setTeams] = useState([]),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function load() {
    setLoading(true); setError('');
    try {
      const [ministries, connections] = await Promise.all([api('/ministries'), api('/connections')]);
      setTeams(ministries); setSaved(connections);
    } catch (err) { setError('Could not load church data. Check that the backend is running. ' + err.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);
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
    e.preventDefault(); setBusy(true); setError(''); setResults(null);
    try { setResults(await api('/matches', { method: 'POST', body: JSON.stringify({ name, skills, style, day }) })); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  const visible = teams.filter(m => (m.name + ' ' + m.description).toLowerCase().includes(query.toLowerCase()) && (!filter || urgent(m)));
  const titles = {
    'Overview': 'A place for everyone.',
    'Ministries': 'Many teams. One purpose.',
    'Find a place': 'Good gifts. The right place.',
    'Saved connections': 'Keep the connection going.',
    'Prayer map': 'Sharp facts. Soft people.',
    'Our vision': 'From attending to belonging.'
  };
  return <div className="shell"><aside><a className="brand" href="#" onClick={e => {
        e.preventDefault();
        go('Overview');
      }}><b>b</b>belong<span>.</span></a><div className="church"><span>G</span><div><strong>Grace Community</strong><small>Church workspace</small></div><i>⌄</i></div><div className="eyebrow nav-label">WORKSPACE</div><nav>{[['Overview', '▦'], ['Ministries', '◈'], ['Find a place', '✧'], ['Saved connections', '♡'], ['Prayer map', '☾'], ['Our vision', '☼']].map(([p, icon]) => <button className={page === p ? 'active' : ''} key={p} onClick={() => go(p)}><span>{icon}</span>{p}{p === 'Saved connections' && saved.length > 0 && <b>{saved.length}</b>}</button>)}</nav><div className="sidebar-bottom"><div className="ai-note"><span>✧</span><strong>People first. AI assisted.</strong><p>Meaningful connections, with Gloo AI at the heart of the vision.</p><div className="eyebrow">INTERACTIVE MOCKUP</div></div><div className="profile"><span className="avatar">AL</span><div><strong>Alex Lewis</strong><small>Church leadership · Demo</small></div></div></div></aside><div className="workspace"><header><div>Workspace <span>/</span><strong>{page}</strong></div><div className="header-right"><span className="demo">● Demo workspace</span><span className="avatar">AL</span></div></header><main>{error && <div className="api-message" role="alert">{error} <button onClick={load} disabled={loading || busy}>Reload data</button></div>}{loading && <p role="status">Loading church data…</p>}<div className="heading"><div><div className="eyebrow">GRACE COMMUNITY CHURCH</div><h1>{titles[page]}</h1><p>{page === 'Overview' ? 'See where help is needed. Connect people with a purpose.' : page === 'Find a place' ? 'Start a conversation, discover their gifts, and find a meaningful next step.' : page === 'Saved connections' ? 'A shortlist for your next conversation. Saved in your church workspace.' : page === 'Prayer map' ? 'Real news gets a real pin. People in sensitive places never do.' : 'Help a growing church grow closer, one connection at a time.'}</p></div>{page !== 'Find a place' && page !== 'Prayer map' && <button className="primary" onClick={() => go('Find a place')}>✧ &nbsp; Find a place to serve &nbsp; ↗</button>}</div>
 {page === 'Overview' && <><section className="hero"><div><div className="eyebrow">LESS SEARCHING. MORE BELONGING.</div><h2>The next right step<br />starts with a person.</h2><p>Everyone brings something unique. Help them discover where their gifts meet your church’s needs.</p><button onClick={() => go('Find a place')}>Make a connection &nbsp; ↗</button></div><div className="art" aria-hidden="true"><div className="orbit" /><div className="orbit outer" /><span className="flower">✳</span><span className="art-tag one">♡ A heart to serve</span><span className="art-tag two">✦ A place to belong</span></div></section><div className="stats">{[['Active volunteers', teams.reduce((sum, team) => sum + team.filled, 0), 'People making a difference', '♧'], ['Open opportunities', teams.reduce((sum, team) => sum + team.total - team.filled, 0), `Across ${teams.length} ministry teams`, '↗'], ['Teams needing extra help', teams.filter(urgent).length, '35% or more roles unfilled', '◷'], ['One shared mission', 'Belonging', 'More than filling a schedule', '♡']].map(([label, value, caption, icon]) => <article key={label}><div>{label}<span>{icon}</span></div><strong>{value}</strong><small>{caption}</small></article>)}</div></>}
 {(page === 'Overview' || page === 'Ministries') && <section><div className="section-heading"><h2>Where you can make a difference <small>{teams.length} ministries</small></h2><p>A little of your time can make a lasting impact.</p></div><div className="toolbar"><div className="filters"><button className={!filter ? 'selected' : ''} onClick={() => setFilter(false)}>All ministries</button><button className={filter ? 'selected' : ''} onClick={() => setFilter(true)}>∙ Needs extra help</button></div><label className="search">⌕ <input aria-label="Search ministries" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search ministries..." /></label></div><div className="grid">{visible.map(m => <article className="team" key={m.id}><div className="card-top"><span className={'icon color' + m.id}>{m.icon}</span><span className={'badge ' + (urgent(m) ? 'urgent' : '')}>{urgent(m) ? '● Needs extra help' : 'Welcoming volunteers'}</span></div><div className="category">{m.category}</div><h3>{m.name}</h3><p>{m.description}</p><div className="coverage"><span><b>{m.total - m.filled}</b> open spots</span><span>{m.filled} / {m.total} filled</span></div><div className="progress" role="meter" aria-label={m.name + ' volunteer coverage'} aria-valuenow={m.filled} aria-valuemin={0} aria-valuemax={m.total}><span style={{
                  width: m.filled / m.total * 100 + '%'
                }} /></div><div className="card-bottom"><span>◷ {m.day}</span><button onClick={() => {
                  setDetail(m);
                }}>View team ↗</button></div></article>)}</div>{!loading && !error && !visible.length && <div className="empty">No ministries match. Try another search or clear the filter.</div>}<div id="team-detail">{detail && <section className="panel team-detail" aria-live="polite"><button className="close" aria-label="Close team details" onClick={() => setDetail(null)}>×</button><div className="eyebrow">MEET THE TEAM</div><h2>{detail.name}</h2><p>{detail.description}</p><p><b>{detail.total - detail.filled} openings · {detail.day}</b></p><p>{detail.note}</p><Contact m={detail} /><button className="primary" onClick={() => {
                setSkills(detail.skills);
                setDay(detail.day);
                setStyle(detail.style);
                setResults(null);
                go('Find a place');
              }}>Explore a match →</button></section>}</div></section>}
 {page === 'Find a place' && <div className="matching"><form className="panel match-form" onSubmit={match}><div className="form-title"><span className="icon color1">✧</span><div><h2>Meet the member</h2><p>A few details can open the right door.</p></div></div><label className="field">Member’s name <small>Optional</small><input value={name} maxLength={100} onChange={e => setName(e.target.value)} placeholder="e.g. Jamie Parker" /></label><fieldset><legend>What are their gifts & skills?</legend><p>Choose all that feel like a good fit.</p><div className="chips">{gifts.map(s => <button type="button" key={s} aria-pressed={skills.includes(s)} className={skills.includes(s) ? 'chosen' : ''} onClick={() => setSkills(skills.includes(s) ? skills.filter(v => v !== s) : [...skills, s])}>{skills.includes(s) ? '✓' : '+'} {s}</button>)}</div></fieldset><label className="field">How would they like to serve?<select value={style} onChange={e => setStyle(e.target.value)}>{['Working with people', 'Behind the scenes', 'Hands-on service'].map(v => <option key={v}>{v}</option>)}</select></label><label className="field">When are they available?<select value={day} onChange={e => setDay(e.target.value)}>{['Sunday mornings', 'Saturday mornings', 'Weekday evenings'].map(v => <option key={v}>{v}</option>)}</select></label><button className="primary wide" disabled={loading || busy || !teams.length}>{busy ? "Working…" : "✧ Discover opportunities →"}</button><p className="disclaimer">The backend currently uses simple rules for matching. Gloo AI integration is the next step.</p></form><section aria-live="polite">{!results ? <div className="placeholder"><span>✳</span><div className="eyebrow">EVERYONE HAS SOMETHING TO GIVE</div><h2>Let’s find their place.</h2><p>Tell us a little about the member. Suggested ministries and team contacts will appear here.</p><small>01 Get to know them<br /><br />02 Explore the fit<br /><br />03 Make an introduction</small></div> : <><div className="results-heading"><div className="eyebrow">RULE-BASED RECOMMENDATIONS</div><h2>A few places for {results.name}</h2><p>Conversation starters, not commitments. Confirm availability with each team.</p></div>{results.matches.map((m, i) => {
                const exists = saved.some(s => s.id === m.id && s.member === results.name);
                return <article className="panel recommendation" key={m.id}><div className="card-top"><span className={'icon color' + m.id}>{m.icon}</span><span className="badge">{i === 0 ? 'Top suggestion' : 'Suggestion ' + (i + 1)}</span></div><h3>{m.name}</h3><p>{m.description}</p><div className="reason"><b>Why it could fit</b><p>{m.overlap.length ? 'Connects with gifts in ' + m.overlap.join(', ').toLowerCase() + '.' : 'An opportunity to explore a new area of service.'} {m.style === results.style ? 'Matches their preferred serving style.' : 'Serving style: ' + m.style.toLowerCase() + '.'} {m.day === results.day ? 'Fits their availability.' : 'Schedule differs: ' + m.day.toLowerCase() + '.'} {m.total - m.filled} open spots.</p></div><div className="contact-row"><Contact m={m} /><button className="secondary" disabled={exists || busy} onClick={() => save(m)}>{exists ? '✓ Saved' : 'Save connection'}</button></div><small className="requirement">{m.note}</small></article>;
              })}</>}</section></div>}
 {page === 'Prayer map' && <PrayerMap />}
 {page === 'Saved connections' && <section>{saved.length ? saved.map((m) => <article className="panel saved" key={m.id + '-' + m.member}><span className={'icon color' + m.id}>{m.icon}</span><div><h3>{m.member} → {m.name}</h3><Contact m={m} /><small>Introduction not yet sent</small></div><button className="secondary" disabled={busy} onClick={() => remove(m.connection_id)}>Remove</button></article>) : <div className="panel empty"><h2>Every connection starts somewhere.</h2><p>Find opportunities for a member, then save a team to follow up with.</p><button className="primary" onClick={() => go('Find a place')}>Find a place to serve →</button></div>}</section>}
 {(page === 'Overview' || page === 'Our vision') && <section className={'vision ' + (page === 'Our vision' ? 'expanded' : '')}><span>✧</span><div><div className="eyebrow">THE IDEA BEHIND BELONG</div><h2>A big church can still feel personal.</h2><p>{vision}</p>{page === 'Our vision' && <div className="steps">{[['01 / See the need', 'A shared view of volunteer coverage and responsibilities.'], ['02 / Know the person', 'Start with their gifts, interests, and time.'], ['03 / Connect with care', 'Gloo AI suggests possibilities. People lead the relationship.']].map(([title, text]) => <div key={title}><b>{title}</b><p>{text}</p></div>)}</div>}</div>{page === 'Overview' && <button onClick={() => go('Our vision')}>Our vision ↗</button>}</section>}
 <footer><b>belong.</b><span>Helping people find their people.</span><span>Prototype · All church data, contacts, regions, and testimonies are fictional</span></footer></main></div></div>;
}
function Contact({
  m
}) {
  return <div className="contact"><strong>{m.head}</strong><small>Ministry lead · Sample contact</small><a href={'mailto:' + m.email}>{m.email}</a></div>;
}
