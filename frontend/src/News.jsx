import { useEffect, useState } from 'react';
import { api } from './api.js';
import { useChurch } from './ChurchContext.js';
import Icon from './Icon.jsx';
import samples from './data/newsSamples.json';

// News holds two kinds of post: short updates that point somewhere (a page on this site or
// another website), and longer articles with key takeaways, where a link is optional.
const KINDS = [['all', 'All'], ['update', 'Updates'], ['article', 'Articles']];
// Pages an update can point to; anything else is a full web address.
const PAGES = [['serve', 'Serve'], ['serve/find', 'Find a place to serve'], ['calendar', 'Calendar'], ['guests/plan', 'Plan your visit'],
  ['guests/welcome', 'Welcome team'], ['notes', 'Sermon Notes'], ['give', 'Give'], ['give/trips', 'Mission trips'],
  ['about/connect', 'Connect'], ['prayer', 'Prayer map']];
const isWebLink = url => /^https?:\/\//.test(url);
// An article longer than this opens with its takeaways and a "Read the full article" button.
const LONG = 420;

// A post from before News had kinds is an article.
const normalize = p => ({ ...p, kind: p.kind === 'update' ? 'update' : 'article', categories: p.categories || [], bullet_summary: p.bullet_summary || [] });

// Branch previews share the live church API, which only deploys from main. Until it has News
// (its posts carry no kind), the demo church shows the sample posts it will seed, so a preview
// has updates to look at. Remove this and data/newsSamples.json once the API is deployed.
const SAMPLES = samples.map((s, i) => normalize({
  ...s, id: `sample-${i}`, sample: true, kind: s.kind || 'update', author: s.author || 'Church Staff',
  categories: s.categories || [s.category], created_at: s.date + 'T12:00:00Z',
}));
const withSamples = (posts, demo) => !demo || posts.some(p => 'kind' in p) ? posts.map(normalize)
  : [...posts.map(normalize), ...SAMPLES.filter(s => !posts.some(p => p.title === s.title))].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

const dateLabel = iso => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
};

function PostLink({ post, go }) {
  if (!post.link_url) return null;
  const label = post.link_label || (isWebLink(post.link_url) ? 'Learn more' : PAGES.find(([r]) => r === post.link_url)?.[1] ?? 'Learn more');
  if (isWebLink(post.link_url)) return <a className="link" href={post.link_url} target="_blank" rel="noopener noreferrer">{label}<Icon name="arrow" size={16} /></a>;
  return <button className="link" onClick={() => go(post.link_url)}>{label}<Icon name="arrow" size={16} /></button>;
}

export default function News({ go }) {
  // Writing, deleting and summarizing posts is staff work; the Worker enforces it too.
  const { staff, demo } = useChurch();
  const [posts, setPosts] = useState(null), [error, setError] = useState('');
  const [kind, setKind] = useState('all'), [category, setCategory] = useState('');
  const [events, setEvents] = useState([]);
  const [writing, setWriting] = useState(false);

  function load() {
    setError('');
    api('/blog').then(ps => setPosts(withSamples(ps, demo))).catch(e => { setPosts([]); setError(e.message || 'Could not load the news.'); });
  }
  useEffect(load, []);
  useEffect(() => { api('/church').then(c => setEvents(c.events || [])).catch(() => {}); }, []);

  const ofKind = (posts || []).filter(p => kind === 'all' || p.kind === kind);
  // Tags in use for the kind showing, most used first, for the tag box's suggestions.
  const counts = {};
  ofKind.forEach(p => p.categories.forEach(c => { counts[c] = (counts[c] || 0) + 1; }));
  const tags = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
  // An exact tag (picked from the list or clicked on a post) matches only that tag; while typing,
  // any tag containing the text matches, so the list narrows as you go.
  const q = category.trim().toLowerCase();
  const exact = tags.some(t => t.toLowerCase() === q);
  const shown = ofKind.filter(p => !q || p.categories.some(c => exact ? c.toLowerCase() === q : c.toLowerCase().includes(q)));
  const replace = post => setPosts(ps => ps.map(p => p.id === post.id ? normalize(post) : p));

  async function remove(post) {
    if (!window.confirm(`Delete "${post.title}"?`)) return;
    try {
      await api(`/blog/${post.id}`, { method: 'DELETE' });
      setPosts(ps => ps.filter(p => p.id !== post.id));
    } catch (e) { alert(e.message || 'Could not delete the post.'); }
  }

  return <div className="news-layout">
    <div>
      <div className="news-toolbar">
        <div className="chips" role="group" aria-label="Show">
          {KINDS.map(([k, label]) => <button key={k} className={kind === k ? 'active' : ''} aria-pressed={kind === k} onClick={() => setKind(k)}>{label}</button>)}
        </div>
        <div className="news-tools">
          <div className="search news-tag">
            <Icon name="tag" size={18} />
            <input value={category} list="news-tags" placeholder="Filter by tag" aria-label="Filter by tag" maxLength={40}
              onChange={e => setCategory(e.target.value)} onKeyDown={e => e.key === 'Escape' && setCategory('')} />
            <datalist id="news-tags">{tags.map(t => <option key={t} value={t}>{counts[t] === 1 ? '1 post' : `${counts[t]} posts`}</option>)}</datalist>
            {category && <button className="news-tag-clear" aria-label="Clear the tag filter" onClick={() => setCategory('')}><Icon name="x" size={16} /></button>}
          </div>
          {staff && <button className="primary" onClick={() => setWriting(true)}><Icon name="plus" size={18} />Write a post</button>}
        </div>
      </div>
      {error && <div className="banner error" role="alert"><span>{error}</span><button className="ghost" onClick={load}><Icon name="refresh" size={16} />Retry</button></div>}
      <div className="news-list">
        {posts === null && <div className="card empty"><p>Loading the news…</p></div>}
        {shown.map(p => p.kind === 'update'
          ? <Update key={p.id} post={p} go={go} staff={staff} onCategory={setCategory} onDelete={remove} />
          : <Article key={p.id} post={p} go={go} staff={staff} onCategory={setCategory} onDelete={remove} onChange={replace} />)}
        {posts !== null && !error && shown.length === 0 && <div className="card empty"><p>{posts.length ? 'Nothing here yet. Try another filter.' : 'No news yet. Check back soon.'}</p></div>}
      </div>
    </div>
    <aside className="card news-side">
      <div className="eyebrow">Coming up</div>
      {events.length === 0 ? <p>See the calendar for upcoming events.</p> : <ul>
        {events.slice(0, 4).map(ev => <li key={ev.id}><b>{ev.name}</b><small>{ev.when}</small></li>)}
      </ul>}
      <button className="secondary wide" onClick={() => go('calendar')}><Icon name="calendar" size={18} />Full calendar</button>
      <button className="secondary wide" onClick={() => go('prayer')}><Icon name="compass" size={18} />News from around the world</button>
    </aside>
    {staff && writing && <Composer onClose={() => setWriting(false)} onPublished={() => { setWriting(false); load(); }} />}
  </div>;
}

function Meta({ post, staff, onCategory, onDelete, label }) {
  return <div className="news-meta">
    {label && <span className="news-kind">{label}</span>}
    {post.categories.map(c => <button key={c} className="badge" title={`Show only ${c}`} onClick={() => onCategory(c)}>{c}</button>)}
    <small>{dateLabel(post.created_at)}</small>
    {staff && !post.sample && <button className="icon-btn news-delete" title="Delete post" aria-label={`Delete ${post.title}`} onClick={() => onDelete(post)}><Icon name="trash" size={16} /></button>}
  </div>;
}

function Update({ post, go, ...rest }) {
  return <article className="card news-item">
    <Meta post={post} {...rest} />
    <h3>{post.title}</h3>
    <p>{post.content}</p>
    <PostLink post={post} go={go} />
  </article>;
}

function Article({ post, go, staff, onChange, ...rest }) {
  const [open, setOpen] = useState(false), [summarizing, setSummarizing] = useState(false);
  const long = post.content.length > LONG;
  const takeaways = post.bullet_summary;

  async function summarize() {
    setSummarizing(true);
    try { onChange(await api(`/blog/${post.id}/summarize`, { method: 'POST', body: JSON.stringify({}) })); }
    catch (e) { alert(e.message || 'Could not write key takeaways. Check the AI connection.'); }
    finally { setSummarizing(false); }
  }

  return <article className="card news-item news-article">
    <Meta post={post} staff={staff} label="Article" {...rest} />
    <h2>{post.title}</h2>
    <small className="news-author">By {post.author}</small>
    {(takeaways.length > 0 || staff) && <div className="takeaways">
      <div className="takeaways-head">
        <strong><Icon name="sparkle" size={16} />Key takeaways</strong>
        {staff && !post.sample && <button className="link" disabled={summarizing} onClick={summarize}>
          <Icon name={takeaways.length ? 'refresh' : 'sparkle'} size={14} />
          {summarizing ? 'Writing…' : takeaways.length ? 'Rewrite' : 'Write key takeaways'}
        </button>}
      </div>
      {takeaways.length > 0 ? <ul>{takeaways.map((t, i) => <li key={i}>{t}</li>)}</ul>
        : <p>Visitors see a few key takeaways here once you write them.</p>}
    </div>}
    <div className={'news-body' + (long && !open ? ' clipped' : '')}>{post.content}</div>
    {long && <button className="link" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Show less' : 'Read the full article'}</button>}
    <PostLink post={post} go={go} />
  </article>;
}

function Composer({ onClose, onPublished }) {
  const [kind, setKind] = useState('update');
  const [title, setTitle] = useState(''), [content, setContent] = useState(''), [author, setAuthor] = useState('');
  const [categories, setCategories] = useState([]), [newCategory, setNewCategory] = useState('');
  const [linkPage, setLinkPage] = useState(''), [linkUrl, setLinkUrl] = useState(''), [linkLabel, setLinkLabel] = useState('');
  const [summarize, setSummarize] = useState(true), [suggested, setSuggested] = useState(false);
  const [busy, setBusy] = useState(''), [err, setErr] = useState('');
  const article = kind === 'article';
  const link = linkPage === 'web' ? linkUrl.trim() : linkPage;
  const badWebLink = linkPage === 'web' && !isWebLink(link);

  function addCategory(c) {
    const t = c.trim();
    if (t && !categories.some(x => x.toLowerCase() === t.toLowerCase())) setCategories(cs => [...cs, t]);
  }

  async function suggest() {
    setErr(''); setBusy('suggest');
    try {
      const res = await api('/blog/categorize', { method: 'POST', body: JSON.stringify({ title: title.trim(), content: content.trim() }) });
      (res?.categories || []).forEach(addCategory);
      setSuggested(true);
      return (res?.categories || []).length;
    } catch (e) { setErr(e.message || 'Could not suggest categories.'); }
    finally { setBusy(''); }
  }

  async function submit(e) {
    e.preventDefault();
    if (badWebLink) { setErr('A website link starts with http:// or https://.'); return; }
    // Categories are the poster's call: with none chosen, suggest them first and let the poster review.
    if (!categories.length && !suggested) {
      const found = await suggest();
      if (found) return;
    }
    setErr(''); setBusy('publish');
    try {
      onPublished(await api('/blog', { method: 'POST', body: JSON.stringify({
        kind, title: title.trim(), content: content.trim(), author: author.trim() || 'Church Staff',
        categories, auto_categorize: false, auto_summarize: article && summarize,
        link_url: link, link_label: link ? linkLabel.trim() : '',
      }) }));
    } catch (e2) { setErr(e2.message || 'Could not publish the post.'); setBusy(''); }
  }

  return <div className="news-modal" role="dialog" aria-modal="true" aria-labelledby="news-compose-title" onKeyDown={e => e.key === 'Escape' && onClose()}>
    <form className="card news-modal-card" onSubmit={submit}>
      <button type="button" className="close" aria-label="Close" onClick={onClose}><Icon name="x" size={20} /></button>
      <h2 id="news-compose-title">Write a post</h2>
      <div className="chips news-kinds" role="radiogroup" aria-label="Kind of post">
        <button type="button" role="radio" aria-checked={!article} className={!article ? 'active' : ''} onClick={() => setKind('update')}>
          <b>Update</b><small>A short note that points people somewhere</small>
        </button>
        <button type="button" role="radio" aria-checked={article} className={article ? 'active' : ''} onClick={() => setKind('article')}>
          <b>Article</b><small>A longer read with key takeaways</small>
        </button>
      </div>
      {err && <div className="banner error" role="alert"><span>{err}</span></div>}
      <label className="field">Title<input value={title} maxLength={300} required autoFocus onChange={e => setTitle(e.target.value)}
        placeholder={article ? 'Walking in faith through seasons of change' : 'Serve Day is October 17'} /></label>
      <label className="field">{article ? 'Article' : 'What people need to know'}<textarea rows={article ? 10 : 3} value={content} required onChange={e => setContent(e.target.value)}
        placeholder={article ? 'Write the full article here.' : 'One or two sentences: what, when and who it is for.'} /></label>
      {article && <label className="field">Author<small>optional</small><input value={author} maxLength={100} placeholder="Church Staff" onChange={e => setAuthor(e.target.value)} /></label>}

      <label className="field">Link<small>{article ? 'optional' : 'where people go next'}</small>
        <select value={linkPage} onChange={e => setLinkPage(e.target.value)}>
          <option value="">No link</option>
          {PAGES.map(([r, label]) => <option key={r} value={r}>{label}</option>)}
          <option value="web">Another website…</option>
        </select>
      </label>
      {linkPage === 'web' && <label className="field">Web address<input type="url" value={linkUrl} maxLength={500} placeholder="https://" required onChange={e => setLinkUrl(e.target.value)} /></label>}
      {link && <label className="field">Link text<small>optional</small><input value={linkLabel} maxLength={80} placeholder={linkPage === 'web' ? 'Learn more' : PAGES.find(([r]) => r === linkPage)?.[1]} onChange={e => setLinkLabel(e.target.value)} /></label>}

      <div className="field">
        <div className="news-cat-head">Categories<button type="button" className="link" disabled={busy === 'suggest' || !content.trim()} onClick={suggest}><Icon name="sparkle" size={14} />{busy === 'suggest' ? 'Suggesting…' : 'Suggest'}</button></div>
        <div className="news-cats">
          {categories.length === 0 && <small>None yet. When you publish, Tekton suggests some for you to review first.</small>}
          {suggested && categories.length > 0 && <small className="news-cat-note" role="status">Tekton suggested these. Remove any that don&rsquo;t fit, then publish.</small>}
          {categories.map(c => <span key={c} className="badge">{c}<button type="button" aria-label={`Remove ${c}`} onClick={() => setCategories(cs => cs.filter(x => x !== c))}><Icon name="x" size={12} /></button></span>)}
        </div>
        <div className="news-cat-add">
          <input value={newCategory} maxLength={40} placeholder="Add a category" aria-label="Add a category" onChange={e => setNewCategory(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCategory(newCategory); setNewCategory(''); } }} />
          <button type="button" className="secondary" onClick={() => { addCategory(newCategory); setNewCategory(''); }}>Add</button>
        </div>
      </div>

      {article && <label className="field checkbox"><input type="checkbox" checked={summarize} onChange={e => setSummarize(e.target.checked)} />Write key takeaways when publishing</label>}
      <div className="news-modal-actions">
        <button type="button" className="ghost" onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy === 'publish' || !title.trim() || !content.trim()}>{busy === 'publish' ? 'Publishing…' : article ? 'Publish article' : 'Post update'}</button>
      </div>
    </form>
  </div>;
}
