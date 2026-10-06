import { useEffect, useState } from 'react';
import { api, fmt } from './api.js';
import { useChurch } from './ChurchContext.js';
import { loadChurch, percent } from './giving.js';
import Icon from './Icon.jsx';

const STEPS = [
  ['See the need', 'A shared view of volunteer coverage and what each team does.'],
  ['Know the person', 'Start with their gifts, interests and time.'],
  ['Connect with care', 'The assistant suggests possibilities. People lead the relationship.'],
];

export default function Home({ go, onAsk }) {
  const church = useChurch();
  const [info, setInfo] = useState(null), [giving, setGiving] = useState(null);
  useEffect(() => {
    api('/info').then(setInfo).catch(() => {});
    loadChurch(church.slug).then(setGiving).catch(() => {});
  }, []);
  // The first fund with a goal gets the progress bar on the Give card.
  const goal = giving && [...giving.funds, ...giving.trips].find(f => f.goal > 0);
  const newChurch = !church.demo && info && !info.services?.length;

  return <div className="page home">
    <section className="home-hero">
      <div className="eyebrow">{info?.name || church.name}</div>
      <h1>A place to belong,<br />grow and give.</h1>
      <p>{info?.about || 'Find where your gifts fit, catch up on Sunday’s message, and support the mission. All in one place.'}</p>
      <div className="hero-actions">
        <button className="primary" onClick={() => go('serve/find')}>Find a place to serve<Icon name="arrow" size={18} /></button>
        <button className="secondary" onClick={() => go('guests/plan')}>Planning your first visit?<Icon name="arrow" size={18} /></button>
        <button className="secondary" onClick={onAsk}><Icon name="chat" size={18} />Ask Belong</button>
      </div>
      <div className="hero-art" aria-hidden="true"><div className="orbit" /><div className="orbit outer" /><Icon name="sparkle" size={96} /></div>
    </section>

    {newChurch && <section className="card church-state home-setup">
      <span className="icon color3"><Icon name="sparkle" size={24} /></span>
      <h2>{church.name} is just getting started here.</h2>
      <p>{church.staff ? 'Add your service times, address, common questions and serving teams, and this site fills in.' : 'Service times and more are on the way. You can already give online.'}</p>
      <button className="primary" onClick={() => go(church.staff ? 'setup' : 'give')}>{church.staff ? 'Open church setup' : 'Give online'}<Icon name="arrow" size={18} /></button>
    </section>}

    <div className="features">
      <a className="card feature" href="#/serve" onClick={e => { e.preventDefault(); go('serve'); }}>
        <span className="icon color1"><Icon name="users" size={22} /></span>
        <h2>Serve</h2>
        <p>Browse ministry teams, see where help is needed, and match members to a place that fits.</p>
        <span className="link">Explore ministries<Icon name="arrow" size={16} /></span>
      </a>
      <a className="card feature" href="#/notes" onClick={e => { e.preventDefault(); go('notes'); }}>
        <span className="icon color3"><Icon name="book" size={22} /></span>
        <h2>Sermon Notes</h2>
        <p>Read past sermons and ask questions. Answers quote the message with timestamps.</p>
        <span className="link">Open sermon notes<Icon name="arrow" size={16} /></span>
      </a>
      <a className="card feature" href="#/give" onClick={e => { e.preventDefault(); go('give'); }}>
        <span className="icon color0"><Icon name="heart" size={22} /></span>
        <h2>Give</h2>
        {goal ? <>
          <p>{goal.name}: <b>{fmt(goal.raised, giving.currency)}</b> of {fmt(goal.goal, giving.currency)}</p>
          <div className="progress" aria-hidden="true"><span style={{ width: percent(goal.raised, goal.goal) + '%' }} /></div>
        </> : <p>Support the mission with a gift, in a couple of taps.</p>}
        <span className="link">Give online<Icon name="arrow" size={16} /></span>
      </a>
    </div>

    {/* The About pages hold the demo church's own text; other churches do not show these links yet. */}
    {church.demo && <section className="know-us" aria-label="Get to know us">
      <div className="eyebrow">Get to know us</div>
      <div className="know-links">
        <button className="secondary" onClick={() => go('about')}><Icon name="info" size={18} />Our story</button>
        <button className="secondary" onClick={() => go('about/beliefs')}><Icon name="book" size={18} />What we believe</button>
        <button className="secondary" onClick={() => go('about/news')}><Icon name="news" size={18} />News</button>
        <button className="secondary" onClick={() => go('about/directory')}><Icon name="phone" size={18} />Contact directory</button>
        <button className="primary" onClick={() => go('about/connect')}><Icon name="mail" size={18} />Connect with us</button>
      </div>
    </section>}

    {info?.services?.length > 0 && <section className="card week" id="home-service-times">
      <div className="week-head">
        <div><div className="eyebrow">Join us</div><h2>Service times</h2></div>
        {info.address && <small><Icon name="pin" size={16} />{info.address}</small>}
      </div>
      <div className="services">
        {info.services.map(s => <div className="service" key={s.day + s.time}>
          <strong>{s.day} · {s.time}</strong>
          <p>{s.note}</p>
        </div>)}
      </div>
    </section>}

    <section className="leaders">
      <div>
        <div className="eyebrow">For church leaders</div>
        <h2>A big church can still feel personal.</h2>
        <p>Belong helps leaders turn a desire to serve into a real connection: see which teams need people, meet a member where they are, and hand off to the right ministry lead.</p>
      </div>
      <ol className="steps">{STEPS.map(([title, text], i) => <li key={title}><span>{String(i + 1).padStart(2, '0')}</span><b>{title}</b><p>{text}</p></li>)}</ol>
    </section>
  </div>;
}
