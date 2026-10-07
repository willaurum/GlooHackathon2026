import { useEffect, useState } from 'react';
import { createBlank, createFromDraft, createFromFiles, draftApi, draftPageApi, itemApi, partApi, pollDraft } from './builderApi.js';
import { BUILDER_LABELS, BUILDER_LISTS, SITE_PARTS, builderEvidence, builderImportProgress, builderItem, builderListCounts, builderPage, builderValue, canReviewBuilder, siteMenuLines, sitePartItem } from './builder.js';
import { paragraphs, safeHref } from './site.js';
import { useChurch } from './ChurchContext.js';
import { hashFor } from './church.js';
import { PageHeader } from './Layout.jsx';

const DRAFT_KEY = 'tekton-new-draft';
const CREATED_KEY = 'tekton-new-church';

function savedDraft() {
  try { return sessionStorage.getItem(DRAFT_KEY) || ''; } catch { return ''; }
}
function rememberDraft(id) {
  try {
    if (id) sessionStorage.setItem(DRAFT_KEY, id);
    else sessionStorage.removeItem(DRAFT_KEY);
  } catch { /* The builder still works when browser storage is unavailable. */ }
}
function savedCreated() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(CREATED_KEY) || 'null');
    return saved?.draftId === savedDraft() && typeof saved?.slug === 'string' ? saved : null;
  } catch { return null; }
}
function rememberCreated(church) {
  try {
    if (church) sessionStorage.setItem(CREATED_KEY, JSON.stringify({ slug: church.slug, draftId: church.draftId }));
    else sessionStorage.removeItem(CREATED_KEY);
  } catch { /* Keep the target in memory if browser storage is unavailable. */ }
}

export default function Builder() {
  const church = useChurch();
  const [session, setSession] = useState(null), [sessionId, setSessionId] = useState(savedDraft);
  const [url, setUrl] = useState(''), [busy, setBusy] = useState('');
  const [importMode, setImportMode] = useState('website'), [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(!!sessionId), [retry, setRetry] = useState(0);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(null), [editing, setEditing] = useState('');
  const [created, setCreated] = useState(savedCreated), [creating, setCreating] = useState(!!savedCreated());

  useEffect(() => {
    if (!sessionId || session?.id === sessionId) return;
    let live = true;
    const controller = new AbortController();
    setLoading(true); setError('');
    draftApi('/' + encodeURIComponent(sessionId), { signal: controller.signal })
      .then(saved => { if (live) { setSession(saved); setUrl(saved.url || ''); } })
      .catch(err => {
        if (!live) return;
        setError(err.message);
        if (err.status === 404 && !created) { rememberDraft(''); setSessionId(''); }
      })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; controller.abort(); };
  }, [sessionId, retry]);

  // A website import runs in the background; follow it until it is ready (also after a reload).
  const importing = session?.status === 'importing';
  useEffect(() => {
    if (!importing) return;
    const controller = new AbortController();
    pollDraft(session.id, setSession, { signal: controller.signal })
      .catch(err => { if (err.name !== 'AbortError') setError(err.status === 404 ? 'This import expired. Please start again.' : err.message); });
    return () => controller.abort();
  }, [session?.id, importing]);

  async function updateItem(body) {
    if (busy || loading) return false;
    setBusy('item'); setError('');
    try {
      setSession(await itemApi(session.id, body)); setPreview(null);
      return true;
    } finally { setBusy(''); }
  }

  async function updatePart(body) {
    if (busy || loading) return false;
    setBusy('part'); setError('');
    try {
      setSession(await partApi(session.id, body)); setPreview(null);
      return true;
    } finally { setBusy(''); }
  }

  async function importDraft(e) {
    e.preventDefault();
    if (busy || loading) return;
    setBusy(importMode === 'questions' ? 'blank' : 'reading'); setError('');
    try {
      if (importMode === 'files' && (files.length > 5 || files.some(file => file.size > 5 * 1024 * 1024)
          || files.reduce((total, file) => total + file.size, 0) > 10 * 1024 * 1024)) {
        throw new Error('Choose 1 to 5 files, each 5 MB or smaller and at most 10 MB in total.');
      }
      const draft = importMode === 'questions' ? await createBlank() : importMode === 'files' ? await createFromFiles(files)
        : await draftApi('', { method: 'POST', body: JSON.stringify({ url: url.trim() }) });
      rememberDraft(draft.id); setSession(draft); setSessionId(draft.id);
    } catch (err) { setError(err.message); }
    finally { setBusy(''); }
  }

  async function answer(field, value) {
    if (busy || loading) return false;
    setBusy('answer:' + field); setError('');
    try {
      const updated = await draftApi('/' + encodeURIComponent(session.id) + '/answers', {
        method: 'POST', body: JSON.stringify({ field, value }),
      });
      // Only the API's successful answer response can mark a field confirmed.
      setSession(updated); setPreview(null); setEditing('');
      return true;
    } finally { setBusy(''); }
  }

  async function showPreview() {
    if (busy || loading || editing || !canReviewBuilder(session)) return;
    setBusy('preview'); setError('');
    try {
      const result = await draftApi('/' + encodeURIComponent(session.id) + '/preview', { method: 'POST' });
      setPreview(result.content);
    } catch (err) { setError(err.message); }
    finally { setBusy(''); }
  }

  function startOver() {
    rememberDraft(''); rememberCreated(null); setSessionId(''); setSession(null); setUrl('');
    setFiles([]); setImportMode('website');
    setPreview(null); setEditing(''); setError(''); setCreating(false);
  }

  function onCreated(target) {
    rememberCreated(target); setCreated(target);
  }
  function onSuccess(slug) {
    rememberDraft(''); rememberCreated(null);
    church.choose(slug);
  }

  const questions = session?.questions || [];
  const review = canReviewBuilder(session);
  const locked = !!busy || loading;
  const step = creating ? 3 : questions.length ? 1 : review ? 2 : 0;
  const failed = session?.status === 'failed';
  return <>
    <PageHeader eyebrow="Tekton" title="Create your church site"
      text="Start with your website, church materials, or answers to a few questions. Confirm the details, then create a new site for your church."
      action={(session || sessionId) && !created && <button type="button" className="secondary" disabled={locked} onClick={startOver}>Start over</button>} />
    <div className="builder">
      <ol className="builder-steps" aria-label="Create your site steps">{['Import', 'Clarify', 'Review', 'Create your church'].map((label, i) => <li key={label} aria-current={step === i ? 'step' : undefined}><span aria-hidden="true">{i + 1}</span>{label}</li>)}</ol>
      <p className="builder-progress" role="status" aria-live="polite">{loading ? 'Resuming your draft…' : importing ? builderImportProgress(session) + ' This can take up to 3 minutes; keep this tab open.' : failed ? 'The import did not finish.' : busy === 'item' ? 'Saving…' : busy === 'reading' ? (importMode === 'files' ? 'Reading your church materials… This can take up to a minute.' : 'Starting to read your website…') : busy === 'blank' ? 'Preparing your questions…' : busy.startsWith('answer:') ? 'Saving your answer…' : busy === 'preview' ? 'Preparing the content preview…' : busy === 'create' ? 'Creating your church site…' : creating ? 'Set up your church and staff account.' : questions.length ? questions.length + ' ' + (questions.length === 1 ? 'question' : 'questions') + ' left' : review ? 'All questions answered. Review your details.' : 'Choose how to start your draft.'}</p>
      {session?.notes?.length > 0 && <ul className="builder-notes">{session.notes.map((note, i) => <li key={i}>{note}</li>)}</ul>}
      {error && <div className="banner error" role="alert"><p>{error}</p></div>}
      {!loading && importing && <section className="card give-pad builder-importing" aria-live="polite">
        <h2>Reading {session.url}</h2>
        <p>We read the most useful pages first: visit, staff, events, ministries, groups, sermons and locations. Every detail we find keeps a quote from the page it came from.</p>
        <div className="give-progress" aria-hidden="true"><span style={{ width: Math.min(95, session.progress?.stage === 'extracting' ? 80 : 10 + 60 * ((session.progress?.pages_read || 0) / Math.max(1, session.progress?.pages_found || 1))) + '%' }} /></div>
      </section>}
      {!loading && failed && <section className="card give-pad" role="alert">
        <h2>We could not finish reading your website</h2>
        <p>{session.error || 'Please try again.'}</p>
        <button type="button" className="primary" onClick={startOver}>Start again</button>
      </section>}
      {!loading && !session && sessionId && !created && <div className="card give-pad"><p>Your saved import could not be loaded.</p><button type="button" className="secondary" onClick={() => setRetry(v => v + 1)}>Try again</button></div>}
      {!loading && !session && !sessionId && <form className="card give-pad" onSubmit={importDraft}>
        <div className="builder-actions" role="group" aria-label="How to start your draft">{[
          ['website', 'Use my website'], ['files', 'Upload church materials'], ['questions', 'Answer questions instead'],
        ].map(([mode, label]) => <button key={mode} type="button" className={importMode === mode ? 'primary' : 'secondary'} aria-pressed={importMode === mode} disabled={locked} onClick={() => { if (importMode !== mode) setFiles([]); setImportMode(mode); setError(''); }}>{label}</button>)}</div>
        {importMode === 'website' && <>
          <label className="field">Current website URL<input type="url" placeholder="https://church.example.org" required maxLength={500} value={url} disabled={locked} onChange={e => setUrl(e.target.value)} /></label>
          <button className="primary" disabled={locked || !url.trim()}>{busy === 'reading' ? 'Reading your website…' : 'Read my website'}</button>
        </>}
        {importMode === 'files' && <>
          <label className="field">Church materials<input type="file" multiple accept=".pdf,.txt,.html,.htm,.docx,.png,.jpg,.jpeg,.webp" required disabled={locked} aria-describedby="builder-file-limits" onChange={e => setFiles(Array.from(e.target.files || []))} /></label>
          <p className="form-note" id="builder-file-limits">Choose 1–5 files: PDF, text, HTML, Word documents or images. Each file must be 5 MB or smaller, with at most 10 MB in total.</p>
          {files.length > 0 && <ul>{files.map((file, i) => <li key={i}>{file.name} ({(file.size / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KB)</li>)}</ul>}
          <button className="primary" disabled={locked || !files.length}>{busy === 'reading' ? 'Reading your materials…' : 'Read my materials'}</button>
        </>}
        {importMode === 'questions' && <>
          <p>Tell us your church name, address, contact details and service times, then review and preview your site.</p>
          <button className="primary" disabled={locked}>{busy === 'blank' ? 'Preparing your questions…' : 'Start answering questions'}</button>
        </>}
        <p className="form-note">Drafts expire 24 hours after import. Keep this browser tab to resume your draft.</p>
      </form>}
      {!loading && !creating && questions.map(question => <Question key={session.id + ':' + question.field} question={question} answer={answer} disabled={locked} />)}
      {!loading && review && !creating && <>
        <section className="card give-pad">
          <div className="eyebrow">Review</div><h2>Review your church details</h2>
          <p>Check the details below. You can edit anything before creating your church.</p>
          {Object.entries(BUILDER_LABELS).map(([field, label]) => <ReviewField key={session.id + ':' + field} field={field} label={label} session={session} editing={editing === field} onEdit={() => { setEditing(field); setPreview(null); }} onCancel={() => setEditing('')} answer={answer} disabled={locked} />)}
        </section>
        {BUILDER_LISTS.filter(list => session.collections?.[list.key]?.length).map(list => <ImportedList key={session.id + ':' + list.key} list={list} entries={session.collections[list.key]} update={updateItem} disabled={locked} />)}
        {session.site?.pages?.length > 0 && <SiteReview key={session.id + ':site'} session={session} update={updatePart} disabled={locked} />}
        {preview && <section className="card give-pad builder-preview" aria-label="Content preview">
          <div className="eyebrow">Content preview</div><h2>{preview.info?.name || 'Your church'}</h2>
          <dl className="builder-summary">{Object.entries(preview.info || {}).filter(([field, value]) => field !== 'map_query' && value != null && value !== '' && (!Array.isArray(value) || value.length)).map(([field, value]) => <div key={field}><dt>{BUILDER_LABELS[field] || field.replaceAll('_', ' ')}</dt><dd>{builderValue(field, value)}</dd></div>)}</dl>
          <p>{preview.faqs?.length || 0} FAQs{builderListCounts(session).map(list => `, ${list.included} of ${list.total} ${list.label.toLowerCase()}`).join('')}</p>
        </section>}
        <section className="card give-pad builder-build">
          <p>Ready? Create your church and a staff account to manage its new site.</p>
          {editing && <p className="form-note">Save or cancel your edit before continuing.</p>}
          <div className="builder-actions"><button type="button" className="primary" disabled={locked || !!editing} onClick={() => { window.location.hash = '#/new/preview'; }}>Preview your site</button><button type="button" className="secondary" disabled={locked || !!editing} onClick={showPreview}>Preview the content</button><button type="button" className="primary" disabled={locked || !!editing} onClick={() => setCreating(true)}>Create your church</button></div>
        </section>
      </>}
      {!loading && creating && (review || created) && <CreateAccount session={session} draftId={sessionId} created={created} onCreated={onCreated} onSuccess={onSuccess} onBack={() => setCreating(false)} answer={answer} disabled={locked} setBusy={setBusy} />}
    </div>
  </>;
}

function addressCity(address = '') {
  // Addresses normally read "street, town, state"; leave unstructured addresses for the person to fill in.
  return address.split(',')[1]?.trim() || '';
}

function CreateAccount({ session, draftId, created, onCreated, onSuccess, onBack, answer, disabled, setBusy }) {
  const [name, setName] = useState(session?.fields.name?.value || '');
  const [city, setCity] = useState(addressCity(session?.fields.address?.value));
  const [ownerName, setOwnerName] = useState(''), [ownerEmail, setOwnerEmail] = useState('');
  const [password, setPassword] = useState(''), [confirm, setConfirm] = useState(''), [error, setError] = useState('');
  const [registrationClosed, setRegistrationClosed] = useState(false);
  async function submit(e) {
    e.preventDefault();
    if (disabled) return;
    setError(''); setRegistrationClosed(false);
    if (!created && (password.length < 10 || password !== confirm)) {
      setError(password.length < 10 ? 'Use a password of at least 10 characters.' : 'The passwords must match.');
      return;
    }
    try {
      if (!created) {
        // Keep the registry name and confirmed content together if the name changes here.
        if (name.trim() !== session.fields.name.value) await answer('name', name.trim());
        setBusy('create');
        // Validate content and expiry before creating a church.
        await draftApi('/' + encodeURIComponent(draftId) + '/preview', { method: 'POST' });
      } else setBusy('create');
      const result = await createFromDraft(draftId, {
        name: name.trim(), city: city.trim(), ownerName: ownerName.trim(), ownerEmail: ownerEmail.trim(), password,
      }, created, target => { onCreated(target); setPassword(''); setConfirm(''); });
      onSuccess(result.church);
    } catch (err) {
      const closed = err.status === 403 && err.registrationClosed;
      setRegistrationClosed(closed);
      setError(closed ? 'Creating new churches is not open on this site yet. You can still preview your site.' : err.message);
    }
    finally { setBusy(''); }
  }
  return <form className="card give-pad builder-create" onSubmit={submit}>
    <div className="eyebrow">Create</div><h2>{created ? 'Finish loading your content' : 'Create your church'}</h2>
    {created ? <>
      <p>Your church was created, but its confirmed content has not finished loading. Try again to load this draft into the same church.</p>
      <p className="form-note">Church address: <a href={'/' + hashFor(created.slug, '')}>{created.slug}</a>. You can also sign in there to finish setup if your draft has expired.</p>
    </> : <>
      <label className="field">Church name<input required minLength={3} maxLength={80} value={name} disabled={disabled} onChange={e => setName(e.target.value)} /></label>
      <label className="field">Town or city<input required maxLength={80} value={city} disabled={disabled} onChange={e => setCity(e.target.value)} /></label>
      <label className="field">Your name<input required minLength={2} maxLength={120} autoComplete="name" value={ownerName} disabled={disabled} onChange={e => setOwnerName(e.target.value)} /></label>
      <label className="field">Your email<input required type="email" maxLength={200} autoComplete="email" value={ownerEmail} disabled={disabled} onChange={e => setOwnerEmail(e.target.value)} /></label>
      <label className="field">Password (10+ characters)<input required type="password" minLength={10} maxLength={200} autoComplete="new-password" value={password} disabled={disabled} onChange={e => setPassword(e.target.value)} /></label>
      <label className="field">Confirm password<input required type="password" minLength={10} maxLength={200} autoComplete="new-password" value={confirm} disabled={disabled} onChange={e => setConfirm(e.target.value)} /></label>
    </>}
    {error && <div className="banner error" role="alert">{error}</div>}
    <div className="builder-actions">
      {registrationClosed && <button type="button" className="primary" onClick={() => { window.location.hash = '#/new/preview'; }}>Preview your site</button>}
      <button className="primary" disabled={disabled}>{disabled ? 'Loading your church…' : created ? 'Try again' : 'Create my church site'}</button>
      {!created && <button type="button" className="secondary" disabled={disabled} onClick={onBack}>Back to review</button>}
    </div>
  </form>;
}
function Evidence({ items }) {
  return <ul className="builder-evidence">{items.map((item, i) => <li key={i}>
    {/^(https?):\/\//i.test(item.url) ? <a href={item.url} target="_blank" rel="noreferrer">{builderPage(item)}</a> : <span>{builderPage(item)}</span>}
    <blockquote>{item.quote}</blockquote>
  </li>)}</ul>;
}

function AnswerInput({ field, label, value, setValue, disabled, question }) {
  const hint = field === 'services' ? 'e.g. Sundays 9:00 AM and 11:00 AM' : '';
  return <label className="field">{label}
    {field === 'about' || field === 'first_visit'
      ? <textarea aria-label={question} rows={3} value={value} disabled={disabled} onChange={e => setValue(e.target.value)} />
      : <input aria-label={question} value={value} inputMode={field === 'phone' ? 'tel' : field === 'email' ? 'email' : undefined} placeholder={hint} disabled={disabled} onChange={e => setValue(e.target.value)} />}
  </label>;
}

function Question({ question, answer, disabled }) {
  const [value, setValue] = useState(''), [error, setError] = useState('');
  async function save(value) {
    setError('');
    try { await answer(question.field, value); } catch (err) { setError(err.message); }
  }
  return <section className="card give-pad builder-question">
    <div className="eyebrow">{BUILDER_LABELS[question.field]}</div><h2>{question.prompt}</h2>
    {question.kind === 'conflict' && <div className="builder-candidates">{question.candidates.map((candidate, i) => <div className="builder-candidate" key={i}>
      <h3>{candidate.display}</h3><Evidence items={candidate.evidence || []} />
      <button type="button" className="secondary" disabled={disabled} aria-label={'Use this: ' + candidate.display} onClick={() => save(candidate.value)}>Use this</button>
    </div>)}</div>}
    <form onSubmit={e => { e.preventDefault(); save(value); }}>
      <AnswerInput field={question.field} label={question.kind === 'conflict' ? 'Something else' : BUILDER_LABELS[question.field]} question={question.prompt} value={value} setValue={setValue} disabled={disabled} />
      {error && <div className="banner error" role="alert">{error}</div>}
      <button className="primary" disabled={disabled || !value.trim()}>Save</button>
    </form>
  </section>;
}

function ReviewField({ field, label, session, editing, onEdit, onCancel, answer, disabled }) {
  const info = session.fields[field];
  const [value, setValue] = useState(''), [error, setError] = useState(''), [showSource, setShowSource] = useState(false);
  const evidence = info?.status === 'prefilled' ? builderEvidence(session, field) : [];
  async function submit(e) {
    e.preventDefault(); setError('');
    try { await answer(field, value); } catch (err) { setError(err.message); }
  }
  return <div className="builder-review-field">
    <div className="builder-field-heading"><h3>{label}</h3>{info && <span className="badge">{info.status === 'confirmed' ? 'You confirmed' : session.url ? 'From your website' : 'From your materials'}</span>}</div>
    <p className="builder-value">{builderValue(field, info?.value) || 'Not provided'}</p>
    <div className="builder-actions">
      <button type="button" className="link" disabled={disabled} aria-expanded={editing} onClick={() => { setValue(builderValue(field, info?.value)); setError(''); onEdit(); }}>Edit<span className="builder-sr-only"> {label}</span></button>
      {info?.status === 'prefilled' && <button type="button" className="link" aria-expanded={showSource} onClick={() => setShowSource(v => !v)}>{showSource ? 'Hide source' : 'Show source'}<span className="builder-sr-only"> for {label}</span></button>}
    </div>
    {showSource && (evidence.length ? <Evidence items={evidence} /> : <p className="form-note">No source quote is available for this field.</p>)}
    {editing && <form onSubmit={submit}>
      <AnswerInput field={field} label={label} value={value} setValue={setValue} disabled={disabled} />
      {error && <div className="banner error" role="alert">{error}</div>}
      <div className="builder-actions"><button className="primary" disabled={disabled || !value.trim()}>Save</button><button type="button" className="secondary" disabled={disabled} onClick={onCancel}>Cancel</button></div>
    </form>}
  </div>;
}

function ImportedList({ list, entries, update, disabled }) {
  const included = entries.filter(entry => entry.include).length;
  const [error, setError] = useState('');
  async function run(body) {
    setError('');
    try { return await update({ collection: list.key, ...body }); } catch (err) { setError(err.message); return false; }
  }
  return <section className="card give-pad builder-list" aria-label={list.label}>
    <div className="builder-field-heading"><h2>{list.label}</h2><span className="badge">{included} of {entries.length} included</span></div>
    {list.note && <p className="form-note">{list.note}</p>}
    <div className="builder-actions">
      <button type="button" className="link" disabled={disabled || included === entries.length} onClick={() => run({ include: true })}>Include all</button>
      <button type="button" className="link" disabled={disabled || !included} onClick={() => run({ include: false })}>Leave all out</button>
    </div>
    {error && <div className="banner error" role="alert">{error}</div>}
    <ul className="builder-items">{entries.map(entry => <ImportedItem key={entry.id} list={list} entry={entry} run={run} disabled={disabled} />)}</ul>
  </section>;
}

function ImportedItem({ list, entry, run, disabled }) {
  const { title, detail } = builderItem(list.key, entry.value);
  const [editing, setEditing] = useState(false), [showSource, setShowSource] = useState(false), [form, setForm] = useState({});
  async function save(e) {
    e.preventDefault();
    if (await run({ id: entry.id, value: form })) setEditing(false);
  }
  return <li className={'builder-item' + (entry.include ? '' : ' excluded')}>
    <label className="builder-item-check">
      <input type="checkbox" checked={!!entry.include} disabled={disabled} onChange={e => run({ id: entry.id, include: e.target.checked })} />
      <span><strong>{title}</strong>{detail && <small>{detail}</small>}</span>
    </label>
    <div className="builder-actions">
      <button type="button" className="link" disabled={disabled} aria-expanded={editing} onClick={() => { setForm(Object.fromEntries(list.fields.map(([key]) => [key, entry.value[key] || '']))); setEditing(v => !v); }}>Edit<span className="builder-sr-only"> {title}</span></button>
      <button type="button" className="link" aria-expanded={showSource} onClick={() => setShowSource(v => !v)}>{showSource ? 'Hide source' : 'Show source'}<span className="builder-sr-only"> for {title}</span></button>
    </div>
    {showSource && <Evidence items={entry.evidence || []} />}
    {editing && <form onSubmit={save}>
      {list.fields.map(([key, label, long]) => <label key={key} className="field">{label}
        {long ? <textarea rows={2} value={form[key] || ''} disabled={disabled} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))} />
          : <input value={form[key] || ''} disabled={disabled} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))} />}
      </label>)}
      <div className="builder-actions"><button className="primary" disabled={disabled}>Save</button><button type="button" className="secondary" disabled={disabled} onClick={() => setEditing(false)}>Cancel</button></div>
    </form>}
  </li>;
}

// The imported website as a whole: its menu and look, then each part the church keeps or leaves out.
function SiteReview({ session, update, disabled }) {
  const { site } = session;
  const menu = siteMenuLines(site.navigation);
  const theme = site.theme || {};
  const colors = [['primary', 'Main color'], ['accent', 'Accent'], ['text', 'Text'], ['background', 'Background']].filter(([key]) => theme[key]);
  return <>
    <section className="card give-pad builder-list" aria-label="Your website">
      <div className="eyebrow">Your website</div><h2>Menu and look</h2>
      {menu.length > 0 ? <ul className="builder-menu">{menu.map((line, i) => <li key={i} style={{ marginLeft: line.depth * 18 }}>{line.label}{line.external && <small> · another site</small>}</li>)}</ul>
        : <p className="form-note">No menu was found; your pages will be listed instead.</p>}
      {colors.length > 0 && <div className="builder-swatches">{colors.map(([key, label]) => <span key={key}><i style={{ background: theme[key] }} />{label} {theme[key]}</span>)}</div>}
      {(theme.heading_font || theme.body_font) && <p className="form-note">Fonts: {[theme.heading_font && `${theme.heading_font} (headings)`, theme.body_font && `${theme.body_font} (text)`].filter(Boolean).join(', ')}</p>}
    </section>
    {SITE_PARTS.filter(part => site[part.key]?.length).map(part => <SitePartList key={part.key} part={part} session={session} entries={site[part.key]} update={update} disabled={disabled} />)}
  </>;
}

function SitePartList({ part, session, entries, update, disabled }) {
  const included = entries.filter(entry => entry.include).length;
  const [error, setError] = useState('');
  async function run(body) {
    setError('');
    try { return await update({ part: part.key, ...body }); } catch (err) { setError(err.message); return false; }
  }
  return <section className="card give-pad builder-list" aria-label={part.label}>
    <div className="builder-field-heading"><h2>{part.label}</h2><span className="badge">{included} of {entries.length} kept</span></div>
    {part.note && <p className="form-note">{part.note}</p>}
    <div className="builder-actions">
      <button type="button" className="link" disabled={disabled || included === entries.length} onClick={() => run({ include: true })}>Keep all</button>
      <button type="button" className="link" disabled={disabled || !included} onClick={() => run({ include: false })}>Leave all out</button>
    </div>
    {error && <div className="banner error" role="alert">{error}</div>}
    <ul className="builder-items">{entries.map(entry => <SitePartItem key={entry.id} part={part.key} draftId={session.id} entry={entry} run={run} disabled={disabled} />)}</ul>
  </section>;
}

function SitePartItem({ part, draftId, entry, run, disabled }) {
  const { title, detail } = sitePartItem(part, entry);
  const [page, setPage] = useState(null), [error, setError] = useState('');
  const href = safeHref(entry.url);
  async function togglePage() {
    if (page) { setPage(null); return; }
    setError('');
    try { setPage(await draftPageApi(draftId, entry.id)); } catch (err) { setError(err.message); }
  }
  return <li className={'builder-item' + (entry.include ? '' : ' excluded')}>
    <label className="builder-item-check">
      <input type="checkbox" checked={!!entry.include} disabled={disabled} onChange={e => run({ id: entry.id, include: e.target.checked })} />
      <span><strong>{title}</strong>{detail && <small>{detail}</small>}</span>
    </label>
    {part === 'assets' && href && <img className="builder-asset" src={href} alt={entry.alt || title} referrerPolicy="no-referrer" loading="lazy" />}
    {part === 'assets' && <label className="builder-item-check"><input type="checkbox" checked={!!entry.rights} disabled={disabled || !entry.include} onChange={e => run({ id: entry.id, rights: e.target.checked })} /><span>We own this image or have permission to use it</span></label>}
    <div className="builder-actions">
      {part === 'pages' && <button type="button" className="link" aria-expanded={!!page} onClick={togglePage}>{page ? 'Hide page' : 'Show page'}<span className="builder-sr-only"> {title}</span></button>}
      {href && part !== 'assets' && <a className="link" href={href} target="_blank" rel="noopener noreferrer">Open<span className="builder-sr-only"> {title}</span></a>}
    </div>
    {error && <div className="banner error" role="alert">{error}</div>}
    {page && <div className="builder-page-preview">{page.sections.map((section, i) => <div key={i}>
      {section.heading && <strong>{section.heading}</strong>}
      {paragraphs(section.text).slice(0, 4).map((line, j) => <p key={j}>{line}</p>)}
      {section.links.length > 0 && <small>Buttons: {section.links.map(l => l.text || l.url).join(', ')}</small>}
    </div>)}</div>}
  </li>;
}
