// Chat page suggestions name a page key (backend chat.SITE_PAGES); only these keys can navigate.
const pages = {
  home: ['Home', ''],
  'plan-visit': ['Plan your visit', 'guests/plan'],
  ministries: ['Ministries', 'serve'],
  'find-place': ['Find a place', 'serve/find'],
  calendar: ['Calendar', 'calendar'],
  give: ['Give', 'give'],
  'prayer-map': ['Prayer map', 'prayer'],
};
// Sections within a page (backend chat.SITE_SECTIONS): [label, element id to scroll to].
const sections = {
  home: { 'service-times': ['Service times', 'home-service-times'] },
  'plan-visit': {
    'service-times': ['Service times', 'visit-service-times'],
    'what-to-expect': ['What to expect', 'visit-what-to-expect'],
    // Parking and kids check-in live in the Find your way card, alongside the map.
    'good-to-know': ['Parking, entrances & kids check-in', 'visit-map'],
    map: ['Map & directions', 'visit-map'],
    'next-steps': ['A good place to start', 'visit-next-steps'],
    'sign-up': ['Let us know you’re coming', 'visit-sign-up'],
  },
};

// An unknown section falls back to the top of a valid page.
const section = action => Object.hasOwn(sections, action.page) && Object.hasOwn(sections[action.page], action.section)
  ? sections[action.page][action.section] : null;

export function navigationPage(action) {
  if (action?.tool !== 'suggest_page' || !Object.hasOwn(pages, action.page)) return null;
  const part = section(action);
  return pages[action.page][0] + (part ? ' · ' + part[0] : '');
}

export function followSuggestion(action, onNavigate) {
  if (!navigationPage(action) || !onNavigate) return false;
  onNavigate(pages[action.page][1], section(action)?.[1]);
  return true;
}
