import { useEffect, useMemo } from 'react';
import { MapContainer, TileLayer, Polygon, CircleMarker, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Every spot shows in its own colour from the start; selecting one makes it bolder.
const areaStyle = (color, on) => ({ color: on ? '#ffffff' : color, weight: on ? 4 : 2, fillColor: color, fillOpacity: on ? 0.6 : 0.35 });
const pointStyle = (color, on) => ({ color: '#ffffff', weight: on ? 3 : 2, fillColor: color, fillOpacity: 1 });
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

export default function ChurchMap(props) {
  if (props.center) return <div className="church-map">
    <MapContainer key={props.center.join(',')} center={props.center} zoom={props.approximate ? 12 : 16} scrollWheelZoom={false} style={{ height: '100%', width: '100%' }}>
      <TileLayer url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' />
      <CircleMarker center={props.center} radius={8} pathOptions={pointStyle('#2b6248', false)}>
        <Tooltip>{props.name}</Tooltip>
      </CircleMarker>
    </MapContainer>
  </div>;
  return <CampusMap {...props} />;
}

function CampusMap({ building, spots, activeId, onSelect, maskIds = [] }) {
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
          ? <Polygon key={s.id + on} positions={s.shape} pathOptions={areaStyle(s.color, on)} eventHandlers={events}>
            <Tooltip permanent={on} direction="center">{s.label}</Tooltip>
          </Polygon>
          : <CircleMarker key={s.id + on} center={s.at} radius={on ? 11 : 8} pathOptions={pointStyle(s.color, on)} eventHandlers={events}>
            <Tooltip permanent={on} direction="top" offset={[0, -8]}>{s.label}</Tooltip>
          </CircleMarker>;
      })}
      <FocusOn spot={active} campus={campus} />
    </MapContainer>
  </div>;
}
