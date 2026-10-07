import { useId, useState } from 'react';
import { builderPage } from './builder.js';
import { useChurch } from './ChurchContext.js';
import { evidenceLink, factSources } from './sourceLink.js';

/** On a Tekton site preview with sources shown, a fact Tekton imported shows where it came from: hover it, tab to
 *  it, or tap it. Each source opens the original page scrolled to the quote. Anywhere else it is just its text.
 *  `field` names a detail ('services', 'address'); `list` and `name` name a list entry (a ministry, a person). */
export default function Sourced({ field, list, name, children }) {
  const church = useChurch();
  const id = useId();
  const [open, setOpen] = useState(false);
  const sources = factSources(church?.provenance, { field, list, name });
  if (!church?.showSources || !sources.length) return children;
  return <span className={'sourced' + (open ? ' open' : '')} tabIndex={0} aria-describedby={id}
    onClick={() => setOpen(v => !v)} onKeyDown={e => { if (e.key === 'Escape') setOpen(false); if (e.key === 'Enter') setOpen(v => !v); }}>
    {children}
    <span className="source-tip" id={id}>
      {sources.map((source, i) => {
        const href = evidenceLink(source);
        return <span key={i} className="source-tip-item">
          <span className="source-tip-from">{href ? <>From <a href={href} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}>{builderPage(source)}</a></> : source.title}</span>
          {source.quote && <q>{source.quote}</q>}
        </span>;
      })}
    </span>
  </span>;
}
