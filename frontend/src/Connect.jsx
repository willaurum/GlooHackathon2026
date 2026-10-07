import { useEffect, useState } from 'react';
import { api } from './api.js';
import { useChurch } from './ChurchContext.js';
import { signupLinks } from './churchSite.js';
import Icon from './Icon.jsx';
import connect from './data/connect.json';
const CONNECT_INTERESTS = connect.interests;

const PATHS = [
  { route: 'guests/plan', icon: 'pin', color: 'color1', title: 'Visiting for the first time', text: 'Service times, what to expect, and a way to tell us you are coming.' },
  { route: 'serve/find', icon: 'users', color: 'color3', title: 'Find a place to serve', text: 'Tell us your gifts and availability and get a few suggestions.' },
  { route: 'calendar', icon: 'calendar', color: 'color0', title: 'Come to an event', text: 'Classes, outreach days and gatherings, open to everyone.' },
];

export default function Connect({ go, onAsk }) {
  const church = useChurch();
  const [info, setInfo] = useState(null), [groups, setGroups] = useState([]);
  const [name, setName] = useState(''), [contact, setContact] = useState(''), [interest, setInterest] = useState(CONNECT_INTERESTS[0]), [message, setMessage] = useState('');
  useEffect(() => {
    api('/info').then(setInfo).catch(() => {});
    api('/church').then(c => setGroups(Array.isArray(c.groups) ? c.groups : [])).catch(() => {});
  }, []);
  // Registration and sign-up forms the church already uses, from its imported website.
  const signups = signupLinks(church.site);

  const to = info?.email || '';
  // There is no inbox behind this form yet, so it opens the visitor's own email app.
  const mailto = `mailto:${to}?subject=${encodeURIComponent(`Connecting with ${info?.name || church.name || 'the church'}: ${interest}`)}&body=${encodeURIComponent(`${message}\n\n${name}${contact ? '\n' + contact : ''}`.trim())}`;
  const ready = to && name.trim();

  return <div className="connect">
    <div className="paths">
      {PATHS.map(p => <button key={p.route} className="card feature path" onClick={() => go(p.route)}>
        <span className={'icon ' + p.color}><Icon name={p.icon} size={22} /></span>
        <h2>{p.title}</h2>
        <p>{p.text}</p>
        <span className="link">Go<Icon name="arrow" size={16} /></span>
      </button>)}
    </div>

    {groups.length > 0 && <section className="card about-block" id="connect-groups">
      <div className="eyebrow">Groups</div>
      <h2>Find your people</h2>
      <ul className="connect-list">{groups.map(g => <li key={g.id ?? g.name}>
        <strong>{g.name}</strong>
        <small>{[g.when, g.where, g.audience].filter(Boolean).join(' · ')}</small>
        {g.description && <span>{g.description}</span>}
      </li>)}</ul>
    </section>}

    {signups.length > 0 && <section className="card about-block" id="connect-sign-ups">
      <div className="eyebrow">Sign up</div>
      <h2>Register for what’s next</h2>
      <div className="about-actions">
        {signups.map(link => <a key={link.url} className="btn secondary" href={link.url} target="_blank" rel="noopener noreferrer">{link.label}<Icon name="link" size={14} /></a>)}
      </div>
    </section>}

    <div className="connect-grid">
      <section className="card about-block">
        <div className="eyebrow">Say hello</div>
        <h2>Send us a note</h2>
        <p>Tell us a little about yourself and someone from the church will reply within one business day.</p>
        <form onSubmit={e => { e.preventDefault(); if (ready) window.location.href = mailto; }}>
          <label className="field">Name
            <input required maxLength={100} value={name} onChange={e => setName(e.target.value)} placeholder="Jamie Parker" />
          </label>
          <label className="field">Email or phone <small>Optional</small>
            <input maxLength={200} value={contact} onChange={e => setContact(e.target.value)} placeholder="jamie@example.com" />
          </label>
          <label className="field">How can we help?
            <select value={interest} onChange={e => setInterest(e.target.value)}>
              {CONNECT_INTERESTS.map(i => <option key={i}>{i}</option>)}
            </select>
          </label>
          <label className="field">Message <small>Optional</small>
            <textarea className="field-textarea" maxLength={1000} value={message} onChange={e => setMessage(e.target.value)} />
          </label>
          <button className="primary wide" disabled={!ready}><Icon name="mail" size={18} />Write the email</button>
          <small className="connect-note">This opens your email app with the note filled in.</small>
        </form>
      </section>

      <aside className="card about-block">
        <div className="eyebrow">Other ways</div>
        <h2>Talk to someone</h2>
        <p>Prefer a conversation? Ask Tekton about groups, events or service times, or look up the right person in the directory.</p>
        <div className="about-actions stack">
          <button className="secondary wide" onClick={onAsk}><Icon name="chat" size={18} />Ask Tekton</button>
          <button className="secondary wide" onClick={() => go('about/directory')}><Icon name="phone" size={18} />Contact directory</button>
          <button className="secondary wide" onClick={() => go('serve/saved')}><Icon name="bookmark" size={18} />My saved connections</button>
        </div>
        <small>Need prayer or care? Mention it in your note, or call the office. Staff respond within one business day.</small>
      </aside>
    </div>
  </div>;
}
