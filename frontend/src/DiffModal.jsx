import { useVisualEditor } from './VisualEditorContext.jsx';
import Icon from './Icon.jsx';

export default function DiffModal({ onClose }) {
  const editor = useVisualEditor();
  const { changes, saving, saveError, saveSuccess, publishChanges, discardChanges } = editor;

  return (
    <div className="diff-modal-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="card diff-modal" role="dialog" aria-modal="true" aria-labelledby="diff-title">
        <div className="diff-modal-header">
          <div className="diff-modal-title">
            <Icon name="check" size={22} />
            <h2 id="diff-title">Verify Changes Before Publishing</h2>
          </div>
          <button type="button" className="close-btn" onClick={onClose} aria-label="Close modal">
            <Icon name="x" size={20} />
          </button>
        </div>

        <div className="diff-modal-body">
          <p className="diff-modal-desc">
            Review all pending changes below. Changes are currently in <strong>Preview Mode</strong> and are not visible to visitors until you click <strong>Publish to Site</strong>.
          </p>

          {changes.length === 0 ? (
            <div className="diff-empty">
              <p>No changes detected from the live site.</p>
            </div>
          ) : (
            <div className="diff-list">
              {changes.map((c, i) => (
                <div key={i} className="diff-item">
                  <div className="diff-item-header">
                    <strong>{c.field}</strong>
                  </div>
                  <div className="diff-comparison">
                    <div className="diff-box diff-original">
                      <span className="diff-badge">Live version</span>
                      <pre>{c.from || '(empty)'}</pre>
                    </div>
                    <div className="diff-box diff-modified">
                      <span className="diff-badge modified">Preview version</span>
                      <pre>{c.to || '(empty)'}</pre>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {saveError && <div className="banner error">{saveError}</div>}
          {saveSuccess && (
            <div className="banner demo">
              <Icon name="check" size={18} />
              <span>Changes have been successfully published and are now live!</span>
            </div>
          )}
        </div>

        <div className="diff-modal-footer">
          <button
            type="button"
            className="secondary"
            disabled={saving}
            onClick={() => {
              discardChanges();
              onClose();
            }}
          >
            Discard All
          </button>
          <button
            type="button"
            className="ghost"
            disabled={saving}
            onClick={onClose}
          >
            Keep Previewing
          </button>
          <button
            type="button"
            className="primary"
            disabled={saving || changes.length === 0}
            onClick={async () => {
              await publishChanges();
              if (!saveError) {
                setTimeout(onClose, 800);
              }
            }}
          >
            {saving ? 'Publishing…' : 'Publish to Site'}
          </button>
        </div>
      </div>
    </div>
  );
}
