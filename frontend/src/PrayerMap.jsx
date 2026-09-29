import { useEffect, useMemo, useState } from 'react';
import { MapContainer, TileLayer, GeoJSON, Marker, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { api } from './api.js';
import countryBorders from './data/countryBorders.json';

const newsIcon = L.divIcon({ className: 'news-pin', iconSize: [9, 9], iconAnchor: [4.5, 4.5] });

function beaconIcon(country, selected) {
  return L.divIcon({
    className: 'beacon' + (selected ? ' selected' : ''),
    html: `<span class="beacon-ring"></span><span class="beacon-ring delay"></span><span class="beacon-core"></span><span class="beacon-label">${country}</span>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

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
  const regionNews = useMemo(
    () => (selected ? news.filter(n => n.country_code === selected.country_code) : []),
    [news, selected]
  );
  const borderFeatures = useMemo(
    () => countryBorders.features.filter(f => regionByCode[f.properties.country_code]),
    [regionByCode]
  );

  const selectedCode = selected?.country_code;
  const beacons = useMemo(
    () => borderFeatures.map(f => {
      const region = regionByCode[f.properties.country_code];
      return {
        region,
        center: L.geoJSON(f).getBounds().getCenter(),
        icon: beaconIcon(region.country, region.country_code === selectedCode),
      };
    }),
    [borderFeatures, regionByCode, selectedCode]
  );

  function selectCountry(code) {
    const region = regionByCode[code];
    if (region) selectRegion(region);
  }

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
    <div className="map-legend">
      <span><span className="legend-dot region-dot" /> Missionary testimony · click to open</span>
      <span><span className="legend-dot news-dot" /> News story</span>
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
          key={`${borderFeatures.length}-${selectedCode}`}
          data={{ type: 'FeatureCollection', features: borderFeatures }}
          style={feature => feature.properties.country_code === selectedCode
            ? { className: 'region-glow selected', color: '#2d6349', weight: 1.5, fillColor: '#5f8f6b', fillOpacity: 0.6 }
            : { className: 'region-glow', color: 'transparent', weight: 0, fillColor: '#5f8f6b', fillOpacity: 0.4 }}
          onEachFeature={(feature, layer) => {
            layer.on('click', () => selectCountry(feature.properties.country_code));
          }}
        />
        {news.map(n => (
          <Marker key={n.id} position={[n.lat, n.lng]} icon={newsIcon}
            eventHandlers={{ click: () => selectCountry(n.country_code) }}>
            <Tooltip direction="top" offset={[0, -6]}>{n.headline}</Tooltip>
          </Marker>
        ))}
        {beacons.map(({ region, center, icon }) => (
          <Marker key={region.id} position={center} zIndexOffset={1000} icon={icon}
            eventHandlers={{ click: () => selectRegion(region) }}
          />
        ))}
      </MapContainer>
    </div>
    <div id="prayer-detail">
      {selected && <section className="panel prayer-card" aria-live="polite">
        <button className="close" aria-label="Close region details" onClick={() => { setSelected(null); setHistory([]); }}>×</button>
        <div className="eyebrow">{selected.country.toUpperCase()}</div>
        <h2>{selected.codename}</h2>
        <div className="source-columns">
          <div className="source-block">
            <div className="source-label">From the field</div>
            <p>{selected.testimony}</p>
          </div>
          <div className="source-block">
            <div className="source-label">In the news</div>
            {regionNews.length > 0
              ? regionNews.map(n => <article key={n.id}>
                  <b>{n.headline}</b>
                  <small>{n.city} · {n.source} · {n.date}</small>
                </article>)
              : <p>No recent news from {selected.country}.</p>}
          </div>
        </div>
        <div className="prayer-points">
          <b>Prayer points{latest && <span className="angle-pill">{latest.angle}</span>}</b>
          {latest && <ul>{latest.prayer_points.map((point, i) => <li key={i}>{point}</li>)}</ul>}
          <button className="primary" disabled={busy} onClick={generateAngle}>
            {busy ? 'Loading…' : latest ? 'Pray about something else' : 'Show prayer points'}
          </button>
        </div>
      </section>}
    </div>
  </div>;
}
