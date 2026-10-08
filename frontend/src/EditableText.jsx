import { useState, useRef, useEffect } from 'react';
import { useVisualEditor } from './VisualEditorContext.jsx';
import Icon from './Icon.jsx';

/**
 * An inline editable text component.
 * In Edit Mode (and not previewing), clicking enables live inline editing with an optional formatting toolbar.
 * In Preview Mode or for visitors, renders clean semantic HTML.
 */
export default function EditableText({
  value = '',
  onChange,
  tag: Tag = 'div',
  className = '',
  placeholder = 'Click to edit text...',
  multiline = false,
  isHeading = false,
  level = 2,
  onLevelChange,
  children,
}) {
  const editor = useVisualEditor();
  const isEditing = editor?.isEditing && !editor?.isPreviewing;
  const [active, setActive] = useState(false);
  const [text, setText] = useState(value || '');
  const [headingLevel, setHeadingLevel] = useState(level);
  const [fontSize, setFontSize] = useState('normal'); // 'smaller', 'normal', 'larger'
  const inputRef = useRef(null);

  useEffect(() => {
    setText(value || '');
  }, [value]);

  useEffect(() => {
    setHeadingLevel(level);
  }, [level]);

  useEffect(() => {
    if (active && inputRef.current) {
      inputRef.current.focus();
    }
  }, [active]);

  if (!isEditing) {
    const ActualTag = isHeading ? `h${headingLevel}` : Tag;
    const sizeClass = fontSize === 'smaller' ? ' size-smaller' : fontSize === 'larger' ? ' size-larger' : '';
    return (
      <ActualTag className={className + sizeClass}>
        {children !== undefined ? children : value}
      </ActualTag>
    );
  }

  function handleSave() {
    setActive(false);
    if (onChange && text !== value) {
      onChange(text);
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !multiline) {
      e.preventDefault();
      handleSave();
    } else if (e.key === 'Escape') {
      setText(value || '');
      setActive(false);
    }
  }

  function changeLevel(newLevel) {
    setHeadingLevel(newLevel);
    if (onLevelChange) {
      onLevelChange(newLevel);
    }
  }

  function cycleSize() {
    const next = fontSize === 'normal' ? 'larger' : fontSize === 'larger' ? 'smaller' : 'normal';
    setFontSize(next);
  }

  const ActualTag = isHeading ? `h${headingLevel}` : Tag;
  const sizeClass = fontSize === 'smaller' ? ' size-smaller' : fontSize === 'larger' ? ' size-larger' : '';

  if (active) {
    return (
      <div className="editable-active-container">
        {isHeading && (
          <div className="editable-mini-toolbar" role="toolbar" aria-label="Heading options">
            <span className="mini-toolbar-label">Level:</span>
            {[1, 2, 3].map(lvl => (
              <button
                key={lvl}
                type="button"
                className={`mini-toolbar-btn ${headingLevel === lvl ? 'active' : ''}`}
                onClick={() => changeLevel(lvl)}
              >
                H{lvl}
              </button>
            ))}
            <span className="mini-toolbar-sep">|</span>
            <button
              type="button"
              className="mini-toolbar-btn"
              title="Change heading font size"
              onClick={cycleSize}
            >
              Size: {fontSize}
            </button>
            <span className="mini-toolbar-sep">|</span>
            <button
              type="button"
              className="mini-toolbar-btn primary"
              onClick={handleSave}
            >
              <Icon name="check" size={14} /> Done
            </button>
          </div>
        )}
        {multiline ? (
          <textarea
            ref={inputRef}
            className={`editable-input editable-textarea ${className}${sizeClass}`}
            value={text}
            placeholder={placeholder}
            rows={3}
            onChange={e => setText(e.target.value)}
            onBlur={handleSave}
            onKeyDown={handleKeyDown}
          />
        ) : (
          <input
            ref={inputRef}
            type="text"
            className={`editable-input ${className}${sizeClass}`}
            value={text}
            placeholder={placeholder}
            onChange={e => setText(e.target.value)}
            onBlur={handleSave}
            onKeyDown={handleKeyDown}
          />
        )}
        {!isHeading && (
          <div className="editable-actions">
            <button type="button" className="btn-done" onClick={handleSave}>
              <Icon name="check" size={14} /> Done
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className={`editable-hover-wrapper ${className}${sizeClass}`}
      onClick={() => setActive(true)}
      title="Click to edit text"
      role="button"
      tabIndex={0}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setActive(true);
        }
      }}
    >
      <ActualTag className="editable-content-display">
        {text || <span className="editable-placeholder">{placeholder}</span>}
      </ActualTag>
      <span className="editable-badge" aria-hidden="true">
        <Icon name="sparkle" size={13} />
        <span className="editable-badge-text">Edit</span>
      </span>
    </div>
  );
}
