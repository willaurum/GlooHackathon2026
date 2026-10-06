import { useEffect, useMemo, useState } from 'react';
import { api } from './api.js';
import Icon from './Icon.jsx';
import announcements from './data/announcements.json';
const { categories: NEWS_CATEGORIES, items: NEWS } = announcements;

const dateLabel = iso => new Date(iso + 'T12:00:00').toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });

export default function News({ go }) {
  const [category, setCategory] = useState('All'), [events, setEvents] = useState([]);
  useEffect(() => { api('/church').then(c => setEvents(c.events || [])).catch(() => {}); }, []);
  const items = useMemo(() => NEWS.filter(n => category === 'All' || n.category === category).sort((a, b) => b.date.localeCompare(a.date)), [category]);

  return <div className="news-layout">
    <div>
      <div className="chips" role="group" aria-label="Filter news">
        {NEWS_CATEGORIES.map(c => <button key={c} className={'chip' + (category === c ? ' active' : '')} aria-pressed={category === c} onClick={() => setCategory(c)}>{c}</button>)}
      </div>
      <div className="news-list">
        {items.map(n => <article key={n.id} className="card news-item">
          <div className="news-meta"><span className="badge">{n.category}</span><small>{dateLabel(n.date)}</small></div>
          <h3>{n.title}</h3>
          <p>{n.text}</p>
          {n.cta && <button className="link" onClick={() => go(n.cta[0])}>{n.cta[1]}<Icon name="arrow" size={16} /></button>}
        </article>)}
        {items.length === 0 && <div className="card empty"><p>No news in this category yet.</p></div>}
      </div>
    </div>
    <aside className="card news-side">
      <div className="eyebrow">Coming up</div>
      {events.length === 0 ? <p>See the calendar for upcoming events.</p> : <ul>
        {events.slice(0, 4).map(ev => <li key={ev.id}><b>{ev.name}</b><small>{ev.when}</small></li>)}
      </ul>}
      <button className="secondary wide" onClick={() => go('calendar')}><Icon name="calendar" size={18} />Full calendar</button>
      <button className="secondary wide" onClick={() => go('prayer')}><Icon name="compass" size={18} />News from around the world</button>
    </aside>
  </div>;
}
