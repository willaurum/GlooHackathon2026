// The imported site's look (church_content.Theme): its colors replace the template's green scale and its fonts
// lead the font stacks. Values were validated on the server; they are checked again before they reach CSS.

const HEX = /^#[0-9a-f]{6}$/i;
const FONT = /^[A-Za-z0-9 '-]{1,60}$/;

const channels = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const toHex = rgb => '#' + rgb.map(c => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('');
/** `hex` mixed toward `target` (0 = unchanged, 1 = target). */
export const mix = (hex, target, amount) => toHex(channels(hex).map((c, i) => c + (channels(target)[i] - c) * amount));

/** CSS custom properties for a theme: {} when it has nothing usable. */
export function themeVariables(theme) {
  const vars = {};
  const primary = HEX.test(theme?.primary || '') ? theme.primary.toLowerCase() : '';
  if (primary) Object.assign(vars, {
    '--green-900': mix(primary, '#000000', 0.3), '--green-800': mix(primary, '#000000', 0.15), '--green-700': primary,
    '--green-600': mix(primary, '#ffffff', 0.15), '--green-200': mix(primary, '#ffffff', 0.75),
    '--green-100': mix(primary, '#ffffff', 0.88), '--green-50': mix(primary, '#ffffff', 0.94),
  });
  const background = HEX.test(theme?.background || '') ? theme.background.toLowerCase() : '';
  if (background) Object.assign(vars, {
    // The Home hero is the page background with a touch of the main color, so a new background shows at once.
    '--bg': background, '--hero-from': mix(background, primary || '#2b6248', 0.06),
    '--hero-to': mix(background, primary || '#2b6248', 0.12), '--hero-line': mix(background, primary || '#2b6248', 0.2),
  });
  if (HEX.test(theme?.accent || '')) Object.assign(vars, {
    '--sand-50': mix(theme.accent, '#ffffff', 0.94), '--sand-100': mix(theme.accent, '#ffffff', 0.85),
    '--sand-700': mix(theme.accent, '#000000', 0.35),
    // The Button color (kept readable with white text on the server) fills the site's main buttons.
    '--button': theme.accent.toLowerCase(), '--button-hover': mix(theme.accent, '#000000', 0.15),
  });
  if (HEX.test(theme?.text || '')) {
    // Body text, headings and the softer secondary text (a little toward the page) all follow the text color.
    const text = theme.text.toLowerCase();
    Object.assign(vars, { '--text': text, '--ink': text, '--muted': mix(text, background || '#ffffff', 0.2),
      '--hero-text': mix(text, background || '#ffffff', 0.12) });
  }
  if (FONT.test(theme?.body_font || '')) vars['--font'] = `'${theme.body_font}', system-ui, -apple-system, sans-serif`;
  if (FONT.test(theme?.heading_font || '')) vars['--display'] = `'${theme.heading_font}', Georgia, serif`;
  return vars;
}

/** Font families the theme names, for one Google Fonts stylesheet (the template loads its own fonts there too). */
export function themeFontsUrl(theme) {
  const families = [...new Set([theme?.heading_font, theme?.body_font].filter(f => FONT.test(f || '')))];
  if (!families.length) return '';
  return 'https://fonts.googleapis.com/css2?' + families.map(f => 'family=' + encodeURIComponent(f).replace(/%20/g, '+') + ':wght@400;700').join('&') + '&display=swap';
}

/** Apply a theme to the page; returns a function that puts the template's look back. */
export function applyTheme(theme, root = document.documentElement) {
  const vars = themeVariables(theme);
  const before = Object.fromEntries(Object.keys(vars).map(name => [name, root.style.getPropertyValue(name)]));
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  let link;
  const fonts = themeFontsUrl(theme);
  if (fonts && typeof document !== 'undefined') {
    link = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: fonts });
    document.head.appendChild(link);
  }
  return () => {
    for (const [name, value] of Object.entries(before)) value ? root.style.setProperty(name, value) : root.style.removeProperty(name);
    link?.remove();
  };
}
