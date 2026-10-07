// The church's recreated website (imported by the site builder): menu routes, safe links and players.
// Everything here comes from another website, so addresses are checked again before they are used.

export const PAGE_ROUTE = /^p\/[a-z0-9][a-z0-9-]{0,79}$/;
export const pageRoute = slug => 'p/' + slug;

/** An http(s) address, or '' (never javascript:, data: or a relative path). */
export function safeHref(url) {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '';
  } catch {
    return '';
  }
}

const YOUTUBE_ID = /(?:youtube(?:-nocookie)?\.com\/(?:watch\?v=|embed\/|live\/)|youtu\.be\/)([\w-]{11})/;

// Players and forms that may be embedded on the church's pages, and how. Anything else becomes a link.
const EMBEDS = [
  [/^(www\.)?(youtube\.com|youtube-nocookie\.com|youtu\.be)$/, url => {
    const id = YOUTUBE_ID.exec(url.href)?.[1];
    return id ? `https://www.youtube-nocookie.com/embed/${id}` : '';
  }],
  [/^(player\.)?vimeo\.com$/, url => {
    const id = /\/(?:video\/)?(\d+)/.exec(url.pathname)?.[1];
    return id ? `https://player.vimeo.com/video/${id}` : '';
  }],
  [/^player\.castr\.(com|io)$/, url => url.href],
  [/^(www\.)?boxcast\.tv$/, url => url.href],
  [/^(www\.)?subsplash\.com$/, url => url.href],
  [/^[\w-]+\.churchcenter\.com$/, url => url.href],
  [/^open\.spotify\.com$/, url => url.pathname.startsWith('/embed/') ? url.href : ''],
  [/^www\.google\.com$/, url => url.pathname.startsWith('/maps/embed') ? url.href : ''],
];

/** The iframe address for an embeddable player or form, or '' to show it as a link instead. */
export function embedSrc(url) {
  const href = safeHref(url);
  if (!href) return '';
  const parsed = new URL(href);
  if (parsed.protocol !== 'https:') return '';
  for (const [host, src] of EMBEDS) if (host.test(parsed.hostname)) return src(parsed);
  return '';
}

/** Menu entries for the imported menu: { label, route } for the church's pages, { label, href } for other
 * sites, and { label, children } for a label over a submenu. Pages the church no longer has are left out. */
export function siteMenu(site, pages) {
  const slugs = new Set((pages || []).map(p => p.slug));
  const walk = items => (items || []).flatMap(item => {
    const children = walk(item.children);
    if (item.page && slugs.has(item.page)) return [{ label: item.label, route: pageRoute(item.page), children }];
    const href = safeHref(item.url);
    if (href) return [{ label: item.label, href, children }];
    return children.length ? [{ label: item.label, children }] : [];
  });
  return walk(site?.navigation?.main);
}

/** A section's text as paragraphs (one per line). */
export const paragraphs = text => String(text || '').split('\n').map(line => line.trim()).filter(Boolean);
