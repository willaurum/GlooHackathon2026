import { useState } from 'react';
import { api } from './api.js';
import { useVisualEditor } from './VisualEditorContext.jsx';
import Icon from './Icon.jsx';

const SUGGESTIONS = [
  'We had Pastor Bob leave, change the pastor name to Pastor John',
  'Hey that header doesn\'t look the right size, make it smaller',
  'Change the section at the bottom of the home page to ministries',
  'Make the main color navy and buttons gold',
  'Change the headline to Welcome to Grace Community Church',
  'Hide the calendar page',
];

export default function EditAssistant({ viewing = '', onClose }) {
  const editor = useVisualEditor();
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [lastProposal, setLastProposal] = useState(null);
  const [history, setHistory] = useState([]);

  async function handleAsk(textToSend = prompt) {
    const text = textToSend.trim();
    if (!text || busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await api('/church/edit-assist', {
        method: 'POST',
        body: JSON.stringify({
          request: text,
          viewing,
          content: editor.content,
        }),
      });

      const proposal = {
        request: text,
        reply: res.reply,
        changes: res.changes || [],
        content: res.content,
        refused: res.refused || [],
      };

      setLastProposal(proposal);
      setHistory(prev => [...prev, proposal]);
      setPrompt('');
    } catch (err) {
      setError(err.message || 'The AI assistant was unable to process that request.');
    } finally {
      setBusy(false);
    }
  }

  function applyProposal(proposal) {
    if (proposal?.content) {
      editor.applyAiChanges(proposal.content);
      // Auto close or show applied status
      setLastProposal(null);
    }
  }

  return (
    <div className="edit-assistant-drawer" role="dialog" aria-modal="true" aria-label="AI Website Assistant">
      <div className="assistant-header">
        <div className="assistant-title">
          <Icon name="sparkle" size={20} />
          <span>AI Website Assistant</span>
        </div>
        <button type="button" className="close-btn" onClick={onClose} aria-label="Close assistant">
          <Icon name="x" size={18} />
        </button>
      </div>

      <div className="assistant-body">
        <p className="assistant-intro">
          Tell the assistant what to change on your website in plain English. You will be able to <strong>verify and preview</strong> the changes before publishing.
        </p>

        {/* Suggestion Chips */}
        <div className="assistant-suggestions">
          <span className="suggestions-label">Try asking:</span>
          <div className="suggestion-chips">
            {SUGGESTIONS.map((s, i) => (
              <button
                key={i}
                type="button"
                className="chip-btn"
                onClick={() => {
                  setPrompt(s);
                  handleAsk(s);
                }}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        {/* Proposed Changes Preview Verification Box */}
        {lastProposal && (
          <div className="proposal-card" role="region" aria-label="Proposed changes verification">
            <div className="proposal-badge">
              <Icon name="check" size={16} />
              <span>Proposed Changes (Requires Verification)</span>
            </div>
            <p className="proposal-reply">{lastProposal.reply}</p>
            {lastProposal.changes.length > 0 && (
              <ul className="proposal-changes-list">
                {lastProposal.changes.map((c, i) => (
                  <li key={i}>
                    <Icon name="check" size={14} /> {c}
                  </li>
                ))}
              </ul>
            )}
            {lastProposal.refused?.length > 0 && (
              <p className="proposal-refused">{lastProposal.refused.join(' ')}</p>
            )}
            <div className="proposal-actions">
              <button
                type="button"
                className="primary"
                onClick={() => applyProposal(lastProposal)}
              >
                <Icon name="sparkle" size={16} /> Apply to Live Preview
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => setLastProposal(null)}
              >
                Discard
              </button>
            </div>
            <p className="proposal-safety-note">
              Applying updates your visual preview. You can review the site visually before clicking "Save &amp; Publish".
            </p>
          </div>
        )}

        {/* History log */}
        {history.length > 0 && (
          <div className="assistant-history">
            <h4>Recent AI Requests:</h4>
            {history.slice(-3).map((h, i) => (
              <div key={i} className="history-item">
                <strong>“{h.request}”</strong>
                <p>{h.reply}</p>
              </div>
            ))}
          </div>
        )}

        {error && <div className="banner error">{error}</div>}
      </div>

      <div className="assistant-footer">
        <form
          onSubmit={e => {
            e.preventDefault();
            handleAsk();
          }}
          className="assistant-form"
        >
          <input
            type="text"
            className="assistant-input"
            value={prompt}
            disabled={busy}
            placeholder="e.g. Change the pastor name to Pastor John Davis"
            onChange={e => setPrompt(e.target.value)}
          />
          <button
            type="submit"
            className="primary"
            disabled={busy || !prompt.trim()}
          >
            {busy ? 'Thinking…' : 'Ask AI'}
          </button>
        </form>
      </div>
    </div>
  );
}
