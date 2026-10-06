import { useEffect, useState } from 'react';
import { fmt, gapi } from './api.js';
import { BASE_DOMAIN } from './church.js';
import { friendly } from './giving.js';
import Icon from './Icon.jsx';
import { PageHeader } from './Layout.jsx';
import { MODE_LABELS, churchLink, filterChurches, getPlatformKey, setPlatformKey } from './platformChurches.js';

// #/platform: every church, for the people building belong. Not in the navigation and not linked
// anywhere. The list comes from the giving Worker and needs its PLATFORM_ADMIN_KEY secret.
export default function Platform() {
  const [key, setKey] = useState(getPlatformKey), [tries, setTries] = useState(0);
  // loading | off (route not deployed or no secret) | ask | list | error
  const [state, setState] = useState('loading');
  const [churches, setChurches] = useState([]), [err, setErr] = useState(''), [query, setQuery] = useState('');

  useEffect(() => {
    let live = true;
    setState('loading');
    const headers = key ? { Authorization: 'Bearer ' + key } : {};
    gapi('/api/platform/churches', { headers }).then(res => {
      if (!live) return;
      setChurches(Array.isArray(res.churches) ? res.churches : []);
      setErr('');
      setState('list');
    }).catch(e => {
      if (!live) return;
      if (e.status === 404) return setState('off');
      if (e.status === 401 || e.status === 429) {
        // A wrong key is forgotten, so the next visit asks again.
        if (key && e.status === 401) setPlatformKey('');
        setErr(key ? friendly(e) : '');
        return setState('ask');
      }
      setErr(friendly(e));
      setState('error');
    });
    return () => { live = false; };
  }, [key, tries]);

  function tryKey(next) { setPlatformKey(next); setKey(next); setTries(t => t + 1); }
  function signOut() { setChurches([]); setErr(''); tryKey(''); }

  const header = <PageHeader eyebrow="Platform" title="All churches." text="For the belong. team only. Churches never see each other, and this page is not linked anywhere."
    action={state === 'list' ? <button className="secondary" onClick={signOut}>Sign out</button> : null} />;

  if (state === 'loading') return <>{header}<div className="card give-pad"><p role="status">Loading churches…</p></div></>;
  if (state === 'off') return <>{header}
    <section className="card church-state" role="status">
      <span className="icon color4"><Icon name="clock" size={24} /></span>
      <h2>Not available yet.</h2>
      <p>Deploy the giving Worker and set PLATFORM_ADMIN_KEY.</p>
    </section>
  </>;
  if (state === 'error') return <>{header}<div className="banner error" role="alert">{err}</div></>;
  if (state === 'ask') return <>{header}<KeyForm error={err} onKey={tryKey} /></>;

  const shown = filterChurches(churches, query);
  return <>{header}
    <div className="platform-bar">
      <label className="search"><Icon name="search" size={18} /><input type="search" aria-label="Search churches" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search name, city or link" /></label>
      <span className="muted" role="status">{shown.length === churches.length ? churches.length + (churches.length === 1 ? ' church' : ' churches') : shown.length + ' of ' + churches.length}</span>
    </div>
    {shown.length ? <div className="platform-list">{shown.map(c => <ChurchCard key={c.slug} church={c} />)}</div>
      : <div className="card give-pad"><p>No church matches “{query}”.</p></div>}
  </>;
}

function KeyForm({ error, onKey }) {
  const [value, setValue] = useState('');
  return <form className="card give-pad staff-signin" onSubmit={e => { e.preventDefault(); if (value.trim()) onKey(value.trim()); }}>
    <div className="form-title"><span className="icon color2"><Icon name="lock" size={22} /></span><div><h2>Platform key</h2><p>The PLATFORM_ADMIN_KEY secret of the giving Worker. It is kept in this browser tab only.</p></div></div>
    <label className="field">Platform key<input type="password" value={value} maxLength={300} autoComplete="off" onChange={e => setValue(e.target.value)} /></label>
    {error && <div className="banner error" role="alert">{error}</div>}
    <button className="primary wide" disabled={!value.trim()}>Show churches</button>
  </form>;
}

const joined = iso => {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);

function ChurchCard({ church: c }) {
  const g = c.giving;
  const link = route => churchLink(c.slug, route, { base: BASE_DOMAIN });
  return <article className="card platform-church">
    <div className="platform-head">
      <h2>{c.name}</h2>
      <p className="muted">{[c.city || 'No city', joined(c.createdAt) && 'Joined ' + joined(c.createdAt)].filter(Boolean).join(' · ')}</p>
      <code>{c.slug}</code>
    </div>
    <div className="platform-tags">
      {c.demo && <span className="tag">Demo church</span>}
      {g ? <span className={'tag' + (g.mode === 'live' ? '' : ' done')}>{MODE_LABELS[g.mode] || g.mode}</span> : <span className="tag crisis">No giving data</span>}
      {g && !c.demo && (g.setup.done ? <span className="tag">Setup done</span> : <span className="tag crisis">{!g.setup.stripe ? 'Needs Stripe' : 'No trip yet'}</span>)}
    </div>
    {g && <p className="platform-counts">{plural(g.funds, 'fund', 'funds')} · {plural(g.trips, 'trip', 'trips')} · {plural(g.gifts, 'gift', 'gifts')} · {fmt(g.raised, g.currency)}</p>}
    <div className="platform-actions">
      <a className="primary" href={link('')}>Open site</a>
      <a className="secondary" href={link('give')}>Give page</a>
      <a className="secondary" href={link('setup')}>Staff sign in</a>
    </div>
  </article>;
}
