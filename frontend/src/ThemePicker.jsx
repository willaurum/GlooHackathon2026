import { useVisualEditor } from './VisualEditorContext.jsx';
import Icon from './Icon.jsx';

const PRESET_PALETTES = [
  { name: 'Navy & Gold', primary: '#1f3a5f', accent: '#c9a227', background: '#faf6ea', text: '#222222' },
  { name: 'Forest Green', primary: '#2f5d34', accent: '#b8860b', background: '#f5f7f4', text: '#1a2419' },
  { name: 'Burgundy & Tan', primary: '#6d1f33', accent: '#d9c7a3', background: '#fdfbf7', text: '#261b1e' },
  { name: 'Modern Slate', primary: '#2d5c9e', accent: '#c2571a', background: '#ffffff', text: '#1e293b' },
  { name: 'Warm Charcoal', primary: '#33363b', accent: '#b8577a', background: '#fafaf9', text: '#1c1917' },
];

const FONTS = [
  { label: 'Classic Serif (Georgia)', value: 'Georgia' },
  { label: 'Modern Sans (Inter / System)', value: 'Inter, system-ui, sans-serif' },
  { label: 'Warm Serif (Merriweather)', value: 'Merriweather, serif' },
  { label: 'Clean Clean (Roboto)', value: 'Roboto, sans-serif' },
];

export default function ThemePicker({ onClose }) {
  const editor = useVisualEditor();
  const theme = editor?.content?.site?.theme || {};

  function setField(field, value) {
    editor.updateTheme({ [field]: value });
  }

  function applyPreset(palette) {
    editor.updateTheme({
      primary: palette.primary,
      accent: palette.accent,
      background: palette.background,
      text: palette.text,
    });
  }

  return (
    <div className="theme-picker-drawer" role="dialog" aria-modal="true" aria-label="Theme & Style Customizer">
      <div className="theme-picker-header">
        <div className="theme-picker-title">
          <Icon name="sparkle" size={20} />
          <span>Theme &amp; Style Customizer</span>
        </div>
        <button type="button" className="close-btn" onClick={onClose} aria-label="Close customizer">
          <Icon name="x" size={18} />
        </button>
      </div>

      <div className="theme-picker-body">
        {/* Preset palettes */}
        <section className="theme-section">
          <h4>Preset Color Palettes</h4>
          <div className="palette-grid">
            {PRESET_PALETTES.map(p => (
              <button
                key={p.name}
                type="button"
                className="palette-card"
                onClick={() => applyPreset(p)}
              >
                <div className="palette-swatches">
                  <span className="swatch" style={{ backgroundColor: p.primary }} />
                  <span className="swatch" style={{ backgroundColor: p.accent }} />
                  <span className="swatch" style={{ backgroundColor: p.background }} />
                </div>
                <span className="palette-name">{p.name}</span>
              </button>
            ))}
          </div>
        </section>

        {/* Custom colors */}
        <section className="theme-section">
          <h4>Custom Colors</h4>
          <div className="color-field">
            <label htmlFor="color-primary">Main Brand / Header Color</label>
            <div className="color-picker-row">
              <input
                id="color-primary"
                type="color"
                value={theme.primary || '#1f3a5f'}
                onChange={e => setField('primary', e.target.value)}
              />
              <input
                type="text"
                className="color-hex-input"
                value={theme.primary || ''}
                placeholder="#1f3a5f"
                onChange={e => setField('primary', e.target.value)}
              />
            </div>
          </div>

          <div className="color-field">
            <label htmlFor="color-accent">Button / Accent Color</label>
            <div className="color-picker-row">
              <input
                id="color-accent"
                type="color"
                value={theme.accent || '#c2571a'}
                onChange={e => setField('accent', e.target.value)}
              />
              <input
                type="text"
                className="color-hex-input"
                value={theme.accent || ''}
                placeholder="#c2571a"
                onChange={e => setField('accent', e.target.value)}
              />
            </div>
          </div>

          <div className="color-field">
            <label htmlFor="color-bg">Page Background (Light)</label>
            <div className="color-picker-row">
              <input
                id="color-bg"
                type="color"
                value={theme.background || '#ffffff'}
                onChange={e => setField('background', e.target.value)}
              />
              <input
                type="text"
                className="color-hex-input"
                value={theme.background || ''}
                placeholder="#ffffff"
                onChange={e => setField('background', e.target.value)}
              />
            </div>
          </div>
        </section>

        {/* Typography */}
        <section className="theme-section">
          <h4>Typography</h4>
          <div className="field">
            <label htmlFor="heading-font">Heading Font</label>
            <select
              id="heading-font"
              value={theme.heading_font || 'Georgia'}
              onChange={e => setField('heading_font', e.target.value)}
            >
              {FONTS.map(f => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="body-font">Body Font</label>
            <select
              id="body-font"
              value={theme.body_font || 'system-ui, sans-serif'}
              onChange={e => setField('body_font', e.target.value)}
            >
              {FONTS.map(f => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>
        </section>
      </div>

      <div className="theme-picker-footer">
        <button type="button" className="primary" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}
