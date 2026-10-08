import { useEffect, useState } from 'react';
import { api, fmt } from './api.js';
import { hashFor } from './church.js';
import { useChurch } from './ChurchContext.js';
import { livestreamLink, pageHidden, pageOfType, siteImage } from './churchSite.js';
import { loadChurch, percent } from './giving.js';
import Icon from './Icon.jsx';
import { safeHref } from './site.js';
import { copyText } from './siteCopy.js';
import { Editable, SectionFrame, SetupFact, sectionKeys, useEditor } from './Editable.jsx';
import Sourced from './Sourced.jsx';
import SiteImage from './SiteImage.jsx';

// The Home sections in their usual order; a church can reorder or hide them by asking Tekton (site.layout, the keys
// of backend builder_edit.PAGES['home']).
export const HOME_SECTIONS = ['features', 'about', 'ministries', 'sermons', 'service_times', 'leaders'];

// The three steps of the bottom section (site copy keys home.leaders_step<n>_title and _text).
const STEPS = [1, 2, 3];
const DEFAULT_TAGLINE = 'A place to belong, grow and give.';
const DEFAULT_ABOUT = 'Find where your gifts fit, catch up on Sunday’s message, and support the mission. All in one place.';

export default function Home({ go, onAsk }) {
  const church = useChurch();
  const editor = useEditor();
  // The church's own wording for the template's text (site.copy), else the template's.
  const copy = key => copyText(church.site, key, church.name);
  const [info, setInfo] = useState(null), [giving, setGiving] = useState(null), [sermons, setSermons] = useState([]);
  const [ministries, setMinistries] = useState([]);
  useEffect(() => {
    api('/info').then(setInfo).catch(() => {});
    api('/ministries').then(list => setMinistries(Array.isArray(list) ? list : [])).catch(() => {});
    loadChurch(church.slug).then(setGiving).catch(() => {});
    // Sermons the church publishes on its website (imported by Tekton or added in Church setup).
    if (!church.demo) api('/church').then(c => setSermons((c.sermons || []).filter(s => safeHref(s.url)))).catch(() => {});
  }, []);
  const live = livestreamLink(church.site);
  const hero = siteImage(church.site, 'hero');
  const recent = [...sermons].sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 3);
  // The first fund with a goal gets the progress bar on the Give card.
  const goal = giving && [...giving.funds, ...giving.trips].find(f => f.goal > 0);
  const newChurch = !church.demo && info && !info.services?.length;
  // Up to six teams on Home; the demo church shows its own on Serve.
  const shownMinistries = church.demo ? [] : ministries.slice(0, 6);

  return <div className="page home">
    <section className={'home-hero' + (hero ? ' has-image' : '')}>
      <div className="home-hero-copy">
      <SetupFact as="div" className="eyebrow">{info?.name || church.name}</SetupFact>
      <Editable as="h1" path="info.tagline" fallback={DEFAULT_TAGLINE}>{info?.tagline || <>A place to belong,<br />grow and give.</>}</Editable>
      <Editable as="p" path="info.about" fallback={DEFAULT_ABOUT}>{info?.about ? <Sourced field="about">{info.about}</Sourced> : DEFAULT_ABOUT}</Editable>
      <div className="hero-actions">
        <button className="primary" onClick={() => go('serve/find')}>Find a place to serve<Icon name="arrow" size={18} /></button>
        <button className="secondary" onClick={() => go('guests/plan')}>Planning your first visit?<Icon name="arrow" size={18} /></button>
        <button className="secondary" onClick={onAsk}><Icon name="chat" size={18} />Ask Tekton</button>
        {live && <a className="btn secondary" href={live.url} target="_blank" rel="noopener noreferrer"><Icon name="play" size={18} />Watch live</a>}
      </div>
      </div>
      <div className="hero-art" aria-hidden={hero ? undefined : true}><div className="orbit" /><div className="orbit outer" /><Icon name="sparkle" size={96} /><SiteImage asset={hero} loading="eager" /></div>
    </section>

    {newChurch && <section className="card church-state home-setup">
      <span className="icon color3"><Icon name="sparkle" size={24} /></span>
      <h2>{church.name} is just getting started here.</h2>
      <p>{church.staff ? 'Add your service times, address, common questions and serving teams, and this site fills in.' : 'Service times and more are on the way. You can already give online.'}</p>
      {(church.staff || !pageHidden(church.site, 'give')) && <button className="primary" onClick={() => go(church.staff ? 'setup' : 'give')}>{church.staff ? 'Open church setup' : 'Give online'}<Icon name="arrow" size={18} /></button>}
    </section>}

    {/* In the order the church asked Tekton for (site.layout). */}
    {sectionKeys(editor, church.site?.layout, 'home', HOME_SECTIONS).map(key => <SectionFrame key={key} page="home" section={key} layout={church.site?.layout}>{{
      features: <div className="features">
        {!pageHidden(church.site, 'serve') && <a className="card feature" href={hashFor(church.slug, 'serve')} onClick={e => { e.preventDefault(); go('serve'); }}>
          <span className="icon color1"><Icon name="users" size={22} /></span>
          <Editable as="h2" path="copy.home.serve_title">{copy('home.serve_title')}</Editable>
          <Editable as="p" path="copy.home.serve_text">{copy('home.serve_text')}</Editable>
          <span className="link">Explore ministries<Icon name="arrow" size={16} /></span>
        </a>}
        {!pageHidden(church.site, 'notes') && <a className="card feature" href={hashFor(church.slug, 'notes')} onClick={e => { e.preventDefault(); go('notes'); }}>
          <span className="icon color3"><Icon name="book" size={22} /></span>
          <Editable as="h2" path="copy.home.notes_title">{copy('home.notes_title')}</Editable>
          <Editable as="p" path="copy.home.notes_text">{copy('home.notes_text')}</Editable>
          <span className="link">Open sermon notes<Icon name="arrow" size={16} /></span>
        </a>}
        {!pageHidden(church.site, 'give') && <a className="card feature" href={hashFor(church.slug, 'give')} onClick={e => { e.preventDefault(); go('give'); }}>
          <span className="icon color0"><Icon name="heart" size={22} /></span>
          <Editable as="h2" path="copy.home.give_title">{copy('home.give_title')}</Editable>
          {goal ? <>
            <p>{goal.name}: <b>{fmt(goal.raised, giving.currency)}</b> of {fmt(goal.goal, giving.currency)}</p>
            <div className="progress" aria-hidden="true"><span style={{ width: percent(goal.raised, goal.goal) + '%' }} /></div>
          </> : <Editable as="p" path="copy.home.give_text">{copy('home.give_text')}</Editable>}
          <span className="link">Give online<Icon name="arrow" size={16} /></span>
        </a>}
      </div>,
      about: <>{/* Beliefs is Grace Community's own statement; other churches show it when Tekton imported theirs. */}
      <section className="know-us" aria-label="Get to know us">
        <Editable as="div" className="eyebrow" path="copy.home.about_eyebrow">{copy('home.about_eyebrow')}</Editable>
        <div className="know-links">
          <button className="secondary" onClick={() => go('about')}><Icon name="info" size={18} />Our story</button>
          {(church.demo || pageOfType(church.pages, 'beliefs')) && <button className="secondary" onClick={() => go('about/beliefs')}><Icon name="book" size={18} />What we believe</button>}
          <button className="secondary" onClick={() => go('about/news')}><Icon name="news" size={18} />News</button>
          <button className="secondary" onClick={() => go('about/directory')}><Icon name="phone" size={18} />Contact directory</button>
          <button className="primary" onClick={() => go('about/connect')}><Icon name="mail" size={18} />Connect with us</button>
        </div>
      </section></>,
      ministries: (shownMinistries.length > 0 && <section className="card week home-ministries" id="home-ministries">
        <div className="week-head">
          <div><Editable as="div" className="eyebrow" path="copy.home.ministries_eyebrow">{copy('home.ministries_eyebrow')}</Editable><Editable as="h2" path="copy.home.ministries_title">{copy('home.ministries_title')}</Editable></div>
          {!pageHidden(church.site, 'serve') && <button className="link" onClick={() => go('serve')}>Find a place to serve<Icon name="arrow" size={16} /></button>}
        </div>
        <SetupFact as="ul">{shownMinistries.map(m => <li key={m.id ?? m.name}>
          <strong><Sourced list="ministries" name={m.name}>{m.name}</Sourced></strong>
          {m.description && <small>{m.description}</small>}
        </li>)}</SetupFact>
      </section>),
      sermons: (recent.length > 0 && <section className="card week home-sermons" id="home-sermons">
        <div className="week-head">
          <div><Editable as="div" className="eyebrow" path="copy.home.sermons_eyebrow">{copy('home.sermons_eyebrow')}</Editable><Editable as="h2" path="copy.home.sermons_title">{copy('home.sermons_title')}</Editable></div>
          {!pageHidden(church.site, 'notes') && <button className="link" onClick={() => go('notes')}>All sermons<Icon name="arrow" size={16} /></button>}
        </div>
        <SetupFact as="ul">{recent.map(s => <li key={s.id ?? s.url}>
          <a className="link" href={safeHref(s.url)} target="_blank" rel="noopener noreferrer">{s.title}</a>
          <small>{[s.date, s.speaker, s.series, s.scripture].filter(Boolean).join(' · ')}</small>
        </li>)}</SetupFact>
      </section>),
      service_times: (info?.services?.length > 0 && <section className="card week" id="home-service-times">
        <div className="week-head">
          <div><Editable as="div" className="eyebrow" path="copy.home.services_eyebrow">{copy('home.services_eyebrow')}</Editable><Editable as="h2" path="copy.home.services_title">{copy('home.services_title')}</Editable></div>
          {info.address && <SetupFact as="small"><Icon name="pin" size={16} /><Sourced field="address">{info.address}</Sourced></SetupFact>}
        </div>
        <SetupFact as="div" className="services">
          {info.services.map(s => <div className="service" key={s.day + s.time}>
            <strong><Sourced field="services">{s.day} · {s.time}</Sourced></strong>
            <p>{s.note}</p>
          </div>)}
        </SetupFact>
      </section>),
      leaders: <section className="leaders">
        <div>
          <Editable as="div" className="eyebrow" path="copy.home.leaders_eyebrow">{copy('home.leaders_eyebrow')}</Editable>
          <Editable as="h2" path="copy.home.leaders_title">{copy('home.leaders_title')}</Editable>
          <Editable as="p" path="copy.home.leaders_text">{copy('home.leaders_text')}</Editable>
        </div>
        <ol className="steps">{STEPS.map(n => <li key={n}><span>{String(n).padStart(2, '0')}</span>
          <Editable as="b" path={`copy.home.leaders_step${n}_title`}>{copy(`home.leaders_step${n}_title`)}</Editable>
          <Editable as="p" path={`copy.home.leaders_step${n}_text`}>{copy(`home.leaders_step${n}_text`)}</Editable>
        </li>)}</ol>
      </section>,
    }[key]}</SectionFrame>)}
  </div>;
}
