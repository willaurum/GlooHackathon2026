export default function ChurchMap({ query, address }) {
  return <div className="church-map">
    <iframe
      title="Map to the church"
      src={`https://maps.google.com/maps?q=${encodeURIComponent(query)}&output=embed`}
      loading="lazy"
      referrerPolicy="no-referrer-when-downgrade"
    />
    <div className="map-links">
      <a className="btn primary" href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(query)}`} target="_blank" rel="noopener noreferrer">Get directions</a>
      <a className="btn secondary" href={`https://maps.apple.com/?daddr=${encodeURIComponent(query)}`} target="_blank" rel="noopener noreferrer">Open in Apple Maps</a>
    </div>
    <p className="map-address">{address}</p>
  </div>;
}
