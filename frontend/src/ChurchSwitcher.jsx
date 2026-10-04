import { useEffect, useRef, useState } from 'react';
import { gapi } from './api.js';
import { DEMO_INFO } from './church.js';
import { useChurch } from './ChurchContext.js';
import { givingCapabilities } from './giving.js';
import Icon from './Icon.jsx';

// "Your church": shows which church the site is for, and lets anyone find another church,
// switch to it, or add their own. Sits in the sidebar on desktop and the top bar on phones.
export default function ChurchSwitcher({ compact = false }) {
  const church = useChurch();
  const [open, setOpen] = useState(false), [q, setQ] = useState(''), [list, setList] = useState(null), [multi, setMulti] = useState(null);
  const box = useRef(null);
  useEffect(() => { givingCapabilities().then(c => setMulti(c.churches)); }, []);
  useEffect(() => {
    if (!open) return;
    if (multi === false) { setList([DEMO_INFO]); return; }
    if (multi === null) return;
    const t = setTimeout(() => {
      gapi('/api/churches' + (q.trim() ? '?q=' + encodeURIComponent(q.trim()) : '')).then(d => setList(d.churches || [])).catch(() => setList([DEMO_INFO]));
    }, 200);
    return () => clearTimeout(t);
  }, [q, open, multi]);
  useEffect(() => {
    if (!open) return;
    const away = e => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    const esc = e => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); };
  }, [open]);

  function pick(slug) {
    setOpen(false); setQ('');
    if (slug !== church.slug) church.choose(slug);
  }
  function to(route) { setOpen(false); church.go(route); }

  const name = church.name || ' ';
  return <div className={'church-switcher' + (compact ? ' compact' : '')} ref={box}>
    <button className="church" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(o => !o)}>
      <span aria-hidden="true">{name.trim().charAt(0).toUpperCase() || '·'}</span>
      <div><strong>{name}</strong><small>{compact ? 'Change church' : church.city || 'Your church'}</small></div>
      <Icon name="search" size={16} />
    </button>
    {open && <div className="church-menu" role="dialog" aria-label="Choose your church">
      <label className="field">Find your church
        <input autoFocus value={q} maxLength={60} placeholder="Church name or city" onChange={e => setQ(e.target.value)} />
      </label>
      {list === null ? <p role="status" className="muted">Searching…</p> : list.length ? <ul>
        {list.map(c => <li key={c.slug}><button className={c.slug === church.slug ? 'chosen' : ''} aria-current={c.slug === church.slug ? 'true' : undefined} onClick={() => pick(c.slug)}>
          <strong>{c.name}</strong>{c.city && <small>{c.city}</small>}{c.slug === church.slug && <Icon name="check" size={16} />}
        </button></li>)}
      </ul> : <p className="muted">No churches match that search.</p>}
      {multi === false && <p className="form-note">More churches can join as soon as the updated service is deployed.</p>}
      <div className="church-menu-actions">
        <button className="primary" onClick={() => to('start')}><Icon name="plus" size={18} />Add your church</button>
        <button className="ghost" onClick={() => to('setup')}><Icon name="lock" size={16} />{church.staff ? 'Church setup' : 'Staff sign in'}</button>
      </div>
    </div>}
  </div>;
}
