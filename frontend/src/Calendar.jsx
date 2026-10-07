import { useState, useEffect } from 'react';
import { api } from './api.js';
import { useChurch } from './ChurchContext.js';
import { eventsToList, isoDay, listHeading } from './calendarList.js';

const CATEGORIES = [
  'All',
  'Worship',
  'Youth & Kids',
  'Discipleship',
  'Outreach',
  'Fellowship',
  'Hospitality',
  'Creative Arts',
  'Next Generation',
];

const CATEGORY_COLORS = {
  'Worship': '#729564',
  'Youth & Kids': '#b88963',
  'Discipleship': '#9b8bbd',
  'Outreach': '#b4a057',
  'Fellowship': '#819fbd',
  'Hospitality': '#b98da0',
  'Creative Arts': '#5b9b8b',
  'Next Generation': '#bd7b60',
};

export default function Calendar({ setError = () => {} }) {
  const church = useChurch();
  // Calendar writes require staff, including on the demo church.
  const canEdit = church.staff;
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [selectedDate, setSelectedDate] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  // 'month': the month the grid shows. 'upcoming': today or later, from any month.
  const [listView, setListView] = useState('month');
  const [showAddModal, setShowAddModal] = useState(false);
  const [busy, setBusy] = useState(false);

  // Default to September 2026 (or current date if later)
  const [currentMonthDate, setCurrentMonthDate] = useState(() => {
    const today = new Date();
    // If today is in 2026, use today, otherwise anchor to late September 2026
    return today.getFullYear() === 2026 ? today : new Date(2026, 8, 1);
  });

  const [formData, setFormData] = useState({
    title: '',
    category: 'Worship',
    date: isoDay(),
    time: '10:00 AM - 11:30 AM',
    location: 'Main Sanctuary',
    ministry_name: 'Worship collective',
    description: '',
  });

  async function loadEvents() {
    setLoading(true);
    try {
      const data = await api('/events');
      setEvents(data);
    } catch (err) {
      setError('Could not load events: ' + err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadEvents();
  }, []);

  async function handleCreateEvent(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const created = await api('/events', {
        method: 'POST',
        body: JSON.stringify(formData),
      });
      setEvents(prev => [...prev, created]);
      setShowAddModal(false);
      setFormData({
        title: '',
        category: 'Worship',
        date: isoDay(),
        time: '10:00 AM - 11:30 AM',
        location: 'Main Sanctuary',
        ministry_name: 'Worship collective',
        description: '',
      });
    } catch (err) {
      setError('Could not create event: ' + err.message);
    } finally {
      setBusy(false);
    }
  }

  // Calendar calculations
  const year = currentMonthDate.getFullYear();
  const month = currentMonthDate.getMonth(); // 0-indexed

  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];

  const firstDayOfWeek = new Date(year, month, 1).getDay();
  const daysInCurrentMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrevMonth = new Date(year, month, 0).getDate();

  const prevMonthCells = [];
  for (let i = firstDayOfWeek - 1; i >= 0; i--) {
    prevMonthCells.push({
      dayNum: daysInPrevMonth - i,
      isCurrentMonth: false,
      dateStr: '',
    });
  }

  const currentMonthCells = [];
  for (let d = 1; d <= daysInCurrentMonth; d++) {
    const mm = String(month + 1).padStart(2, '0');
    const dd = String(d).padStart(2, '0');
    const dateStr = `${year}-${mm}-${dd}`;
    const dayEvents = events.filter(e => e.date === dateStr);
    currentMonthCells.push({
      dayNum: d,
      isCurrentMonth: true,
      dateStr,
      events: dayEvents,
    });
  }

  const totalCellsSoFar = prevMonthCells.length + currentMonthCells.length;
  const nextMonthCellsNeeded = (7 - (totalCellsSoFar % 7)) % 7;
  const nextMonthCells = [];
  for (let d = 1; d <= nextMonthCellsNeeded; d++) {
    nextMonthCells.push({
      dayNum: d,
      isCurrentMonth: false,
      dateStr: '',
    });
  }

  const calendarGrid = [...prevMonthCells, ...currentMonthCells, ...nextMonthCells];

  function prevMonth() {
    setCurrentMonthDate(new Date(year, month - 1, 1));
    setListView('month');
  }

  function nextMonth() {
    setCurrentMonthDate(new Date(year, month + 1, 1));
    setListView('month');
  }

  function goToToday() {
    const today = new Date();
    setCurrentMonthDate(today);
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    setSelectedDate(`${today.getFullYear()}-${mm}-${dd}`);
  }

  // The list beside the grid: the month it shows, or upcoming (today or later), a picked day, or a search.
  const listOptions = { view: listView, year, month, selectedDate, category: selectedCategory, query: searchQuery };
  const filteredEvents = eventsToList(events, listOptions);

  async function handleDelete(event) {
    if (!window.confirm(`Delete "${event.title}" from the calendar?`)) return;
    try {
      await api(`/events/${event.id}`, { method: 'DELETE' });
      setEvents(list => list.filter(e => e.id !== event.id));
    } catch (err) {
      setError(`Could not delete "${event.title}": ${err.message || 'please try again.'}`);
    }
  }


  return (
    <div className="calendar-section">
      {/* Top Controls Bar */}
      {canEdit && (
        <div className="calendar-banner">
          <div className="calendar-banner-left">
            <p className="calendar-subtitle">
              Manage gatherings, services, and outreach on the church calendar.
            </p>
          </div>
          <div className="calendar-banner-actions">
            <button className="primary" onClick={() => setShowAddModal(true)}>
              + Add New Event
            </button>
          </div>
        </div>
      )}

      {/* Main Layout: Split Calendar View & Event Cards */}
      <div className="calendar-layout">
        {/* Left Column: Interactive Month Calendar */}
        <div className="calendar-sidebar">
          <div className="calendar-card panel">
            <div className="calendar-header">
              <button className="cal-nav-btn" onClick={prevMonth} aria-label="Previous month">
                ‹
              </button>
              <div className="cal-title">
                <strong>{monthNames[month]} {year}</strong>
              </div>
              <button className="cal-nav-btn" onClick={nextMonth} aria-label="Next month">
                ›
              </button>
            </div>

            <div className="cal-quick-actions">
              <button className="cal-today-btn" onClick={goToToday}>
                Today
              </button>
              {selectedDate && (
                <button
                  className="cal-clear-btn"
                  onClick={() => setSelectedDate(null)}
                >
                  Show all dates ✕
                </button>
              )}
            </div>

            {/* Days of week */}
            <div className="cal-weekdays">
              {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((day, idx) => (
                <span key={idx} className="cal-weekday">{day}</span>
              ))}
            </div>

            {/* Days Grid */}
            <div className="cal-grid">
              {calendarGrid.map((cell, index) => {
                if (!cell.isCurrentMonth) {
                  return (
                    <div key={index} className="cal-cell inactive">
                      <span>{cell.dayNum}</span>
                    </div>
                  );
                }

                const isSelected = selectedDate === cell.dateStr;
                const hasEvents = cell.events && cell.events.length > 0;
                const todayStr = new Date().toISOString().split('T')[0];
                const isToday = cell.dateStr === todayStr;

                return (
                  <button
                    key={index}
                    type="button"
                    className={`cal-cell active-month ${isSelected ? 'selected' : ''} ${isToday ? 'is-today' : ''} ${hasEvents ? 'has-events' : ''}`}
                    onClick={() => {
                      setSelectedDate(isSelected ? null : cell.dateStr);
                    }}
                    title={hasEvents ? `${cell.events.length} event(s) on ${cell.dateStr}` : cell.dateStr}
                  >
                    <span className="cal-day-num">{cell.dayNum}</span>
                    {hasEvents && (
                      <div className="cal-dots">
                        {cell.events.slice(0, 3).map((ev, i) => (
                          <span
                            key={i}
                            className="cal-dot"
                            style={{
                              backgroundColor: CATEGORY_COLORS[ev.category] || '#729564',
                            }}
                          />
                        ))}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Categories Filter */}
          <div className="calendar-filter-card panel">
            <h3>Categories</h3>
            <div className="category-chips">
              {CATEGORIES.map(cat => (
                <button
                  key={cat}
                  className={`chip ${selectedCategory === cat ? 'active' : ''}`}
                  onClick={() => setSelectedCategory(cat)}
                >
                  {cat !== 'All' && (
                    <span
                      className="category-color-pip"
                      style={{ backgroundColor: CATEGORY_COLORS[cat] || '#888' }}
                    />
                  )}
                  {cat}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Right Column: Events List & Cards */}
        <section className="events-main">
          {/* Search and context header */}
          <div className="events-toolbar">
            <div className="events-header-info">
              <h2>{listHeading(listOptions)}</h2>
              <span className="events-count">{filteredEvents.length} event(s) found</span>
              <div className="events-view-toggle" role="group" aria-label="Which events to list">
                {[['month', `${monthNames[month]} ${year}`], ['upcoming', 'Upcoming']].map(([value, label]) => (
                  <button key={value} className={`chip ${listView === value && !selectedDate ? 'active' : ''}`}
                    aria-pressed={listView === value && !selectedDate}
                    onClick={() => { setListView(value); setSelectedDate(null); }}>{label}</button>
                ))}
              </div>
            </div>

            <label className="search events-search">
              ⌕{' '}
              <input
                type="text"
                placeholder="Search events or topics..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
              />
            </label>
          </div>

          {loading ? (
            <p role="status">Loading church events…</p>
          ) : events.length === 0 ? (
            <p className="muted">No events are scheduled yet.</p>
          ) : filteredEvents.length === 0 ? (
            <div className="panel empty-events">
              <span className="empty-icon">🗓</span>
              <h3>No events found</h3>
              <p>{selectedDate || searchQuery.trim() || selectedCategory !== 'All'
                ? 'There are no church events matching your selected date or filters.'
                : listView === 'upcoming' ? 'Nothing is on the calendar from today on yet.' : `Nothing is on the calendar in ${monthNames[month]} ${year}.`}</p>
              <div className="empty-actions">
                {listView === 'month' && !selectedDate && (
                  <button className="secondary" onClick={() => setListView('upcoming')}>
                    Show upcoming events
                  </button>
                )}
                {selectedDate && (
                  <button className="secondary" onClick={() => setSelectedDate(null)}>
                    Clear date filter
                  </button>
                )}
                {selectedCategory !== 'All' && (
                  <button className="secondary" onClick={() => setSelectedCategory('All')}>
                    Show all categories
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="events-list">
              {filteredEvents.map(event => (
                <article key={event.id} className="panel event-card">
                  <div className="event-card-header">
                    <div className="event-meta-tags">
                      <span
                        className="category-badge"
                        style={{
                          backgroundColor: `${CATEGORY_COLORS[event.category] || '#729564'}22`,
                          color: CATEGORY_COLORS[event.category] || '#314c37',
                          borderColor: `${CATEGORY_COLORS[event.category] || '#729564'}44`,
                        }}
                      >
                        {event.category}
                      </span>
                      {event.ministry_name && (
                        <span className="ministry-badge">
                          ◈ {event.ministry_name}
                        </span>
                      )}
                    </div>
                    <div className="event-datetime-badge">
                      <span>🗓 {event.date}</span>
                      <span>·</span>
                      <span>◷ {event.time}</span>
                    </div>
                  </div>

                  <div className="event-title-row">
                    <h3 className="event-title">{event.title}</h3>
                    {canEdit && (
                      <button
                        className="ghost event-delete"
                        onClick={() => handleDelete(event)}
                        aria-label={`Delete ${event.title}`}
                      >
                        Delete
                      </button>
                    )}
                  </div>

                  <div className="event-location">
                    <span>📍</span> {event.location}
                  </div>

                  <p className="event-description">{event.description}</p>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* Add Event Modal */}
      {canEdit && showAddModal && (
        <div className="modal-backdrop" onClick={() => setShowAddModal(false)}>
          <div className="panel modal-content" onClick={e => e.stopPropagation()}>
            <button className="close" onClick={() => setShowAddModal(false)}>
              ×
            </button>
            <div className="form-title">
              <span className="icon color1">🗓</span>
              <div>
                <h2>Create Church Event</h2>
                <p>Add a new gathering or service to the church calendar.</p>
              </div>
            </div>

            <form onSubmit={handleCreateEvent}>
              <label className="field">
                Event Title
                <input
                  required
                  placeholder="e.g. Worship Night & Prayer"
                  value={formData.title}
                  onChange={e => setFormData({ ...formData, title: e.target.value })}
                />
              </label>

              <div className="form-row">
                <label className="field">
                  Category
                  <select
                    value={formData.category}
                    onChange={e => setFormData({ ...formData, category: e.target.value })}
                  >
                    {CATEGORIES.filter(c => c !== 'All').map(c => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </label>

                <label className="field">
                  Ministry Lead
                  <input
                    placeholder="e.g. Worship Collective"
                    value={formData.ministry_name}
                    onChange={e => setFormData({ ...formData, ministry_name: e.target.value })}
                  />
                </label>
              </div>

              <div className="form-row">
                <label className="field">
                  Date (YYYY-MM-DD)
                  <input
                    type="date"
                    required
                    value={formData.date}
                    onChange={e => setFormData({ ...formData, date: e.target.value })}
                  />
                </label>

                <label className="field">
                  Time
                  <input
                    required
                    placeholder="e.g. 06:30 PM - 08:00 PM"
                    value={formData.time}
                    onChange={e => setFormData({ ...formData, time: e.target.value })}
                  />
                </label>
              </div>

              <label className="field">
                Location / Room
                <input
                  required
                  placeholder="e.g. Main Sanctuary, Fellowship Hall, Room 204"
                  value={formData.location}
                  onChange={e => setFormData({ ...formData, location: e.target.value })}
                />
              </label>

              <label className="field">
                Full Description
                <textarea
                  required
                  rows={4}
                  className="field-textarea"
                  placeholder="Describe the event, who should attend, and what to expect..."
                  value={formData.description}
                  onChange={e => setFormData({ ...formData, description: e.target.value })}
                />
              </label>

              <div className="modal-actions">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setShowAddModal(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="primary"
                  disabled={busy}
                >
                  {busy ? 'Saving…' : 'Create Event'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
