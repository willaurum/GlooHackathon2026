import { useEffect, useState } from 'react';
import { fmt, gapi } from './api.js';
import Icon from './Icon.jsx';
import { PageHeader, SubNav } from './Layout.jsx';
import GiveChurchBar from './GiveChurchBar.jsx';
import GiveManage from './GiveManage.jsx';
import GiveStaff from './GiveStaff.jsx';
import { useChurch } from './ChurchContext.js';
import { DEMO_CHURCH, churchApi, friendly, loadChurch, manageLinkFor, percent, startCheckout, tripDates } from './giving.js';

const TABS = [['give', 'Give', 'heart'], ['give/trips', 'Mission trips', 'compass'], ['give/staff', 'Church staff', 'lock']];
const HEADERS = {
  'give': ['Give with confidence.', 'Choose where your gift goes. Gifts are private: this page shows totals, never names.'],
  'give/trips': ['Go, or help send someone.', 'Mission trips and teams that need people and funding. Apply to go, or give toward a trip.'],
  'give/staff': ['For church staff.', 'Connect Stripe, manage funds and trips, review applications and see who gave.'],
  'give/manage': ['Your monthly gift.', 'See a monthly gift and cancel it any time, right here.'],
};
const MANAGE_PREFIX = 'give/manage/';

// Gives to the church the whole site is showing (church.js); the church search here switches the site.
export default function Give({ route, go, sessionId = '', status = '', returnChurch = '' }) {
  const { slug, choose } = useChurch();
  const [church, setChurch] = useState(null),
    [loadErr, setLoadErr] = useState(null),
    [fundId, setFundId] = useState(''),
    [version, setVersion] = useState(0);
  const manageToken = route.startsWith(MANAGE_PREFIX) ? route.slice(MANAGE_PREFIX.length) : '';
  const tab = HEADERS[route] ? route : manageToken ? 'give/manage' : 'give';

  useEffect(() => {
    let live = true;
    setLoadErr(null);
    loadChurch(slug).then(c => live && setChurch(c)).catch(e => { if (live) { setChurch(null); setLoadErr(e); } });
    return () => { live = false; };
  }, [slug, version]);

  function pickChurch(next) {
    if (next !== slug) choose(next, tab === 'give/staff' || tab === 'give/manage' ? tab : 'give');
    else setVersion(v => v + 1);
  }
  function giveTo(id) { setFundId(id); go('give'); }

  const [title, text] = HEADERS[tab];
  let body;
  if (sessionId) body = <Confirmation id={sessionId} status={status} slug={returnChurch} go={go} />;
  else if (tab === 'give/staff') body = <GiveStaff slug={slug} church={church} go={go} onPickChurch={pickChurch} onChanged={() => setVersion(v => v + 1)} />;
  else if (tab === 'give/manage') body = <GiveManage token={manageToken} church={church} slug={slug} go={go} onPickChurch={pickChurch} onChanged={() => setVersion(v => v + 1)} />;
  else if (loadErr) body = <LoadError err={loadErr} slug={slug} onPick={pickChurch} />;
  else if (!church) body = <div className="card give-pad"><p role="status">Loading giving options…</p></div>;
  else body = <>
    <GiveChurchBar church={church} slug={slug} onPick={pickChurch} />
    {tab === 'give/trips' ? <Trips church={church} onGive={giveTo} onApplied={() => setVersion(v => v + 1)} /> : <DonationFlow church={church} fundId={fundId} setFundId={setFundId} go={go} />}
  </>;

  return <>
    <PageHeader eyebrow="Give" title={title} text={text} />
    <SubNav tabs={TABS} route={sessionId ? '' : tab} go={go} />
    <section className="give">{body}</section>
  </>;
}

function LoadError({ err, slug, onPick }) {
  const missing = err.status === 404;
  return <div className="card give-pad give-error" role="alert">
    <h2>{missing ? 'We could not find that church.' : 'Giving is unavailable right now.'}</h2>
    <p>{missing ? 'The link may be old, or the church may have changed its address.' : friendly(err)}</p>
    {slug !== DEMO_CHURCH && <button className="secondary" onClick={() => onPick(DEMO_CHURCH)}>Go to Grace Community</button>}
  </div>;
}

function ModeBanner({ mode, legacy }) {
  if (mode === 'demo') return <div className="banner demo" role="status"><Icon name="sparkle" /><span><b>Demo mode.</b> This church has not connected Stripe{legacy ? '' : ' yet'}, so gifts are simulated and no card is charged.</span></div>;
  if (mode === 'test') return <div className="banner demo" role="status"><Icon name="sparkle" /><span><b>Stripe test mode.</b> Use card 4242 4242 4242 4242 with any future date and CVC. No real money moves.</span></div>;
  return null;
}

function FundProgress({ f, currency, big }) {
  const pct = percent(f.raised, f.goal);
  return <div className={'give-fund-progress' + (big ? ' big' : '')}>
    <div className="give-raised"><strong>{fmt(f.raised || 0, currency)}</strong>{f.goal ? <> raised of {fmt(f.goal, currency)}</> : ' raised'}</div>
    {f.goal > 0 && <div className="give-progress" role="progressbar" aria-label={f.name + ' progress'} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><span style={{ width: pct + '%' }} /></div>}
    {typeof f.gifts === 'number' && <small>{f.gifts === 1 ? '1 gift' : f.gifts + ' gifts'}{f.goal ? ' · ' + pct + '%' : ''}</small>}
  </div>;
}

function DonationFlow({ church, fundId, setFundId, go }) {
  const options = [...church.funds, ...church.trips];
  const fund = options.find(f => f.id === fundId) || options[0];
  const [amount, setAmount] = useState(0),
    [custom, setCustom] = useState(''),
    [monthly, setMonthly] = useState(false),
    [busy, setBusy] = useState(false),
    [formErr, setFormErr] = useState('');

  if (!fund) return <div className="card give-pad"><h2>No funds are open right now.</h2><p>Check back soon.</p></div>;
  const presets = church.presets?.length ? church.presets : [2500, 5000, 10000, 25000];
  const current = amount || (custom ? Math.round(parseFloat(custom.replace(/[^\d.]/g, '')) * 100) || 0 : 0);
  const recurring = fund.recurring && monthly;

  async function submit(e) {
    e.preventDefault();
    setFormErr('');
    if (!current) return setFormErr('Choose an amount or enter your own.');
    if (current < 100) return setFormErr('The smallest online gift is ' + fmt(100, church.currency) + '.');
    setBusy(true);
    try {
      const res = await startCheckout(church, { fund: fund.id, amount: current, cadence: recurring ? 'month' : 'once' });
      window.location.href = res.url;
    } catch (err) {
      setFormErr(friendly(err));
      setBusy(false);
    }
  }

  return <>
    <ModeBanner mode={church.mode} legacy={church.legacy} />
    <div className="give-grid">
      <div className="card give-goal">
        <div className="eyebrow">Where your gift goes</div>
        <div className="give-funds" role="radiogroup" aria-label="Fund">
          {options.map(f => <button key={f.id} type="button" role="radio" aria-checked={f.id === fund.id} className={'give-fund' + (f.id === fund.id ? ' chosen' : '')} onClick={() => { setFundId(f.id); if (!f.recurring) setMonthly(false); }}>
            <span className={'icon ' + (f.kind === 'trip' ? 'color3' : f.recurring ? 'color1' : 'color0')}><Icon name={f.kind === 'trip' ? 'compass' : f.recurring ? 'calendar' : 'heart'} size={18} /></span>
            <span className="give-fund-text"><strong>{f.name}</strong><small>{f.kind === 'trip' ? [tripDates(f.startDate, f.endDate), f.location].filter(Boolean).join(' · ') || 'Mission trip' : f.goal ? fmt(f.raised, church.currency) + ' of ' + fmt(f.goal, church.currency) : f.recurring ? 'One-time or monthly' : 'Any amount helps'}</small></span>
            {f.id === fund.id && <Icon name="check" size={18} className="give-fund-check" />}
          </button>)}
        </div>
        <div className="give-fund-detail">
          <h2>{fund.name}</h2>
          {fund.description && <p>{fund.description}</p>}
          <FundProgress f={fund} currency={church.currency} big />
        </div>
        <p className="give-private"><Icon name="lock" size={16} />This page shows totals, never names.</p>
      </div>

      <form className="card give-form" onSubmit={submit} noValidate>
        <div className="form-title"><span className="icon color0"><Icon name="heart" size={22} /></span><div><h2>Make a gift</h2><p>To {fund.name}.</p></div></div>
        {fund.recurring && <div className="filters give-cadence" role="group" aria-label="How often">
          <button type="button" className={!monthly ? 'selected' : ''} aria-pressed={!monthly} onClick={() => setMonthly(false)}>One time</button>
          <button type="button" className={monthly ? 'selected' : ''} aria-pressed={monthly} onClick={() => setMonthly(true)}>Monthly</button>
        </div>}
        <div className="field"><span>Amount <small>{church.currency.toUpperCase()}</small></span>
          <div className="preset-row">
            {presets.map(p => <button type="button" key={p} className={amount === p ? 'chosen' : ''} aria-pressed={amount === p} onClick={() => { setAmount(p); setCustom(''); }}>{fmt(p, church.currency)}</button>)}
          </div>
          <input inputMode="decimal" aria-label="Other amount" placeholder="Or enter any amount" value={custom} onChange={e => { setCustom(e.target.value); setAmount(0); }} />
        </div>
        {formErr && <div className="banner error" role="alert">{formErr}</div>}
        <button className="primary wide continue" disabled={busy || !current}>
          {busy ? 'Starting…' : 'Continue to payment' + (current ? ' · ' + fmt(current, church.currency) + (recurring ? '/mo' : '') : '')}
        </button>
        <p className="disclaimer">{church.mode === 'demo' ? 'This is a demo. ' : 'Secured by Stripe. '}No card details are stored on our servers.{recurring ? ' You can cancel a monthly gift any time on this site.' : ''}</p>
        <p className="give-manage-link"><button type="button" className="link" onClick={() => go('give/manage')}>Manage or cancel a monthly gift<Icon name="arrow" size={16} /></button></p>
      </form>
    </div>
  </>;
}

function Trips({ church, onGive, onApplied }) {
  const [applying, setApplying] = useState('');
  if (church.legacy) return <div className="card give-pad"><h2>Mission trips are on the way.</h2><p>Trips and team applications appear here once the updated giving service is live.</p></div>;
  if (!church.trips.length) return <div className="card give-pad empty"><Icon name="compass" size={32} /><h2>No trips posted yet.</h2><p>When {church.name} posts a mission trip or team, you can apply or give toward it here.</p></div>;
  return <div className="give-trips">
    {church.trips.map(t => {
      const full = t.spots > 0 && t.filled >= t.spots;
      return <article key={t.id} className="card give-trip">
        <div className="category">{[tripDates(t.startDate, t.endDate), t.location].filter(Boolean).join(' · ') || 'Mission trip'}</div>
        <h2>{t.name}</h2>
        {t.description && <p>{t.description}</p>}
        <FundProgress f={t} currency={church.currency} />
        {t.spots > 0 && <div className="give-spots"><Icon name="users" size={16} />{full ? 'Team is full' : `${t.filled} of ${t.spots} spots filled`}</div>}
        <div className="give-trip-actions">
          <button className="primary" onClick={() => onGive(t.id)}><Icon name="heart" size={18} />Give toward this trip</button>
          {t.applicationsOpen && !full && <button className="secondary" aria-expanded={applying === t.id} onClick={() => setApplying(a => (a === t.id ? '' : t.id))}>{applying === t.id ? 'Close' : 'Apply to go'}</button>}
        </div>
        {!t.applicationsOpen && <small>Applications are closed.</small>}
        {applying === t.id && <ApplyForm church={church} trip={t} onDone={onApplied} />}
      </article>;
    })}
  </div>;
}

function ApplyForm({ church, trip, onDone }) {
  const [f, setF] = useState({ name: '', email: '', phone: '', message: '' }), [busy, setBusy] = useState(false), [err, setErr] = useState(''), [sent, setSent] = useState(false);
  const set = k => e => setF(v => ({ ...v, [k]: e.target.value }));
  async function submit(e) {
    e.preventDefault();
    setErr('');
    if (!f.name.trim() || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email.trim())) return setErr('Add your name and a valid email.');
    setBusy(true);
    try {
      await churchApi(church.slug, '/trips/' + encodeURIComponent(trip.id) + '/apply', { method: 'POST', body: JSON.stringify(f) });
      setSent(true);
      onDone?.();
    } catch (e2) { setErr(friendly(e2)); }
    finally { setBusy(false); }
  }
  if (sent) return <div className="give-applied" role="status"><Icon name="check" size={20} /><div><b>Application sent.</b><p>The trip team at {church.name} will review it and reach out by email.</p></div></div>;
  return <form className="give-apply" onSubmit={submit} noValidate>
    <h3>Apply for {trip.name}</h3>
    <p className="form-note">Only the church's trip leaders see your application.</p>
    <div className="form-row">
      <label className="field">Your name<input value={f.name} maxLength={120} autoComplete="name" onChange={set('name')} /></label>
      <label className="field">Email<input type="email" value={f.email} maxLength={200} autoComplete="email" onChange={set('email')} /></label>
    </div>
    <label className="field">Phone <small>Optional</small><input type="tel" value={f.phone} maxLength={40} autoComplete="tel" onChange={set('phone')} /></label>
    <label className="field">Why do you want to go? <small>Skills, experience, questions</small><textarea rows={4} value={f.message} maxLength={2000} onChange={set('message')} /></label>
    {err && <div className="banner error" role="alert">{err}</div>}
    <button className="primary" disabled={busy}>{busy ? 'Sending…' : 'Send application'}</button>
  </form>;
}

function Confirmation({ id, status, slug, go }) {
  const [info, setInfo] = useState(null), [err, setErr] = useState('');
  useEffect(() => {
    if (status === 'cancel') return;
    const load = slug ? churchApi(slug, '/confirm/' + encodeURIComponent(id)) : gapi('/api/confirm/' + encodeURIComponent(id));
    load.then(setInfo).catch(e => setErr(friendly(e)));
  }, [id, slug, status]);

  const state = status === 'cancel' ? 'cancel' : info?.demo ? 'demo' : info?.status;
  const title = state === 'cancel' ? 'No worries.' : state === 'pending' ? 'Checking your gift…' : state === 'expired' ? 'That checkout expired.' : 'Thank you for your gift!';
  return <div className="card give-confirm" aria-live="polite">
    <div className="give-mark"><Icon name={state === 'cancel' ? 'arrow' : 'heart'} size={28} /></div>
    <div className="eyebrow">{info?.church || 'Your gift'}</div>
    <h2>{title}</h2>
    {state === 'cancel' ? <p>Your gift was not started and no card was charged.</p>
      : info ? <>
        <p>{fmt(info.amount, info.currency || 'usd')}{info.cadence === 'month' ? ' each month' : ''}{info.fund ? ' to ' + info.fund : ''}{info.anonymous ? ' · Anonymous' : ''}</p>
        <div className={'give-status ' + (info.demo ? 'demo' : info.status)}>
          {info.demo ? 'Simulated gift: no card was charged.' : info.status === 'completed' ? 'Payment confirmed. Stripe emails your receipt.' : info.status === 'expired' ? 'No payment was taken.' : 'We will confirm your gift shortly.'}
        </div>
        {info.cadence === 'month' && <ManageMonthly id={id} info={info} slug={slug} go={go} />}
      </> : err ? <p>{err}</p> : <p role="status">Looking up your gift…</p>}
    <button className={(info?.cadence === 'month' ? 'secondary' : 'primary') + ' give-again'} onClick={() => go('give')}>Make another gift</button>
  </div>;
}

// After a monthly gift: a way to change your mind later, without calling the church.
function ManageMonthly({ id, info, slug, go }) {
  const [busy, setBusy] = useState(false), [err, setErr] = useState('');
  const token = info.manage === 'link' ? manageLinkFor(id) : '';
  async function openPortal() {
    setBusy(true); setErr('');
    try {
      const res = await churchApi(slug, '/portal', { method: 'POST', body: JSON.stringify({ session: id }) });
      window.location.href = res.url;
    } catch (e) { setErr(friendly(e)); setBusy(false); }
  }
  if (info.canceled) return <p className="give-manage-note">This monthly gift has been canceled. You will not be charged again.</p>;
  const canPortal = info.manage === 'portal' && slug;
  if (!token && !canPortal) return <p className="give-manage-note">You can cancel this monthly gift any time. <button className="link" onClick={() => go('give/manage')}>Manage or cancel a monthly gift</button></p>;
  return <div className="give-manage-box">
    <p>You can change your mind any time. Cancel here and no more gifts are made.</p>
    {token
      ? <button className="primary" onClick={() => go('give/manage/' + token)}>Manage or cancel</button>
      : <button className="primary" disabled={busy} onClick={openPortal}>{busy ? 'Opening…' : 'Manage or cancel'}</button>}
    {canPortal && <small>Opens a secure Stripe page for this gift.</small>}
    {err && <div className="banner error" role="alert">{err}</div>}
  </div>;
}
