import { useEffect, useMemo, useState } from 'react';
import { MapContainer, TileLayer, GeoJSON, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { api } from './api.js';
import { useChurch } from './ChurchContext.js';
import { SetUpThis } from './ChurchStates.jsx';
import countryBorders from './data/countryBorders.json';

const newsIcon = L.divIcon({ className: 'news-pin', iconSize: [12, 12], iconAnchor: [6, 6] });

function FitToBorders({ features }) {
  const map = useMap();
  useEffect(() => {
    if (!features.length) return;
    const bounds = L.geoJSON(features).getBounds();
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40] });
  }, [features, map]);
  return null;
}

export default function PrayerMap() {
  const { staff } = useChurch();
  const [regions, setRegions] = useState([]);
  const [news, setNews] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [history, setHistory] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true); setError('');
      try {
        const [r, n] = await Promise.all([api('/regions'), api('/news')]);
        setRegions(r); setNews(n);
      } catch (err) {
        setError('Could not load prayer map data. Check that the backend is running. ' + err.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (selected) document.getElementById('prayer-detail')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [selected]);

  const regionByCode = useMemo(() => Object.fromEntries(regions.map(r => [r.country_code, r])), [regions]);
  const newsById = useMemo(() => Object.fromEntries(news.map(n => [n.id, n])), [news]);
  const borderFeatures = useMemo(
    () => countryBorders.features.filter(f => regionByCode[f.properties.country_code]),
    [regionByCode]
  );

  async function selectRegion(region) {
    setSelected(region);
    setBusy(true); setError('');
    try {
      setHistory(await api(`/regions/${region.id}/prayer-angles`));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function generateAngle() {
    if (!selected) return;
    setBusy(true); setError('');
    try {
      const angle = await api(`/regions/${selected.id}/prayer-angles`, { method: 'POST' });
      setHistory(previous => [...previous, angle]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const latest = history[history.length - 1];

  return <div className="prayer-map">
    {error && <div className="api-message" role="alert">{error}</div>}
    {loading && <p role="status">Loading prayer map data…</p>}
    {!loading && !error && !regions.length && <SetUpThis icon="compass" title="No prayer map yet."
      text="This church has not added the places it prays for yet."
      staffText="The prayer map shows the places your missionaries serve. Adding regions from Church setup is coming next." />}
    <div className="map-legend">
      <span><span className="legend-dot news-dot" /> Real news — exact city</span>
      <span><span className="legend-dot region-dot" /> Missionary presence — whole country only, never an exact point</span>
    </div>
    <div className="map-shell">
      <MapContainer center={[20, 40]} zoom={2} scrollWheelZoom style={{ height: '100%', width: '100%' }}>
        <TileLayer
          url="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}"
          attribution="Tiles &copy; Esri &mdash; Esri, HERE, Garmin, OpenStreetMap contributors"
          maxNativeZoom={16}
        />
        <FitToBorders features={borderFeatures} />
        <GeoJSON
          key={borderFeatures.length}
          data={{ type: 'FeatureCollection', features: borderFeatures }}
          style={() => ({ className: 'region-glow', color: 'transparent', weight: 0, fillColor: '#5f8f6b', fillOpacity: 0.45 })}
          onEachFeature={(feature, layer) => {
            layer.on('click', () => {
              const region = regionByCode[feature.properties.country_code];
              if (region) selectRegion(region);
            });
          }}
        />
        {news.map(n => (
          <Marker key={n.id} position={[n.lat, n.lng]} icon={newsIcon}>
            <Popup>
              <strong>{n.headline}</strong><br />
              {n.city}, {n.country} · {n.source} · {n.date}
              <p>{n.summary}</p>
            </Popup>
          </Marker>
        ))}
      </MapContainer>
    </div>
    <div id="prayer-detail">
      {selected && <section className="panel prayer-card" aria-live="polite">
        <button className="close" aria-label="Close region details" onClick={() => { setSelected(null); setHistory([]); }}>×</button>
        <div className="eyebrow">{selected.country.toUpperCase()} · SOFT PRESENCE, NOT AN EXACT LOCATION</div>
        <h2>{selected.codename}</h2>
        <p><b>{selected.field_of_ministry}</b> · serving since {selected.since} · team of {selected.team_size}</p>
        <p>{selected.testimony}</p>
        {latest && <>
          <span className="angle-pill">Angle: {latest.angle}</span>
          <p className="situational-summary">{latest.summary}</p>
          <div className="reason">
            <b>Prayer points</b>
            <ul>{latest.prayer_points.map((point, i) => <li key={i}>{point}</li>)}</ul>
          </div>
          {latest.source_news_ids.length > 0 && <small className="requirement">
            Sourced from: {latest.source_news_ids.map(id => newsById[id]?.headline).filter(Boolean).join(' · ')}
          </small>}
        </>}
        {staff && <button className="primary" disabled={busy} onClick={generateAngle}>
          {busy ? 'Working…' : latest ? 'Generate another angle →' : 'Reveal this region’s story →'}
        </button>}
      </section>}
    </div>
  </div>;
}
