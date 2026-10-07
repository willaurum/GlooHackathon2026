import { useState } from 'react';
import { editApi, undoEditApi } from './builderApi.js';

const EXAMPLE = 'Put service times above ministries';

/** "Ask Tekton to change something": a request in plain words that Tekton makes as checked changes (moving or
 *  hiding a section, changing a detail, leaving out a list entry), each one undoable. `onChanged(draft)` gets the
 *  updated draft. Used on the review step and in the site preview's banner. */
export default function TektonEdit({ draftId, undoCount = 0, onChanged, compact = false, lastResult = null }) {
  const [request, setRequest] = useState(''), [busy, setBusy] = useState(''), [error, setError] = useState('');
  const [result, setResult] = useState(lastResult);
  async function act(kind, call) {
    if (busy) return;
    setBusy(kind); setError('');
    try {
      const response = await call();
      const done = { reply: response.reply, changes: response.changes || [] };
      setResult(done);
      if (kind === 'edit') setRequest('');
      onChanged?.(response.draft, done);
    } catch (err) { setError(err.message); setResult(null); }
    finally { setBusy(''); }
  }
  const id = compact ? 'tekton-edit-compact' : 'tekton-edit';
  return <div className={'tekton-edit' + (compact ? ' compact' : '')}>
    <form onSubmit={e => { e.preventDefault(); if (request.trim().length >= 3) act('edit', () => editApi(draftId, request.trim())); }}>
      <label className="builder-sr-only" htmlFor={id}>Ask Tekton to change something</label>
      <div className="tekton-edit-row">
        <input id={id} value={request} maxLength={300} placeholder={compact ? 'Ask Tekton to change something' : 'e.g. ' + EXAMPLE}
          disabled={!!busy} onChange={e => setRequest(e.target.value)} />
        <button className="primary" disabled={!!busy || request.trim().length < 3}>{busy === 'edit' ? 'Changing…' : 'Change it'}</button>
        {undoCount > 0 && <button type="button" className="secondary" disabled={!!busy} onClick={() => act('undo', () => undoEditApi(draftId))}>{busy === 'undo' ? 'Undoing…' : 'Undo'}</button>}
      </div>
    </form>
    <div className="tekton-edit-result" role="status" aria-live="polite">
      {error && <p className="tekton-edit-error">{error}</p>}
      {result && <p>{[...result.changes, result.changes.length ? '' : result.reply].filter(Boolean).join('. ')}{result.changes.length ? '.' : ''}</p>}
    </div>
    {!compact && <p className="form-note">Tekton can move or hide sections of Home and Plan your visit, change a detail like the phone number, or leave out a ministry, event or person. It never writes new content.</p>}
  </div>;
}
