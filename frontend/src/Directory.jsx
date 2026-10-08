import { useEffect, useMemo, useState } from 'react';
import { api } from './api.js';
import { useChurch } from './ChurchContext.js';
import Icon from './Icon.jsx';
import STAFF from './data/staff.json';
import Sourced from './Sourced.jsx';

const telHref = phone => 'tel:' + (phone || '').replace(/[^\d+]/g, '');

function Person({ name, role, email, note, sourced = false }) {
  return <article className="card person">
    <h3>{sourced ? <Sourced list="staff" name={name}>{name}</Sourced> : name}</h3>
    <div className="person-role">{role}</div>
    {note && <p>{note}</p>}
    {email && <a className="link" href={'mailto:' + email}><Icon name="mail" size={16} />{email}</a>}
  </article>;
}

export default function Directory() {
  const { demo } = useChurch();
  const [info, setInfo] = useState(null), [ministries, setMinistries] = useState([]), [error, setError] = useState(''), [q, setQ] = useState('');
  // A church's own staff list (from Church setup or Tekton); only the demo church falls back to the sample list.
  const [people, setPeople] = useState(null);
  useEffect(() => {
    api('/info').then(setInfo).catch(() => {});
    const sample = demo ? STAFF : [];
    api('/church').then(church => setPeople(church.staff?.length ? church.staff.map(p => ({ ...p, note: p.bio })) : sample)).catch(() => setPeople(sample));
    api('/ministries').then(setMinistries).catch(() => setError('Could not load ministry leaders. Refresh to try again.'));
  }, []);

  const needle = q.trim().toLowerCase();
  const match = (...parts) => !needle || parts.some(p => (p || '').toLowerCase().includes(needle));
  const staff = useMemo(() => (people || []).filter(s => match(s.name, s.role, s.note)), [people, needle]);
  const leads = useMemo(() => ministries.filter(m => m.head && match(m.name, m.head, m.category, m.description)), [ministries, needle]);

  return <div className="directory">
    {info && <section className="card about-block">
      <div className="eyebrow">Church office</div>
      <h2>{info.name}</h2>
      <div className="office">
        {info.phone && <a className="link" href={telHref(info.phone)}><Icon name="phone" size={16} />{info.phone}</a>}
        {info.email && <a className="link" href={'mailto:' + info.email}><Icon name="mail" size={16} />{info.email}</a>}
        {info.address && <span className="link"><Icon name="pin" size={16} />{info.address}</span>}
        {info.office_hours && <span className="link"><Icon name="clock" size={16} />{info.office_hours}</span>}
      </div>
    </section>}

    {((people || []).length > 0 || ministries.some(m => m.head)) && <label className="field dir-search">Search the directory
      <input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Name, role or ministry" />
    </label>}
    {error && <div className="api-message" role="alert">{error}</div>}

    {staff.length > 0 && <section>
      <div className="eyebrow">Pastors &amp; staff</div>
      <div className="people">{staff.map(s => <Person key={s.name} {...s} sourced />)}</div>
    </section>}

    {leads.length > 0 && <section>
      <div className="eyebrow">Ministry leaders</div>
      <div className="people">{leads.map(m => <Person key={m.id} name={m.head} role={'Leads ' + m.name} email={m.email} note={m.description} />)}</div>
    </section>}

    {staff.length === 0 && leads.length === 0 && !error && people && <p className="muted">{needle ? <>No one matches “{q}”. Try a ministry name or a first name.</> : 'No staff are listed yet. The church office can point you to the right person.'}</p>}
    {people === STAFF && <small>Demo directory. All names and addresses are fictional.</small>}
  </div>;
}
