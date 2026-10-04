import { useEffect, useState } from 'react';
import { api } from './api.js';
import Icon from './Icon.jsx';
import { MISSION, STORY, VALUES } from './data/site.js';

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
        <button className="secondary" onClick={() => go('connect')}>Connect with us</button>
      </div>
    </section>
  </div>;
}
