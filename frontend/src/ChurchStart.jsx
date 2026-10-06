import { useEffect, useState } from 'react';
import { gapi } from './api.js';
import { setStaffToken } from './church.js';
import { useChurch } from './ChurchContext.js';
import { friendly, givingCapabilities } from './giving.js';
import Icon from './Icon.jsx';
import { PageHeader } from './Layout.jsx';

const CURRENCIES = [['usd', 'US dollar'], ['cad', 'Canadian dollar'], ['gbp', 'British pound'], ['eur', 'Euro'], ['aud', 'Australian dollar'], ['nzd', 'New Zealand dollar']];
const STEPS = [
  ['Add your church', 'Your church name and a staff password. Takes a minute.'],
  ['Fill in the basics', 'Service times, your address, and a few words about your church.'],
  ['Share your site', 'Visitors can plan a visit, find a place to serve, ask questions and give.'],
];

// Add your church: one registry and one staff password for the whole site (kept by the giving service).
export default function ChurchStart() {
  const { choose } = useChurch();
  const [f, setF] = useState({ name: '', city: '', currency: 'usd', password: '', confirm: '' }),
    [busy, setBusy] = useState(false), [err, setErr] = useState(''), [ready, setReady] = useState(null);
  useEffect(() => { givingCapabilities().then(c => setReady(c.churches)); }, []);
  const set = k => e => setF(v => ({ ...v, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setErr('');
    if (f.name.trim().length < 3) return setErr('Type the name of your church.');
    if (f.password.length < 10) return setErr('Choose a staff password with at least 10 characters.');
    if (f.password !== f.confirm) return setErr('The two passwords are different. Type the same password twice.');
    setBusy(true);
    try {
      const res = await gapi('/api/churches', { method: 'POST', body: JSON.stringify({ name: f.name.trim(), city: f.city.trim(), currency: f.currency, password: f.password }) });
      setStaffToken(res.slug, res.token, { verified: true });
      choose(res.slug, 'setup');
    } catch (e2) {
      setErr(friendly(e2));
      setBusy(false);
    }
  }

  return <>
    <PageHeader eyebrow="Add your church" title="Bring your church to belong." text="Free to set up. You get a church site with visits, serving, sermons, a calendar, giving and a helpful chat assistant." />
    <div className="give-signup">
      <ol className="card give-steps">
        {STEPS.map(([title, text], i) => <li key={title} className={i === 0 ? 'current' : ''}><span>{i + 1}</span><div><b>{title}</b><p>{text}</p></div></li>)}
      </ol>
      <form className="card give-pad" onSubmit={submit} noValidate>
        <div className="form-title"><span className="icon color1"><Icon name="plus" size={22} /></span><div><h2>Add your church</h2><p>You can change any of this later.</p></div></div>
        {ready === false && <div className="banner demo" role="status"><Icon name="sparkle" /><span>Adding a church opens here as soon as the updated service is deployed.</span></div>}
        <label className="field">Church name<input value={f.name} maxLength={80} autoComplete="organization" placeholder="e.g. Hope Chapel" onChange={set('name')} /></label>
        <label className="field">Town or city <small>Optional</small><input value={f.city} maxLength={80} autoComplete="address-level2" placeholder="e.g. Austin, TX" onChange={set('city')} /></label>
        <div className="form-row">
          <label className="field">Staff password <small>10 or more characters</small><input type="password" value={f.password} maxLength={200} autoComplete="new-password" onChange={set('password')} /></label>
          <label className="field">Type it again<input type="password" value={f.confirm} maxLength={200} autoComplete="new-password" onChange={set('confirm')} /></label>
        </div>
        <details className="more-options">
          <summary>More options</summary>
          <label className="field">Currency for gifts<select value={f.currency} onChange={set('currency')}>{CURRENCIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        </details>
        <p className="form-note">Share the staff password only with people who help run the church site. There is no reset yet, so write it down somewhere safe.</p>
        {err && <div className="banner error" role="alert">{err}</div>}
        <button className="primary wide continue" disabled={busy || ready === false}>{busy ? 'Adding your church…' : 'Add my church'}</button>
      </form>
    </div>
  </>;
}
