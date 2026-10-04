import { useEffect, useState } from 'react';
import Icon from './Icon.jsx';
import { gapi } from './api.js';
import { friendly, givingCapabilities, setStaffToken } from './giving.js';

const CURRENCIES = [['usd', 'US dollar'], ['cad', 'Canadian dollar'], ['gbp', 'British pound'], ['eur', 'Euro'], ['aud', 'Australian dollar'], ['nzd', 'New Zealand dollar']];
const STEPS = [
  ['Sign up', 'Your church name and a staff password.'],
  ['Connect Stripe', 'Paste a key once. We create your giving funds in Stripe for you.'],
  ['Share your link', 'Post trips, review applications, and see gifts privately.'],
];

export default function GiveSignup({ onCreated }) {
  const [f, setF] = useState({ name: '', city: '', currency: 'usd', password: '', confirm: '' }),
    [busy, setBusy] = useState(false), [err, setErr] = useState(''), [ready, setReady] = useState(null);
  useEffect(() => { givingCapabilities().then(c => setReady(c.churches)); }, []);
  const set = k => e => setF(v => ({ ...v, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setErr('');
    if (f.name.trim().length < 3) return setErr('Add your church name.');
    if (f.password.length < 10) return setErr('Choose a staff password of at least 10 characters.');
    if (f.password !== f.confirm) return setErr('The two passwords do not match.');
    setBusy(true);
    try {
      const res = await gapi('/api/churches', { method: 'POST', body: JSON.stringify({ name: f.name.trim(), city: f.city.trim(), currency: f.currency, password: f.password }) });
      setStaffToken(res.slug, res.token);
      onCreated(res.slug);
    } catch (e2) {
      setErr(friendly(e2));
      setBusy(false);
    }
  }

  return <div className="give-signup">
    <ol className="card give-steps">
      {STEPS.map(([title, text], i) => <li key={title} className={i === 0 ? 'current' : ''}><span>{i + 1}</span><div><b>{title}</b><p>{text}</p></div></li>)}
    </ol>
    <form className="card give-pad" onSubmit={submit} noValidate>
      <div className="form-title"><span className="icon color1"><Icon name="plus" size={22} /></span><div><h2>Sign up your church</h2><p>Free to set up. Stripe's normal card fees apply to gifts.</p></div></div>
      {ready === false && <div className="banner demo" role="status"><Icon name="sparkle" /><span>Church sign-up needs the updated giving service. It opens here as soon as that update is deployed.</span></div>}
      <label className="field">Church name<input value={f.name} maxLength={80} autoComplete="organization" placeholder="e.g. Hope Chapel" onChange={set('name')} /></label>
      <div className="form-row">
        <label className="field">City <small>Optional</small><input value={f.city} maxLength={80} autoComplete="address-level2" placeholder="e.g. Austin, TX" onChange={set('city')} /></label>
        <label className="field">Currency<select value={f.currency} onChange={set('currency')}>{CURRENCIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
      </div>
      <div className="form-row">
        <label className="field">Staff password <small>10+ characters</small><input type="password" value={f.password} maxLength={200} autoComplete="new-password" onChange={set('password')} /></label>
        <label className="field">Confirm password<input type="password" value={f.confirm} maxLength={200} autoComplete="new-password" onChange={set('confirm')} /></label>
      </div>
      <p className="form-note">Anyone with this password can manage giving and see who gave, so share it only with staff. There is no reset yet: keep it in a password manager.</p>
      {err && <div className="banner error" role="alert">{err}</div>}
      <button className="primary wide continue" disabled={busy || ready === false}>{busy ? 'Creating…' : 'Create church and continue'}</button>
    </form>
  </div>;
}
