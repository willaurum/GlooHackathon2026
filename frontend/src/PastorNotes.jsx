import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { api, apiHeaders, apiUrl, getApiKey, setApiKey } from './api.js';
import { useChurch } from './ChurchContext.js';
import Icon from './Icon.jsx';
import { canStep, formatNoteDate, pickCurrent, readPrefs, statusLabel, stepSize, textSizePx, writePrefs } from './readerPrefs.js';
import { fetchVerse, referenceParts } from './verses.js';

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
  const { go } = useChurch();
  const [value, setValue] = useState('');
  return <form className="card pn-key" onSubmit={e => { e.preventDefault(); setApiKey(value.trim()); onChange(); }}>
    <span className="icon color3"><Icon name="lock" size={22} /></span>
    <h2>Connect to Sermon Notes</h2>
    <p>Sermon notes are shared with the church family. Enter the church’s access key to browse and ask questions. It stays in this browser tab only.</p>
    <label className="field">API key<input type="password" value={value} onChange={e => setValue(e.target.value)} autoComplete="off" /></label>
    <button className="primary wide" disabled={!value.trim()}>Connect</button>
    <p className="form-note">Church staff can <button type="button" className="link" onClick={() => go('setup')}>sign in with the staff password</button> instead.</p>
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
        const response = await fetch(apiUrl(`/notes/upload?title=${encodeURIComponent(title)}`), {
          method: 'POST', headers: await apiHeaders(undefined, { 'Content-Type': file.type || 'video/mp4' }), body: file,
        });
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).detail || `Upload failed (${response.status})`);
      }
      setTitle(''); setUrl(''); setFile(null); onCreated();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  return <form className="pn-new" onSubmit={submit}>
    <div className="filters" role="group" aria-label="Source">
      <button type="button" className={mode === 'youtube' ? 'selected' : ''} aria-pressed={mode === 'youtube'} onClick={() => setMode('youtube')}>YouTube link</button>
      <button type="button" className={mode === 'upload' ? 'selected' : ''} aria-pressed={mode === 'upload'} onClick={() => setMode('upload')}>Upload a file</button>
    </div>
    <label className="field">Title<input value={title} maxLength={200} onChange={e => setTitle(e.target.value)} placeholder="e.g. Sunday, Luke 10" /></label>
    {mode === 'youtube'
      ? <label className="field">YouTube URL<input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://www.youtube.com/watch?v=..." /></label>
      : <label className="field">Video or audio file <small>Up to 95 MB</small><input type="file" accept="video/*,audio/*" onChange={e => setFile(e.target.files[0] || null)} /></label>}
    {error && <p className="pn-error" role="alert">{error}</p>}
    <button className="primary wide" disabled={busy || !title.trim() || (mode === 'youtube' ? !url.trim() : !file)}>{busy ? 'Working…' : 'Create note'}</button>
  </form>;
}

const BIBLE_CATS = new Set(['bible_quote', 'bible_paraphrase']);

// The passage a highlight points at, loaded from YouVersion when tapped.
function VerseCard({ reference, onClose }) {
  const [verse, setVerse] = useState(null), [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    setVerse(null); setError('');
    fetchVerse(reference).then(v => live && setVerse(v), err => live && setError(err.message));
    return () => { live = false; };
  }, [reference.usfm]);
  return <div className="verse-card" role="region" aria-label={reference.human}>
    <div className="verse-head">
      <b>{verse?.reference || reference.human}</b>
      {verse?.version?.abbreviation && <span className="verse-version">{verse.version.abbreviation}</span>}
      <button className="verse-close" onClick={onClose} aria-label="Close passage">×</button>
    </div>
    {error ? <p className="pn-error">{error}</p>
      : verse ? <>
          <p className="verse-text">{verse.text}</p>
          <div className="verse-foot">
            <small>{verse.version.title}{verse.version.copyright ? ', ' + verse.version.copyright : ''}</small>
            <a href={verse.link} target="_blank" rel="noreferrer">Read on YouVersion</a>
          </div>
        </>
      : <p className="verse-loading">Loading passage…</p>}
  </div>;
}

// Notes saved before the backend merged duplicates can tag the same claim twice over touching segments.
function mergeAnnotations(list) {
  const out = [];
  for (const a of list) {
    const same = out.find(b => b.category === a.category && b.label.trim().toLowerCase() === (a.label || '').trim().toLowerCase()
      && a.seg_from <= b.seg_to + 1 && b.seg_from <= a.seg_to + 1);
    if (same) { same.seg_from = Math.min(same.seg_from, a.seg_from); same.seg_to = Math.max(same.seg_to, a.seg_to); }
    else out.push({ ...a, label: a.label || '' });
  }
  return out;
}

// A modal panel: a drawer from the right on desktop, a bottom sheet on phones.
function Sheet({ title, onClose, children, className = '', focusField }) {
  const ref = useRef(null), titleId = useId();
  useEffect(() => {
    const before = document.activeElement, el = ref.current;
    // Focus the first field. On touch screens that throws the keyboard up over the panel, so only when asked.
    const touch = window.matchMedia?.('(pointer: coarse)').matches;
    (((focusField ?? !touch) && el.querySelector('input:not([type=file]), textarea')) || el).focus();
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
      if (e.key !== 'Tab') return;
      // Keep Tab inside the panel while it is open.
      const items = [...el.querySelectorAll('button:not(:disabled), input:not(:disabled), a[href], textarea')];
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    el.addEventListener('keydown', onKey);
    return () => { el.removeEventListener('keydown', onKey); before?.focus?.(); };
  }, []);
  return <div className="pn-sheet-wrap">
    <div className="pn-sheet-backdrop" onClick={onClose} />
    <div ref={ref} className={'pn-sheet ' + className} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <div className="pn-sheet-head">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
      </div>
      <div className="pn-sheet-body">{children}</div>
    </div>
  </div>;
}

// The header dropdown: the open sermon's title and date, opening a list to switch sermons.
function SermonPicker({ notes, current, onPick }) {
  const [open, setOpen] = useState(false), wrap = useRef(null), listId = useId();
  const items = () => [...wrap.current.querySelectorAll('.pn-picker-list button')];
  const toggle = () => wrap.current.querySelector('.pn-picker-btn');
  useEffect(() => {
    if (!open) return;
    (items().find(b => b.getAttribute('aria-current')) || items()[0])?.focus();
    const away = e => { if (!wrap.current.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  function onKeyDown(e) {
    const list = open ? items() : [], i = list.indexOf(document.activeElement);
    if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); toggle().focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); open ? list[Math.min(i + 1, list.length - 1)]?.focus() : setOpen(true); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (open) list[Math.max(i - 1, 0)]?.focus(); }
    else if (e.key === 'Home' && open) { e.preventDefault(); list[0]?.focus(); }
    else if (e.key === 'End' && open) { e.preventDefault(); list[list.length - 1]?.focus(); }
    else if (e.key === 'Tab' && open) setOpen(false);
  }
  const date = current && formatNoteDate(current.created_at);
  return <div className="pn-picker" ref={wrap} onKeyDown={onKeyDown}>
    <button type="button" className="pn-picker-btn" aria-haspopup="true" aria-expanded={open} aria-controls={listId}
      onClick={() => setOpen(o => !o)} disabled={!notes.length}>
      <span className="pn-picker-text">
        <small>{notes.length ? `Sermon${notes.length > 1 ? ` · ${notes.length} in all` : ''}` : 'No sermons yet'}
          {date && <span className="pn-picker-inline-date"> · {date}</span>}
          {current && current.status !== 'ready' && <span className="pn-picker-inline-date"> · <span className={'status ' + current.status}>{statusLabel(current.status)}</span></span>}
        </small>
        <strong>{current ? current.title : notes.length ? 'Pick a sermon' : 'Add one to get started'}</strong>
      </span>
      {current && (date || current.status !== 'ready') && <span className="pn-picker-meta">
        {date}{current.status !== 'ready' && <span className={'status ' + current.status}>{statusLabel(current.status)}</span>}
      </span>}
      <span className="pn-chevron" aria-hidden="true" />
    </button>
    {open && <ul id={listId} className="pn-picker-list" aria-label="Sermons">
      {notes.map(n => <li key={n.id}>
        <button type="button" aria-current={n.id === current?.id ? 'true' : undefined}
          onClick={() => { setOpen(false); toggle().focus(); onPick(n.id); }}>
          <strong>{n.title}</strong>
          <small>
            <Icon name={n.source_kind === 'youtube' ? 'play' : 'book'} size={14} />
            {n.source_kind === 'youtube' ? 'YouTube' : 'Upload'}
            {formatNoteDate(n.created_at) && <> · {formatNoteDate(n.created_at)}</>}
            {n.status !== 'ready' && <> · <span className={'status ' + n.status}>{statusLabel(n.status)}</span></>}
          </small>
          {n.id === current?.id && <Icon name="check" size={16} className="pn-picker-check" />}
        </button>
      </li>)}
    </ul>}
  </div>;
}

// A- / A+ and the timestamps switch.
function ReaderControls({ prefs, setPrefs, disabled }) {
  const step = delta => setPrefs(p => ({ ...p, size: stepSize(p.size, delta) }));
  return <div className="pn-controls" role="group" aria-label="Reading options">
    <button type="button" className="pn-ctl" aria-label="Smaller text" title="Smaller text" disabled={disabled || !canStep(prefs.size, -1)} onClick={() => step(-1)}>
      <span aria-hidden="true">A<span className="pn-ctl-sign">−</span></span>
    </button>
    <button type="button" className="pn-ctl pn-ctl-big" aria-label="Larger text" title="Larger text" disabled={disabled || !canStep(prefs.size, 1)} onClick={() => step(1)}>
      <span aria-hidden="true">A<span className="pn-ctl-sign">+</span></span>
    </button>
    <button type="button" className="pn-ctl pn-ctl-ts" aria-pressed={prefs.timestamps} disabled={disabled}
      onClick={() => setPrefs(p => ({ ...p, timestamps: !p.timestamps }))}>
      <Icon name="clock" size={16} /><span>Timestamps</span>
    </button>
  </div>;
}

// Question, answer and error for "Ask about this sermon".
function useAsk(noteId) {
  const [question, setQuestion] = useState(''), [answer, setAnswer] = useState(null),
    [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function ask(e) {
    e.preventDefault(); setBusy(true); setError(''); setAnswer(null);
    try { setAnswer(await api(`/notes/${noteId}/ask`, { method: 'POST', body: JSON.stringify({ question }) })); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  return { question, setQuestion, answer, busy, error, ask };
}

function AskBox({ asker, label = 'Ask about this sermon' }) {
  const { question, setQuestion, answer, busy, error, ask } = asker;
  return <div className="pn-askbox">
    <form className="pn-ask" onSubmit={ask}>
      <label className="field"><span className="pn-ask-label">{label}</span><input value={question} maxLength={500} onChange={e => setQuestion(e.target.value)} placeholder="What was said about the good Samaritan?" /></label>
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
  </div>;
}

function Transcript({ segments, bySegment, activeCats, prefs }) {
  const [openVerse, setOpenVerse] = useState(null);
  return <article className={'pn-transcript' + (prefs.timestamps ? '' : ' no-ts')} style={{ '--pn-size': textSizePx(prefs.size) + 'px' }} aria-label="Transcript">
    <ol className="pn-segments">{segments.map(s => {
      const shown = (bySegment.get(s.idx) || []).filter(a => activeCats.has(a.category));
      // A passage's label goes on its first segment; the first shown category picks the color.
      const starts = shown.filter(a => a.seg_from === s.idx);
      return <li key={s.idx} className={shown.length ? 'hl hl-' + shown[0].category : undefined}>
        {starts.length > 0 && <span className="hl-legend">{starts.map((a, i) => {
          const parts = BIBLE_CATS.has(a.category) ? referenceParts(a.label) : [{ text: a.label, ref: null }];
          return <span key={i}>{i > 0 && ' · '}{CAT_LABEL[a.category]}{a.label && ': '}
            {parts.map((p, j) => {
              const key = `${s.idx}:${i}:${j}`;
              return p.ref ? <button key={j} className="hl-verse-btn" aria-expanded={openVerse?.key === key}
                  onClick={() => setOpenVerse(openVerse?.key === key ? null : { key, ref: p.ref })}>{p.text}</button>
                : p.text;
            })}
          </span>;
        })}</span>}
        <b className="pn-ts">{s.timestamp}</b> {s.text}
        {openVerse?.key.startsWith(s.idx + ':') && <VerseCard reference={openVerse.ref} onClose={() => setOpenVerse(null)} />}
      </li>;
    })}</ol>
  </article>;
}

// Where Ask and the highlight chips sit around the transcript.
function ReaderBody({ asker, toggles, transcript }) {
  return <div className="pn-body">
    <AskBox asker={asker} />
    {toggles}
    {transcript}
  </div>;
}

function NoteView({ note, onChange, prefs }) {
  const [segments, setSegments] = useState([]), [error, setError] = useState(''), [loading, setLoading] = useState(true),
    [annotations, setAnnotations] = useState([]), [activeCats, setActiveCats] = useState(() => new Set(CATS.filter(c => c.on).map(c => c.key)));
  const asker = useAsk(note.id);
  useEffect(() => {
    setSegments([]); setAnnotations([]); setError(''); setLoading(true);
    if (note.status !== 'ready') return;
    api(`/notes/${note.id}/segments`).then(setSegments).catch(err => setError(err.message)).finally(() => setLoading(false));
    // Highlights are optional; a transcript without them still reads fine.
    api(`/notes/${note.id}/annotations`).then(list => setAnnotations(mergeAnnotations(list))).catch(() => {});
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
  if (note.status !== 'ready') {
    return <section className="card pn-state">
      <span className={'status ' + note.status}>{statusLabel(note.status)}</span>
      <h2>{note.title}</h2>
      <p>{note.status === 'failed' ? (ERRORS[note.error] || `Processing failed (${note.error}).`) : 'Transcribing… this page updates on its own.'}</p>
      {error && <p className="pn-error" role="alert">{error}</p>}
      {note.status === 'failed' && <button className="secondary" onClick={() => api(`/notes/${note.id}/retry`, { method: 'POST' }).then(onChange, err => setError(err.message))}>Try again</button>}
    </section>;
  }
  const transcript = error ? <p className="pn-error pn-transcript-msg" role="alert">{error}</p>
    : loading && !segments.length ? <p className="muted pn-transcript-msg">Loading transcript…</p>
    : <Transcript segments={segments} bySegment={bySegment} activeCats={activeCats} prefs={prefs} />;
  const toggles = annotations.length > 0 ? <CategoryToggles counts={counts} active={activeCats} onToggle={toggleCat} /> : null;
  return <ReaderBody asker={asker} toggles={toggles} transcript={transcript} highlightCount={annotations.length} />;
}

// The open sermon lives in the route (#/notes/<id>); without one, the newest ready sermon opens.
export default function PastorNotes({ route, go }) {
  const church = useChurch();
  // The Sermon Notes key, or a signed-in staff session for this church, opens the notes.
  const [hasKey, setHasKey] = useState(Boolean(getApiKey() || church.staff)),
    [notes, setNotes] = useState([]), [loaded, setLoaded] = useState(false), [error, setError] = useState(''),
    [adding, setAdding] = useState(false), [prefs, setPrefs] = useState(() => readPrefs(globalThis.localStorage));
  const selected = route.startsWith('notes/') ? route.slice('notes/'.length) : null;
  async function load() {
    try {
      setNotes(await api('/notes')); setError('');
    } catch (err) { setError(err.message); }
    finally { setLoaded(true); }
  }
  useEffect(() => { if (hasKey) load(); }, [hasKey]);
  useEffect(() => { writePrefs(globalThis.localStorage, prefs); }, [prefs]);
  // Poll while anything is still being transcribed.
  useEffect(() => {
    if (!notes.some(pending)) return;
    const timer = setTimeout(load, 5000);
    return () => clearTimeout(timer);
  }, [notes]);
  if (!hasKey) return <KeyForm onChange={() => setHasKey(true)} />;
  const current = pickCurrent(notes, selected);
  // Anyone who can open the notes can add a sermon, as before.
  const canAdd = hasKey;
  return <div className="pn pn-reading">
    <header className="pn-head">
      <div className="pn-head-top">
        <span className="eyebrow">Sermon Notes{church.name ? ` · ${church.name}` : ''}</span>
        {getApiKey() && <button className="ghost" onClick={() => { setApiKey(''); setHasKey(church.staff); setNotes([]); }}>Forget key</button>}
      </div>
      <div className="pn-head-main">
        <SermonPicker notes={notes} current={current} onPick={id => { if (id !== current?.id) go('notes/' + id); }} />
        {canAdd && <button type="button" className="primary pn-add" aria-label="Add sermon" aria-haspopup="dialog" aria-expanded={adding} onClick={() => setAdding(true)}>
          <Icon name="plus" size={18} /><span>Add sermon</span>
        </button>}
        <ReaderControls prefs={prefs} setPrefs={setPrefs} disabled={current?.status !== 'ready'} />
      </div>
    </header>
    {error && <div className="banner error" role="alert">{error}</div>}
    {current ? <NoteView key={current.id} note={current} onChange={load} prefs={prefs} />
      : <section className="card pn-state pn-empty"><Icon name="book" size={40} />
          <h2>{!loaded ? 'Loading sermons…' : selected ? 'Sermon not found' : 'No sermons yet'}</h2>
          {loaded && <p>{selected ? 'It may have been removed. Pick another from the list above.' : 'Add a YouTube link or upload a file. Once it is transcribed you can read it here and ask questions.'}</p>}
        </section>}
    {adding && <Sheet title="Add a sermon" onClose={() => setAdding(false)}>
      <NewNote onCreated={() => { setAdding(false); load(); }} />
    </Sheet>}
  </div>;
}
