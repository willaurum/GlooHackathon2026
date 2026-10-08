import { useEffect, useMemo, useRef, useState } from 'react';
import { getStaffToken, getVerifiedStaffToken, hashFor, setStaffToken } from './church.js';
import { askTekton, discardDraft, loadEditor, publishDraft, restorePrevious, saveDraft } from './editorApi.js';
import { verifyStaffSession } from './giving.js';
import Icon from './Icon.jsx';
import { Brand } from './Layout.jsx';
import { COLOR_TOKENS, FONTS, MAX_OPS, SCALES, STYLE_LABELS, acceptOp, addOp, applyOps, checkOp, describeChanges, newOpId,
  pathLabel, publicSite, readPath, removeOp } from './siteDraft.js';

// Staff edit their live site here (#/c/<slug>/edit/<route>): the site as visitors see it with the draft on top,
// text changed in place, sections moved or hidden, colors and sizes picked, and Tekton asked for changes. Every change
// waits in a draft on the server until staff review and publish it.

// The template's own colors, shown in the color pickers while the church uses them.
const TEMPLATE_COLORS = { primary: '#2b6248', accent: '#8f7a4f', background: '#f6f7f3', text: '#3a4d44' };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Only signed-in staff of this church may edit; anyone else is pointed to Church setup to sign in. */
export default function SiteEditor({ slug, Site }) {
  const [, setStaffVersion] = useState(0);
  useEffect(() => {
    const changed = () => setStaffVersion(v => v + 1);
    window.addEventListener('belong-staff', changed);
    return () => window.removeEventListener('belong-staff', changed);
  }, []);
  const token = getStaffToken(slug);
  const verified = !!token && getVerifiedStaffToken(slug) === token;
  // A token restored from this tab is checked again first, as the site does.
  useEffect(() => {
    let live = true, retry;
    if (!token || verified) return;
    async function verify() {
      try {
        const valid = await verifyStaffSession(slug);
        if (live && getStaffToken(slug) === token) setStaffToken(slug, valid ? token : '', { verified: valid });
      } catch (err) {
        if (live && getStaffToken(slug) === token && err.status !== 401) retry = setTimeout(verify, 5000);
      }
    }
    verify();
    return () => { live = false; clearTimeout(retry); };
  }, [slug, token, verified]);
  if (!token) return <EditorGate slug={slug}>
    <h1>Sign in to edit your site.</h1>
    <p>Only church staff can edit this site. Sign in in Church setup, then open Edit your site.</p>
  </EditorGate>;
  if (!verified) return <EditorGate slug={slug} status>Checking your staff sign-in…</EditorGate>;
  return <EditorSession slug={slug} Site={Site} />;
}

function EditorGate({ slug, status = false, children }) {
  useEffect(() => { document.title = 'Edit your site · Tekton'; }, []);
  return <div className="standalone-builder editor-gate">
    <header><Brand /></header>
    <main>
      {status ? <p role="status">{children}</p> : children}
      <p><a href={hashFor(slug, 'setup')}>Open Church setup</a> · <a href={hashFor(slug)}>Back to the site</a></p>
    </main>
  </div>;
}

function EditorSession({ slug, Site }) {
  const [server, setServer] = useState(null), [ops, setOps] = useState([]), [loadError, setLoadError] = useState('');
  const [epoch, setEpoch] = useState(0), [clean, setClean] = useState(false), [panel, setPanel] = useState('');
  const [saving, setSaving] = useState('saved'), [message, setMessage] = useState(null), [busy, setBusy] = useState('');
  const [reply, setReply] = useState(null), [published, setPublished] = useState(null);
  // The latest ops and draft version, for saves that finish after newer edits.
  const opsRef = useRef([]), versionRef = useRef(0), dirtyRef = useRef(false), savingRef = useRef(null), timerRef = useRef(null);

  function notify(text, kind = 'error') { setMessage(text ? { text, kind } : null); }
  // A fresh State from the server: its ops replace ours; `reload` remounts the site so pages read the new content.
  function adopt(state, reload = true) {
    clearTimeout(timerRef.current);
    dirtyRef.current = false;
    versionRef.current = state.version;
    opsRef.current = state.ops || [];
    setServer(state);
    setOps(opsRef.current);
    setSaving('saved');
    if (reload) setEpoch(e => e + 1);
  }
  async function reload() {
    try { adopt(await loadEditor(slug)); } catch (err) { notify(err.message); }
  }
  useEffect(() => {
    loadEditor(slug).then(state => adopt(state, false)).catch(err => setLoadError(err.status === 401 ? 'Please sign in as church staff.' : err.message));
  }, [slug]);

  // Saving: changes apply at once on screen and are sent shortly after (PUT replaces the whole op list).
  function change(next) {
    opsRef.current = next;
    setOps(next);
    dirtyRef.current = true;
    setSaving('saving');
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(flush, 600);
  }
  async function flush() {
    clearTimeout(timerRef.current);
    while (savingRef.current) await savingRef.current;
    if (!dirtyRef.current) return true;
    dirtyRef.current = false;
    const sent = opsRef.current;
    setSaving('saving');
    savingRef.current = saveDraft(slug, versionRef.current, sent).then(state => {
      versionRef.current = state.version;
      setServer(state);
      // The server's copy (ids, cleaned values) unless staff changed more while it saved.
      if (opsRef.current === sent) { opsRef.current = state.ops || []; setOps(opsRef.current); }
      setSaving(dirtyRef.current ? 'saving' : 'saved');
      return true;
    }).catch(async err => {
      if (err.status === 409) {
        notify('Your draft was changed somewhere else, so it was reloaded. Check your changes and try again.');
        await reload();
      } else if (err.status === 422 && err.op && sent.some(o => o.id === err.op)) {
        notify('One change could not be saved and was undone. ' + err.message);
        change(removeOp(opsRef.current, err.op));
      } else {
        dirtyRef.current = true;
        setSaving('error');
        notify('Your changes are not saved yet. ' + err.message);
      }
      return false;
    }).finally(() => { savingRef.current = null; });
    return savingRef.current;
  }
  // Leaving the editor sends what is not saved yet; closing the tab first asks.
  useEffect(() => {
    const warn = e => { if (dirtyRef.current || savingRef.current) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
      clearTimeout(timerRef.current);
      if (dirtyRef.current) saveDraft(slug, versionRef.current, opsRef.current).catch(() => {});
    };
  }, []);

  const draft = useMemo(() => server ? applyOps(server.published, ops, { pending: true }) : null, [server?.published, ops]);
  const snapshot = useMemo(() => draft && publicSite(draft.content), [draft]);
  const changes = useMemo(() => server ? describeChanges(server.published, ops) : [], [server?.published, ops]);
  // Highlights: text and sections staff changed, and the ones Tekton suggests.
  const marks = useMemo(() => {
    const map = new Map();
    for (const op of ops) {
      const key = op.op === 'set_text' ? op.path : /_section$/.test(op.op) ? `section:${op.page}:${op.section}` : '';
      if (key && map.get(key) !== 'suggested') map.set(key, op.pending ? 'suggested' : 'changed');
    }
    return map;
  }, [ops]);

  if (loadError) return <EditorGate slug={slug}><h1>The editor could not open.</h1><p role="alert">{loadError}</p></EditorGate>;
  if (!server || !draft) return <EditorGate slug={slug} status>Loading your site…</EditorGate>;

  const live = server.published;
  const name = live?.info?.name || 'your church';
  const pending = changes.filter(c => c.pending), accepted = changes.filter(c => !c.pending && !c.stale);

  // A staff change: checked like the server does; one that puts back the live value just drops the earlier change.
  function addChange(fields) {
    const op = { id: newOpId(), source: 'staff', pending: false, ...fields };
    const checked = checkOp(draft.content, op);
    if (checked.error) return checked.error;
    if (checked.stale) return 'That part of the site is no longer there. It may have been removed in Church setup.';
    const same = checked.op.op === 'set_text' ? readPath(applyOps(live, [checked.op]).content, op.path) === readPath(live, op.path)
      : checked.op.op === 'set_style' ? (SCALES[op.token] ? (live.site?.style?.[op.token] ?? 1) : live.site?.theme?.[op.token] || '') === checked.op.value
        : false;
    const kind = checked.op.op === 'set_text' ? 'path' : 'token';
    const without = opsRef.current.filter(o => o.pending || o.op !== checked.op.op || o[kind] !== checked.op[kind]);
    const next = same ? without : addOp(opsRef.current, checked.op);
    if (next.length > MAX_OPS) return 'Your draft holds as many changes as it can. Publish or undo some first.';
    change(next);
    return '';
  }
  const setStyle = (token, value) => addChange({ op: 'set_style', token, value });

  async function run(kind, call, { remount = true, done } = {}) {
    if (busy) return;
    setBusy(kind);
    try {
      if (!(await flush())) return;
      const state = await call();
      adopt(state, remount);
      done?.(state);
    } catch (err) {
      if (err.status === 409) { notify(err.message || 'Your draft changed. It was reloaded.'); await reload(); }
      else notify(err.message);
    } finally { setBusy(''); }
  }
  const publish = () => run('publish', () => publishDraft(slug, versionRef.current), {
    done: state => { setPublished(state.published_changes || []); notify(''); } });
  const discard = () => run('discard', () => discardDraft(slug), { done: () => { setPanel(''); setReply(null); notify('Your draft was discarded.', 'info'); } });
  const restore = () => run('restore', () => restorePrevious(slug), {
    done: () => { setPanel(''); setPublished(null); notify('The previous version is live again.', 'info'); } });
  const ask = (request, route) => run('ask', () => askTekton(slug, request, route, versionRef.current), {
    remount: false, done: state => setReply({ reply: state.reply || '', refused: state.refused || [], proposed: state.proposed || [] }) });
  async function exit(route) {
    await flush();
    window.location.hash = hashFor(slug, route);
  }
  const accept = id => change(acceptOp(opsRef.current, id));
  const decline = id => change(removeOp(opsRef.current, id));
  const acceptAll = () => change(pending.reduce((list, c) => acceptOp(list, c.id), opsRef.current));
  const toggle = name => setPanel(p => p === name ? '' : name);

  const toolbar = (route, viewing) => <div className="editor-ui">
    <div className="editor-bar">
      <div className="editor-status">
        <strong>Editing {name}</strong>
        <span role="status">{ops.length ? plural(ops.length, 'change') : 'No changes yet'} · {{ saved: 'Saved', saving: 'Saving…', error: 'Not saved' }[saving]}</span>
      </div>
      <div className="editor-actions">
        <button type="button" className="secondary" aria-expanded={panel === 'style'} onClick={() => toggle('style')}><Icon name="sparkle" size={16} />Style</button>
        <button type="button" className="secondary" aria-expanded={panel === 'ask'} onClick={() => toggle('ask')}>
          <Icon name="chat" size={16} />Ask Tekton{pending.length > 0 && <b className="count">{pending.length}</b>}
        </button>
        <button type="button" className="primary" onClick={() => { setPublished(null); setPanel('review'); }}>Review and publish</button>
        <button type="button" className="ghost" disabled={!ops.length} onClick={() => setPanel('discard')}>Discard draft</button>
        {server.previous && <button type="button" className="ghost" onClick={() => setPanel('restore')}>Restore previous version</button>}
        <button type="button" className="ghost" onClick={() => exit(route)}>Exit editor</button>
      </div>
    </div>
    {message && <div className={'editor-message ' + message.kind} role={message.kind === 'error' ? 'alert' : 'status'}>
      <span>{message.text}</span>
      <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => notify('')}><Icon name="x" size={16} /></button>
    </div>}
    {panel === 'style' && <StylePanel live={live} theme={draft.content.site?.theme || {}} style={draft.content.site?.style || {}} setStyle={setStyle} onClose={() => setPanel('')} />}
    {panel === 'ask' && <AskPanel viewing={viewing} route={route} busy={busy === 'ask'} reply={reply} pending={pending}
      onAsk={request => ask(request, route)} onAccept={accept} onDecline={decline} onAcceptAll={acceptAll} onClose={() => setPanel('')} />}
    {panel === 'review' && <EditorDialog title={published ? 'Your changes are live.' : 'Review and publish'} drawer onClose={() => setPanel('')}>
      {published ? <div className="editor-published">
        <p>Visitors now see {plural(published.length || accepted.length, 'change')} on your site.</p>
        {published.length > 0 && <ul>{published.map((label, i) => <li key={i}>{label}</li>)}</ul>}
        <div className="editor-dialog-actions">
          <a className="btn primary" href={hashFor(slug)}>See your live site</a>
          {server.previous && <button type="button" className="secondary" onClick={() => setPanel('restore')}>Restore previous version</button>}
        </div>
      </div> : <>
        <label className="field checkbox"><input type="checkbox" checked={clean} onChange={e => setClean(e.target.checked)} />Hide outlines to see the page as visitors will</label>
        {changes.length === 0 ? <p>No changes yet. Click any text on your site to change it, or open a section’s menu to move or hide it.</p>
          : <ul className="editor-changes">{changes.map(c => <li key={c.id} className={c.pending ? 'suggested' : c.stale ? 'stale' : ''}>
            <ChangeLine change={c} />
            <div className="editor-change-actions">
              {c.pending ? <>
                <button type="button" className="secondary" onClick={() => accept(c.id)}>Accept</button>
                <button type="button" className="ghost" onClick={() => decline(c.id)}>Decline</button>
              </> : <button type="button" className="ghost" onClick={() => decline(c.id)}>Undo</button>}
            </div>
          </li>)}</ul>}
        {pending.length > 0 && <p className="form-note">Accept or decline Tekton’s suggestions before you publish.</p>}
        <div className="editor-dialog-actions">
          <button type="button" className="primary" disabled={!accepted.length || pending.length > 0 || !!busy} onClick={publish}>{busy === 'publish' ? 'Publishing…' : 'Publish'}</button>
          <button type="button" className="ghost" onClick={() => setPanel('')}>Keep editing</button>
        </div>
      </>}
    </EditorDialog>}
    {panel === 'discard' && <EditorDialog title="Discard your draft?" onClose={() => setPanel('')}>
      <p>This removes all {plural(ops.length, 'change')} you have not published. Your live site stays as it is.</p>
      <div className="editor-dialog-actions">
        <button type="button" className="primary danger" disabled={!!busy} onClick={discard}>{busy === 'discard' ? 'Discarding…' : 'Discard draft'}</button>
        <button type="button" className="ghost" onClick={() => setPanel('')}>Keep editing</button>
      </div>
    </EditorDialog>}
    {panel === 'restore' && server.previous && <EditorDialog title="Restore the previous version?" onClose={() => setPanel('')}>
      <p>Your live site goes back to how it was before {server.previous.saved_at ? new Date(server.previous.saved_at).toLocaleString() : 'the last publish'}. These changes are undone:</p>
      <ul className="editor-previous">{(server.previous.changes || []).map((label, i) => <li key={i}>{label}</li>)}</ul>
      <p className="form-note">Your draft is kept. You can restore again to bring these changes back.</p>
      <div className="editor-dialog-actions">
        <button type="button" className="primary" disabled={!!busy} onClick={restore}>{busy === 'restore' ? 'Restoring…' : 'Restore previous version'}</button>
        <button type="button" className="ghost" onClick={() => setPanel('')}>Cancel</button>
      </div>
    </EditorDialog>}
  </div>;

  const editor = {
    slug, content: draft.content, clean, setupHref: hashFor(slug, 'setup'),
    read: path => readPath(draft.content, path),
    status: key => marks.get(key) || '',
    label: path => pathLabel(draft.content, path),
    setText: (path, value) => addChange({ op: 'set_text', path, value }),
    addOp: fields => { const error = addChange(fields); if (error) notify(error); },
    notify, toolbar,
  };
  return <Site key={epoch} snapshot={snapshot} editor={editor} />;
}

function ChangeLine({ change }) {
  const show = value => value === '' || value == null ? <em>Empty</em> : value;
  return <div className="editor-change">
    <div className="editor-change-label">
      <strong>{change.label}</strong>
      {change.pending && <span className="editor-tag">Suggested by Tekton</span>}
      {change.stale && <span className="editor-tag stale">No longer applies</span>}
    </div>
    <dl className="editor-diff">
      <dt>Before</dt><dd>{show(change.before)}</dd>
      <dt>After</dt><dd>{show(change.after)}</dd>
    </dl>
  </div>;
}

function StylePanel({ live, theme, style, setStyle, onClose }) {
  const [error, setError] = useState('');
  const set = (token, value) => setError(setStyle(token, value));
  const fonts = token => [...new Set([...FONTS, ...(live.site?.theme?.[token] ? [live.site.theme[token]] : [])])];
  const step = (token, delta) => {
    const [low, high] = SCALES[token];
    const next = Math.round(((style[token] ?? 1) + delta) * 20) / 20;
    if (next >= low - 1e-9 && next <= high + 1e-9) set(token, next);
  };
  return <section className="editor-panel card" aria-label="Style">
    <div className="editor-panel-head"><strong>Style</strong><button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="x" size={18} /></button></div>
    <div className="editor-style-grid">
      {COLOR_TOKENS.map(token => <div key={token} className="editor-style-row">
        <label htmlFor={'style-' + token}>{STYLE_LABELS[token]}</label>
        <input id={'style-' + token} type="color" value={theme[token] || TEMPLATE_COLORS[token]} onChange={e => set(token, e.target.value)} />
        <button type="button" className="ghost" disabled={!theme[token]} onClick={() => set(token, '')}>Default</button>
      </div>)}
      {['heading_font', 'body_font'].map(token => <div key={token} className="editor-style-row">
        <label htmlFor={'style-' + token}>{STYLE_LABELS[token]}</label>
        <select id={'style-' + token} value={theme[token] || ''} onChange={e => set(token, e.target.value)}>
          <option value="">Default</option>
          {fonts(token).map(f => <option key={f} value={f}>{f}</option>)}
        </select>
      </div>)}
      {Object.keys(SCALES).map(token => <div key={token} className="editor-style-row">
        <span>{STYLE_LABELS[token]}</span>
        <div className="editor-stepper">
          <button type="button" className="secondary" aria-label={'Smaller ' + STYLE_LABELS[token].toLowerCase()} disabled={(style[token] ?? 1) <= SCALES[token][0] + 1e-9} onClick={() => step(token, -0.05)}>−</button>
          <output>{Math.round((style[token] ?? 1) * 100)}%</output>
          <button type="button" className="secondary" aria-label={'Larger ' + STYLE_LABELS[token].toLowerCase()} disabled={(style[token] ?? 1) >= SCALES[token][1] - 1e-9} onClick={() => step(token, 0.05)}>+</button>
        </div>
      </div>)}
    </div>
    {error && <p className="editor-error" role="alert">{error}</p>}
  </section>;
}

function AskPanel({ viewing, busy, reply, pending, onAsk, onAccept, onDecline, onAcceptAll, onClose }) {
  const [request, setRequest] = useState('');
  const text = request.trim();
  return <section className="editor-panel card" aria-label="Ask Tekton">
    <div className="editor-panel-head"><strong>Ask Tekton</strong><button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="x" size={18} /></button></div>
    <form className="editor-ask" onSubmit={e => { e.preventDefault(); if (text.length >= 3 && !busy) { onAsk(text); setRequest(''); } }}>
      <label className="builder-sr-only" htmlFor="editor-ask">Ask Tekton to change your site</label>
      <input id="editor-ask" value={request} maxLength={300} disabled={busy} onChange={e => setRequest(e.target.value)}
        placeholder={'Ask Tekton to change ' + (viewing || 'your site') + ', like “Make the headings bigger”'} />
      <button className="primary" disabled={busy || text.length < 3}>{busy ? 'Working…' : 'Ask'}</button>
    </form>
    <p className="form-note">Tekton suggests changes. Nothing changes until you accept it and publish.</p>
    <div role="status" aria-live="polite">
      {reply?.reply && <p className="editor-reply">{reply.reply}</p>}
      {reply?.refused?.length > 0 && <p className="editor-error">{reply.refused.join(' ')}</p>}
    </div>
    {pending.length > 0 && <div className="editor-suggestions">
      <div className="editor-panel-head"><strong>{plural(pending.length, 'suggestion')}</strong>
        <button type="button" className="secondary" onClick={onAcceptAll}>Accept all</button></div>
      <ul className="editor-changes">{pending.map(c => <li key={c.id} className="suggested">
        <ChangeLine change={c} />
        <div className="editor-change-actions">
          <button type="button" className="secondary" onClick={() => onAccept(c.id)}>Accept</button>
          <button type="button" className="ghost" onClick={() => onDecline(c.id)}>Decline</button>
        </div>
      </li>)}</ul>
    </div>}
  </section>;
}

function EditorDialog({ title, drawer = false, onClose, children }) {
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return <div className={'editor-backdrop' + (drawer ? ' drawer' : '')} onClick={e => e.target === e.currentTarget && onClose()}>
    <div className="card editor-dialog" role="dialog" aria-modal="true" aria-label={title}>
      <div className="editor-panel-head"><h2>{title}</h2><button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="x" size={20} /></button></div>
      {children}
    </div>
  </div>;
}
