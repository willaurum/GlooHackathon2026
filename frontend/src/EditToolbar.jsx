import { useVisualEditor } from './VisualEditorContext.jsx';
import Icon from './Icon.jsx';

export default function EditToolbar({ currentRoute = '' }) {
  const editor = useVisualEditor();
  if (!editor?.isEditing) return null;

  const {
    isPreviewing,
    togglePreview,
    dirty,
    changes,
    saving,
    canUndo,
    undo,
    setAiOpen,
    setThemeOpen,
    setDiffOpen,
    discardChanges,
    publishChanges,
    exitEditor,
  } = editor;

  return (
    <div className={`visual-editor-toolbar ${isPreviewing ? 'in-preview-mode' : 'in-edit-mode'}`} role="region" aria-label="Visual Editor Toolbar">
      <div className="toolbar-left">
        <div className="toolbar-brand">
          <Icon name="sparkle" size={18} />
          <span className="toolbar-title">Visual Editor</span>
        </div>

        {/* Edit vs Preview Mode Toggle */}
        <div className="mode-toggle" role="group" aria-label="Editor view mode">
          <button
            type="button"
            className={`mode-btn ${!isPreviewing ? 'active' : ''}`}
            onClick={() => isPreviewing && togglePreview()}
            title="Interactive inline editing mode"
          >
            Edit Mode
          </button>
          <button
            type="button"
            className={`mode-btn ${isPreviewing ? 'active' : ''}`}
            onClick={() => !isPreviewing && togglePreview()}
            title="Clean preview as visitors will see it"
          >
            Preview Mode
          </button>
        </div>

        {/* Feature Triggers */}
        <button
          type="button"
          className="toolbar-action-btn"
          onClick={() => setAiOpen(true)}
          title="Open AI Edit Assistant"
        >
          <Icon name="chat" size={16} />
          <span>Ask AI</span>
        </button>

        <button
          type="button"
          className="toolbar-action-btn"
          onClick={() => setThemeOpen(true)}
          title="Customize theme colors & fonts"
        >
          <Icon name="compass" size={16} />
          <span>Theme &amp; Styles</span>
        </button>

        {canUndo && (
          <button
            type="button"
            className="toolbar-action-btn"
            onClick={undo}
            title="Undo last change"
          >
            ↶ Undo
          </button>
        )}
      </div>

      <div className="toolbar-right">
        {dirty ? (
          <>
            <button
              type="button"
              className="changes-pill-btn"
              onClick={() => setDiffOpen(true)}
              title="Click to view all pending changes"
            >
              <span className="dirty-dot" />
              <span>{changes.length} change{changes.length === 1 ? '' : 's'} pending</span>
            </button>

            <button
              type="button"
              className="toolbar-btn secondary"
              disabled={saving}
              onClick={() => setDiffOpen(true)}
            >
              Verify Changes
            </button>

            <button
              type="button"
              className="toolbar-btn ghost"
              disabled={saving}
              onClick={discardChanges}
            >
              Discard
            </button>

            <button
              type="button"
              className="toolbar-btn primary"
              disabled={saving}
              onClick={publishChanges}
            >
              {saving ? 'Publishing…' : 'Publish to Site'}
            </button>
          </>
        ) : (
          <span className="no-changes-label">Live site matches preview</span>
        )}

        <button
          type="button"
          className="toolbar-btn exit-btn"
          onClick={exitEditor}
          title="Exit visual editor"
        >
          Exit
        </button>
      </div>
    </div>
  );
}
