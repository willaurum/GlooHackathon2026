import { DEMO_CHURCH } from './church.js';
import { useChurch } from './ChurchContext.js';
import Icon from './Icon.jsx';

const SECTION_NAMES = { '': 'This page', guests: 'Plan your visit', serve: 'Serving', notes: 'Sermon Notes', calendar: 'The calendar', prayer: 'The prayer map', setup: 'Church setup' };

// Giving works while the church API waits for deployment.
export function ChurchNotReady({ section }) {
  const { name, go } = useChurch();
  return <div className="page">
    <section className="card church-state" role="status">
      <span className="icon color1"><Icon name="sparkle" size={24} /></span>
      <div className="eyebrow">{name}</div>
      <h1>{SECTION_NAMES[section] ?? 'This page'} is almost ready.</h1>
      <p>Online giving already works for {name}. Visits, serving, sermons, the calendar and the chat open here as soon as the updated church service is deployed. Nothing for you to do.</p>
      <div className="hero-actions">
        <button className="primary" onClick={() => go('give')}><Icon name="heart" size={18} />Go to giving</button>
      </div>
    </section>
  </div>;
}

export function ChurchMissing() {
  const { choose } = useChurch();
  return <div className="page">
    <section className="card church-state" role="alert">
      <span className="icon color0"><Icon name="search" size={24} /></span>
      <h1>We could not find that church.</h1>
      <p>The link may be old, or the church may have changed its address. Ask your church for its current link. You can also look around the demo church.</p>
      <div className="hero-actions">
        <button className="primary" onClick={() => choose(DEMO_CHURCH)}>See the demo church</button>
      </div>
    </section>
  </div>;
}

// Screens with guests or members contact details, on a church that is not the shared demo.
export function StaffOnly({ what }) {
  const { name, go } = useChurch();
  return <section className="card church-state staff-only">
    <span className="icon color2"><Icon name="lock" size={24} /></span>
    <h2>{what} is for {name} staff.</h2>
    <p>It shows people and their contact details, so only signed-in church staff can see it.</p>
    <button className="primary" onClick={() => go('setup')}><Icon name="lock" size={18} />Staff sign in</button>
  </section>;
}

// An empty section on a new church: tells visitors it is coming, and staff where to fill it in.
export function SetUpThis({ icon = 'sparkle', title, text, staffText }) {
  const { staff, go } = useChurch();
  return <section className="card church-state empty-state">
    <span className="icon color3"><Icon name={icon} size={24} /></span>
    <h2>{title}</h2>
    <p>{staff ? staffText : text}</p>
    {staff && <button className="primary" onClick={() => go('setup')}>Open church setup<Icon name="arrow" size={18} /></button>}
  </section>;
}
