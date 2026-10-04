import { useEffect, useState } from 'react';
import { gapi } from './api.js';
import { givingCapabilities } from './giving.js';

// Which church the Give pages are for, with a search to switch to another.
export default function GiveChurchBar({ church, slug, onPick, label = 'Giving to' }) {
  const [open, setOpen] = useState(false), [q, setQ] = useState(''), [list, setList] = useState(null), [multi, setMulti] = useState(false);
  useEffect(() => { givingCapabilities().then(c => setMulti(c.churches)); }, []);
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      gapi('/api/churches' + (q.trim() ? '?q=' + encodeURIComponent(q.trim()) : '')).then(d => setList(d.churches || [])).catch(() => setList([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q, open]);
  const name = church?.name || slug;
  const current = church?.slug || slug;
  return <div className="card give-church">
    <div className="give-church-row">
      <span className="give-church-mark" aria-hidden="true">{(name || '?').slice(0, 1).toUpperCase()}</span>
      <div className="give-church-name"><small>{label}</small><strong>{name}</strong>{church?.city && <small>{church.city}</small>}</div>
      {multi && <button className="ghost" aria-expanded={open} onClick={() => setOpen(o => !o)}>{open ? 'Close' : 'Change church'}</button>}
    </div>
    {open && <div className="give-church-search">
      <label className="field">Find your church
        <input autoFocus value={q} maxLength={60} placeholder="Church name or city" onChange={e => setQ(e.target.value)} />
      </label>
      {list === null ? <p role="status">Searching…</p> : list.length ? <ul>
        {list.map(c => <li key={c.slug}><button className={c.slug === current ? 'chosen' : ''} onClick={() => { onPick(c.slug); setOpen(false); setQ(''); }}>
          <strong>{c.name}</strong>{c.city && <small>{c.city}</small>}
        </button></li>)}
      </ul> : <p>No churches match that search.</p>}
    </div>}
  </div>;
}
