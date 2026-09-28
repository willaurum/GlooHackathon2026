import { useEffect, useState } from 'react';
import { api, getApiKey, setApiKey } from './api.js';

const API_BASE = import.meta.env.VITE_API_BASE ?? '';
const pending = note => note.status === 'queued' || note.status === 'processing';
const ERRORS = {
  youtube_blocked: 'YouTube blocked the download from our servers. Upload the video file instead.',
  youtube_unavailable: 'That YouTube video is private or unavailable.',
  too_long: 'The video is longer than the 90-minute limit.',
  no_audio: 'The file has no audio track.',
  no_speech: 'No speech was found in the audio.',
  interrupted: 'Processing was interrupted. Try again.',
};

function KeyForm({ onChange }) {
  const [value, setValue] = useState('');
  return <form className="panel pn-key" onSubmit={e => { e.preventDefault(); setApiKey(value.trim()); onChange(); }}>
    <h2>Connect to Pastor Notes</h2>
    <p>Enter this church's API key. It stays in this browser tab only.</p>
    <label className="field">API key<input type="password" value={value} onChange={e => setValue(e.target.value)} autoComplete="off" /></label>
    <button className="primary" disabled={!value.trim()}>Connect</button>
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
  return <form className="panel pn-new" onSubmit={submit}>
    <h2>New note</h2>
    <div className="filters">
      <button type="button" className={mode === 'youtube' ? 'selected' : ''} onClick={() => setMode('youtube')}>YouTube link</button>
      <button type="button" className={mode === 'upload' ? 'selected' : ''} onClick={() => setMode('upload')}>Upload a file</button>
    </div>
    <label className="field">Title<input value={title} maxLength={200} onChange={e => setTitle(e.target.value)} placeholder="e.g. Sunday, Luke 10" /></label>
    {mode === 'youtube'
      ? <label className="field">YouTube URL<input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://www.youtube.com/watch?v=..." /></label>
      : <label className="field">Video or audio file <small>Up to 95 MB</small><input type="file" accept="video/*,audio/*" onChange={e => setFile(e.target.files[0] || null)} /></label>}
    {error && <p className="pn-error" role="alert">{error}</p>}
    <button className="primary" disabled={busy || !title.trim() || (mode === 'youtube' ? !url.trim() : !file)}>{busy ? 'Working…' : 'Create note'}</button>
  </form>;
}

function NoteView({ note, onChange }) {
  const [segments, setSegments] = useState([]), [question, setQuestion] = useState(''),
    [answer, setAnswer] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    setSegments([]); setAnswer(null);
    if (note.status === 'ready') api(`/notes/${note.id}/segments`).then(setSegments).catch(err => setError(err.message));
  }, [note.id, note.status]);
  async function ask(e) {
    e.preventDefault(); setBusy(true); setError(''); setAnswer(null);
    try { setAnswer(await api(`/notes/${note.id}/ask`, { method: 'POST', body: JSON.stringify({ question }) })); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  if (note.status !== 'ready') {
    return <section className="panel"><h2>{note.title}</h2>
      <p>{note.status === 'failed' ? (ERRORS[note.error] || `Processing failed (${note.error}).`) : 'Transcribing… this page updates on its own.'}</p>
      {error && <p className="pn-error" role="alert">{error}</p>}
      {note.status === 'failed' && <button className="secondary" onClick={() => api(`/notes/${note.id}/retry`, { method: 'POST' }).then(onChange, err => setError(err.message))}>Try again</button>}
    </section>;
  }
  return <section className="panel pn-note">
    <h2>{note.title}</h2>
    <form className="pn-ask" onSubmit={ask}>
      <label className="field">Ask about this note<input value={question} maxLength={500} onChange={e => setQuestion(e.target.value)} placeholder="What did he say about the good Samaritan?" /></label>
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
    <ol className="pn-segments">{segments.map(s => <li key={s.idx}><b>{s.timestamp}</b> {s.text}</li>)}</ol>
  </section>;
}

export default function PastorNotes() {
  const [hasKey, setHasKey] = useState(Boolean(getApiKey())), [church, setChurch] = useState(null),
    [notes, setNotes] = useState([]), [selected, setSelected] = useState(null), [error, setError] = useState('');
  async function load() {
    try {
      const [info, list] = await Promise.all([api('/church'), api('/notes')]);
      setChurch(info); setNotes(list); setError('');
    } catch (err) { setError(err.message); }
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
  return <div className="pn">
    <div className="pn-bar">
      <div className="eyebrow">{church ? church.name.toUpperCase() : ' '}</div>
      <button className="secondary" onClick={() => { setApiKey(''); setHasKey(false); setNotes([]); }}>Forget key</button>
    </div>
    {error && <div className="api-message" role="alert">{error}</div>}
    <div className="pn-grid">
      <div>
        <NewNote onCreated={load} />
        <section className="panel pn-list"><h2>Notes <small>{notes.length}</small></h2>
          {notes.length ? <ul>{notes.map(n => <li key={n.id}>
            <button className={n.id === selected ? 'selected' : ''} onClick={() => setSelected(n.id)}>
              <strong>{n.title}</strong><small>{n.source_kind} · {n.status}{n.error ? ` (${n.error})` : ''}</small>
            </button></li>)}</ul> : <p>No notes yet. Add a YouTube link or upload a file.</p>}
        </section>
      </div>
      {current ? <NoteView note={current} onChange={load} /> : <section className="panel"><p>Pick a note to read its transcript and ask questions.</p></section>}
    </div>
  </div>;
}
