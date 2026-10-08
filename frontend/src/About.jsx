import { useEffect, useState } from 'react';
import { api } from './api.js';
import { useChurch } from './ChurchContext.js';
import { pageOfType } from './churchSite.js';
import Icon from './Icon.jsx';
import { paragraphs } from './site.js';
import { SitePageBody } from './SitePages.jsx';
import about from './data/about.json';
const { mission: MISSION, story: STORY, values: VALUES } = about;

export default function About({ go }) {
  const [info, setInfo] = useState(null);
  useEffect(() => { api('/info').then(setInfo).catch(() => {}); }, []);

  return <div className="about">
    <section className="card about-block about-mission">
      <div className="eyebrow">Our mission</div>
      <h2>{MISSION}</h2>
    </section>

    <section className="card about-block">
      <div className="eyebrow">Our story</div>
      <h2>A big church that still feels personal</h2>
      {STORY.map(p => <p key={p.slice(0, 24)}>{p}</p>)}
    </section>

    <section>
      <div className="eyebrow">What we value</div>
      <div className="values">
        {VALUES.map(v => <article key={v.title} className="card value">
          <span className={'icon ' + v.color}><Icon name={v.icon} size={22} /></span>
          <h3>{v.title}</h3>
          <p>{v.text}</p>
        </article>)}
      </div>
    </section>

    <section className="card about-block">
      <div className="eyebrow">Find us</div>
      <h2>Come visit</h2>
      {info ? <>
        <p>{info.address}</p>
        {info.office_hours && <p>Office hours: {info.office_hours}</p>}
      </> : <p>We meet Sundays at 9:00am and 11:00am, and Wednesdays at 6:30pm.</p>}
      <div className="about-actions">
        <button className="primary" onClick={() => go('guests/plan')}>Plan your visit<Icon name="arrow" size={18} /></button>
        <button className="secondary" onClick={() => go('about/beliefs')}>What we believe</button>
        <button className="secondary" onClick={() => go('about/connect')}>Connect with us</button>
      </div>
    </section>
  </div>;
}

// Our story for a church other than the demo: the about page Tekton imported from its website, or its own
// About text from Church setup.
export function ChurchStory({ go }) {
  const church = useChurch();
  const [info, setInfo] = useState(null);
  useEffect(() => { api('/info').then(setInfo).catch(() => {}); }, []);
  const page = pageOfType(church.pages, 'about');
  return <div className="about">
    {page ? <SitePageBody slug={page.slug} /> : info && <section className="card about-block">
      <div className="eyebrow">Our story</div>
      <h2>{info.name || church.name}</h2>
      {info.about ? paragraphs(info.about).map(p => <p key={p.slice(0, 24)}>{p}</p>)
        : <p>{church.name} has not shared its story here yet. {church.staff ? 'Add it in Church setup.' : 'Ask Tekton or the church office in the meantime.'}</p>}
    </section>}
    <section className="card about-block">
      <div className="eyebrow">Find us</div>
      <h2>Come visit</h2>
      {info?.address && <p>{info.address}</p>}
      {info?.office_hours && <p>Office hours: {info.office_hours}</p>}
      <div className="about-actions">
        <button className="primary" onClick={() => go('guests/plan')}>Plan your visit<Icon name="arrow" size={18} /></button>
        {pageOfType(church.pages, 'beliefs') && <button className="secondary" onClick={() => go('about/beliefs')}>What we believe</button>}
        <button className="secondary" onClick={() => go('about/connect')}>Connect with us</button>
      </div>
    </section>
  </div>;
}

// Beliefs for a church other than the demo: its statement of belief, imported by Tekton.
export function ChurchBeliefs({ go }) {
  const church = useChurch();
  const page = pageOfType(church.pages, 'beliefs');
  if (page) return <SitePageBody slug={page.slug} />;
  return <section className="card about-block">
    <p>{church.name} has not shared a statement of belief here yet. Questions about faith are always welcome: ask a pastor or the church office.</p>
    <div className="about-actions"><button className="secondary" onClick={() => go('about/directory')}>Who to contact</button></div>
  </section>;
}
