import { Fragment, useEffect, useState } from 'react';
import { api, fmt } from './api.js';
import { hashFor } from './church.js';
import { useChurch } from './ChurchContext.js';
import { livestreamLink, orderedSections, pageHidden, pageOfType, siteImage } from './churchSite.js';
import { loadChurch, percent } from './giving.js';
import Icon from './Icon.jsx';
import { safeHref } from './site.js';
import Sourced from './Sourced.jsx';
import SiteImage from './SiteImage.jsx';
import { useVisualEditor } from './VisualEditorContext.jsx';
import EditableText from './EditableText.jsx';
import SectionControls from './SectionControls.jsx';

// The Home sections in their usual order; a church can reorder or hide them by asking Tekton (site.layout, the keys
// of backend builder_edit.PAGES['home']).
export const HOME_SECTIONS = ['features', 'about', 'ministries', 'sermons', 'service_times', 'leaders'];

const SECTION_LABELS = {
  features: 'Key Features (Serve, Notes, Give)',
  about: 'Get to know us',
  ministries: 'Ministries',
  sermons: 'Recent sermons',
  service_times: 'Service times',
  leaders: 'For church leaders',
};

const SETUP_LINKS = {
  service_times: 'setup-services',
  ministries: 'setup-teams',
};

const STEPS = [
  ['See the need', 'A shared view of volunteer coverage and what each team does.'],
  ['Know the person', 'Start with their gifts, interests and time.'],
  ['Connect with care', 'The assistant suggests possibilities. People lead the relationship.'],
];

export default function Home({ go, onAsk }) {
  const church = useChurch();
  const editor = useVisualEditor();
  const [info, setInfo] = useState(null), [giving, setGiving] = useState(null), [sermons, setSermons] = useState([]);
  const [ministries, setMinistries] = useState([]);
  useEffect(() => {
    api('/info').then(setInfo).catch(() => {});
    api('/ministries').then(list => setMinistries(Array.isArray(list) ? list : [])).catch(() => {});
    loadChurch(church.slug).then(setGiving).catch(() => {});
    // Sermons the church publishes on its website (imported by Tekton or added in Church setup).
    if (!church.demo) api('/church').then(c => setSermons((c.sermons || []).filter(s => safeHref(s.url)))).catch(() => {});
  }, []);

  const effectiveInfo = editor?.content?.info || info;
  const currentLayout = editor?.content?.site?.layout || church.site?.layout;
  const isEditing = editor?.isEditing && !editor?.isPreviewing;

  const live = livestreamLink(church.site);
  const hero = siteImage(church.site, 'hero');
  const recent = [...sermons].sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 3);
  // The first fund with a goal gets the progress bar on the Give card.
  const goal = giving && [...giving.funds, ...giving.trips].find(f => f.goal > 0);
  const newChurch = !church.demo && effectiveInfo && !effectiveInfo.services?.length;
  // Up to six teams on Home; the demo church shows its own on Serve.
  const shownMinistries = church.demo ? [] : ministries.slice(0, 6);

  // In edit mode show all sections with hidden indicator; otherwise use orderedSections
  const sectionsToRender = isEditing
    ? (currentLayout?.home?.length ? [...new Set([...currentLayout.home, ...HOME_SECTIONS])] : HOME_SECTIONS)
    : orderedSections(currentLayout, 'home', HOME_SECTIONS);

  function moveSection(key, dir) {
    const list = [...(currentLayout?.home?.length ? currentLayout.home : HOME_SECTIONS)];
    const i = list.indexOf(key);
    if (i === -1) return;
    const target = i + dir;
    if (target < 0 || target >= list.length) return;
    const [item] = list.splice(i, 1);
    list.splice(target, 0, item);
    editor?.reorderHomeSections(list);
  }

  function isSectionHidden(key) {
    return (currentLayout?.hidden || []).includes(`home:${key}`);
  }

  return <div className="page home">
    <section className={'home-hero' + (hero ? ' has-image' : '')}>
      <div className="home-hero-copy">
      <div className="eyebrow">{effectiveInfo?.name || church.name}</div>
      {isEditing ? (
        <EditableText
          value={effectiveInfo?.tagline || ''}
          placeholder="A place to belong, grow and give."
          onChange={val => editor?.updateInfo('tagline', val)}
          isHeading
          level={1}
        />
      ) : (
        <h1>{effectiveInfo?.tagline || <>A place to belong,<br />grow and give.</>}</h1>
      )}
      {isEditing ? (
        <EditableText
          value={effectiveInfo?.about || ''}
          placeholder="Find where your gifts fit, catch up on Sunday’s message, and support the mission. All in one place."
          onChange={val => editor?.updateInfo('about', val)}
          tag="p"
          multiline
        />
      ) : (
        <p>{effectiveInfo?.about ? <Sourced field="about">{effectiveInfo.about}</Sourced> : 'Find where your gifts fit, catch up on Sunday’s message, and support the mission. All in one place.'}</p>
      )}
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

    {/* In the order the church asked Tekton for (site.layout), with Visual Editor section controls in Edit Mode. */}
    {sectionsToRender.map((key, secIndex) => <Fragment key={key}>
      {isEditing && (
        <SectionControls
          sectionKey={key}
          sectionLabel={SECTION_LABELS[key] || key}
          canMoveUp={secIndex > 0}
          canMoveDown={secIndex < sectionsToRender.length - 1}
          onMoveUp={() => moveSection(key, -1)}
          onMoveDown={() => moveSection(key, 1)}
          isHidden={isSectionHidden(key)}
          onToggleHide={() => editor?.toggleSectionVisibility('home', key)}
          setupLink={SETUP_LINKS[key]}
          onOpenSetup={() => go('setup')}
        />
      )}
      {{
      features: <div className={`features ${isEditing && isSectionHidden(key) ? 'is-hidden-section' : ''}`}>
        {!pageHidden(church.site, 'serve') && <a className="card feature" href={hashFor(church.slug, 'serve')} onClick={e => { e.preventDefault(); go('serve'); }}>
          <span className="icon color1"><Icon name="users" size={22} /></span>
          <h2>Serve</h2>
          <p>Browse ministry teams, see where help is needed, and match members to a place that fits.</p>
          <span className="link">Explore ministries<Icon name="arrow" size={16} /></span>
        </a>}
        {!pageHidden(church.site, 'notes') && <a className="card feature" href={hashFor(church.slug, 'notes')} onClick={e => { e.preventDefault(); go('notes'); }}>
          <span className="icon color3"><Icon name="book" size={22} /></span>
          <h2>Sermon Notes</h2>
          <p>Read past sermons and ask questions. Answers quote the message with timestamps.</p>
          <span className="link">Open sermon notes<Icon name="arrow" size={16} /></span>
        </a>}
        {!pageHidden(church.site, 'give') && <a className="card feature" href={hashFor(church.slug, 'give')} onClick={e => { e.preventDefault(); go('give'); }}>
          <span className="icon color0"><Icon name="heart" size={22} /></span>
          <h2>Give</h2>
          {goal ? <>
            <p>{goal.name}: <b>{fmt(goal.raised, giving.currency)}</b> of {fmt(goal.goal, giving.currency)}</p>
            <div className="progress" aria-hidden="true"><span style={{ width: percent(goal.raised, goal.goal) + '%' }} /></div>
          </> : <p>Support the mission with a gift, in a couple of taps.</p>}
          <span className="link">Give online<Icon name="arrow" size={16} /></span>
        </a>}
      </div>,
      about: <div className={isEditing && isSectionHidden(key) ? 'is-hidden-section' : ''}>
      <section className="know-us" aria-label="Get to know us">
        <div className="eyebrow">Get to know us</div>
        <div className="know-links">
          <button className="secondary" onClick={() => go('about')}><Icon name="info" size={18} />Our story</button>
          {(church.demo || pageOfType(church.pages, 'beliefs')) && <button className="secondary" onClick={() => go('about/beliefs')}><Icon name="book" size={18} />What we believe</button>}
          <button className="secondary" onClick={() => go('about/news')}><Icon name="news" size={18} />News</button>
          <button className="secondary" onClick={() => go('about/directory')}><Icon name="phone" size={18} />Contact directory</button>
          <button className="primary" onClick={() => go('about/connect')}><Icon name="mail" size={18} />Connect with us</button>
        </div>
      </section></div>,
      ministries: ((shownMinistries.length > 0 || isEditing) && <section className={`card week home-ministries ${isEditing && isSectionHidden(key) ? 'is-hidden-section' : ''}`} id="home-ministries">
        <div className="week-head">
          <div><div className="eyebrow">Get involved</div><h2>Ministries</h2></div>
          {!pageHidden(church.site, 'serve') && <button className="link" onClick={() => go('serve')}>Find a place to serve<Icon name="arrow" size={16} /></button>}
        </div>
        <ul>{shownMinistries.map(m => <li key={m.id ?? m.name}>
          <strong><Sourced list="ministries" name={m.name}>{m.name}</Sourced></strong>
          {m.description && <small>{m.description}</small>}
        </li>)}</ul>
      </section>),
      sermons: ((recent.length > 0 || isEditing) && <section className={`card week home-sermons ${isEditing && isSectionHidden(key) ? 'is-hidden-section' : ''}`} id="home-sermons">
        <div className="week-head">
          <div><div className="eyebrow">Watch &amp; listen</div><h2>Recent sermons</h2></div>
          {!pageHidden(church.site, 'notes') && <button className="link" onClick={() => go('notes')}>All sermons<Icon name="arrow" size={16} /></button>}
        </div>
        <ul>{recent.map(s => <li key={s.id ?? s.url}>
          <a className="link" href={safeHref(s.url)} target="_blank" rel="noopener noreferrer">{s.title}</a>
          <small>{[s.date, s.speaker, s.series, s.scripture].filter(Boolean).join(' · ')}</small>
        </li>)}</ul>
      </section>),
      service_times: ((effectiveInfo?.services?.length > 0 || isEditing) && <section className={`card week ${isEditing && isSectionHidden(key) ? 'is-hidden-section' : ''}`} id="home-service-times">
        <div className="week-head">
          <div><div className="eyebrow">Join us</div><h2>Service times</h2></div>
          {effectiveInfo?.address && <small><Icon name="pin" size={16} /><Sourced field="address">{effectiveInfo.address}</Sourced></small>}
        </div>
        <div className="services">
          {(effectiveInfo?.services || []).map(s => <div className="service" key={s.day + s.time}>
            <strong><Sourced field="services">{s.day} · {s.time}</Sourced></strong>
            <p>{s.note}</p>
          </div>)}
        </div>
      </section>),
      leaders: <section className={`leaders ${isEditing && isSectionHidden(key) ? 'is-hidden-section' : ''}`}>
        <div>
          <div className="eyebrow">For church leaders</div>
          <h2>A big church can still feel personal.</h2>
          <p>Tekton helps leaders turn a desire to serve into a real connection: see which teams need people, meet a member where they are, and hand off to the right ministry lead.</p>
        </div>
        <ol className="steps">{STEPS.map(([title, text], i) => <li key={title}><span>{String(i + 1).padStart(2, '0')}</span><b>{title}</b><p>{text}</p></li>)}</ol>
      </section>,
    }[key]}</Fragment>)}
  </div>;
}
