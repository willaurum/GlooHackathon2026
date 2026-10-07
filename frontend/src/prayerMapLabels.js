// Country labels on the prayer map overlap on a phone at the zoom that fits every country
// (Nepal sits under India's label). On a narrow map below LABEL_ZOOM only the selected
// country keeps its label; tapping a beacon selects it, and zooming in brings the rest back.
export const LABEL_ZOOM = 4;
export const NARROW_MAP = 700;

export const compactLabels = (zoom, width) => zoom < LABEL_ZOOM && width < NARROW_MAP;
