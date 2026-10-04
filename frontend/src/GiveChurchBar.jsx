// Which church the Give pages are for. There is no way to switch here: churches do not see each
// other, and a donor reaches a church by its own link.
export default function GiveChurchBar({ church, slug, label = 'Giving to' }) {
  const name = church?.name || slug;
  return <div className="card give-church">
    <div className="give-church-row">
      <span className="give-church-mark" aria-hidden="true">{(name || '?').slice(0, 1).toUpperCase()}</span>
      <div className="give-church-name"><small>{label}</small><strong>{name}</strong>{church?.city && <small>{church.city}</small>}</div>
    </div>
  </div>;
}
