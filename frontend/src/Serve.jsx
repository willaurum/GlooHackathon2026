import { useEffect, useState } from 'react';
import { api } from './api.js';
import { useChurch } from './ChurchContext.js';
import { SetUpThis } from './ChurchStates.jsx';
import { EMAIL_HINT, PHONE_HINT, isEmail, isPhone } from './contact.js';
import ContactInput from './ContactInput.jsx';
import Icon from './Icon.jsx';
import { PageHeader, SubNav } from './Layout.jsx';

const urgent = m => m.total > 0 && (m.total - m.filled) / m.total >= .35;
const TABS = [['serve', 'Ministries', 'grid'], ['serve/find', 'Find a place', 'compass']];
const HEADERS = {
  'serve': ['Many teams. One purpose.', 'See where help is needed and meet the people who lead each team.'],
  'serve/find': ['Good gifts. The right place.', 'Tell us about yourself and discover where you could belong.'],
};

// Applications to serve are filed here and reviewed by church staff in Church staff → Volunteers.
export default function Serve({ route, go }) {
  const church = useChurch();
  const [query, setQuery] = useState(''),
    [filter, setFilter] = useState(false),
    [detail, setDetail] = useState(null),
    [applying, setApplying] = useState(false),
    [description, setDescription] = useState(''),
    [availabilityNote, setAvailabilityNote] = useState(''),
    [connectionNote, setConnectionNote] = useState(''),
    [matching, setMatching] = useState(false),
    [matchError, setMatchError] = useState(''),
    [results, setResults] = useState(null),
    [teams, setTeams] = useState([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  async function load() {
    setLoading(true); setError('');
    try { setTeams(await api('/ministries')); }
    catch (err) { setError('Could not load church data. ' + err.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (detail) document.getElementById('team-detail')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [detail]);
  // Opens a team with its application form, from its card or a Find a place result.
  function openTeam(m, apply = false) {
    setDetail(teams.find(t => t.id === m.id) || m); setApplying(apply);
    if (route !== 'serve') go('serve');
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
    <SubNav tabs={TABS} route={route} go={go} />
    {error && <div className="banner error" role="alert"><span>{error}</span><button className="secondary" onClick={load} disabled={loading}>Reload</button></div>}
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
          <div className="card-bottom"><span><Icon name="clock" size={16} />{m.day}</span><button className="link" onClick={() => openTeam(m)}>View team<Icon name="arrow" size={16} /></button></div>
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
        {/* The contact, with Explore a match and Apply to join beside it on the right (below it on phones). */}
        <div className="team-contact">
          <div>
            <div className="team-contact-label">Contact us here:</div>
            <Contact m={detail} />
          </div>
          <div className="team-actions">
            <button className="secondary" onClick={exploreMatch}>Explore a match<Icon name="arrow" size={18} /></button>
            {!applying && <button className="primary" onClick={() => setApplying(true)}>Apply to join</button>}
          </div>
        </div>
        {applying && <ApplyForm key={detail.id} team={detail} church={church} onClose={() => setApplying(false)} />}
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
            <div className="contact-row"><Contact m={m} /><button className="secondary" onClick={() => openTeam(m, true)}>Apply to join<Icon name="arrow" size={16} /></button></div>
            <small className="requirement">{m.note}</small>
          </article>)}
        </>}
      </section>
    </div>}
  </div>;
}

// The explanation's length limits (backend main.APPLICATION_MIN / APPLICATION_MAX).
const ABOUT_MIN = 250, ABOUT_MAX = 1000;

// Only what this team needs: how to reach the person, and in their own words who they are,
// what they'd like to do and why.
function ApplyForm({ team, church, onClose }) {
  const [f, setF] = useState({ name: '', email: '', phone: '', message: '' }),
    [busy, setBusy] = useState(false), [err, setErr] = useState(''), [sent, setSent] = useState(false);
  const set = k => e => setF(v => ({ ...v, [k]: e.target.value }));
  const length = f.message.trim().length;
  async function submit(e) {
    e.preventDefault();
    setErr('');
    if (!f.name.trim()) return setErr('Add your name.');
    if (!isEmail(f.email)) return setErr(EMAIL_HINT);
    if (f.phone.trim() && !isPhone(f.phone)) return setErr(PHONE_HINT);
    if (length < ABOUT_MIN) return setErr(`Tell us a little more about yourself: at least ${ABOUT_MIN} characters (${ABOUT_MIN - length} to go).`);
    setBusy(true);
    try {
      await api(`/ministries/${team.id}/apply`, { method: 'POST', body: JSON.stringify(f) });
      setSent(true);
    } catch (e2) { setErr(e2.message); }
    finally { setBusy(false); }
  }
  if (sent) return <div className="give-applied team-applied" role="status"><Icon name="check" size={20} />
    <div><b>Application sent.</b><p>Church staff at {church.name} review every application, then someone from {team.name} will reach out by email.</p></div></div>;
  return <form className="team-apply" onSubmit={submit} noValidate>
    <div className="team-apply-head"><h3>Apply to join {team.name}</h3><button type="button" className="link" onClick={onClose}>Cancel</button></div>
    <p className="form-note">Church staff review your application before anyone reaches out. Only {church.name}'s staff see it.</p>
    <div className="form-row">
      <label className="field">Your name<input value={f.name} maxLength={120} autoComplete="name" onChange={set('name')} /></label>
      <label className="field">Email<ContactInput kind="email" value={f.email} maxLength={200} autoComplete="email" placeholder="name@example.com" onChange={set('email')} /></label>
    </div>
    <label className="field">Phone <small>Optional</small><ContactInput kind="phone" value={f.phone} maxLength={40} autoComplete="tel" placeholder="(555) 010-0140" onChange={set('phone')} /></label>
    <label className="field">Tell us about yourself
      <span className="field-hint" id="about-hint">Who you are, what you'd like to do on {team.name}, and why you want to serve.</span>
      <textarea rows={6} value={f.message} maxLength={ABOUT_MAX} onChange={set('message')} aria-describedby="about-hint about-count" />
      <span className={'char-count' + (length >= ABOUT_MIN ? ' done' : '')} id="about-count" aria-live="polite">
        {length < ABOUT_MIN ? `${ABOUT_MIN - length} more characters needed` : 'Looks good'} · {length} / {ABOUT_MAX}
      </span>
    </label>
    {err && <div className="banner error" role="alert">{err}</div>}
    <button className="primary" disabled={busy}>{busy ? 'Sending…' : 'Send application'}</button>
  </form>;
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
