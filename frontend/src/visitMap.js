// Example campus for the Plan your visit map: Thomas Road Baptist Church, Lynchburg, VA.
// Building and lot outlines come from OpenStreetMap (© OpenStreetMap contributors, ODbL).
// Which lot is for guests, and where each door is, are illustrative, not the church's real guidance.

export const EXAMPLE_CAMPUS = {
  name: 'Thomas Road Baptist Church',
  address: 'Mountain View Road, Lynchburg, VA',
  directionsQuery: 'Thomas Road Baptist Church, Lynchburg, VA',
  building: [[37.361202, -79.173065], [37.360477, -79.17369], [37.360107, -79.173012], [37.360124, -79.172997], [37.360742, -79.172465], [37.360833, -79.172386]],
};

// kind 'area' outlines a lot; kind 'point' pins a door.
export const MAP_SPOTS = [
  {
    id: 'guest-parking',
    kind: 'area',
    label: 'First-time guest parking',
    text: 'Reserved spaces right outside the main entrance. Look for the green "Guest" signs and a greeter in a lanyard.',
    shape: [[37.36158, -79.17275], [37.361364, -79.172954], [37.361154, -79.17255], [37.361097, -79.172502], [37.361073, -79.172454], [37.361289, -79.172258], [37.361319, -79.172311], [37.361336, -79.172294]],
  },
  {
    id: 'main-parking',
    kind: 'area',
    label: 'Main parking',
    text: 'The large lot on the west side. Accessible spaces are in the row closest to the building.',
    shape: [[37.361777, -79.173042], [37.36064, -79.174073], [37.360604, -79.1741], [37.360802, -79.17447], [37.360814, -79.174458], [37.36106, -79.174708], [37.362158, -79.173698]],
  },
  {
    id: 'overflow-parking',
    kind: 'area',
    label: 'Overflow parking',
    text: 'When the main lot fills up on Sunday mornings, park here. It is a short walk to the main entrance.',
    shape: [[37.360604, -79.1741], [37.359822, -79.174612], [37.359771, -79.174681], [37.359757, -79.17475], [37.359882, -79.1751], [37.360203, -79.174868], [37.360802, -79.17447]],
  },
  {
    id: 'main-entrance',
    kind: 'point',
    label: 'Main entrance',
    text: 'Greeters meet you here, and the coffee bar is just inside the lobby. If you tapped "I\'m here", this is where your host will find you.',
    at: [37.36102, -79.17273],
  },
  {
    id: 'kids-check-in',
    kind: 'point',
    label: 'Kids check-in',
    text: 'The east doors lead straight to the Kids Welcome desk, where a volunteer prints matching name and pickup tags.',
    at: [37.36079, -79.17246],
  },
  {
    id: 'accessible-entrance',
    kind: 'point',
    label: 'Accessible entrance',
    text: 'A step-free entrance facing the main lot, with elevator access and reserved seating near the front.',
    at: [37.36084, -79.17338],
  },
];
