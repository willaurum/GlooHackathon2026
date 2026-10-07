import { useEffect, useState } from 'react';
import { api } from './api.js';
import { useChurch } from './ChurchContext.js';
import Icon from './Icon.jsx';
import { PageHeader } from './Layout.jsx';
import { hashFor } from './church.js';
import { embedSrc, importedRoute, paragraphs, safeHref } from './site.js';

// One imported page, loaded by its slug: { page, error }.
function usePage(slug) {
  const [page, setPage] = useState(null), [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    setPage(null);
    setError('');
    api('/church/pages/' + encodeURIComponent(slug))
      .then(data => { if (live) setPage(data); })
      .catch(err => { if (live) setError(err.status === 404 ? 'This page could not be found.' : err.message); });
    return () => { live = false; };
  }, [slug]);
  return { page, error };
}

// The page title is shown once, so a first section headed with the same words starts without its heading.
function SiteSections({ page }) {
  const sections = page.sections.map((s, i) => i === 0 && s.heading === page.title ? { ...s, heading: '' } : s);
  return sections.map((section, i) => <SiteSection key={i} section={section} />);
}

// A page of the church's own website, imported by Tekton: headed sections of text, buttons and players.
export default function SitePage({ slug }) {
  const church = useChurch();
  const { page, error } = usePage(slug);
  if (error) return <div className="page"><p role="alert">{error}</p></div>;
  if (!page) return <div className="page"><p role="status">Loading…</p></div>;
  return <div className="page site-page">
    <PageHeader eyebrow={church?.name || ''} title={page.title} />
    <SiteSections page={page} />
  </div>;
}

/** An imported page's sections under another page's header (Our story, Beliefs). */
export function SitePageBody({ slug }) {
  const { page, error } = usePage(slug);
  if (error) return <p role="alert">{error}</p>;
  if (!page) return <p role="status">Loading…</p>;
  return <div className="site-page"><SiteSections page={page} /></div>;
}

function SiteSection({ section }) {
  const Heading = section.level >= 3 ? 'h3' : 'h2';
  const links = section.links.filter(l => safeHref(l.url));
  if (!section.heading && !section.text && !links.length && !section.embeds.length) return null;
  return <section className="site-section">
    {section.heading && <Heading>{section.heading}</Heading>}
    {paragraphs(section.text).map((line, i) => <p key={i}>{line}</p>)}
    {section.embeds.map(url => <Embed key={url} url={url} />)}
    {links.length > 0 && <div className="site-actions">
      {links.map(link => <SiteLink key={link.url} className="secondary" href={link.url}>{link.text || 'Open'}</SiteLink>)}
    </div>}
  </section>;
}

function Embed({ url }) {
  const src = embedSrc(url);
  if (!src) return safeHref(url) ? <p><SiteLink className="link" href={url}>Open the player</SiteLink></p> : null;
  return <div className="site-embed">
    <iframe src={src} title="Embedded player" loading="lazy" referrerPolicy="strict-origin-when-cross-origin"
      sandbox="allow-scripts allow-same-origin allow-presentation allow-popups allow-forms" allowFullScreen />
  </div>;
}

// Imported pages stay on this site; other addresses open in a new tab.
export function SiteLink({ href, className, children }) {
  const church = useChurch();
  const route = importedRoute(href, church?.pages);
  if (route) return <a className={className} href={church.source === 'preview' ? '#/new/preview/' + route : hashFor(church.slug, route, church.source)}
    onClick={e => { if (!e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && e.button === 0) { e.preventDefault(); church.go(route); } }}>{children}<Icon name="arrow" size={14} /></a>;
  const safe = safeHref(href);
  if (!safe) return <span className={className}>{children}</span>;
  return <a className={className} href={safe} target="_blank" rel="noopener noreferrer">{children}<Icon name="link" size={14} /></a>;
}
