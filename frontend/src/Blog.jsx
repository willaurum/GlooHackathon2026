import { useEffect, useState } from 'react';
import Icon from './Icon.jsx';
import { api } from './api.js';

export default function Blog() {
  const [posts, setPosts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [activeCategory, setActiveCategory] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [summarizingId, setSummarizingId] = useState(null);

  // Create post modal state
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('Church Staff');
  const [content, setContent] = useState('');
  const [postCategories, setPostCategories] = useState([]);
  const [customCat, setCustomCat] = useState('');
  const [autoSummarize, setAutoSummarize] = useState(false);
  const [isNlpLoading, setIsNlpLoading] = useState(false);
  const [formError, setFormError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    loadBlogData();
  }, [activeCategory]);

  async function loadBlogData() {
    setLoading(true);
    setError('');
    try {
      const url = activeCategory && activeCategory !== 'all'
        ? `/blog?category=${encodeURIComponent(activeCategory)}`
        : '/blog';
      const [postsData, catsData] = await Promise.all([
        api(url),
        api('/blog/categories'),
      ]);
      setPosts(postsData || []);
      setCategories(catsData || []);
    } catch (err) {
      setError(err.message || 'Failed to load blog posts.');
    } finally {
      setLoading(false);
    }
  }

  async function handleNlpSuggest() {
    if (!content.trim() && !title.trim()) {
      setFormError('Please enter a title or post content before running NLP categorization.');
      return;
    }
    setFormError('');
    setIsNlpLoading(true);
    try {
      const res = await api('/blog/categorize', {
        method: 'POST',
        body: JSON.stringify({ title: title.trim(), content: content.trim() }),
      });
      if (res && Array.isArray(res.categories) && res.categories.length > 0) {
        setPostCategories(prev => {
          const merged = [...prev];
          res.categories.forEach(c => {
            if (!merged.includes(c)) merged.push(c);
          });
          return merged;
        });
      } else {
        setFormError('NLP did not detect specific categories for this text.');
      }
    } catch (err) {
      setFormError(err.message || 'NLP categorization failed. Try again.');
    } finally {
      setIsNlpLoading(false);
    }
  }

  function handleAddCustomCat(e) {
    e.preventDefault();
    const trimmed = customCat.trim();
    if (!trimmed) return;
    if (!postCategories.includes(trimmed)) {
      setPostCategories([...postCategories, trimmed]);
    }
    setCustomCat('');
  }

  function handleRemoveCat(catToRemove) {
    setPostCategories(postCategories.filter(c => c !== catToRemove));
  }

  async function handleCreatePost(e) {
    e.preventDefault();
    if (!title.trim()) {
      setFormError('Post title is required.');
      return;
    }
    if (!content.trim()) {
      setFormError('Post content is required.');
      return;
    }

    setFormError('');
    setIsSubmitting(true);
    try {
      await api('/blog', {
        method: 'POST',
        body: JSON.stringify({
          title: title.trim(),
          author: author.trim() || 'Church Staff',
          content: content.trim(),
          categories: postCategories,
          auto_categorize: postCategories.length === 0, // Auto-generate if empty
          auto_summarize: autoSummarize,
        }),
      });
      // Reset form & reload
      setTitle('');
      setAuthor('Church Staff');
      setContent('');
      setPostCategories([]);
      setAutoSummarize(false);
      setIsModalOpen(false);
      await loadBlogData();
    } catch (err) {
      setFormError(err.message || 'Failed to publish post.');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleSummarizePost(postId) {
    setSummarizingId(postId);
    try {
      const updatedPost = await api(`/blog/${postId}/summarize`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setPosts(prev => prev.map(p => (p.id === postId ? updatedPost : p)));
    } catch (err) {
      alert(err.message || 'Summarization failed. Please check AI connection.');
    } finally {
      setSummarizingId(null);
    }
  }

  async function handleDeletePost(postId) {
    if (!window.confirm('Are you sure you want to delete this blog post?')) return;
    try {
      await api(`/blog/${postId}`, { method: 'DELETE' });
      setPosts(prev => prev.filter(p => p.id !== postId));
      // Refresh categories list
      const catsData = await api('/blog/categories');
      setCategories(catsData || []);
    } catch (err) {
      alert(err.message || 'Failed to delete post.');
    }
  }

  function formatDate(isoStr) {
    if (!isoStr) return '';
    try {
      const d = new Date(isoStr);
      return d.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
    } catch {
      return isoStr;
    }
  }

  return (
    <div className="blog-section">
      {/* Action / Controls Header */}
      <div className="blog-header-bar" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
        <div className="blog-categories" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button
            className={`pill-btn ${activeCategory === 'all' ? 'active' : ''}`}
            onClick={() => setActiveCategory('all')}
            style={{
              padding: '6px 14px',
              borderRadius: 20,
              fontSize: 13,
              fontWeight: 600,
              border: '1px solid var(--line-strong)',
              background: activeCategory === 'all' ? 'var(--green-700)' : 'var(--card)',
              color: activeCategory === 'all' ? '#fff' : 'var(--text)',
              cursor: 'pointer',
            }}
          >
            All Posts
          </button>
          {categories.map(cat => (
            <button
              key={cat}
              className={`pill-btn ${activeCategory === cat ? 'active' : ''}`}
              onClick={() => setActiveCategory(cat)}
              style={{
                padding: '6px 14px',
                borderRadius: 20,
                fontSize: 13,
                fontWeight: 600,
                border: '1px solid var(--line-strong)',
                background: activeCategory === cat ? 'var(--green-700)' : 'var(--card)',
                color: activeCategory === cat ? '#fff' : 'var(--text)',
                cursor: 'pointer',
              }}
            >
              {cat}
            </button>
          ))}
        </div>

        <button
          className="primary"
          onClick={() => setIsModalOpen(true)}
          style={{ gap: 8 }}
        >
          <Icon name="plus" size={18} />
          Write Blog Post
        </button>
      </div>

      {error && (
        <div className="banner error">
          <span>{error}</span>
          <button className="ghost" onClick={loadBlogData}><Icon name="refresh" size={16} /> Retry</button>
        </div>
      )}

      {loading ? (
        <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>
          Loading blog posts...
        </div>
      ) : posts.length === 0 ? (
        <div className="card" style={{ padding: 48, textAlign: 'center' }}>
          <Icon name="document" size={40} className="muted" style={{ margin: '0 auto 16px' }} />
          <h3>No blog posts found</h3>
          <p style={{ marginTop: 8 }}>
            {activeCategory !== 'all'
              ? `There are no posts tagged with "${activeCategory}".`
              : 'Be the first to share an encouragement or church story!'}
          </p>
          <button className="primary" style={{ marginTop: 20 }} onClick={() => setIsModalOpen(true)}>
            <Icon name="plus" size={18} />
            Create First Post
          </button>
        </div>
      ) : (
        <div className="blog-posts-list" style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          {posts.map(post => {
            const isSummarizing = summarizingId === post.id;
            const hasBullets = Array.isArray(post.bullet_summary) && post.bullet_summary.length > 0;

            return (
              <article key={post.id} className="card" style={{ padding: '28px 32px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {post.categories && post.categories.map(c => (
                      <span
                        key={c}
                        className="badge"
                        style={{ cursor: 'pointer' }}
                        onClick={() => setActiveCategory(c)}
                        title={`Filter by ${c}`}
                      >
                        {c}
                      </span>
                    ))}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <small>{formatDate(post.created_at)}</small>
                    <button
                      className="icon-btn"
                      style={{ width: 28, height: 28, color: 'var(--faint)' }}
                      onClick={() => handleDeletePost(post.id)}
                      title="Delete post"
                    >
                      <Icon name="trash" size={15} />
                    </button>
                  </div>
                </div>

                <h2 style={{ fontSize: 24, fontWeight: 700, color: 'var(--ink)', marginBottom: 8, lineHeight: 1.25 }}>
                  {post.title}
                </h2>

                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18, color: 'var(--muted)', fontSize: 14 }}>
                  <span>By <strong>{post.author}</strong></span>
                </div>

                <div className="blog-content" style={{ fontSize: 15, lineHeight: 1.7, color: 'var(--text)', whiteSpace: 'pre-line', marginBottom: 20 }}>
                  {post.content}
                </div>

                {/* AI Bullet Point Summary Section */}
                <div
                  className="ai-bullet-box"
                  style={{
                    marginTop: 20,
                    padding: '20px 24px',
                    borderRadius: 'var(--r)',
                    background: hasBullets ? 'var(--sand-50)' : 'var(--green-50)',
                    border: hasBullets ? '1px solid var(--sand-100)' : '1px solid var(--green-200)',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: hasBullets ? 14 : 0, flexWrap: 'wrap', gap: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <Icon name="sparkle" size={18} className="muted" />
                      <strong style={{ color: 'var(--ink)', fontSize: 14 }}>
                        {hasBullets ? 'Key Takeaways (LLM Summary)' : 'AI Bullet Summary'}
                      </strong>
                      {hasBullets && <span className="badge" style={{ fontSize: 11, background: '#fff' }}>Ollama / LLM</span>}
                    </div>

                    <button
                      className="link"
                      disabled={isSummarizing}
                      onClick={() => handleSummarizePost(post.id)}
                      style={{ fontSize: 13, gap: 6 }}
                    >
                      {isSummarizing ? (
                        <>
                          <Icon name="sparkle" size={14} /> Generating summary...
                        </>
                      ) : hasBullets ? (
                        <>
                          <Icon name="refresh" size={14} /> Regenerate Bullets
                        </>
                      ) : (
                        <>
                          <Icon name="sparkle" size={14} /> Summarize into Bullet Points
                        </>
                      )}
                    </button>
                  </div>

                  {hasBullets && (
                    <ul style={{ margin: 0, paddingLeft: 20, listStyleType: 'disc', color: 'var(--text)', lineHeight: 1.6 }}>
                      {post.bullet_summary.map((bullet, idx) => (
                        <li key={idx} style={{ marginBottom: 8, fontSize: 14.5 }}>
                          {bullet}
                        </li>
                      ))}
                    </ul>
                  )}

                  {!hasBullets && !isSummarizing && (
                    <p style={{ margin: 0, fontSize: 13.5, color: 'var(--muted)' }}>
                      Click the button above to generate a quick bullet-point summary of this article using the local LLM.
                    </p>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* Create Blog Post Modal */}
      {isModalOpen && (
        <div
          className="modal-backdrop"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'grid',
            placeItems: 'center',
            zIndex: 1000,
            padding: 16,
            backdropFilter: 'blur(3px)',
          }}
        >
          <div
            className="card"
            style={{
              width: '100%',
              maxWidth: 680,
              maxHeight: '90vh',
              overflowY: 'auto',
              padding: '32px 36px',
              position: 'relative',
              borderRadius: 'var(--r-xl)',
            }}
          >
            <button
              className="close"
              onClick={() => setIsModalOpen(false)}
              aria-label="Close"
            >
              <Icon name="x" size={20} />
            </button>

            <div className="eyebrow">New Article</div>
            <h2 style={{ marginBottom: 6 }}>Write a Blog Post</h2>
            <p style={{ marginBottom: 20 }}>
              Share ministry updates, pastoral encouragement, or church reflections.
            </p>

            {formError && (
              <div className="banner error" style={{ marginBottom: 16 }}>
                <span>{formError}</span>
              </div>
            )}

            <form onSubmit={handleCreatePost}>
              <label className="field">
                Post Title
                <input
                  type="text"
                  placeholder="e.g. Walking in Grace This Season"
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '10px 14px',
                    borderRadius: 8,
                    border: '1px solid var(--line-strong)',
                    marginTop: 6,
                  }}
                  required
                />
              </label>

              <label className="field">
                Author
                <input
                  type="text"
                  placeholder="e.g. Pastor Marcus Vance"
                  value={author}
                  onChange={e => setAuthor(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '10px 14px',
                    borderRadius: 8,
                    border: '1px solid var(--line-strong)',
                    marginTop: 6,
                  }}
                />
              </label>

              <div className="field">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <span>Categories / Topics</span>
                  <button
                    type="button"
                    className="link"
                    disabled={isNlpLoading || (!title.trim() && !content.trim())}
                    onClick={handleNlpSuggest}
                    style={{ fontSize: 13, gap: 5 }}
                    title="Analyze title and content using NLP to generate smart categories"
                  >
                    <Icon name="sparkle" size={14} />
                    {isNlpLoading ? 'Analyzing with NLP...' : 'Auto-Suggest Categories (NLP)'}
                  </button>
                </div>

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8, minHeight: 32 }}>
                  {postCategories.length === 0 ? (
                    <small style={{ color: 'var(--faint)' }}>
                      No categories added yet. Click &quot;Auto-Suggest Categories (NLP)&quot; or add your own below.
                    </small>
                  ) : (
                    postCategories.map(cat => (
                      <span
                        key={cat}
                        className="badge"
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '4px 10px',
                        }}
                      >
                        {cat}
                        <button
                          type="button"
                          onClick={() => handleRemoveCat(cat)}
                          style={{
                            display: 'grid',
                            placeItems: 'center',
                            cursor: 'pointer',
                            color: 'var(--muted)',
                          }}
                        >
                          <Icon name="x" size={12} />
                        </button>
                      </span>
                    ))
                  )}
                </div>

                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="text"
                    placeholder="Add a custom category..."
                    value={customCat}
                    onChange={e => setCustomCat(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleAddCustomCat(e);
                      }
                    }}
                    style={{
                      flex: 1,
                      padding: '8px 12px',
                      borderRadius: 8,
                      border: '1px solid var(--line-strong)',
                      fontSize: 14,
                    }}
                  />
                  <button
                    type="button"
                    className="secondary"
                    onClick={handleAddCustomCat}
                    style={{ minHeight: 38, padding: '0 14px', fontSize: 13 }}
                  >
                    Add
                  </button>
                </div>
              </div>

              <label className="field">
                Content
                <textarea
                  rows={8}
                  placeholder="Write your article here..."
                  value={content}
                  onChange={e => setContent(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '12px 14px',
                    borderRadius: 8,
                    border: '1px solid var(--line-strong)',
                    marginTop: 6,
                    fontFamily: 'inherit',
                    fontSize: 14.5,
                    lineHeight: 1.6,
                  }}
                  required
                />
              </label>

              <div style={{ margin: '18px 0', display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  id="autoSummaryCheck"
                  checked={autoSummarize}
                  onChange={e => setAutoSummarize(e.target.checked)}
                  style={{ cursor: 'pointer', width: 16, height: 16 }}
                />
                <label htmlFor="autoSummaryCheck" style={{ fontSize: 14, cursor: 'pointer', color: 'var(--text)' }}>
                  Automatically generate AI bullet summary with LLM upon publishing
                </label>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 24 }}>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setIsModalOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="primary"
                  disabled={isSubmitting}
                >
                  {isSubmitting ? 'Publishing...' : 'Publish Article'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
