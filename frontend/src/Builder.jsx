import { useEffect, useState } from 'react';
import { api } from './api.js';
import { BUILDER_LABELS, builderEvidence, builderPage, builderValue, canReviewBuilder } from './builder.js';
import { useChurch } from './ChurchContext.js';
import { StaffSignIn } from './ChurchSetup.jsx';
import { PageHeader } from './Layout.jsx';

const SESSION_KEY = 'belong-builder-session';

function savedSession() {
  try { return sessionStorage.getItem(SESSION_KEY) || ''; } catch { return ''; }
}
function rememberSession(id) {
  try {
    if (id) sessionStorage.setItem(SESSION_KEY, id);
    else sessionStorage.removeItem(SESSION_KEY);
  } catch { /* The builder still works when browser storage is unavailable. */ }
}

export default function Builder({ go }) {
  const church = useChurch();
  if (!church.staff) return <>
    <PageHeader eyebrow="Site builder" title={'Sign in to build ' + church.name + '.'} text="Church staff can import an existing website and confirm its details before building." />
    <StaffSignIn />
  </>;
  return <BuilderFlow go={go} />;
}

function BuilderFlow({ go }) {
  const church = useChurch();
  const [session, setSession] = useState(null), [sessionId, setSessionId] = useState(savedSession);
  const [url, setUrl] = useState(''), [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(!!sessionId), [retry, setRetry] = useState(0);
  const [error, setError] = useState(''), [demoBlocked, setDemoBlocked] = useState(false);
  const [preview, setPreview] = useState(null), [editing, setEditing] = useState('');

  useEffect(() => {
    if (!sessionId || session?.id === sessionId) return;
    let live = true;
    const controller = new AbortController();
    setLoading(true); setError('');
    api('/builder/sessions/' + encodeURIComponent(sessionId), { signal: controller.signal })
      .then(saved => { if (live) { setSession(saved); setUrl(saved.url); } })
      .catch(err => {
        if (!live) return;
        setError(err.message);
        if (err.status === 404) { rememberSession(''); setSessionId(''); }
      })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; controller.abort(); };
  }, [sessionId, retry]);

  async function readWebsite(e) {
    e.preventDefault();
    if (busy || loading) return;
    setBusy('reading'); setError('');
    try {
      const created = await api('/builder/sessions', { method: 'POST', body: JSON.stringify({ url: url.trim() }) });
      rememberSession(created.id); setSession(created); setSessionId(created.id);
    } catch (err) { setError(err.message); }
    finally { setBusy(''); }
  }

  async function answer(field, value) {
    if (busy || loading) return false;
    setBusy('answer:' + field); setError(''); setDemoBlocked(false);
    try {
      const updated = await api('/builder/sessions/' + encodeURIComponent(session.id) + '/answers', {
        method: 'POST', body: JSON.stringify({ field, value }),
      });
      // Only the API's successful answer response can mark a field confirmed.
      setSession(updated); setPreview(null); setEditing('');
      return true;
    } finally { setBusy(''); }
  }

  async function build(apply) {
    if (busy || loading || editing || !canReviewBuilder(session)) return;
    setBusy(apply ? 'build' : 'preview'); setError(''); setDemoBlocked(false);
    try {
      const result = await api('/builder/sessions/' + encodeURIComponent(session.id) + '/build', {
        method: 'POST', body: JSON.stringify({ apply }),
      });
      if (result.applied) { setSession(current => ({ ...current, status: 'built' })); church.refresh(); }
      else setPreview(result.content);
    } catch (err) {
      setError(err.message); setDemoBlocked(apply && err.status === 403 && church.demo);
    } finally { setBusy(''); }
  }

  function startOver() {
    rememberSession(''); setSessionId(''); setSession(null); setUrl('');
    setPreview(null); setEditing(''); setError(''); setDemoBlocked(false);
  }

  const questions = session?.questions || [];
  const review = canReviewBuilder(session);
  const locked = !!busy || loading;
  const step = session?.status === 'built' ? 4 : questions.length ? 2 : review ? 3 : busy === 'reading' ? 1 : 0;
  return <>
    <PageHeader eyebrow="Site builder" title="Build your site from your current website"
      text="We read your public pages and ask you about anything unclear."
      action={(session || sessionId) && <button type="button" className="secondary" disabled={locked} onClick={startOver}>Start over</button>} />
    <div className="builder">
      <ol className="builder-steps" aria-label="Build your site steps">{['Import', 'Extract', 'Clarify', 'Confirm', 'Build preview'].map((label, i) => <li key={label} aria-current={step === i ? 'step' : undefined}><span aria-hidden="true">{i + 1}</span>{label}</li>)}</ol>
      <p className="builder-progress" role="status" aria-live="polite">{loading ? 'Resuming your website import…' : busy === 'reading' ? 'Reading your website… This can take up to a minute.' : busy.startsWith('answer:') ? 'Saving your answer…' : busy === 'preview' ? 'Preparing the content preview…' : busy === 'build' ? 'Building your site…' : questions.length ? `${questions.length} ${questions.length === 1 ? 'question' : 'questions'} left` : session?.status === 'built' ? 'Your site is ready.' : review ? 'All questions answered. Review and confirm your details.' : 'Start with your website address.'}</p>
      {error && <div className="banner error" role="alert"><p>{error}</p>{demoBlocked && <button type="button" className="link" onClick={() => go('start')}>Sign up a church</button>}</div>}
      {!loading && !session && sessionId && <div className="card give-pad"><p>Your saved import could not be loaded.</p><button type="button" className="secondary" onClick={() => setRetry(v => v + 1)}>Try again</button></div>}
      {!loading && !session && !sessionId && <form className="card give-pad" onSubmit={readWebsite}>
        <label className="field">Current website URL<input type="url" placeholder="https://yourchurch.org" required maxLength={500} value={url} disabled={locked} onChange={e => setUrl(e.target.value)} /></label>
        <button className="primary" disabled={locked || !url.trim()}>{busy === 'reading' ? 'Reading your website…' : 'Read my website'}</button>
      </form>}
      {!loading && session && session.status !== 'built' && questions.map(question => <Question key={session.id + ':' + question.field} question={question} answer={answer} disabled={locked} />)}
      {!loading && review && <>
        <section className="card give-pad">
          <div className="eyebrow">Confirm</div><h2>Review your church details</h2>
          <p>Check the details below. You can edit anything before building.</p>
          {Object.entries(BUILDER_LABELS).map(([field, label]) => <ReviewField key={session.id + ':' + field} field={field} label={label} session={session} editing={editing === field} onEdit={() => { setEditing(field); setPreview(null); }} onCancel={() => setEditing('')} answer={answer} disabled={locked} />)}
        </section>
        {preview && <section className="card give-pad builder-preview" aria-label="Content preview">
          <div className="eyebrow">Content preview</div><h2>{preview.info?.name || 'Your church'}</h2>
          <dl className="builder-summary">{Object.entries(preview.info || {}).filter(([field, value]) => field !== 'map_query' && value != null && value !== '' && (!Array.isArray(value) || value.length)).map(([field, value]) => <div key={field}><dt>{BUILDER_LABELS[field] || field.replaceAll('_', ' ')}</dt><dd>{builderValue(field, value)}</dd></div>)}</dl>
          <p>{preview.faqs?.length || 0} FAQs</p>
        </section>}
        <section className="card give-pad builder-build">
          <p>Build my site replaces the information and imported FAQs for {church.name}. Then you can open your church’s site as the preview.</p>
          {editing && <p className="form-note">Save or cancel your edit before previewing or building.</p>}
          <div className="builder-actions"><button type="button" className="secondary" disabled={locked || !!editing} onClick={() => build(false)}>Preview the content</button><button type="button" className="primary" disabled={locked || !!editing} onClick={() => build(true)}>Build my site</button></div>
        </section>
      </>}
      {!loading && session?.status === 'built' && <section className="card give-pad builder-built">
        <div className="eyebrow">Built</div><h2>Your site is ready</h2><p>Your church details have been saved. Open your site to see the preview.</p>
        <div className="builder-actions"><button type="button" className="primary" onClick={() => go('')}>Open my site</button><button type="button" className="secondary" onClick={startOver}>Start over</button></div>
      </section>}
    </div>
  </>;
}

function Evidence({ items }) {
  return <ul className="builder-evidence">{items.map((item, i) => <li key={i}>
    {/^(https?):\/\//i.test(item.url) ? <a href={item.url} target="_blank" rel="noreferrer">{builderPage(item)}</a> : <span>{builderPage(item)}</span>}
    <blockquote>{item.quote}</blockquote>
  </li>)}</ul>;
}

function AnswerInput({ field, label, value, setValue, disabled }) {
  const hint = field === 'services' ? 'e.g. Sundays 9:00 AM and 11:00 AM' : '';
  return <label className="field">{label}
    {field === 'about' || field === 'first_visit'
      ? <textarea rows={3} value={value} disabled={disabled} onChange={e => setValue(e.target.value)} />
      : <input value={value} inputMode={field === 'phone' ? 'tel' : field === 'email' ? 'email' : undefined} placeholder={hint} disabled={disabled} onChange={e => setValue(e.target.value)} />}
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
      <AnswerInput field={question.field} label={question.kind === 'conflict' ? 'Something else' : BUILDER_LABELS[question.field]} value={value} setValue={setValue} disabled={disabled} />
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
    <div className="builder-field-heading"><h3>{label}</h3>{info && <span className="badge">{info.status === 'confirmed' ? 'You confirmed' : 'From your website'}</span>}</div>
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
