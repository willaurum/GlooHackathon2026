import { useEffect, useState } from 'react';
import { api } from './api.js';
import { useChurch } from './ChurchContext.js';
import Icon from './Icon.jsx';
import { PageHeader } from './Layout.jsx';
import { embedSrc, paragraphs, safeHref } from './site.js';

// A page of the church's own website, imported by the site builder: headed sections of text, buttons and players.
export default function SitePage({ slug }) {
  const church = useChurch();
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
  if (error) return <div className="page"><p role="alert">{error}</p></div>;
  if (!page) return <div className="page"><p role="status">Loading…</p></div>;
  // The page title is shown once, so a first section headed with the same words starts without its heading.
  const sections = page.sections.map((s, i) => i === 0 && s.heading === page.title ? { ...s, heading: '' } : s);
  return <div className="page site-page">
    <PageHeader eyebrow={church?.name || ''} title={page.title} />
    {sections.map((section, i) => <SiteSection key={i} section={section} />)}
  </div>;
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

// Links to other sites open in a new tab; links back to the old site stay there too.
export function SiteLink({ href, className, children }) {
  const safe = safeHref(href);
  if (!safe) return <span className={className}>{children}</span>;
  return <a className={className} href={safe} target="_blank" rel="noopener noreferrer">{children}<Icon name="link" size={14} /></a>;
}
