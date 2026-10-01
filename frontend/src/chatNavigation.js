const pages = {
  overview: 'Overview',
  ministries: 'Ministries',
  'find-place': 'Find a place',
  'saved-connections': 'Saved connections',
  'our-vision': 'Our vision',
};

export function navigationPage(action) {
  return action?.tool === 'suggest_page' && Object.hasOwn(pages, action.page)
    ? pages[action.page] : null;
}

export function followSuggestion(action, onNavigate) {
  const page = navigationPage(action);
  if (!page || !onNavigate) return false;
  onNavigate(page);
  return true;
}
