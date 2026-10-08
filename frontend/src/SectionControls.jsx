import { useVisualEditor } from './VisualEditorContext.jsx';
import Icon from './Icon.jsx';

/**
 * Reorder and visibility controls for Home and page sections in Edit Mode.
 */
export default function SectionControls({
  sectionKey,
  sectionLabel,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  isHidden = false,
  onToggleHide,
  setupLink = null,
  onOpenSetup = null,
}) {
  const editor = useVisualEditor();
  if (!editor?.isEditing || editor?.isPreviewing) {
    return null;
  }

  return (
    <div className={`section-editor-bar ${isHidden ? 'is-hidden-section' : ''}`} aria-label={`Controls for ${sectionLabel}`}>
      <div className="section-editor-title">
        <Icon name="grid" size={14} />
        <span>{sectionLabel}</span>
        {isHidden && <span className="section-hidden-pill">Hidden from visitors</span>}
      </div>
      <div className="section-editor-actions">
        {onMoveUp && (
          <button
            type="button"
            className="section-btn"
            disabled={!canMoveUp}
            onClick={onMoveUp}
            title="Move section up"
          >
            ▲ Up
          </button>
        )}
        {onMoveDown && (
          <button
            type="button"
            className="section-btn"
            disabled={!canMoveDown}
            onClick={onMoveDown}
            title="Move section down"
          >
            ▼ Down
          </button>
        )}
        {onToggleHide && (
          <button
            type="button"
            className={`section-btn ${isHidden ? 'active' : ''}`}
            onClick={onToggleHide}
            title={isHidden ? 'Show section to visitors' : 'Hide section from visitors'}
          >
            {isHidden ? '👁 Show' : '✕ Hide'}
          </button>
        )}
        {setupLink && onOpenSetup && (
          <button
            type="button"
            className="section-btn setup-link-btn"
            onClick={onOpenSetup}
            title="Edit details in Church Setup"
          >
            Setup details →
          </button>
        )}
      </div>
    </div>
  );
}
