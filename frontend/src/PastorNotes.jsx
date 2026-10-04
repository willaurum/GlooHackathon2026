import { useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE, api, getApiKey, setApiKey } from './api.js';
import Icon from './Icon.jsx';

const pending = note => note.status === 'queued' || note.status === 'processing';
const ERRORS = {
  youtube_blocked: 'YouTube blocked the download from our servers. Upload the video file instead.',
  youtube_unavailable: 'That YouTube video is private or unavailable.',
  too_long: 'The video is longer than the 90-minute limit.',
  no_audio: 'The file has no audio track.',
  no_speech: 'No speech was found in the audio.',
  interrupted: 'Processing was interrupted. Try again.',
};

// Transcript highlight categories, in toggle-bar order. Bible ones are on by default.
const CATS = [
  { key: 'bible_quote', label: 'Bible quotes', icon: 'book', on: true },
  { key: 'bible_paraphrase', label: 'Bible references', icon: 'bookmark', on: true },
  { key: 'recent_event', label: 'Current events', icon: 'clock' },
  { key: 'political_event', label: 'Politics', icon: 'pin' },
  { key: 'personal_story', label: 'Personal stories', icon: 'heart' },
  { key: 'inerrancy_claim', label: 'Scripture claims', icon: 'check' },
];
const CAT_LABEL = Object.fromEntries(CATS.map(c => [c.key, c.label]));

function CategoryToggles({ counts, active, onToggle }) {
  return <div className="pn-cats" role="group" aria-label="Highlight in transcript">
    {CATS.map(c => <button key={c.key} type="button" className={'cat-' + c.key + (active.has(c.key) ? ' selected' : '')}
      aria-pressed={active.has(c.key)} disabled={!counts[c.key]} onClick={() => onToggle(c.key)}>
      <Icon name={c.icon} size={14} />{c.label}<small>{counts[c.key] || 0}</small>
    </button>)}
  </div>;
}

function KeyForm({ onChange }) {
  const [value, setValue] = useState('');
  return <form className="card pn-key" onSubmit={e => { e.preventDefault(); setApiKey(value.trim()); onChange(); }}>
    <span className="icon color3"><Icon name="lock" size={22} /></span>
    <h2>Connect to Sermon Notes</h2>
    <p>Sermon notes are shared with the church family. Enter the church’s access key to browse and ask questions. It stays in this browser tab only.</p>
    <label className="field">API key<input type="password" value={value} onChange={e => setValue(e.target.value)} autoComplete="off" /></label>
    <button className="primary wide" disabled={!value.trim()}>Connect</button>
  </form>;
}

function NewNote({ onCreated }) {
  const [mode, setMode] = useState('youtube'), [title, setTitle] = useState(''), [url, setUrl] = useState(''),
    [file, setFile] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function submit(e) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      if (mode === 'youtube') {
        await api('/notes', { method: 'POST', body: JSON.stringify({ title, youtube_url: url }) });
      } else {
        // Raw body upload; the browser sets Content-Length from the File.
        const response = await fetch(`${API_BASE}/api/notes/upload?title=${encodeURIComponent(title)}`, {
          method: 'POST', headers: { 'X-API-Key': getApiKey(), 'Content-Type': file.type || 'video/mp4' }, body: file,
        });
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).detail || `Upload failed (${response.status})`);
      }
      setTitle(''); setUrl(''); setFile(null); onCreated();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  return <form className="card pn-new" onSubmit={submit}>
    <h2>Add a sermon</h2>
    <div className="filters">
      <button type="button" className={mode === 'youtube' ? 'selected' : ''} onClick={() => setMode('youtube')}>YouTube link</button>
      <button type="button" className={mode === 'upload' ? 'selected' : ''} onClick={() => setMode('upload')}>Upload a file</button>
    </div>
    <label className="field">Title<input value={title} maxLength={200} onChange={e => setTitle(e.target.value)} placeholder="e.g. Sunday, Luke 10" /></label>
    {mode === 'youtube'
      ? <label className="field">YouTube URL<input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://www.youtube.com/watch?v=..." /></label>
      : <label className="field">Video or audio file <small>Up to 95 MB</small><input type="file" accept="video/*,audio/*" onChange={e => setFile(e.target.files[0] || null)} /></label>}
    {error && <p className="pn-error" role="alert">{error}</p>}
    <button className="primary wide" disabled={busy || !title.trim() || (mode === 'youtube' ? !url.trim() : !file)}>{busy ? 'Working…' : 'Create note'}</button>
  </form>;
}

function NoteView({ note, onChange }) {
  const [segments, setSegments] = useState([]), [question, setQuestion] = useState(''),
    [answer, setAnswer] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(''),
    [annotations, setAnnotations] = useState([]), [activeCats, setActiveCats] = useState(() => new Set(CATS.filter(c => c.on).map(c => c.key)));
  useEffect(() => {
    setSegments([]); setAnnotations([]); setAnswer(null);
    if (note.status !== 'ready') return;
    api(`/notes/${note.id}/segments`).then(setSegments).catch(err => setError(err.message));
    // Highlights are optional; a transcript without them still reads fine.
    api(`/notes/${note.id}/annotations`).then(setAnnotations).catch(() => {});
  }, [note.id, note.status]);
  // Segment idx -> its annotations, and passage counts per category.
  const [bySegment, counts] = useMemo(() => {
    const map = new Map(), counts = {};
    for (const a of annotations) {
      counts[a.category] = (counts[a.category] || 0) + 1;
      for (let i = a.seg_from; i <= a.seg_to; i++) map.set(i, [...(map.get(i) || []), a]);
    }
    return [map, counts];
  }, [annotations]);
  const toggleCat = key => setActiveCats(prev => {
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });
  async function ask(e) {
    e.preventDefault(); setBusy(true); setError(''); setAnswer(null);
    try { setAnswer(await api(`/notes/${note.id}/ask`, { method: 'POST', body: JSON.stringify({ question }) })); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  if (note.status !== 'ready') {
    return <section className="card pn-note"><h2>{note.title}</h2>
      <p>{note.status === 'failed' ? (ERRORS[note.error] || `Processing failed (${note.error}).`) : 'Transcribing… this page updates on its own.'}</p>
      {error && <p className="pn-error" role="alert">{error}</p>}
      {note.status === 'failed' && <button className="secondary" onClick={() => api(`/notes/${note.id}/retry`, { method: 'POST' }).then(onChange, err => setError(err.message))}>Try again</button>}
    </section>;
  }
  return <section className="card pn-note">
    <h2>{note.title}</h2>
    <form className="pn-ask" onSubmit={ask}>
      <label className="field">Ask about this note<input value={question} maxLength={500} onChange={e => setQuestion(e.target.value)} placeholder="What was said about the good Samaritan?" /></label>
      <button className="primary" disabled={busy || !question.trim()}>{busy ? 'Looking…' : 'Ask'}</button>
    </form>
    {error && <p className="pn-error" role="alert">{error}</p>}
    {answer && (answer.found
      ? <div className="pn-answer" aria-live="polite">
          {answer.engine !== 'extractive' && <p>{answer.answer}</p>}
          <ol>{answer.citations.map(c => <li key={c.chunk + c.quote}>
            {c.url ? <a href={c.url} target="_blank" rel="noreferrer">{c.timestamp}</a> : <b>{c.timestamp}</b>} “{c.quote}”
          </li>)}</ol>
          <small>Answered from the transcript ({answer.engine}).</small>
        </div>
      : <div className="pn-answer none" aria-live="polite"><p>Not found in this note.</p></div>)}
    <h3>Transcript</h3>
    {annotations.length > 0 && <CategoryToggles counts={counts} active={activeCats} onToggle={toggleCat} />}
    <ol className="pn-segments">{segments.map(s => {
      const shown = (bySegment.get(s.idx) || []).filter(a => activeCats.has(a.category));
      // A passage's label goes on its first segment; the first shown category picks the color.
      const starts = shown.filter(a => a.seg_from === s.idx);
      return <li key={s.idx} className={shown.length ? 'hl hl-' + shown[0].category : undefined}>
        {starts.length > 0 && <span className="hl-legend">{starts.map(a => CAT_LABEL[a.category] + (a.label ? ': ' + a.label : '')).join(' · ')}</span>}
        <b>{s.timestamp}</b> {s.text}
      </li>;
    })}</ol>
  </section>;
}

// The open sermon lives in the route (#/notes/<id>). On phones it takes over the page, with a back button to the list.
export default function PastorNotes({ route, go }) {
  const [hasKey, setHasKey] = useState(Boolean(getApiKey())), [church, setChurch] = useState(null),
    [notes, setNotes] = useState([]), [loaded, setLoaded] = useState(false), [error, setError] = useState('');
  const selected = route.startsWith('notes/') ? route.slice('notes/'.length) : null;
  // True when the open sermon was tapped from the list, so Back can return to that same history entry.
  const openedFromList = useRef(false);
  async function load() {
    try {
      const [info, list] = await Promise.all([api('/church'), api('/notes')]);
      setChurch(info); setNotes(list); setError('');
    } catch (err) { setError(err.message); }
    finally { setLoaded(true); }
  }
  function open(id) {
    if (id === selected) return;
    openedFromList.current = true;
    go('notes/' + id);
  }
  function back() {
    if (openedFromList.current) { openedFromList.current = false; window.history.back(); }
    else go('notes');
  }
  useEffect(() => { if (hasKey) load(); }, [hasKey]);
  // Poll while anything is still being transcribed.
  useEffect(() => {
    if (!notes.some(pending)) return;
    const timer = setTimeout(load, 5000);
    return () => clearTimeout(timer);
  }, [notes]);
  if (!hasKey) return <KeyForm onChange={() => setHasKey(true)} />;
  const current = notes.find(n => n.id === selected);
  return <div className={'pn' + (selected ? ' pn-detail' : '')}>
    <div className="pn-bar">
      <div className="eyebrow">{church ? church.name : ' '}</div>
      <button className="ghost" onClick={() => { setApiKey(''); setHasKey(false); setNotes([]); }}>Forget key</button>
    </div>
    {error && <div className="banner error" role="alert">{error}</div>}
    <div className="pn-grid">
      <div>
        <section className="card pn-list"><h2>Sermons <small className="count">{notes.length}</small></h2>
          {notes.length ? <ul>{notes.map(n => <li key={n.id}>
            <button className={n.id === selected ? 'selected' : ''} aria-current={n.id === selected ? 'page' : undefined} onClick={() => open(n.id)}>
              <strong>{n.title}</strong><small><Icon name={n.source_kind === 'youtube' ? 'play' : 'book'} size={14} />{n.source_kind === 'youtube' ? 'YouTube' : 'Upload'} · <span className={'status ' + n.status}>{n.status}</span></small>
            </button></li>)}</ul> : <p className="muted">No sermons yet. Add a YouTube link or upload a file.</p>}
        </section>
        <NewNote onCreated={load} />
      </div>
      <div id="pn-view">
        {selected && <button className="ghost pn-back" onClick={back}><Icon name="back" size={18} />All sermons</button>}
        {current ? <NoteView note={current} onChange={load} />
          : selected ? <section className="card pn-pick"><Icon name="book" size={40} /><h2>{loaded ? 'Sermon not found' : 'Loading sermon…'}</h2>{loaded && <p>It may have been removed. Go back to the list to pick another.</p>}</section>
          : <section className="card pn-pick"><Icon name="book" size={40} /><h2>Pick a sermon</h2><p>Read its transcript and ask questions. Answers quote the sermon with timestamps.</p></section>}
      </div>
    </div>
  </div>;
}
