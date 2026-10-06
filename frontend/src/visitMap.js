// Example campus for the Plan your visit map: the Limelight Boulder hotel, Boulder, CO (not a real church).
// Building and lot outlines, and the main entrance, come from OpenStreetMap (© OpenStreetMap contributors, ODbL).
// Which lot is for guests and the other doors are illustrative, for the demo only.

export const EXAMPLE_CAMPUS = {
  name: 'Limelight Boulder',
  address: 'University Avenue, Boulder, CO',
  directionsQuery: 'Limelight Boulder, Boulder, CO',
  building: [[40.011407, -105.277066], [40.011408, -105.276952], [40.011461, -105.276953], [40.011469, -105.276128], [40.01109, -105.276124], [40.010669, -105.27612], [40.010669, -105.276718], [40.010797, -105.276719], [40.010797, -105.27648], [40.011062, -105.276476], [40.011061, -105.276997], [40.011119, -105.276998], [40.011118, -105.277061]],
};

// kind 'area' outlines a lot; kind 'point' pins a door. `color` is shared by the map and the list beside it.
export const MAP_SPOTS = [
  {
    id: 'guest-parking',
    color: '#22c55e',
    kind: 'area',
    label: 'First-time guest parking',
    text: 'The parking structure on the north side. Reserved spaces on the ground level have green "Guest" signs, and a greeter in a lanyard can walk you in.',
    shape: [[40.012163, -105.276863], [40.012054, -105.276339], [40.011725, -105.276146], [40.01163, -105.276142], [40.011628, -105.276768], [40.012103, -105.277045]],
  },
  {
    id: 'main-parking',
    color: '#3b82f6',
    kind: 'area',
    label: 'Main parking',
    text: 'The lot just east of the main entrance. Accessible spaces are in the row closest to the building.',
    shape: [[40.011025, -105.275913], [40.010896, -105.275909], [40.010899, -105.275797], [40.010902, -105.275639], [40.010859, -105.275638], [40.010859, -105.275586], [40.010859, -105.275562], [40.011031, -105.275567]],
  },
  {
    id: 'overflow-parking',
    color: '#a855f7',
    kind: 'area',
    label: 'Overflow parking',
    text: 'When the main lot fills up on Sunday mornings, park here, a little farther east. It is a short walk to the main entrance.',
    shape: [[40.01103, -105.27554], [40.010739, -105.275536], [40.01074, -105.275351], [40.010974, -105.275355], [40.010975, -105.275178], [40.010974, -105.275138], [40.010976, -105.274892], [40.010978, -105.274867], [40.011035, -105.274868]],
  },
  {
    id: 'main-entrance',
    color: '#f97316',
    kind: 'point',
    label: 'Main entrance',
    text: 'Greeters meet you here, and the coffee bar is just inside the lobby. If you tapped "I\'m here", this is where your host will find you.',
    at: [40.01109, -105.276124],
  },
  {
    id: 'kids-check-in',
    color: '#ec4899',
    kind: 'point',
    label: 'Kids check-in',
    text: 'The south doors lead straight to the Kids Welcome desk, where a volunteer prints matching name and pickup tags.',
    at: [40.010669, -105.27642],
  },
  {
    id: 'accessible-entrance',
    color: '#06b6d4',
    kind: 'point',
    label: 'Accessible entrance',
    text: 'A step-free entrance facing the parking structure, with elevator access and reserved seating near the front.',
    at: [40.011465, -105.27655],
  },
];

// Where guests may park. The map dims everything outside these areas; edit this list to change them.
export const ALLOWED_PARKING_IDS = ['guest-parking', 'main-parking', 'overflow-parking'];
