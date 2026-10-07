import { useState } from 'react';
import { customizeApi, undoCustomizeApi } from './builderApi.js';

/** The preview's "Ask Tekton" bar: the church asks for a change to what it sees ("Make the main color navy",
 *  "Hide the map", "Add a question about parking") and Tekton makes it as checked, undoable changes to the draft
 *  (backend builder_customize). Tekton may answer with a question instead; the reply shows under the bar.
 *  `viewing` names the page on screen, so "put service times at the top" means this page. */
export default function TektonAgent({ draftId, steps = 0, viewing = '', lastResult = null, onChanged }) {
  const [request, setRequest] = useState(''), [busy, setBusy] = useState(''), [error, setError] = useState('');
  const [result, setResult] = useState(lastResult);
  async function act(kind, call) {
    if (busy) return;
    setBusy(kind); setError('');
    try {
      const response = await call();
      const done = { reply: response.reply, changes: response.changes || [], refused: response.refused || [], asking: !!response.asking };
      setResult(done);
      if (kind === 'ask') setRequest('');
      // The preview reloads with the change, so the reply is handed up to survive that.
      if (done.changes.length || kind === 'undo') onChanged?.(response.draft, done);
    } catch (err) { setError(err.message); setResult(null); }
    finally { setBusy(''); }
  }
  const text = request.trim();
  return <div className="tekton-edit compact tekton-agent">
    <form onSubmit={e => { e.preventDefault(); if (text.length >= 3) act('ask', () => customizeApi(draftId, text, viewing)); }}>
      <label className="builder-sr-only" htmlFor="tekton-agent">Ask Tekton to customize your site</label>
      <div className="tekton-edit-row">
        <input id="tekton-agent" value={request} maxLength={300} disabled={!!busy} onChange={e => setRequest(e.target.value)}
          placeholder={'Ask Tekton to change ' + (viewing ? viewing : 'your site') + ', like “Make the main color navy”'} />
        <button className="primary" disabled={!!busy || text.length < 3}>{busy === 'ask' ? 'Working…' : 'Ask Tekton'}</button>
        {steps > 0 && <button type="button" className="secondary" disabled={!!busy} onClick={() => act('undo', () => undoCustomizeApi(draftId))}>{busy === 'undo' ? 'Undoing…' : 'Undo'}</button>}
      </div>
    </form>
    <div className="tekton-edit-result" role="status" aria-live="polite">
      {error && <p className="tekton-edit-error">{error}</p>}
      {result && <p className={result.asking ? 'tekton-agent-question' : ''}>{result.reply}</p>}
      {result?.refused.length > 0 && <p className="tekton-edit-error">{result.refused.join(' ')}</p>}
    </div>
  </div>;
}
