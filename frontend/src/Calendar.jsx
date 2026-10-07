import { useState, useEffect } from 'react';
import { api, getApiKey } from './api.js';
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
  // Calendar writes and summary generation require staff, including on the demo church.
  const canEdit = church.staff;
  const canChooseModel = canEdit && !!getApiKey();
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [aiStatus, setAiStatus] = useState(null);
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [selectedDate, setSelectedDate] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  // 'month': the month the grid shows. 'upcoming': today or later, from any month.
  const [listView, setListView] = useState('month');
  const [summarizingId, setSummarizingId] = useState(null);
  const [cardErrors, setCardErrors] = useState({});
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

  async function loadAiStatus() {
    try {
      let status;
      try {
        status = await api('/ai/status');
      } catch {
        status = await api('/ollama/status');
      }
      setAiStatus(status);
    } catch {
      setAiStatus({ connected: false, error: 'AI endpoint unreachable' });
    }
  }

  async function handleModelChange(e) {
    const newModel = e.target.value;
    try {
      try {
        await api('/ai/model', {
          method: 'POST',
          body: JSON.stringify({ model: newModel }),
        });
      } catch {
        await api('/ollama/model', {
          method: 'POST',
          body: JSON.stringify({ model: newModel }),
        });
      }
      await loadAiStatus();
    } catch (err) {
      setError('Failed to switch model: ' + err.message);
    }
  }

  useEffect(() => {
    loadEvents();
    loadAiStatus();
    const timer = setInterval(loadAiStatus, 10000);
    return () => clearInterval(timer);
  }, []);

  async function handleSummarize(eventId) {
    setSummarizingId(eventId);
    setCardErrors(prev => {
      const copy = { ...prev };
      delete copy[eventId];
      return copy;
    });
    setError('');
    try {
      const updated = await api(`/events/${eventId}/summarize`, { method: 'POST' });
      setEvents(prev => prev.map(e => (e.id === eventId ? updated : e)));
    } catch (err) {
      const isTimeout =
        err.message &&
        (err.message.includes('504') ||
          err.message.toLowerCase().includes('timeout') ||
          err.message.toLowerCase().includes('timed out'));

      if (isTimeout) {
        // Check if event summary was saved despite gateway timeout
        try {
          const freshEvent = await api(`/events/${eventId}`);
          if (freshEvent && freshEvent.ai_summary) {
            setEvents(prev => prev.map(e => (e.id === eventId ? freshEvent : e)));
            setError('');
            return;
          }
        } catch {}
      }

      const msg = err.message || 'AI summarization failed';
      setCardErrors(prev => ({ ...prev, [eventId]: msg }));
      setError(`AI summary failed for event #${eventId}: ${msg}`);
    } finally {
      setSummarizingId(null);
    }
  }

  async function handleSummarizeBatch(onlyMissing = false) {
    const mode = onlyMissing ? 'missing' : 'all';
    setSummarizingId(mode);
    setCardErrors({});
    setError('');
    try {
      const res = await api('/events/summarize-all', {
        method: 'POST',
        body: JSON.stringify({ only_missing: onlyMissing }),
      });
      if (res.events) {
        setEvents(res.events);
      } else {
        await loadEvents();
      }
      if (res.errors && res.errors.length > 0) {
        const newCardErrors = {};
        for (const err of res.errors) {
          newCardErrors[err.event_id] = err.error;
        }
        setCardErrors(newCardErrors);
        setError(`Summarized with ${res.errors.length} AI model error(s).`);
      } else {
        setError('');
      }
    } catch (err) {
      const isTimeout =
        err.message &&
        (err.message.includes('504') ||
          err.message.toLowerCase().includes('timeout') ||
          err.message.toLowerCase().includes('timed out'));

      if (isTimeout) {
        // The HTTP request timed out at the gateway (504), but the backend often
        // finishes generating summaries in the database. Poll /events to verify actual status.
        let allSucceeded = false;
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            if (attempt > 0) {
              await new Promise(r => setTimeout(r, 1500));
            }
            const freshEvents = await api('/events');
            setEvents(freshEvents);
            const missing = freshEvents.filter(e => !e.ai_summary).length;
            if (missing === 0 || (onlyMissing && missing === 0)) {
              allSucceeded = true;
              break;
            }
          } catch {
            // ignore network glitch during check
          }
        }

        if (allSucceeded) {
          // All targeted events have summaries successfully generated!
          // Clear any error so no false 504 banner is shown.
          setError('');
          return;
        }

        // If not all finished, show whatever completed
        try {
          const freshEvents = await api('/events');
          setEvents(freshEvents);
          const completedCount = freshEvents.filter(e => !!e.ai_summary).length;
          if (completedCount > 0) {
            setError(
              `Summarization took longer than the gateway timeout, but ${completedCount}/${freshEvents.length} event summaries are saved.`
            );
            return;
          }
        } catch {}
      } else {
        // Non-timeout error: still reload events to show any that were saved
        try {
          await loadEvents();
        } catch {}
      }

      setError(`AI summarization failed: ${err.message}`);
    } finally {
      setSummarizingId(null);
    }
  }

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
        date: '2026-09-27',
        time: '10:00 AM - 11:30 AM',
        location: 'Main Sanctuary',
        ministry_name: 'Worship collective',
        description: '',
      });
      // Optionally trigger AI summary for newly added event immediately
      handleSummarize(created.id);
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

  const unsummarizedCount = events.filter(e => !e.ai_summary).length;

  return (
    <div className="calendar-section">
      {/* Top Controls Bar */}
      <div className="calendar-banner">
        <div className="calendar-banner-left">
          <div className="ai-status-pill">
            <span className={`status-dot ${aiStatus?.connected ? 'connected' : 'offline'}`} />
            <span>
              AI Endpoint: {aiStatus?.connected ? 'Connected' : 'Offline'}
            </span>
            {canChooseModel && aiStatus?.connected && aiStatus?.available_models && aiStatus.available_models.length > 0 ? (
              <select
                className="model-select"
                value={aiStatus.default_model}
                onChange={handleModelChange}
                title="Active AI model (change anytime)"
              >
                {!aiStatus.available_models.includes(aiStatus.default_model) && (
                  <option value={aiStatus.default_model}>{aiStatus.default_model} (configured)</option>
                )}
                {aiStatus.available_models.map(m => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            ) : (
              aiStatus?.default_model && <b> ({aiStatus.default_model})</b>
            )}
          </div>
          <p className="calendar-subtitle">
            All summaries are generated dynamically via our connected <b>AI endpoint</b>, never pre-written.
          </p>
        </div>
        {canEdit && <div className="calendar-banner-actions">
          <button
            className="secondary summary-btn"
            disabled={summarizingId !== null || loading || !aiStatus?.connected || unsummarizedCount === 0}
            onClick={() => handleSummarizeBatch(true)}
            title={
              !aiStatus?.connected
                ? 'AI endpoint offline'
                : unsummarizedCount === 0
                ? 'All events already have AI summaries'
                : `Generate summaries for ${unsummarizedCount} event(s) without summaries`
            }
          >
            {summarizingId === 'missing' ? (
              <>✦ Summarizing missing…</>
            ) : unsummarizedCount === 0 ? (
              <>✓ All Summarized</>
            ) : (
              <>✧ Summarize Missing ({unsummarizedCount})</>
            )}
          </button>
          <button
            className="secondary summary-btn"
            disabled={summarizingId !== null || loading || !aiStatus?.connected}
            onClick={() => handleSummarizeBatch(false)}
            title={!aiStatus?.connected ? 'AI endpoint offline' : 'Regenerate summaries for all events'}
          >
            {summarizingId === 'all' ? (
              <>✦ Remaking all summaries…</>
            ) : (
              <>↻ Remake All Summaries</>
            )}
          </button>
          {canEdit && <button className="primary" onClick={() => setShowAddModal(true)}>
            + Add New Event
          </button>}
        </div>}
      </div>

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
                placeholder="Search events, topics, or AI summaries..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
              />
            </label>
          </div>

          {loading ? (
            <p role="status">Loading church events…</p>
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
              {filteredEvents.map(event => {
                const isSummarizingThis =
                  summarizingId === event.id ||
                  summarizingId === 'all' ||
                  (summarizingId === 'missing' && !event.ai_summary);
                return (
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
                      {canEdit && <button className="ghost event-delete" onClick={() => handleDelete(event)}
                        aria-label={`Delete ${event.title}`}>Delete</button>}
                    </div>

                    <div className="event-location">
                      <span>📍</span> {event.location}
                    </div>

                    <p className="event-description">{event.description}</p>

                    {/* AI SUMMARY BOX */}
                    <div className="ai-summary-container">
                      <div className="ai-summary-header">
                        <div className="ai-summary-label">
                          <span className="sparkle-icon">✧</span>
                          <strong>AI Summary</strong>
                        </div>
                        {canEdit && <button
                          className="ai-refresh-btn"
                          disabled={isSummarizingThis || !aiStatus?.connected}
                          onClick={() => handleSummarize(event.id)}
                          title={!aiStatus?.connected ? 'AI endpoint offline' : event.ai_summary ? 'Regenerate AI summary' : 'Generate AI summary'}
                        >
                          {isSummarizingThis ? 'Generating…' : event.ai_summary ? '↻ Regenerate' : '✧ Generate AI Summary'}
                        </button>}
                      </div>

                      <div className="ai-summary-body">
                        {isSummarizingThis ? (
                          <div className="ai-loading-state">
                            <span className="loading-pulse">✦</span>
                            <span>Generating AI summary…</span>
                          </div>
                        ) : event.ai_summary ? (
                          <>
                            <blockquote className="ai-summary-quote">
                              "{event.ai_summary}"
                            </blockquote>
                            {cardErrors[event.id] && (
                              <div className="ai-card-error" style={{ marginTop: '8px' }}>
                                <span>⚠ Update failed: {cardErrors[event.id]}</span>
                                <button
                                  className="retry-btn"
                                  onClick={() => handleSummarize(event.id)}
                                >
                                  ↻ Retry
                                </button>
                              </div>
                            )}
                          </>
                        ) : (
                          <div className="ai-empty-prompt">
                            {cardErrors[event.id] ? (
                              <div className="ai-card-error">
                                <span>⚠ {cardErrors[event.id]}</span>
                                <button
                                  className="retry-btn"
                                  onClick={() => handleSummarize(event.id)}
                                >
                                  ↻ Retry
                                </button>
                              </div>
                            ) : (
                              <>
                                <p>No AI summary generated for this event yet.</p>
                                <button
                                  className="secondary generate-btn"
                                  disabled={!aiStatus?.connected}
                                  onClick={() => handleSummarize(event.id)}
                                >
                                  ✧ Generate AI Summary
                                </button>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })}
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

              <p className="disclaimer">
                After saving, our AI endpoint will automatically be triggered to draft a welcoming 2-sentence bulletin summary.
              </p>

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
                  {busy ? 'Saving…' : 'Create & Generate AI Summary →'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
