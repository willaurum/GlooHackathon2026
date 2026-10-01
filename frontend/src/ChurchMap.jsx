import { useEffect, useMemo } from 'react';
import { MapContainer, TileLayer, Polygon, CircleMarker, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

const AREA = { color: '#ffffff', weight: 1.5, fillColor: '#c9dcc9', fillOpacity: 0.25 };
const AREA_ACTIVE = { color: '#ffd166', weight: 3, fillColor: '#ffd166', fillOpacity: 0.45 };
const BUILDING = { color: '#ffffff', weight: 2, fillColor: '#2b6248', fillOpacity: 0.55, interactive: false };

const MASK = { stroke: false, fillColor: '#0b1f16', fillOpacity: 0.55, interactive: false };
// The whole world as the outer ring; each allowed area is cut out as a hole.
const WORLD = [[-85, -180], [-85, 180], [85, 180], [85, -180]];

const boundsOf = spot => spot.kind === 'area' ? L.latLngBounds(spot.shape) : L.latLngBounds([spot.at, spot.at]);

// Zooms to the selected spot, or back out to the whole campus when nothing is selected.
function FocusOn({ spot, campus }) {
  const map = useMap();
  useEffect(() => {
    if (!spot) map.flyToBounds(campus, { padding: [24, 24], duration: 0.6 });
    else if (spot.kind === 'point') map.flyTo(spot.at, 19, { duration: 0.6 });
    else map.flyToBounds(boundsOf(spot), { padding: [48, 48], maxZoom: 19, duration: 0.6 });
  }, [map, spot, campus]);
  return null;
}

export default function ChurchMap({ building, spots, activeId, onSelect, maskIds = [] }) {
  const campus = useMemo(() => spots.reduce((b, s) => b.extend(boundsOf(s)), L.latLngBounds(building)), [building, spots]);
  const active = spots.find(s => s.id === activeId);
  const allowed = useMemo(() => spots.filter(s => s.kind === 'area' && maskIds.includes(s.id)).map(s => s.shape), [spots, maskIds]);

  return <div className="church-map">
    <MapContainer bounds={campus} boundsOptions={{ padding: [24, 24] }} scrollWheelZoom={false} style={{ height: '100%', width: '100%' }}>
      <TileLayer
        url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
        attribution='Imagery &copy; Esri, Maxar, Earthstar Geographics | Outlines &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        maxNativeZoom={19}
        maxZoom={20}
      />
      {allowed.length > 0 && <Polygon positions={[WORLD, ...allowed]} pathOptions={MASK} />}
      <Polygon positions={building} pathOptions={BUILDING} />
      {spots.map(s => {
        const on = s.id === activeId;
        const events = { click: () => onSelect(on ? null : s.id) };
        // Keyed on `on` so the tooltip remounts when it switches between hover-only and permanent.
        return s.kind === 'area'
          ? <Polygon key={s.id + on} positions={s.shape} pathOptions={on ? AREA_ACTIVE : AREA} eventHandlers={events}>
            <Tooltip permanent={on} direction="center">{s.label}</Tooltip>
          </Polygon>
          : <CircleMarker key={s.id + on} center={s.at} radius={on ? 11 : 7} pathOptions={{ color: '#ffffff', weight: 2, fillColor: on ? '#ffd166' : '#2b6248', fillOpacity: 1 }} eventHandlers={events}>
            <Tooltip permanent={on} direction="top" offset={[0, -8]}>{s.label}</Tooltip>
          </CircleMarker>;
      })}
      <FocusOn spot={active} campus={campus} />
    </MapContainer>
  </div>;
}
