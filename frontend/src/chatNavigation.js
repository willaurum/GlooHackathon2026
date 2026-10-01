// Chat page suggestions name a page key (backend chat.SITE_PAGES); only these keys can navigate.
const pages = {
  home: ['Home', ''],
  'plan-visit': ['Plan your visit', 'guests/plan'],
  ministries: ['Ministries', 'serve'],
  'find-place': ['Find a place', 'serve/find'],
  'saved-connections': ['Saved', 'serve/saved'],
  calendar: ['Calendar', 'calendar'],
  give: ['Give', 'give'],
  'prayer-map': ['Prayer map', 'prayer/map'],
};

export function navigationPage(action) {
  return action?.tool === 'suggest_page' && Object.hasOwn(pages, action.page)
    ? pages[action.page][0] : null;
}

export function followSuggestion(action, onNavigate) {
  if (!navigationPage(action) || !onNavigate) return false;
  onNavigate(pages[action.page][1]);
  return true;
}
