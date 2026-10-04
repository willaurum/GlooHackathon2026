// Placeholder: replace this file with the real News page. App passes { go }.
export default function News({ go }) {
  return <section className="card about-block">
    <div className="eyebrow">News</div>
    <h2>Coming soon</h2>
    <p>This page is being built.</p>
    <div className="about-actions"><button className="secondary" onClick={() => go('calendar')}>See the calendar</button></div>
  </section>;
}
