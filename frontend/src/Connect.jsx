// Placeholder: replace this file with the real Connect page. App passes { go, onAsk }.
export default function Connect({ go, onAsk }) {
  return <section className="card about-block">
    <div className="eyebrow">Connect</div>
    <h2>Coming soon</h2>
    <p>This page is being built. In the meantime, ask Belong or plan a visit.</p>
    <div className="about-actions">
      <button className="secondary" onClick={onAsk}>Ask Belong</button>
      <button className="secondary" onClick={() => go('guests/plan')}>Plan your visit</button>
    </div>
  </section>;
}
