import { BELIEFS } from './data/site.js';

export default function Beliefs() {
  return <div className="about">
    <section className="card about-block">
      <div className="eyebrow">Statement of belief</div>
      <h2>What we hold to</h2>
      <p>These are the convictions that shape our teaching and our life together. They are shared by Christians across many traditions. Questions are welcome: ask a pastor, or come to Discover Grace on the first Sunday of the month.</p>
    </section>
    <ol className="beliefs">
      {BELIEFS.map((b, i) => <li key={b.title} className="card belief">
        <span className="belief-num">{String(i + 1).padStart(2, '0')}</span>
        <div><h3>{b.title}</h3><p>{b.text}</p></div>
      </li>)}
    </ol>
  </div>;
}
