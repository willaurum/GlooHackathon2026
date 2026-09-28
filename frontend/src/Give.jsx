import { useEffect, useState } from 'react';

// The giving API is a separate Cloudflare Worker, so the page talks to its
// public origin directly (the Worker answers the cross-origin request with CORS
// scoped to the preview origin only).
const API = 'https://gloo-hackathon2026-api-donate-giving.jaronwilson2025.workers.dev';

async function gapi(path, options = {}) {
  const res = await fetch(API + path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status}). Please try again.`);
  return body;
}

function fmt(minor, currency) {
  const sym = currency === 'usd' ? '$' : currency === 'gbp' ? '£' : currency === 'eur' ? '€' : (currency || '').toUpperCase() + ' ';
  const n = (minor / 100).toLocaleString(undefined, { minimumFractionDigits: Number.isInteger(minor / 100) ? 0 : 2, maximumFractionDigits: 2 });
  return sym + n;
}

function timeAgo(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  const m = s / 60;
  if (m < 60) return Math.round(m) + 'm ago';
  const h = m / 60;
  if (h < 24) return Math.round(h) + 'h ago';
  return Math.round(h / 24) + 'd ago';
}

export default function Give({ sessionId = '', status = '' }) {
  if (sessionId) return <Confirmation id={sessionId} status={status} />;
  return <DonationFlow />;
}

function DonationFlow() {
  const [config, setConfig] = useState(null);
  const [feed, setFeed] = useState([]);
  const [loadErr, setLoadErr] = useState('');
  const [amount, setAmount] = useState(0);
  const [custom, setCustom] = useState('');
  const [anonymous, setAnonymous] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState('');

  useEffect(() => {
    gapi('/api/config').then(setConfig).catch((e) => setLoadErr(e.message));
    gapi('/api/gifts').then((d) => setFeed(d.list || [])).catch(() => {});
  }, []);

  if (loadErr) return <div className="give-error panel"><h2>Give is unavailable.</h2><p>{loadErr}</p></div>;
  if (!config) return <div className="panel"><p role="status">Loading giving options…</p></div>;

  const presets = config.presets?.length ? config.presets : [100, 5000, 10000, 15000];
  const goal = config.goal || { title: 'Goal', amount: 0 };
  const raised = config.raised || 0;
  const pct = goal.amount ? Math.min(100, Math.round((raised / goal.amount) * 100)) : 0;
  const demo = config.mode === 'demo';
  const current = amount || (custom ? Math.round(parseFloat(custom) * 100) || 0 : 0);

  async function submit(e) {
    e.preventDefault();
    setFormErr('');
    if (!current) return setFormErr('Choose an amount or enter your own.');
    if (!anonymous && (!name.trim() || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))) return setFormErr('Add your name and email, or choose anonymous.');
    setBusy(true);
    try {
      const res = await gapi('/api/checkout', { method: 'POST', body: JSON.stringify({ amount: current, anonymous, name: anonymous ? '' : name, email: anonymous ? '' : email }) });
      window.location.href = res.url;
    } catch (err) {
      setFormErr(err.message);
      setBusy(false);
    }
  }

  return (
    <section className="give">
      {demo && (
        <div className="give-banner" role="status">
          <span>✦</span>
          <div><b>Demo mode</b> — no payment keys are configured, so gifts are simulated and no card is charged.</div>
        </div>
      )}
      <div className="give-grid">
        <div className="give-goal">
          <div className="eyebrow">OUR GOAL</div>
          <h2>{goal.title}</h2>
          <div className="give-raised">
            <strong>{fmt(raised, config.currency)}</strong> raised of {fmt(goal.amount, config.currency)}
          </div>
          <div className="give-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: pct + '%' }} />
          </div>
          <div className="give-recent">
            <div className="eyebrow">RECENT SUPPORT</div>
            {feed.length ? (
              <ul>
                {feed.map((g, i) => (
                  <li key={i}><span>{g.name}</span><b>{fmt(g.amount, config.currency)}</b><small>{timeAgo(g.created_at)}</small></li>
                ))}
              </ul>
            ) : (
              <p className="give-recent-empty">Be the first to give.</p>
            )}
          </div>
        </div>

        <form className="panel give-form" onSubmit={submit}>
          <div className="form-title"><span className="icon color1">♥</span><div><h2>Make a gift</h2><p>Takes a couple of clicks.</p></div></div>
          <div className="field"><span>Amount <small>{config.currency.toUpperCase()}</small></span>
            <div className="preset-row">
              {presets.map((p, i) => (
                <button type="button" key={p} className={amount === p ? 'chosen' : ''} onClick={() => { setAmount(p); setCustom(''); }}>
                  {fmt(p, config.currency)}{i === 0 ? '+' : i === presets.length - 1 ? '+' : ''}
                </button>
              ))}
            </div>
            <input inputMode="decimal" placeholder="Or enter any amount" value={custom} onChange={(e) => { setCustom(e.target.value); setAmount(0); }} />
          </div>
          <label className="give-anon field">
            <input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} />
            <span>Give anonymously</span>
          </label>
          {!anonymous && (
            <>
              <label className="field">Your name
                <input value={name} maxLength={120} placeholder="e.g. Jamie Parker" onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="field">Email <small>For your receipt</small>
                <input type="email" value={email} maxLength={200} placeholder="you@example.com" onChange={(e) => setEmail(e.target.value)} />
              </label>
            </>
          )}
          {formErr && <div className="api-message" role="alert">{formErr}</div>}
          <button className="primary wide continue" disabled={busy || !current}>
            {busy ? 'Starting…' : 'Continue to Payment' + (current ? ' — ' + fmt(current, config.currency) : '')}
          </button>
          <p className="disclaimer">{demo ? 'This is a demo. ' : 'Secured by Stripe. '}No card details are stored on our servers.</p>
        </form>
      </div>
    </section>
  );
}

function Confirmation({ id, status }) {
  const [info, setInfo] = useState(null);
  const [err, setErr] = useState('');
  const [config, setConfig] = useState(null);

  useEffect(() => {
    gapi('/api/config').then(setConfig).catch(() => {});
    gapi('/api/confirm/' + encodeURIComponent(id)).then(setInfo).catch((e) => setErr(e.message));
  }, [id]);

  const state = status || (info?.demo ? 'demo' : info?.status);
  const title = state === 'cancel' ? 'No worries.' : state === 'pending' ? 'Checking your gift…' : 'Thank you for your gift!';
  const again = () => { window.location.href = window.location.origin + '/give'; };

  return (
    <section className="give">
      <div className="give-confirm" aria-live="polite">
        <div className="give-mark">{state === 'cancel' ? '↺' : '♥'}</div>
        <div className="eyebrow">{config ? config.churchName.toUpperCase() : 'YOUR GIFT'}</div>
        <h2>{title}</h2>
        {info ? (
          <>
            <p>{fmt(info.amount, config?.currency || 'usd')}{info.anonymous ? ' · Anonymous' : ''}</p>
            <div className={'give-status ' + (info.demo ? 'demo' : info.status)}>
              {info.demo ? 'Simulated gift — no card was charged.' : info.status === 'completed' ? 'Payment confirmed.' : 'We will confirm your gift shortly.'}
            </div>
          </>
        ) : err ? <p>{err}</p> : <p role="status">Looking up your gift…</p>}
        <button className="primary give-again" onClick={again}>Make another gift →</button>
      </div>
    </section>
  );
}
