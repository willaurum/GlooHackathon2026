import { useEffect, useState } from 'react';
import { api, whenCapabilitiesKnown } from './api.js';
import { setStaffToken } from './church.js';
import { useChurch } from './ChurchContext.js';
import { churchApi, friendly, givingCapabilities, signOutStaff, staffApi } from './giving.js';
import Icon from './Icon.jsx';
import ChurchLink from './ChurchLink.jsx';
import { PageHeader } from './Layout.jsx';
import countryBorders from './data/countryBorders.json';

// Countries the Prayer map can outline, from its border data.
const COUNTRIES = countryBorders.features.map(f => ({ code: f.properties.country_code, name: f.properties.name })).sort((a, b) => a.name.localeCompare(b.name));

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Church setup, for staff: the details, service times, questions and teams the whole site shows.
// Everything here is saved through PUT /api/church/content, the same import shape a site importer would use.
export default function ChurchSetup() {
  const church = useChurch();
  const [signingOut, setSigningOut] = useState(false), [signOutError, setSignOutError] = useState('');
  async function signOut() {
    setSigningOut(true); setSignOutError('');
    try { await signOutStaff(church.slug); }
    catch (err) { setSignOutError(friendly(err)); }
    finally { setSigningOut(false); }
  }
  if (!church.staff) return <>
    <PageHeader eyebrow="Church setup" title={'Sign in to set up ' + church.name + '.'} text="Church staff can fill in service times, the address, common questions and serving teams." />
    <StaffSignIn />
  </>;
  return <>
    <PageHeader eyebrow="Church setup" title={'Set up ' + church.name + '.'} text="Fill in what you can. Each part saves on its own, and visitors see it right away."
      action={<button className="secondary" disabled={signingOut} onClick={signOut}>{signingOut ? 'Signing out…' : 'Sign out'}</button>} />
    {signOutError && <div className="banner error" role="alert">{signOutError}</div>}
    <ChurchLink />
    {church.ready ? <SetupForms /> : <div className="card give-pad" role="status"><h2>Almost ready.</h2><p>You are signed in. These setup screens open as soon as the updated church service is deployed. Giving and Stripe already work under Church staff.</p></div>}
  </>;
}

export function StaffSignIn() {
  const church = useChurch();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState(''), [busy, setBusy] = useState(false), [err, setErr] = useState(''), [ready, setReady] = useState(null);
  useEffect(() => whenCapabilitiesKnown(givingCapabilities, setReady), []);
  async function submit(e) {
    e.preventDefault();
    setErr(''); setBusy(true);
    try {
      const res = await churchApi(church.slug, '/admin/login', { method: 'POST', body: JSON.stringify({ password, ...(email.trim() ? { email: email.trim() } : {}) }) });
      setPassword('');
      setStaffToken(church.slug, res.token, { verified: true });
    } catch (e2) { setErr(friendly(e2)); }
    finally { setBusy(false); }
  }
  return <form className="card give-pad staff-signin" onSubmit={submit}>
    <div className="form-title"><span className="icon color2"><Icon name="lock" size={22} /></span><div><h2>Staff sign in</h2><p>Use your staff email and password. Leave email blank for the demo or a church still using its shared password. This sign-in also works in Church staff.</p></div></div>
    {ready === false && <div className="banner demo" role="status"><Icon name="sparkle" /><span>Staff sign-in opens as soon as the updated service is deployed.</span></div>}
    {church.demo && <p className="form-note">This is the shared demo church, so anything you change here is visible to everyone.</p>}
    <label className="field">Email<input type="email" value={email} maxLength={200} autoComplete="username" onChange={e => setEmail(e.target.value)} /></label>
    <label className="field">Staff password<input type="password" value={password} maxLength={200} autoComplete="current-password" onChange={e => setPassword(e.target.value)} /></label>
    {err && <div className="banner error" role="alert">{err}</div>}
    <button className="primary wide" disabled={busy || !password || ready === false}>{busy ? 'Signing in…' : 'Sign in'}</button>
    <p className="form-note">Need an account? Ask your church Owner to add you in Church staff → Team.</p>
    <p className="form-note">Starting a new church site? <a href="/#/new">Create it from your current website</a>.</p>
  </form>;
}

function SetupForms() {
  const church = useChurch();
  const [content, setContent] = useState(null), [err, setErr] = useState('');
  useEffect(() => {
    // A rejected session is cleared by api() itself, and only if no newer sign-in replaced it.
    api('/church/content').then(setContent).catch(e => { if (e.status !== 401) setErr(friendly(e)); });
  }, []);
  // Saves one part of the church and returns the whole saved church.
  async function save(part) {
    const saved = await api('/church/content', { method: 'PUT', body: JSON.stringify(part) });
    setContent(saved);
    return saved;
  }
  if (err) return <div className="banner error" role="alert">{err}</div>;
  if (!content) return <div className="card give-pad"><p role="status">Loading your church…</p></div>;
  const info = content.info;
  const steps = [
    ['Church name and address', !!(info.name && info.address), 'setup-details'],
    ['Service times', info.services.length > 0, 'setup-services'],
    ['Questions people ask', content.faqs.length > 0, 'setup-faqs'],
    ['Serving teams', content.ministries.length > 0, 'setup-teams'],
    ['Prayer map places', content.regions.length > 0, 'setup-places'],
  ];
  const done = steps.filter(s => s[1]).length;
  return <div className="setup">
    <section className="card give-pad setup-progress">
      <div className="eyebrow">{done} of {steps.length} done</div>
      <div className="give-progress" aria-hidden="true"><span style={{ width: (done / steps.length) * 100 + '%' }} /></div>
      <ul className="give-checklist">{steps.map(([label, ok, id]) => <li key={label} className={ok ? 'done' : ''}>
        <Icon name={ok ? 'check' : 'clock'} size={18} /><a href={'#' + id} onClick={e => { e.preventDefault(); document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' }); }}>{label}</a>
      </li>)}</ul>
      <p className="form-note">Giving is set up under <button type="button" className="link" onClick={() => church.go('staff')}>Church staff</button>. Add events on the <button type="button" className="link" onClick={() => church.go('calendar')}>Calendar</button>.</p>
    </section>
    <Details info={info} save={save} />
    <Services info={info} save={save} />
    <Faqs faqs={content.faqs} save={save} />
    <Teams ministries={content.ministries} save={save} />
    {LISTS.map(list => <ListPart key={list.kind} list={list} items={content[list.kind] || []} save={save} />)}
    <Places regions={content.regions} save={save} />
  </div>;
}

// A form card with its own Save button and a short saved/error message.
function Part({ id, icon, title, text, onSave, children, disabled }) {
  const [busy, setBusy] = useState(false), [msg, setMsg] = useState(''), [err, setErr] = useState('');
  async function submit(e) {
    e.preventDefault();
    setBusy(true); setMsg(''); setErr('');
    try { await onSave(); setMsg('Saved.'); }
    catch (e2) { setErr(e2.message || 'Could not save. Please try again.'); }
    finally { setBusy(false); }
  }
  return <form id={id} className="card give-pad setup-part" onSubmit={submit} noValidate>
    <div className="form-title"><span className="icon color1"><Icon name={icon} size={22} /></span><div><h2>{title}</h2><p>{text}</p></div></div>
    {children}
    {err && <div className="banner error" role="alert">{err}</div>}
    <div className="give-row">
      <button className="primary" disabled={busy || disabled}>{busy ? 'Saving…' : 'Save'}</button>
      {msg && <span className="setup-saved" role="status"><Icon name="check" size={16} />{msg}</span>}
    </div>
  </form>;
}

const DETAIL_FIELDS = [
  ['name', 'Church name', 'e.g. Hope Chapel', 80],
  ['city', 'Town or city', 'e.g. Austin, TX', 80],
  ['address', 'Street address', 'e.g. 120 Main Street, Austin, TX', 200],
  ['phone', 'Phone', 'e.g. (555) 010-0199', 40],
  ['email', 'Email', 'e.g. hello@yourchurch.org', 200],
  ['office_hours', 'Office hours', 'e.g. Monday to Thursday, 9am to 3pm', 200],
];

function Details({ info, save }) {
  const church = useChurch();
  const [f, setF] = useState(() => Object.fromEntries(['name', 'city', 'address', 'phone', 'email', 'office_hours', 'about', 'first_visit'].map(k => [k, info[k] || ''])));
  const set = k => e => setF(v => ({ ...v, [k]: e.target.value }));
  async function onSave() {
    const name = f.name.trim(), city = f.city.trim();
    if (name.length < 3) throw new Error('Type the name of your church.');
    const saved = await save({ info: { ...info, ...Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.trim()])) } });
    // The church list (and the sign-in) uses the name kept by the giving service; keep them the same.
    if (name !== info.name || city !== (info.city || '')) {
      await staffApi(church.slug, '/settings', { method: 'PUT', body: JSON.stringify({ name, city }) }).catch(() => {});
      church.refresh();
    }
    return saved;
  }
  return <Part id="setup-details" icon="home" title="Your church" text="Your name, where you meet and how to reach you." onSave={onSave}>
    <div className="form-row">{DETAIL_FIELDS.slice(0, 2).map(([k, label, ph, max]) => <label key={k} className="field">{label}<input value={f[k]} maxLength={max} placeholder={ph} onChange={set(k)} /></label>)}</div>
    {DETAIL_FIELDS.slice(2, 3).map(([k, label, ph, max]) => <label key={k} className="field">{label}<input value={f[k]} maxLength={max} placeholder={ph} onChange={set(k)} /></label>)}
    <div className="form-row">{DETAIL_FIELDS.slice(3, 5).map(([k, label, ph, max]) => <label key={k} className="field">{label} <small>Optional</small><input value={f[k]} maxLength={max} placeholder={ph} onChange={set(k)} /></label>)}</div>
    {DETAIL_FIELDS.slice(5).map(([k, label, ph, max]) => <label key={k} className="field">{label} <small>Optional</small><input value={f[k]} maxLength={max} placeholder={ph} onChange={set(k)} /></label>)}
    <label className="field">About your church <small>A few sentences for the home page</small><textarea rows={3} maxLength={2000} value={f.about} placeholder="Who you are and what a Sunday is like." onChange={set('about')} /></label>
    <label className="field">What to expect on a first visit <small>Optional</small><textarea rows={3} maxLength={2000} value={f.first_visit} placeholder="How long services last, what people wear, where to go with kids." onChange={set('first_visit')} /></label>
  </Part>;
}

function Services({ info, save }) {
  const [rows, setRows] = useState(() => info.services.length ? info.services.map(s => ({ ...s })) : [{ day: 'Sunday', time: '', note: '' }]);
  const set = (i, k) => e => setRows(r => r.map((row, j) => (j === i ? { ...row, [k]: e.target.value } : row)));
  async function onSave() {
    const services = rows.map(r => ({ ...r, time: r.time.trim(), note: (r.note || '').trim() })).filter(r => r.time);
    return save({ info: { ...info, services } });
  }
  return <Part id="setup-services" icon="clock" title="Service times" text="When you meet. Guests pick one of these when they let you know they are coming." onSave={onSave}>
    {rows.map((r, i) => <div key={i} className="setup-row">
      <label className="field">Day<select value={r.day} onChange={set(i, 'day')}>{DAYS.map(d => <option key={d}>{d}</option>)}</select></label>
      <label className="field">Time<input value={r.time} maxLength={40} placeholder="e.g. 10:00am" onChange={set(i, 'time')} /></label>
      <label className="field setup-wide">Note <small>Optional</small><input value={r.note || ''} maxLength={300} placeholder="e.g. Kids programs during the service" onChange={set(i, 'note')} /></label>
      <button type="button" className="ghost setup-remove" aria-label={'Remove service ' + (i + 1)} onClick={() => setRows(x => x.filter((_, j) => j !== i))}><Icon name="x" size={18} /></button>
    </div>)}
    <button type="button" className="secondary" onClick={() => setRows(x => [...x, { day: 'Sunday', time: '', note: '' }])}><Icon name="plus" size={18} />Add a service time</button>
  </Part>;
}

function Faqs({ faqs, save }) {
  const [rows, setRows] = useState(() => faqs.length ? faqs.map(q => ({ ...q })) : [{ question: '', answer: '' }]);
  const set = (i, k) => e => setRows(r => r.map((row, j) => (j === i ? { ...row, [k]: e.target.value } : row)));
  async function onSave() {
    const kept = rows.map(r => ({ ...r, question: r.question.trim(), answer: r.answer.trim() })).filter(r => r.question || r.answer);
    if (kept.some(r => !r.question || !r.answer)) throw new Error('Each question needs an answer. Fill it in, or remove the question.');
    return save({ faqs: kept });
  }
  return <Part id="setup-faqs" icon="chat" title="Questions people ask" text="Parking, kids, what to wear. The chat assistant answers from these too." onSave={onSave}>
    {rows.map((r, i) => <div key={i} className="setup-item">
      <label className="field">Question<input value={r.question} maxLength={300} placeholder="e.g. Where do I park?" onChange={set(i, 'question')} /></label>
      <label className="field">Answer<textarea rows={2} value={r.answer} maxLength={2000} placeholder="e.g. There is free parking behind the building." onChange={set(i, 'answer')} /></label>
      <button type="button" className="ghost" onClick={() => setRows(x => x.filter((_, j) => j !== i))}><Icon name="x" size={16} />Remove this question</button>
    </div>)}
    <button type="button" className="secondary" onClick={() => setRows(x => [...x, { question: '', answer: '' }])}><Icon name="plus" size={18} />Add a question</button>
  </Part>;
}

function Teams({ ministries, save }) {
  const blank = { name: '', description: '', day: '', head: '', email: '', total: '' };
  const [rows, setRows] = useState(() => ministries.length ? ministries.map(m => ({ ...m, total: String(m.total ?? '') })) : [{ ...blank }]);
  const set = (i, k) => e => setRows(r => r.map((row, j) => (j === i ? { ...row, [k]: e.target.value } : row)));
  async function onSave() {
    const kept = rows.map(r => ({ ...r, name: r.name.trim(), description: (r.description || '').trim(), day: (r.day || '').trim(), head: (r.head || '').trim(), email: (r.email || '').trim() }))
      .filter(r => r.name || r.description);
    if (kept.some(r => !r.name)) throw new Error('Each team needs a name. Fill it in, or remove the team.');
    return save({ ministries: kept.map(r => ({ ...r, total: Math.max(0, parseInt(r.total, 10) || 0), filled: Math.min(r.filled || 0, Math.max(0, parseInt(r.total, 10) || 0)) })) });
  }
  return <Part id="setup-teams" icon="users" title="Serving teams" text="The teams people can join, who leads them and how many helpers you need." onSave={onSave}>
    {rows.map((r, i) => <div key={r.id ?? 'new-' + i} className="setup-item">
      <div className="form-row">
        <label className="field">Team name<input value={r.name} maxLength={120} placeholder="e.g. Greeters" onChange={set(i, 'name')} /></label>
        <label className="field">When they serve <small>Optional</small><input value={r.day || ''} maxLength={120} placeholder="e.g. Sunday mornings" onChange={set(i, 'day')} /></label>
      </div>
      <label className="field">What the team does<textarea rows={2} value={r.description || ''} maxLength={2000} placeholder="e.g. Welcome people at the door and help guests find their way." onChange={set(i, 'description')} /></label>
      <div className="form-row">
        <label className="field">Team leader <small>Optional</small><input value={r.head || ''} maxLength={120} placeholder="e.g. Pat Lee" onChange={set(i, 'head')} /></label>
        <label className="field">Leader email <small>Optional</small><input type="email" value={r.email || ''} maxLength={200} placeholder="e.g. pat@yourchurch.org" onChange={set(i, 'email')} /></label>
      </div>
      {r.shifts?.length
        ? <p className="form-note">Helpers needed: {r.total}, from this team schedule.</p>
        : <label className="field setup-number">Helpers needed <small>Optional</small><input inputMode="numeric" value={r.total} maxLength={4} placeholder="e.g. 6" onChange={set(i, 'total')} /></label>}
      <button type="button" className="ghost" onClick={() => setRows(x => x.filter((_, j) => j !== i))}><Icon name="x" size={16} />Remove this team</button>
    </div>)}
    <button type="button" className="secondary" onClick={() => setRows(x => [...x, { ...blank }])}><Icon name="plus" size={18} />Add a team</button>
  </Part>;
}

// Simple lists a church keeps (the site builder fills these from the church's website). Fields:
// [key, label, placeholder, max length, wide]. The first field is required.
const LISTS = [
  { kind: 'staff', id: 'setup-staff', icon: 'users', title: 'Staff and leaders', item: 'person',
    text: 'The people listed in your directory. Names, roles and emails here are public.',
    fields: [['name', 'Name', 'e.g. Pastor Pat Lee', 120], ['role', 'Role', 'e.g. Lead Pastor', 120], ['email', 'Email', 'e.g. pat@yourchurch.org', 200], ['phone', 'Phone', '', 60], ['bio', 'Short bio', '', 2000, true]] },
  { kind: 'locations', id: 'setup-locations', icon: 'pin', title: 'Locations', item: 'location',
    text: 'Campuses or other places you meet. Your main address stays under Your church.',
    fields: [['name', 'Name', 'e.g. Riverside Campus', 120], ['address', 'Address', 'e.g. 410 Mill Street, Austin, TX', 300], ['service_times', 'Service times', 'e.g. Sundays 10:00 AM', 300]] },
  { kind: 'events', id: 'setup-events', icon: 'clock', title: 'Regular gatherings', item: 'gathering',
    text: 'Things that happen every week or month. One-time events go on the Calendar.',
    fields: [['name', 'Name', 'e.g. Wednesday night dinner', 200], ['when', 'When', 'e.g. Wednesdays 6:00 PM', 200], ['where', 'Where', 'e.g. Fellowship Hall', 200], ['description', 'Description', '', 2000, true]] },
  { kind: 'groups', id: 'setup-groups', icon: 'users', title: 'Small groups', item: 'group',
    text: 'Groups, classes and Bible studies people can join. The chat assistant suggests these.',
    fields: [['name', 'Name', "e.g. Tuesday women's group", 200], ['when', 'When', 'e.g. Tuesdays 9:30 AM', 200], ['where', 'Where', '', 200], ['audience', 'Who it is for', 'e.g. women', 100], ['description', 'Description', '', 2000, true]] },
  { kind: 'sermons', id: 'setup-sermons', icon: 'book', title: 'Sermons online', item: 'sermon',
    text: 'Links to sermons you publish. Staff can transcribe a YouTube sermon from Sermon Notes.',
    fields: [['title', 'Title', '', 200], ['date', 'Date', 'YYYY-MM-DD', 10], ['speaker', 'Speaker', '', 120], ['scripture', 'Scripture', '', 120], ['url', 'Link', 'https://…', 500, true]] },
];

function ListPart({ list, items, save }) {
  const blank = () => Object.fromEntries(list.fields.map(([key]) => [key, '']));
  const [rows, setRows] = useState(() => items.map(item => ({ ...blank(), ...item })));
  const set = (i, k) => e => setRows(r => r.map((row, j) => (j === i ? { ...row, [k]: e.target.value } : row)));
  const required = list.fields[0][0];
  async function onSave() {
    const kept = rows.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v])))
      .filter(r => list.fields.some(([key]) => r[key]));
    if (kept.some(r => !r[required])) throw new Error(`Each ${list.item} needs a ${list.fields[0][1].toLowerCase()}. Fill it in, or remove it.`);
    if (list.kind === 'sermons' && kept.some(r => r.date && !/^\d{4}-\d{2}-\d{2}$/.test(r.date))) throw new Error('Write sermon dates as YYYY-MM-DD.');
    if (list.kind === 'sermons' && kept.some(r => r.url && !/^https?:\/\/\S+$/.test(r.url))) throw new Error('Sermon links must start with https://');
    return save({ [list.kind]: kept });
  }
  return <Part id={list.id} icon={list.icon} title={list.title} text={list.text} onSave={onSave}>
    {rows.map((r, i) => <div key={r.id ?? 'new-' + i} className="setup-item">
      <div className="form-row">{list.fields.filter(f => !f[4]).map(([key, label, ph, max]) => <label key={key} className="field">{label}<input value={r[key] || ''} maxLength={max} placeholder={ph} onChange={set(i, key)} /></label>)}</div>
      {list.fields.filter(f => f[4]).map(([key, label, ph, max]) => <label key={key} className="field">{label} <small>Optional</small><textarea rows={2} value={r[key] || ''} maxLength={max} placeholder={ph} onChange={set(i, key)} /></label>)}
      <button type="button" className="ghost" onClick={() => setRows(x => x.filter((_, j) => j !== i))}><Icon name="x" size={16} />Remove this {list.item}</button>
    </div>)}
    <button type="button" className="secondary" onClick={() => setRows(x => [...x, blank()])}><Icon name="plus" size={18} />Add a {list.item}</button>
  </Part>;
}

const today = () => new Date().toISOString().slice(0, 10);

function Places({ regions, save }) {
  const blankPlace = () => ({ country: '', country_code: '', codename: '', field_of_ministry: '', since: '', team_size: '', updates: [] });
  const [rows, setRows] = useState(() => regions.length
    ? regions.map(r => ({ ...r, since: String(r.since ?? ''), team_size: String(r.team_size || ''), updates: r.updates.map(u => ({ ...u })) }))
    : [blankPlace()]);
  const setPlace = (i, patch) => setRows(r => r.map((row, j) => (j === i ? { ...row, ...patch } : row)));
  const field = (i, k) => e => setPlace(i, { [k]: e.target.value });
  const setUpdate = (i, n, k) => e => setRows(r => r.map((row, j) => (j === i ? { ...row, updates: row.updates.map((u, m) => (m === n ? { ...u, [k]: e.target.value } : u)) } : row)));
  function pickCountry(i, code) {
    const c = COUNTRIES.find(x => x.code === code);
    setPlace(i, { country_code: code, country: c ? c.name : '' });
  }
  async function onSave() {
    const kept = rows.map(r => ({ ...r, codename: r.codename.trim(), field_of_ministry: r.field_of_ministry.trim(),
      updates: r.updates.map(u => ({ ...u, title: (u.title || '').trim(), body: u.body.trim(), author: (u.author || '').trim() })).filter(u => u.body) }))
      .filter(r => r.country_code || r.codename || r.updates.length);
    if (kept.some(r => !r.country_code)) throw new Error('Choose a country for each place, or remove the place.');
    if (kept.some(r => !r.codename)) throw new Error('Give each place a team name. Use a codename if the work is sensitive.');
    if (new Set(kept.map(r => r.country_code)).size !== kept.length) throw new Error('Each country can only be added once. Add more updates under the same place.');
    if (kept.some(r => r.updates.some(u => !u.date))) throw new Error('Each update needs a date.');
    const since = r => (r.since === '' ? null : parseInt(r.since, 10));
    if (kept.some(r => r.since !== '' && !(since(r) >= 1900 && since(r) <= 2100))) throw new Error('"Serving since" should be a year, like 2019.');
    return save({ regions: kept.map(r => ({ ...r, since: since(r), team_size: Math.max(0, parseInt(r.team_size, 10) || 0) })) });
  }
  return <Part id="setup-places" icon="compass" title="Prayer map places" text="The countries your church prays for. The map shows the whole country, never an exact spot, so you can use a codename for a team. Each update is kept with its date, newest first." onSave={onSave}>
    {rows.map((r, i) => <div key={r.id ?? 'new-' + i} className="setup-item">
      <div className="form-row">
        <label className="field">Country<select value={r.country_code} onChange={e => pickCountry(i, e.target.value)}>
          <option value="">Choose a country</option>
          {COUNTRIES.map(c => <option key={c.code} value={c.code}>{c.name}</option>)}
        </select></label>
        <label className="field">Team name<input value={r.codename} maxLength={120} placeholder="e.g. Team Highland" onChange={field(i, 'codename')} /></label>
      </div>
      <label className="field">What the team does <small>Optional</small><input value={r.field_of_ministry} maxLength={300} placeholder="e.g. Community health training in mountain villages" onChange={field(i, 'field_of_ministry')} /></label>
      <div className="form-row">
        <label className="field">Serving since <small>Optional</small><input inputMode="numeric" value={r.since} maxLength={4} placeholder="e.g. 2019" onChange={field(i, 'since')} /></label>
        <label className="field">Team size <small>Optional</small><input inputMode="numeric" value={r.team_size} maxLength={4} placeholder="e.g. 4" onChange={field(i, 'team_size')} /></label>
      </div>
      <div className="setup-updates">
        <b>From the field</b>
        {r.updates.length === 0 && <p className="form-note">No updates yet. Add the first one below.</p>}
        {r.updates.map((u, n) => <div key={u.id ?? 'u-' + n} className="setup-update">
          <div className="form-row">
            <label className="field">Date<input type="date" value={u.date} onChange={setUpdate(i, n, 'date')} /></label>
            <label className="field">From <small>Optional</small><input value={u.author || ''} maxLength={120} placeholder="e.g. Pat, team lead" onChange={setUpdate(i, n, 'author')} /></label>
          </div>
          <label className="field">Title <small>Optional</small><input value={u.title || ''} maxLength={200} placeholder="e.g. The lower trail reopened" onChange={setUpdate(i, n, 'title')} /></label>
          <label className="field">Update<textarea rows={3} value={u.body} maxLength={4000} placeholder="What is happening, what the team is grateful for, what they need." onChange={setUpdate(i, n, 'body')} /></label>
          <button type="button" className="ghost" onClick={() => setPlace(i, { updates: r.updates.filter((_, m) => m !== n) })}><Icon name="x" size={16} />Remove this update</button>
        </div>)}
        <button type="button" className="secondary" onClick={() => setPlace(i, { updates: [{ date: today(), title: '', body: '', author: '' }, ...r.updates] })}><Icon name="plus" size={18} />Add an update</button>
      </div>
      <button type="button" className="ghost" onClick={() => setRows(x => x.filter((_, j) => j !== i))}><Icon name="x" size={16} />Remove this place</button>
    </div>)}
    <button type="button" className="secondary" onClick={() => setRows(x => [...x, blankPlace()])}><Icon name="plus" size={18} />Add a place</button>
  </Part>;
}
