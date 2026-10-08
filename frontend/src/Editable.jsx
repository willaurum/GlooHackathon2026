import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { orderedSections } from './churchSite.js';
import { SECTIONS, cleanLayout, cleanText, parsePath } from './siteDraft.js';

// The site editor (SiteEditor.jsx) while staff edit their site; null for everyone else, who see the site exactly as
// before: every component here then renders just the element (or text) it wraps.
export const EditorContext = createContext(null);
export const useEditor = () => useContext(EditorContext);
// Outlines, notes and section frames show only while editing with outlines on.
const active = editor => !!editor && !editor.clean;
const classes = (...names) => names.filter(Boolean).join(' ') || undefined;
const stop = e => { e.preventDefault(); e.stopPropagation(); };
// Space and Enter on text inside a <summary> (an FAQ question) would open or close its <details>: the summary acts on
// the click they cause and on their key up. Text being edited keeps those keys to itself.
const keepKeys = e => { if (e.key === ' ' || e.key === 'Enter') stop(e); };
/** The tooltip on site buttons that do nothing in the editor. */
export const INERT = 'Buttons don’t work while editing';

/** Text staff can change in place. `path` is a draft path (siteDraft.js), `fallback` the text shown while the field is
 *  empty (the template's own), `render` turns the text into elements (paragraphs). Without an editor it renders
 *  `children` in `as` (or bare), as the site always has. */
export function Editable({ path, as: Tag = null, className, fallback = '', render, children }) {
  const editor = useEditor();
  const [editing, setEditing] = useState(false);
  const ref = useRef(null);
  const draft = editor && path ? editor.read(path) : undefined;
  const shown = draft === undefined ? undefined : draft || fallback;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!editing || !el) return;
    el.textContent = shown ?? '';
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }, [editing]);
  if (!editor || !path) return Tag ? <Tag className={className}>{children}</Tag> : <>{children}</>;
  const body = shown === undefined ? children : render ? render(shown) : shown;
  const El = Tag || (render ? 'div' : 'span');
  if (!active(editor)) return Tag ? <Tag className={className}>{body}</Tag> : <>{body}</>;

  const where = parsePath(path);
  function commit() {
    const text = ref.current?.innerText ?? '';
    const cleaned = cleanText(text, where || {});
    if (!cleaned.error && cleaned.value === (shown ?? '')) { setEditing(false); return; }
    // Emptying a field with a template default puts the default back.
    const error = editor.setText(path, cleaned.error ? text : cleaned.value);
    if (error) { editor.notify(error); return; }
    setEditing(false);
  }
  function onKeyDown(e) {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
    else if (e.key === 'Enter' && (!where?.multiline || e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(); }
  }
  const status = editor.status(path);
  if (editing) return <El ref={ref} className={classes(className, 'editable', 'editing', where?.multiline && 'multiline')}
    contentEditable="plaintext-only" suppressContentEditableWarning role="textbox" aria-multiline={!!where?.multiline}
    aria-label={editor.label(path)} onKeyDown={onKeyDown} onKeyUp={keepKeys} onBlur={commit} onClick={stop} />;
  return <El className={classes(className, 'editable', status && 'editable-' + status)} tabIndex={0}
    title={status === 'suggested' ? 'Tekton suggested this. Review it in Ask Tekton.' : 'Click to edit'}
    onClick={e => { stop(e); setEditing(true); }} onKeyUp={keepKeys}
    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { stop(e); setEditing(true); } }}>
    {body}
  </El>;
}

// The one "Edit this in Church setup" note open now: opening another closes it.
let closeOpenNote = null;

/** A fact Church setup owns (name, address, service times, lists): in the editor, clicking it says where to change it. */
export function SetupFact({ as: Tag = null, block = false, className, children }) {
  const editor = useEditor();
  const [open, setOpen] = useState(false);
  const close = useRef(() => setOpen(false));
  useEffect(() => () => { if (closeOpenNote === close.current) closeOpenNote = null; }, []);
  if (!active(editor)) return Tag ? <Tag className={className}>{children}</Tag> : <>{children}</>;
  const El = Tag || (block ? 'div' : 'span');
  function toggle(e) {
    stop(e);
    if (open) { setOpen(false); closeOpenNote = null; return; }
    if (closeOpenNote && closeOpenNote !== close.current) closeOpenNote();
    closeOpenNote = close.current;
    setOpen(true);
  }
  return <El className={classes(className, 'editable-fact', open && 'open')} onClick={toggle}>
    {children}
    {open && <span className="editor-note" role="note" onClick={e => e.stopPropagation()}>
      Edit this in Church setup. <a href={editor.setupHref}>Open Church setup</a>
    </span>}
  </El>;
}

/** The section keys a page shows: in the editor the hidden ones too, so they can be shown again. */
export function sectionKeys(editor, layout, page, defaults) {
  return active(editor) ? cleanLayout(layout)[page].filter(k => defaults.includes(k)) : orderedSections(layout, page, defaults);
}

/** A Home or Plan your visit section; in the editor it gets a small menu to move or hide it. */
export function SectionFrame({ page, section, layout, children }) {
  const editor = useEditor();
  const [open, setOpen] = useState(false);
  if (!active(editor)) return children;
  const { [page]: order, hidden: hiddenList } = cleanLayout(layout);
  const hidden = hiddenList.includes(page + ':' + section);
  const index = order.indexOf(section), label = SECTIONS[page][section];
  const act = op => { editor.addOp({ page, section, ...op }); setOpen(false); };
  const status = editor.status('section:' + page + ':' + section);
  return <div className={classes('editor-section', hidden && 'is-hidden', status && 'editable-' + status)}>
    <div className="editor-section-bar">
      <button type="button" className="editor-chip" aria-expanded={open} onClick={() => setOpen(o => !o)}>Section: {label}</button>
      {open && <div className="editor-section-menu" role="group" aria-label={'Section: ' + label}>
        <button type="button" className="secondary" disabled={index <= 0} onClick={() => act({ op: 'move_section', before: order[index - 1] })}>Move up</button>
        <button type="button" className="secondary" disabled={index >= order.length - 1} onClick={() => act({ op: 'move_section', after: order[index + 1] })}>Move down</button>
        <button type="button" className="secondary" onClick={() => act({ op: hidden ? 'show_section' : 'hide_section' })}>{hidden ? 'Show' : 'Hide'}</button>
      </div>}
    </div>
    {hidden ? <div className="editor-hidden-section">
      <span>“{label}” is hidden from visitors.</span>
      <button type="button" className="secondary" onClick={() => act({ op: 'show_section' })}>Show</button>
    </div> : children || <div className="editor-hidden-section"><span>Nothing to show here yet.</span></div>}
  </div>;
}
