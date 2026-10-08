// Which events the calendar lists beside the month grid, and the heading over them.
//   - a picked day: that day's events
//   - a search: matching events from any month
//   - "Upcoming": today or later, from any month
//   - otherwise: the month the grid is showing

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** YYYY-MM-DD for a Date in the visitor's own time zone (event dates are local calendar days). */
export function isoDay(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function matchesQuery(event, query) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [event.title, event.description, event.location, event.ministry_name, event.ai_summary]
    .some(field => typeof field === 'string' && field.toLowerCase().includes(q));
}

/** events: the church's events; month is 0-based; today is YYYY-MM-DD. */
export function eventsToList(events, { view = 'month', year, month, selectedDate = null, category = 'All', query = '', today = isoDay() }) {
  const prefix = `${year}-${String(month + 1).padStart(2, '0')}-`;
  return events.filter(event => {
    if (category !== 'All' && event.category !== category) return false;
    if (selectedDate) return event.date === selectedDate && matchesQuery(event, query);
    if (query.trim()) return matchesQuery(event, query);
    if (view === 'upcoming') return String(event.date) >= today;
    return String(event.date).startsWith(prefix);
  });
}

export function listHeading({ view = 'month', year, month, selectedDate = null, category = 'All', query = '' }) {
  const kind = category !== 'All' ? `${category} events` : 'Events';
  if (selectedDate) return `${kind} on ${selectedDate}`;
  if (query.trim()) return `${kind} matching "${query.trim()}"`;
  if (view === 'upcoming') return category !== 'All' ? `Upcoming ${category} events` : 'Upcoming events';
  return `${kind} in ${MONTH_NAMES[month]} ${year}`;
}
