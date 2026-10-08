import { useEffect, useState } from 'react';
import { useChurch } from './ChurchContext.js';
import { api, fmt, whenCapabilitiesKnown } from './api.js';
import { rotateStaffToken, shareLink } from './church.js';
import ContactInput from './ContactInput.jsx';
import Icon from './Icon.jsx';
import GiveChurchBar from './GiveChurchBar.jsx';
import { churchApi, friendly, getStaffToken, givingCapabilities, percent, revokeStaffToken, setStaffToken, signOutStaff, staffApi, tripDates } from './giving.js';

// Volunteers: applications to serve on a team (church API) and to go on a mission trip (giving API).
// Care requests: what the website chat passed to staff (pastoral care, prayer, crisis).
const VIEWS = [['overview', 'Overview'], ['funds', 'Funds & trips'], ['volunteers', 'Volunteers'], ['care', 'Care requests'], ['gifts', 'Gifts'], ['team', 'Team']];

export default function GiveStaff({ slug, church, go, onPickChurch, onChanged }) {
  const { staff } = useChurch();
  const [token, setToken] = useState(() => getStaffToken(slug)), [ready, setReady] = useState(null);
  useEffect(() => {
    const sync = () => setToken(getStaffToken(slug));
    sync();
    window.addEventListener('belong-staff', sync);
    return () => window.removeEventListener('belong-staff', sync);
  }, [slug]);
  // While the giving service is down, a signed-in user still sees "Verifying" and its Sign out.
  useEffect(() => whenCapabilitiesKnown(givingCapabilities, setReady), []);

  if (ready === false) return <div className="card give-pad"><h2>Church accounts are almost here.</h2><p>Staff sign-in, Stripe setup and trip applications open as soon as the updated giving service is deployed.</p></div>;
  if (!token) return <SignIn slug={slug} church={church} go={go} onPickChurch={onPickChurch} onSignedIn={t => { setStaffToken(slug, t, { verified: true }); }} />;
  if (!staff) return <Verifying slug={slug} />;
  return <Dashboard key={slug} slug={slug} go={go} onChanged={onChanged} />;
}

// Verification retries while the giving service is down; this gives staff a way out meanwhile.
function Verifying({ slug }) {
  const [busy, setBusy] = useState(false);
  async function signOut() {
    setBusy(true);
    // Revoke on the server when it answers; if it can't be reached, at least forget the session here
    // (but never a newer sign-in that replaced it while this was waiting).
    const token = getStaffToken(slug);
    try { await signOutStaff(slug); } catch { if (getStaffToken(slug) === token) setStaffToken(slug, ''); }
  }
  return <div className="card give-pad">
    <p role="status">Verifying your staff session…</p>
    <p className="form-note">Taking too long? <button type="button" className="link" disabled={busy} onClick={signOut}>{busy ? 'Signing out…' : 'Sign out'}</button></p>
  </div>;
}

function SignIn({ slug, church, go, onPickChurch, onSignedIn }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState(''), [busy, setBusy] = useState(false), [err, setErr] = useState('');
  async function submit(e) {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const res = await churchApi(slug, '/admin/login', { method: 'POST', body: JSON.stringify({ password, ...(email.trim() ? { email: email.trim() } : {}) }) });
      setPassword('');
      onSignedIn(res.token);
    } catch (e2) { setErr(friendly(e2)); setBusy(false); }
  }
  return <div className="give-signin">
    <GiveChurchBar church={church} slug={slug} onPick={onPickChurch} label="Staff sign-in for" />
    <form className="card give-pad" onSubmit={submit}>
      <div className="form-title"><span className="icon color2"><Icon name="lock" size={22} /></span><div><h2>Sign in</h2><p>Use your staff email and password. Leave email blank for the demo or a church still using its shared password.</p></div></div>
      <label className="field">Email<ContactInput kind="email" value={email} maxLength={200} autoComplete="username" onChange={e => setEmail(e.target.value)} /></label>
      <label className="field">Staff password<input type="password" value={password} maxLength={200} autoComplete="current-password" onChange={e => setPassword(e.target.value)} /></label>
      {err && <div className="banner error" role="alert">{err}</div>}
      <button className="primary wide" disabled={busy || !password}>{busy ? 'Signing in…' : 'Sign in'}</button>
      <p className="form-note">Need an account? Ask your church Owner to add you.</p>
      <p className="form-note">Starting a new church site? <a href="/#/new">Create it from your current website</a>.</p>
    </form>
  </div>;
}

function Dashboard({ slug, go, onChanged }) {
  const [data, setData] = useState(null), [err, setErr] = useState(''), [view, setView] = useState('overview'), [signingOut, setSigningOut] = useState(false), [signOutError, setSignOutError] = useState('');
  // Waiting on staff in the church API: new team applications and open chat care requests.
  const [waiting, setWaiting] = useState({ teams: 0, care: 0 });
  function fail(e) { if (e.status !== 401) setErr(friendly(e)); }
  useEffect(() => { staffApi(slug, '').then(setData).catch(fail); }, [slug]);
  function countWaiting() {
    Promise.all([api('/volunteers'), api('/requests')]).then(([v, r]) => setWaiting({
      teams: v.applications.filter(a => a.status === 'new').length,
      care: r.filter(x => x.kind !== 'connection' && x.status === 'pending').length,
    })).catch(() => {});
  }
  useEffect(countWaiting, [slug]);
  function update(next) { setData(next); onChanged(); }
  const badges = { volunteers: (data?.newApplications || 0) + waiting.teams, care: waiting.care };
  async function signOut() {
    setSigningOut(true); setSignOutError('');
    try { await signOutStaff(slug); }
    catch (err) { setSignOutError('You are still signed in. ' + friendly(err)); }
    finally { setSigningOut(false); }
  }
  if (err) return <div className="card give-pad give-error" role="alert"><h2>Could not load the staff area.</h2><p>{err}</p></div>;
  if (!data) return <div className="card give-pad"><p role="status">Loading your church…</p></div>;

  return <div className="give-staff">
    <div className="give-staff-head">
      <div><div className="eyebrow">{data.me?.name || 'Church staff'} · {data.me?.role === 'site_admin' ? 'Site admin' : 'Owner'}</div><h2>{data.church.name}</h2></div>
      <button className="secondary" disabled={signingOut} onClick={signOut}>{signingOut ? 'Signing out…' : 'Sign out'}</button>
    </div>
    {signOutError && <div className="banner error" role="alert">{signOutError}</div>}
    <div className="filters give-views" role="tablist" aria-label="Staff sections">
      {VIEWS.map(([v, label]) => <button key={v} role="tab" aria-selected={view === v} className={view === v ? 'selected' : ''} onClick={() => setView(v)}>
        {label}{badges[v] > 0 && <b className="count">{badges[v]}</b>}
      </button>)}
    </div>
    {view === 'overview' && <Overview slug={slug} data={data} update={update} go={go} fail={fail} setView={setView} newVolunteers={badges.volunteers} />}
    {view === 'funds' && <Funds slug={slug} data={data} update={update} fail={fail} />}
    {view === 'volunteers' && <Volunteers slug={slug} fail={fail} onChanged={() => { staffApi(slug, '').then(update).catch(() => {}); countWaiting(); }} />}
    {view === 'care' && <CareRequests onChanged={countWaiting} />}
    {view === 'gifts' && <Gifts slug={slug} fail={fail} canAnonymize={!!data.church.demo && data.me?.role === 'owner'} />}
    {view === 'team' && <Team slug={slug} />}
  </div>;
}

function Overview({ slug, data, update, go, fail, setView, newVolunteers }) {
  const { church, stripe } = data;
  const link = shareLink(church.slug, 'give');
  const [copied, setCopied] = useState(false);
  const trips = data.funds.filter(f => f.kind === 'trip');
  const steps = [
    ['Church created', true],
    ['Stripe connected', stripe.connected && !stripe.provisionError],
    ['A mission trip posted', trips.length > 0],
  ];
  function copy() { navigator.clipboard?.writeText(link).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }).catch(() => {}); }
  return <>
    <div className="stats">
      <div className="card stat"><div>Raised<Icon name="heart" size={18} /></div><strong>{fmt(data.public.totals.raised, church.currency)}</strong><small>{stripe.mode === 'demo' ? 'Includes simulated gifts' : 'Completed gifts'}</small></div>
      <div className="card stat"><div>Gifts<Icon name="check" size={18} /></div><strong>{data.public.totals.gifts}</strong><small>All funds</small></div>
      <button type="button" className="card stat stat-link" onClick={() => setView('volunteers')}><div>New volunteers<Icon name="users" size={18} /></div><strong>{newVolunteers}</strong><small>Teams and trips, waiting for review</small></button>
    </div>
    <div className="give-overview">
      <div className="give-col">
        {!church.demo && <div className="card give-pad">
          <h3>Getting set up</h3>
          <ul className="give-checklist">{steps.map(([label, done]) => <li key={label} className={done ? 'done' : ''}><Icon name={done ? 'check' : 'clock'} size={18} />{label}</li>)}</ul>
          {!trips.length && <button className="link" onClick={() => setView('funds')}>Post a mission trip<Icon name="arrow" size={16} /></button>}
        </div>}
        <div className="card give-pad">
          <h3>Your giving page</h3>
          <p className="form-note">Share this link in your bulletin, website or app. It opens straight to {church.name}.</p>
          <div className="give-link"><code>{link}</code><button className="secondary" onClick={copy}>{copied ? 'Copied' : 'Copy link'}</button></div>
          <button className="link give-view" onClick={() => go('give')}>View it as a donor<Icon name="arrow" size={16} /></button>
        </div>
        <ChurchSettings slug={slug} church={church} me={data.me} update={update} fail={fail} />
      </div>
      <StripeCard slug={slug} stripe={stripe} update={update} fail={fail} go={go} />
    </div>
  </>;
}

function StripeCard({ slug, stripe, update, fail, go }) {
  const [key, setKey] = useState(''), [busy, setBusy] = useState(''), [result, setResult] = useState(null), [replacing, setReplacing] = useState(false), [err, setErr] = useState('');
  async function run(label, path, options) {
    setBusy(label); setErr(''); setResult(null);
    try {
      const res = await staffApi(slug, path, options);
      update(res);
      if (res.provision) setResult(res.provision);
      setReplacing(false);
    } catch (e) { if (e.status === 401) fail(e); else setErr(friendly(e)); }
    finally { setBusy(''); }
  }
  function connect(e) {
    e.preventDefault();
    const value = key.trim();
    setKey('');
    run('connect', '/stripe', { method: 'POST', body: JSON.stringify({ key: value }) });
  }
  const showForm = !stripe.locked && (!stripe.connected || replacing);
  return <div className="card give-pad give-stripe">
    <div className="form-title"><span className="icon color3"><Icon name="lock" size={22} /></span><div><h2>Stripe</h2><p>{stripe.connected ? 'Gifts go straight to your Stripe account.' : 'Connect your Stripe account to take real gifts.'}</p></div></div>
    {stripe.locked && <>
      <p>The demo church always runs in demo mode, so no real money can move here.</p>
    </>}
    {stripe.connected && <dl className="give-facts">
      <div><dt>Mode</dt><dd><span className={'badge' + (stripe.mode === 'live' ? '' : ' urgent')}>{stripe.mode === 'live' ? 'Live' : 'Test mode'}</span></dd></div>
      <div><dt>Key</dt><dd><code>{stripe.keyHint}</code></dd></div>
      {stripe.account && <div><dt>Account</dt><dd>{stripe.account}</dd></div>}
      <div><dt>Webhook</dt><dd>{stripe.webhook ? 'Ready' : 'Not set up'}</dd></div>
      {'portal' in stripe && <div><dt>Donor self-service</dt><dd>{stripe.portal ? 'Ready: donors can cancel monthly gifts' : 'Not set up'}</dd></div>}
      <div><dt>Last set up</dt><dd>{stripe.provisionedAt ? new Date(stripe.provisionedAt).toLocaleString() : 'Not finished'}</dd></div>
    </dl>}
    {stripe.provisionError && <div className="banner error" role="alert">Stripe setup did not finish: {stripe.provisionError}</div>}
    {stripe.webhookNote && <div className="banner demo" role="status">{stripe.webhookNote}</div>}
    {stripe.portalNote && <div className="banner demo" role="status">{stripe.portalNote}</div>}
    {stripe.connected && 'portal' in stripe && !stripe.portal && !stripe.portalNote && <div className="banner demo" role="status">Run "Re-run Stripe setup" once so donors can cancel monthly gifts themselves.</div>}
    {result && result.ok && <div className="give-applied" role="status"><Icon name="check" size={20} /><div><b>Stripe is set up.</b><p>{result.created ? `Created ${result.created} new product${result.created === 1 ? '' : 's'} with prices` : 'Everything was already there'}{result.reused ? `, reused ${result.reused} existing` : ''}. Gifts now go through Stripe Checkout.</p></div></div>}
    {err && <div className="banner error" role="alert">{err}</div>}
    {showForm && <form onSubmit={connect} className="give-key-form">
      {!stripe.encryptionReady && <div className="banner error" role="alert">This server is missing its STRIPE_KEY_ENCRYPTION_KEY secret, so it cannot store Stripe keys yet.</div>}
      <ul className="give-tips">
        <li><Icon name="sparkle" size={16} />Start with a <b>test key</b> (sk_test_…) to try everything safely.</li>
        <li><Icon name="lock" size={16} />For real gifts, use a <b>restricted key</b> (rk_live_…) with Write access to Products, Prices, Checkout Sessions, Webhook Endpoints, Customer portal and Subscriptions.</li>
        <li><Icon name="check" size={16} />We check the key with Stripe, then create a product and prices for every fund and trip, a webhook, and a page where donors can cancel a monthly gift. Running it again never makes duplicates.</li>
        <li><Icon name="lock" size={16} />The key is encrypted on the giving server and never shown again, not even to staff.</li>
      </ul>
      <label className="field">Stripe secret key
        <input type="password" value={key} onChange={e => setKey(e.target.value)} autoComplete="off" spellCheck={false} autoCapitalize="off" placeholder="sk_test_… or rk_live_…" />
      </label>
      <div className="give-row">
        <button className="primary" disabled={!!busy || !key.trim() || !stripe.encryptionReady}>{busy === 'connect' ? 'Setting up Stripe…' : 'Connect and set up Stripe'}</button>
        {replacing && <button type="button" className="ghost" onClick={() => { setReplacing(false); setKey(''); }}>Cancel</button>}
      </div>
    </form>}
    {stripe.connected && !replacing && <div className="give-row">
      <button className="secondary" disabled={!!busy} onClick={() => run('sync', '/stripe/sync', { method: 'POST' })}>{busy === 'sync' ? 'Checking Stripe…' : 'Re-run Stripe setup'}</button>
      <button className="ghost" disabled={!!busy} onClick={() => setReplacing(true)}>Replace key</button>
      <button className="ghost" disabled={!!busy} onClick={() => { if (window.confirm('Disconnect Stripe? Giving goes back to demo mode until you connect again.')) run('disconnect', '/stripe', { method: 'DELETE' }); }}>Disconnect</button>
    </div>}
  </div>;
}

function ChurchSettings({ slug, church, me, update, fail }) {
  const [f, setF] = useState({ name: church.name, city: church.city }), [pw, setPw] = useState({ current: '', next: '' }), [msg, setMsg] = useState(''), [err, setErr] = useState('');
  async function save(e) {
    e.preventDefault(); setMsg(''); setErr('');
    try { update(await staffApi(slug, '/settings', { method: 'PUT', body: JSON.stringify(f) })); setMsg('Saved.'); }
    catch (e2) { if (e2.status === 401) fail(e2); else setErr(friendly(e2)); }
  }
  async function changePassword(e) {
    e.preventDefault(); setMsg(''); setErr('');
    try {
      const res = await rotateStaffToken(slug, () => staffApi(slug, '/password', { method: 'POST', body: JSON.stringify(pw) }));
      // Signed out while the change was in flight: don't leave the new session behind.
      if (!res.installed) return revokeStaffToken(slug, res.token);
      setPw({ current: '', next: '' });
      setMsg('Password changed. Your other sessions were signed out.');
    } catch (e2) { if (e2.status === 401) fail(e2); else setErr(friendly(e2)); }
  }
  return <div className="card give-pad">
    <h3>Church details</h3>
    <form onSubmit={save}>
      <div className="form-row">
        <label className="field">Name<input value={f.name} maxLength={80} onChange={e => setF({ ...f, name: e.target.value })} /></label>
        <label className="field">City<input value={f.city} maxLength={80} onChange={e => setF({ ...f, city: e.target.value })} /></label>
      </div>
      <button className="secondary">Save details</button>
    </form>
    {(!church.demo || (me && !me.shared)) && <form onSubmit={changePassword} className="give-password">
      <div className="form-row">
        <label className="field">Current password<input type="password" autoComplete="current-password" value={pw.current} onChange={e => setPw({ ...pw, current: e.target.value })} /></label>
        <label className="field">New password<input type="password" autoComplete="new-password" value={pw.next} onChange={e => setPw({ ...pw, next: e.target.value })} /></label>
      </div>
      <button className="secondary" disabled={!pw.current || pw.next.length < 10}>Change password</button>
    </form>}
    {msg && <p className="form-note" role="status">{msg}</p>}
    {err && <div className="banner error" role="alert">{err}</div>}
  </div>;
}

function Team({ slug }) {
  const empty = { name: '', email: '', role: 'site_admin', password: '' };
  const [data, setData] = useState(null), [f, setF] = useState(empty), [busy, setBusy] = useState(false), [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    staffApi(slug, '/users').then(d => { if (live) { setData(d); if (!d.users.length) setF(v => ({ ...v, role: 'owner' })); } }).catch(e => { if (live) setErr(friendly(e)); });
    return () => { live = false; };
  }, [slug]);
  const set = key => e => setF(v => ({ ...v, [key]: e.target.value }));
  async function add(e) {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      setData(await staffApi(slug, '/users', { method: 'POST', body: JSON.stringify(f) }));
      setF(empty);
    } catch (e2) { setErr(friendly(e2)); }
    finally { setBusy(false); }
  }
  async function remove(user) {
    if (!window.confirm(`Remove ${user.name}? Their sessions will be signed out immediately.`)) return;
    setBusy(true); setErr('');
    try { setData(await staffApi(slug, '/users/' + encodeURIComponent(user.id), { method: 'DELETE' })); }
    catch (e) { setErr(friendly(e)); }
    finally { setBusy(false); }
  }
  return <div className="give-col">
    {err && <div className="banner error" role="alert">{err}</div>}
    {!data ? <div className="card give-pad"><p role="status">{err ? 'Could not load the team.' : 'Loading the team…'}</p></div> : <>
      <section className="card give-pad">
        <h3>Team</h3><p>Owners and site admins have all staff permissions. Owners can also add and remove staff accounts.</p>
        {data.me.shared && !data.users.length && <p className="form-note">Create your Owner account first using the form below. Then sign out and sign in with your email and new password. You can then add Site admins.</p>}
        {data.me.shared && !!data.users.length && <p className="form-note">You are using the shared password. Sign in with your own staff email and password next time.</p>}
        {!data.users.length && <p>No staff accounts yet.</p>}
        {data.users.map(user => <div className="give-fund-row" key={user.id}>
          <div className="give-fund-row-main"><strong>{user.name}{user.you ? ' (you)' : ''}</strong><small>{user.email} · {user.role === 'owner' ? 'Owner' : 'Site admin'}</small></div>
          {data.canManage && <button className="ghost" disabled={busy || user.you} onClick={() => remove(user)}>Remove</button>}
        </div>)}
      </section>
      {data.canManage && <form className="card give-pad" onSubmit={add}>
        <h3>Add staff</h3>
        <label className="field">Name<input required minLength={2} maxLength={80} value={f.name} autoComplete="name" onChange={set('name')} /></label>
        <label className="field">Email<ContactInput kind="email" required maxLength={200} value={f.email} autoComplete="off" onChange={set('email')} /></label>
        <label className="field">Role<select value={f.role} onChange={set('role')} disabled={!data.users.length}><option value="owner">Owner</option><option value="site_admin">Site admin</option></select></label>
        <label className="field">Temporary password <small>10 or more characters</small><input required type="password" minLength={10} maxLength={200} value={f.password} autoComplete="new-password" onChange={set('password')} /></label>
        <p className="form-note">Share the temporary password privately. Staff can change their own password in Overview.</p>
        <button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Add staff'}</button>
      </form>}
    </>}
  </div>;
}

const dollars = minor => (minor ? String(minor / 100) : '');
const minorUnits = v => Math.round((parseFloat(String(v).replace(/[^\d.]/g, '')) || 0) * 100);

function Funds({ slug, data, update, fail }) {
  const [editing, setEditing] = useState(''), [note, setNote] = useState('');
  const currency = data.church.currency;
  const raised = Object.fromEntries([...data.public.funds, ...data.public.trips].map(f => [f.id, f]));
  async function save(id, body) {
    setNote('');
    const res = await staffApi(slug, id ? '/funds/' + encodeURIComponent(id) : '/funds', { method: id ? 'PUT' : 'POST', body: JSON.stringify(body) });
    update(res);
    setEditing('');
    if (res.stripeNote) setNote(res.stripeNote);
  }
  const groups = [['fund', 'Funds', 'Where regular gifts go.'], ['trip', 'Mission trips & teams', 'Each trip gets its own fund in Stripe, a goal, and an application form.']];
  return <div className="give-funds-admin">
    {note && <div className="banner demo" role="status">{note}</div>}
    {groups.map(([kind, title, text]) => <section key={kind} className="give-group">
      <div className="give-group-head">
        <div><h3>{title}</h3><p>{text}</p></div>
        <button className="primary" onClick={() => setEditing('new-' + kind)}><Icon name="plus" size={18} />{kind === 'trip' ? 'New trip' : 'New fund'}</button>
      </div>
      {editing === 'new-' + kind && <FundForm kind={kind} currency={currency} onCancel={() => setEditing('')} onSave={body => save('', { ...body, kind })} fail={fail} />}
      {data.funds.filter(f => f.kind === kind).map(f => editing === f.id
        ? <FundForm key={f.id} kind={kind} fund={f} currency={currency} onCancel={() => setEditing('')} onSave={body => save(f.id, body)} fail={fail} />
        : <div key={f.id} className={'card give-fund-row' + (f.active ? '' : ' hidden-fund')}>
          <div className="give-fund-row-main">
            <strong>{f.name}</strong>
            <small>{[kind === 'trip' && tripDates(f.startDate, f.endDate), kind === 'trip' && f.location, f.goal ? 'Goal ' + fmt(f.goal, currency) : 'No goal', f.recurring && 'Monthly giving on'].filter(Boolean).join(' · ')}</small>
            <div className="give-tags">
              {!f.active && <span className="tag done">Hidden</span>}
              {f.inStripe ? <span className="tag">In Stripe</span> : data.stripe.connected ? <span className="tag crisis">Not in Stripe yet</span> : null}
              {kind === 'trip' && <span className="tag">{f.applicationsOpen ? 'Applications open' : 'Applications closed'}</span>}
            </div>
            {raised[f.id] && f.goal > 0 && <div className="give-progress" aria-hidden="true"><span style={{ width: percent(raised[f.id].raised, f.goal) + '%' }} /></div>}
          </div>
          <div className="give-fund-row-side">
            {raised[f.id] && <b>{fmt(raised[f.id].raised, currency)}</b>}
            <button className="secondary" onClick={() => setEditing(f.id)}>Edit</button>
          </div>
        </div>)}
    </section>)}
  </div>;
}

function FundForm({ kind, fund, currency, onSave, onCancel, fail }) {
  const trip = kind === 'trip';
  const [f, setF] = useState({
    name: fund?.name || '', description: fund?.description || '', goal: dollars(fund?.goal), recurring: !!fund?.recurring, active: fund ? fund.active : true,
    startDate: fund?.startDate || '', endDate: fund?.endDate || '', location: fund?.location || '', spots: fund?.spots ? String(fund.spots) : '', applicationsOpen: fund ? fund.applicationsOpen : true,
  });
  const [busy, setBusy] = useState(false), [err, setErr] = useState('');
  const set = k => e => setF(v => ({ ...v, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  async function submit(e) {
    e.preventDefault(); setErr('');
    if (!f.name.trim()) return setErr(trip ? 'Give the trip a title.' : 'Give the fund a name.');
    setBusy(true);
    const body = { name: f.name.trim(), description: f.description.trim(), goal: minorUnits(f.goal), active: f.active };
    if (trip) Object.assign(body, { startDate: f.startDate, endDate: f.endDate, location: f.location.trim(), spots: Number(f.spots) || 0, applicationsOpen: f.applicationsOpen });
    else body.recurring = f.recurring;
    try { await onSave(body); }
    catch (e2) { if (e2.status === 401) fail(e2); else setErr(friendly(e2)); setBusy(false); }
  }
  return <form className="card give-pad give-fund-form" onSubmit={submit} noValidate>
    <h3>{fund ? 'Edit ' + fund.name : trip ? 'New mission trip' : 'New fund'}</h3>
    <label className="field">{trip ? 'Trip title' : 'Fund name'}<input value={f.name} maxLength={100} placeholder={trip ? 'e.g. Kenya water project' : 'e.g. Building fund'} onChange={set('name')} /></label>
    <label className="field">Description <small>Shown on the Give page</small><textarea rows={3} value={f.description} maxLength={1000} onChange={set('description')} /></label>
    <div className="form-row">
      <label className="field">Goal <small>{currency.toUpperCase()}, optional</small><input inputMode="decimal" value={f.goal} placeholder="e.g. 12000" onChange={set('goal')} /></label>
      {trip && <label className="field">Team spots <small>Optional</small><input inputMode="numeric" value={f.spots} placeholder="e.g. 12" onChange={set('spots')} /></label>}
    </div>
    {trip && <>
      <div className="form-row">
        <label className="field">Leaves<input type="date" value={f.startDate} onChange={set('startDate')} /></label>
        <label className="field">Returns<input type="date" value={f.endDate} onChange={set('endDate')} /></label>
      </div>
      <label className="field">Where<input value={f.location} maxLength={120} placeholder="e.g. Kisumu, Kenya" onChange={set('location')} /></label>
      <label className="field checkbox"><input type="checkbox" checked={f.applicationsOpen} onChange={set('applicationsOpen')} />Take applications to join this trip</label>
    </>}
    {!trip && <label className="field checkbox"><input type="checkbox" checked={f.recurring} onChange={set('recurring')} />Offer monthly giving (for tithes and pledges)</label>}
    <label className="field checkbox"><input type="checkbox" checked={f.active} onChange={set('active')} />Show on the Give page</label>
    {err && <div className="banner error" role="alert">{err}</div>}
    <div className="give-row">
      <button className="primary" disabled={busy}>{busy ? 'Saving…' : fund ? 'Save changes' : trip ? 'Create trip' : 'Create fund'}</button>
      <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
    </div>
  </form>;
}

const STATUSES = [['new', 'New'], ['accepted', 'Accepted'], ['waitlisted', 'Waitlisted'], ['declined', 'Declined']];
const KINDS = [['teams', 'Serving teams', 'users'], ['trips', 'Mission trips', 'compass']];

function Volunteers({ slug, fail, onChanged }) {
  const [kind, setKind] = useState('teams');
  return <div className="give-apps">
    <div className="subnav volunteer-kinds" role="tablist" aria-label="Kind of volunteer">
      {KINDS.map(([k, label, icon]) => <button key={k} role="tab" aria-selected={kind === k} className={kind === k ? 'active' : ''} onClick={() => setKind(k)}>
        <Icon name={icon} size={16} />{label}</button>)}
    </div>
    {kind === 'teams' ? <TeamApplications fail={fail} onChanged={onChanged} /> : <Applications slug={slug} fail={fail} onChanged={onChanged} />}
  </div>;
}

// The status filter shared by both kinds of application.
function StatusFilter({ list, filter, setFilter }) {
  return <div className="chips" role="group" aria-label="Filter applications">
    {[['all', 'All'], ...STATUSES].map(([v, label]) => <button key={v} className={filter === v ? 'chosen' : ''} aria-pressed={filter === v} onClick={() => setFilter(v)}>
      {label} <small>{v === 'all' ? list.length : list.filter(a => a.status === v).length}</small>
    </button>)}
  </div>;
}

// Applications to serve on a team, from the team's page on Serve or from the website chat.
function TeamApplications({ fail, onChanged }) {
  const [list, setList] = useState(null), [filter, setFilter] = useState('all'), [err, setErr] = useState('');
  useEffect(() => { api('/volunteers').then(d => setList(d.applications)).catch(e => (e.status === 401 ? fail(e) : setErr(e.message))); }, []);
  async function review(id, body) {
    setErr('');
    try { setList((await api('/volunteers/' + id, { method: 'PUT', body: JSON.stringify(body) })).applications); onChanged(); return true; }
    catch (e) { if (e.status === 401) fail(e); else setErr(e.message); return false; }
  }
  if (err && !list) return <div className="banner error" role="alert">{err}</div>;
  if (!list) return <div className="card give-pad"><p role="status">Loading applications…</p></div>;
  const shown = filter === 'all' ? list : list.filter(a => a.status === filter);
  return <>
    <StatusFilter list={list} filter={filter} setFilter={setFilter} />
    {err && <div className="banner error" role="alert">{err}</div>}
    {!shown.length && <div className="card give-pad empty"><Icon name="users" size={32} /><p>{list.length ? 'Nothing here with that status.' : 'No applications yet. They appear here when someone applies to serve on a team.'}</p></div>}
    {shown.map(a => <ApplicationCard key={a.id} a={{ ...a, trip: a.ministry_name, createdAt: a.created_at }} onReview={body => review(a.id, body)}>
      {a.source === 'chat' && <small className="give-app-source">Filed through the website chat.</small>}
    </ApplicationCard>)}
  </>;
}

// Mission trip applications (giving API).
function Applications({ slug, fail, onChanged }) {
  const [list, setList] = useState(null), [filter, setFilter] = useState('all'), [err, setErr] = useState('');
  useEffect(() => { staffApi(slug, '/applications').then(d => setList(d.applications)).catch(fail); }, [slug]);
  async function review(id, body) {
    setErr('');
    try { setList((await staffApi(slug, '/applications/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify(body) })).applications); onChanged(); return true; }
    catch (e) { if (e.status === 401) fail(e); else setErr(friendly(e)); return false; }
  }
  if (!list) return <div className="card give-pad"><p role="status">Loading applications…</p></div>;
  const shown = filter === 'all' ? list : list.filter(a => a.status === filter);
  return <>
    <StatusFilter list={list} filter={filter} setFilter={setFilter} />
    {err && <div className="banner error" role="alert">{err}</div>}
    {!shown.length && <div className="card give-pad empty"><Icon name="users" size={32} /><p>{list.length ? 'Nothing here with that status.' : 'No applications yet. They appear here when someone applies to a trip.'}</p></div>}
    {shown.map(a => <ApplicationCard key={a.id} a={a} onReview={body => review(a.id, body)} />)}
  </>;
}

const DECIDE = { accepted: 'Accept', waitlisted: 'Waitlist', declined: 'Decline' };

// One application, team or trip: who, how to reach them, what they shared, the decision and a private note.
// The staff note is required to change the status (both APIs refuse a change without one) and is saved with it.
function ApplicationCard({ a, onReview, children }) {
  const [note, setNote] = useState(a.note || ''), [missing, setMissing] = useState(false);
  const noteId = 'staff-note-' + a.id;
  function decide(status) {
    if (status === a.status) return;
    if (!note.trim()) { setMissing(true); document.getElementById(noteId)?.focus(); return; }
    onReview({ status, note: note.trim() });
  }
  return <article className="card give-app">
    <div className="give-app-head">
      <div><div className="category">{a.trip}</div><h3>{a.name}</h3></div>
      <span className={'tag ' + (a.status === 'declined' ? 'done' : a.status === 'new' ? 'crisis' : '')}>{STATUSES.find(([v]) => v === a.status)?.[1] || a.status}</span>
    </div>
    <div className="give-app-contact">
      {a.email && <a href={'mailto:' + a.email}><Icon name="mail" size={16} />{a.email}</a>}
      {a.phone && <a href={'tel:' + a.phone.replace(/[^\d+]/g, '')}>{a.phone}</a>}
      <small>Applied {new Date(a.createdAt).toLocaleDateString()}</small>
    </div>
    {children}
    {a.message && <p className="give-app-message">{a.message}</p>}
    {/* The note comes first: it is required before the status buttons below will change anything. */}
    <form className="give-note" onSubmit={e => { e.preventDefault(); onReview({ note }); }}>
      <label className="field">Staff note <small>Private · required to change the status</small>
        <input id={noteId} value={note} maxLength={1000} required aria-invalid={missing || undefined} aria-describedby={missing ? noteId + '-error' : undefined}
          onChange={e => { setNote(e.target.value); setMissing(false); }} placeholder="e.g. Great fit; starts on the 9:00am rotation" />
        {missing && <span className="field-error" id={noteId + '-error'} role="alert">Write a staff note before changing the status.</span>}
      </label>
      <button className="ghost" disabled={note === (a.note || '')}>Save note</button>
    </form>
    <div className="give-row">
      {Object.entries(DECIDE).map(([v, label]) => <button key={v} className={a.status === v ? 'primary' : 'secondary'} aria-pressed={a.status === v}
        onClick={() => decide(v)}>{label}</button>)}
    </div>
  </article>;
}

const CARE_LABELS = { pastoral_care: 'Pastoral care', prayer: 'Prayer', crisis: 'Crisis', other: 'Question' };

// What the website chat passed to staff. Nothing is sent to anyone automatically; staff reach out themselves.
function CareRequests({ onChanged }) {
  const [list, setList] = useState(null), [busy, setBusy] = useState(false), [err, setErr] = useState('');
  const load = () => api('/requests').then(r => setList(r.filter(x => x.kind !== 'connection'))).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);
  async function act(request, method, body) {
    setBusy(true); setErr('');
    try { await api('/requests/' + request.request_id, { method, ...(body && { body: JSON.stringify(body) }) }); await load(); onChanged(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }
  if (!list) return err ? <div className="banner error" role="alert">{err}</div> : <div className="card give-pad"><p role="status">Loading care requests…</p></div>;
  return <div className="give-apps">
    <p className="form-note">Requests the website chat passed to staff. No one is notified automatically, so reach out to the person yourself, then mark it handled.</p>
    {err && <div className="banner error" role="alert">{err}</div>}
    {!list.length && <div className="card give-pad empty"><Icon name="heart" size={32} /><p>No care requests. They appear here when someone asks the chat for prayer, care or help.</p></div>}
    {list.map(r => <article className="card give-app" key={r.request_id}>
      <div className="give-app-head">
        <div><div className="category">{CARE_LABELS[r.kind] || r.kind}</div><h3>{r.name}</h3></div>
        <span className={'tag ' + (r.status !== 'pending' ? 'done' : r.kind === 'crisis' ? 'crisis' : '')}>{r.status === 'pending' ? 'Open' : r.status === 'approved' ? 'Handled' : 'Dismissed'}</span>
      </div>
      <div className="give-app-contact"><span>{r.contact || 'No contact shared'}</span><small>{new Date(r.created_at).toLocaleString()}</small></div>
      {r.details && <p className="give-app-message">{r.details}</p>}
      <div className="give-row">
        {r.status === 'pending' ? <>
          <button className="primary" disabled={busy} onClick={() => act(r, 'PATCH', { status: 'approved' })}>Mark handled</button>
          <button className="secondary" disabled={busy} onClick={() => act(r, 'PATCH', { status: 'declined' })}>Dismiss</button>
        </> : <button className="secondary" disabled={busy} onClick={() => act(r, 'DELETE')}>Remove</button>}
      </div>
    </article>)}
  </div>;
}

// Stripe Checkout asks for the donor's name and email; they arrive when the payment completes.
function donorName(d) {
  if (d.anonymous) return 'Anonymous';
  if (d.name) return d.name;
  return d.status === 'pending' ? 'Waiting for Stripe' : d.status === 'expired' ? 'Checkout not finished' : 'Name not given';
}

// canAnonymize: an owner on the demo church can replace a gift's donor name and email (the Worker checks too).
function Gifts({ slug, fail, canAnonymize = false }) {
  const [data, setData] = useState(null), [fund, setFund] = useState('all'), [busy, setBusy] = useState(''), [err, setErr] = useState('');
  useEffect(() => { staffApi(slug, '/donations').then(setData).catch(fail); }, [slug]);
  if (!data) return <div className="card give-pad"><p role="status">Loading gifts…</p></div>;
  const funds = [...new Map(data.donations.map(d => [d.fundId, d.fund])).entries()];
  const shown = fund === 'all' ? data.donations : data.donations.filter(d => d.fundId === fund);
  const total = shown.filter(d => d.status === 'completed' || d.status === 'demo').reduce((n, d) => n + d.amount, 0);
  async function cancel(d) {
    if (!window.confirm(`Cancel ${d.name || 'this donor'}'s ${fmt(d.amount, data.currency)} monthly gift? No more gifts will be made.`)) return;
    setBusy(d.id); setErr('');
    try { setData(await staffApi(slug, '/donations/' + encodeURIComponent(d.id) + '/cancel', { method: 'POST' })); }
    catch (e) { if (e.status === 401) fail(e); else setErr(friendly(e)); }
    finally { setBusy(''); }
  }
  async function anonymize(d) {
    if (!window.confirm(`Replace ${d.name || 'this donor'}'s name and email with "Demo donor"? The amount and totals stay the same.`)) return;
    setBusy(d.id); setErr('');
    try { setData(await staffApi(slug, '/donations/' + encodeURIComponent(d.id) + '/anonymize', { method: 'POST' })); }
    catch (e) { if (e.status === 401) fail(e); else setErr(friendly(e)); }
    finally { setBusy(''); }
  }
  function csv() {
    const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    const rows = [['Date', 'Fund', 'Amount', 'Currency', 'Frequency', 'Status', 'Monthly gift', 'Name', 'Email'], ...shown.map(d => [d.createdAt, d.fund, (d.amount / 100).toFixed(2), data.currency, d.cadence, d.status, d.cadence !== 'month' ? '' : d.canceled ? 'Canceled ' + (d.canceledAt || '').slice(0, 10) : 'Active', donorName(d), d.email])];
    const url = URL.createObjectURL(new Blob([rows.map(r => r.map(q).join(',')).join('\n')], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'gifts.csv' });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <div className="give-gifts">
    <div className="give-gifts-bar">
      <p className="give-private"><Icon name="lock" size={16} />Only signed-in staff can see this list.</p>
      <div className="give-row">
        <label className="field give-inline-select"><span className="sr-only">Fund</span><select value={fund} onChange={e => setFund(e.target.value)}><option value="all">All funds</option>{funds.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
        <button className="secondary" disabled={!shown.length} onClick={csv}>Download CSV</button>
      </div>
    </div>
    {err && <div className="banner error" role="alert">{err}</div>}
    <div className="card give-pad">
      <div className="give-raised"><strong>{fmt(total, data.currency)}</strong> from {shown.filter(d => d.status === 'completed' || d.status === 'demo').length} gifts</div>
      {!shown.length ? <p>No gifts yet.</p> : <table className="give-table">
        <thead><tr><th>Date</th><th>Donor</th><th>Fund</th><th>Amount</th><th>Status</th></tr></thead>
        <tbody>{shown.map(d => <tr key={d.id}>
          <td data-label="Date"><span>{new Date(d.createdAt).toLocaleDateString()}</span></td>
          <td data-label="Donor"><span>{d.name && !d.anonymous ? <>{d.name}<small>{d.email}</small></> : <><i>{donorName(d)}</i>{d.email && <small>{d.email}</small>}</>}</span></td>
          <td data-label="Fund"><span>{d.fund}</span></td>
          <td data-label="Amount"><span><b>{fmt(d.amount, data.currency)}</b>{d.cadence === 'month' && <small>monthly</small>}</span></td>
          <td data-label="Status"><span className="give-gift-status">
            <span className={'tag ' + (d.status === 'completed' ? '' : d.status === 'demo' ? 'done' : 'crisis')}>{d.status === 'demo' ? 'Simulated' : d.status}</span>
            {d.canceled && <span className="tag crisis give-canceled-tag" title={d.canceledAt ? 'Canceled ' + new Date(d.canceledAt).toLocaleString() : undefined}>Monthly gift canceled</span>}
            {d.cancelable && <button className="ghost" disabled={busy === d.id} onClick={() => cancel(d)}>{busy === d.id ? 'Canceling…' : 'Cancel monthly gift'}</button>}
            {canAnonymize && (d.name !== 'Demo donor' || d.email) && <button className="ghost" disabled={busy === d.id} onClick={() => anonymize(d)}>Anonymize</button>}
          </span></td>
        </tr>)}</tbody>
      </table>}
    </div>
  </div>;
}
