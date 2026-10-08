import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { api } from './api.js';
import { useChurch } from './ChurchContext.js';
import { applyTheme } from './theme.js';

const VisualEditorContext = createContext(null);

export function useVisualEditor() {
  return useContext(VisualEditorContext);
}

export function VisualEditorProvider({ children }) {
  const church = useChurch();
  const [isEditing, setIsEditing] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [content, setContent] = useState(null);
  const [originalContent, setOriginalContent] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);

  // Load content when entering editor
  async function enterEditor() {
    if (!church.staff) return;
    setLoading(true);
    setSaveError('');
    setSaveSuccess(false);
    try {
      const data = await api('/church/content');
      setContent(structuredClone(data));
      setOriginalContent(structuredClone(data));
      setIsEditing(true);
      setIsPreviewing(false);
    } catch (err) {
      setSaveError(err.message || 'Could not load church content for editing.');
    } finally {
      setLoading(false);
    }
  }

  function exitEditor() {
    if (dirty && !window.confirm('You have unsaved changes. Are you sure you want to exit without publishing?')) {
      return;
    }
    setIsEditing(false);
    setIsPreviewing(false);
    setAiOpen(false);
    setThemeOpen(false);
    setDiffOpen(false);
    setContent(null);
    setOriginalContent(null);
    setHistory([]);
  }

  function togglePreview() {
    setIsPreviewing(v => !v);
  }

  // Record history snapshot before mutating
  function recordChange(nextContent) {
    if (content) {
      setHistory(h => [...h.slice(-15), structuredClone(content)]);
    }
    setContent(nextContent);
    setSaveSuccess(false);
  }

  function undo() {
    if (!history.length) return;
    const previous = history[history.length - 1];
    setHistory(h => h.slice(0, -1));
    setContent(previous);
  }

  // Detail / Info updates
  function updateInfo(field, value) {
    if (!content) return;
    const next = structuredClone(content);
    next.info = next.info || {};
    next.info[field] = value;
    recordChange(next);
  }

  // Page section updates
  function updatePageSection(slug, sectionIndex, patch) {
    if (!content) return;
    const next = structuredClone(content);
    next.pages = next.pages || [];
    const page = next.pages.find(p => p.slug === slug);
    if (page && page.sections && page.sections[sectionIndex]) {
      Object.assign(page.sections[sectionIndex], patch);
      recordChange(next);
    }
  }

  // Page section reorder
  function reorderPageSections(slug, newSections) {
    if (!content) return;
    const next = structuredClone(content);
    next.pages = next.pages || [];
    const page = next.pages.find(p => p.slug === slug);
    if (page) {
      page.sections = newSections;
      recordChange(next);
    }
  }

  // Add section to page
  function addPageSection(slug, newSection = { heading: 'New Section', level: 2, text: '', links: [], embeds: [] }) {
    if (!content) return;
    const next = structuredClone(content);
    next.pages = next.pages || [];
    const page = next.pages.find(p => p.slug === slug);
    if (page) {
      page.sections = page.sections || [];
      page.sections.push(newSection);
      recordChange(next);
    }
  }

  // Theme update
  function updateTheme(patch) {
    if (!content) return;
    const next = structuredClone(content);
    next.site = next.site || {};
    next.site.theme = { ...(next.site.theme || {}), ...patch };
    recordChange(next);
    applyTheme(next.site.theme);
  }

  // Home section reorder
  function reorderHomeSections(newOrder) {
    if (!content) return;
    const next = structuredClone(content);
    next.site = next.site || {};
    next.site.layout = next.site.layout || {};
    next.site.layout.home = newOrder;
    recordChange(next);
  }

  // Section visibility (hide/show on page)
  function toggleSectionVisibility(page, section) {
    if (!content) return;
    const next = structuredClone(content);
    next.site = next.site || {};
    next.site.layout = next.site.layout || {};
    const hidden = new Set(next.site.layout.hidden || []);
    const tag = `${page}:${section}`;
    if (hidden.has(tag)) {
      hidden.delete(tag);
    } else {
      hidden.add(tag);
    }
    next.site.layout.hidden = Array.from(hidden);
    recordChange(next);
  }

  // Page visibility (hide/show whole page)
  function togglePageVisibility(route) {
    if (!content) return;
    const next = structuredClone(content);
    next.site = next.site || {};
    next.site.layout = next.site.layout || {};
    const hidden = new Set(next.site.layout.hidden_pages || []);
    if (hidden.has(route)) {
      hidden.delete(route);
    } else {
      hidden.add(route);
    }
    next.site.layout.hidden_pages = Array.from(hidden);
    recordChange(next);
  }

  // Staff updates
  function updateStaffMember(index, patch) {
    if (!content) return;
    const next = structuredClone(content);
    next.staff = next.staff || [];
    if (next.staff[index]) {
      Object.assign(next.staff[index], patch);
      recordChange(next);
    }
  }

  function addStaffMember(person) {
    if (!content) return;
    const next = structuredClone(content);
    next.staff = next.staff || [];
    next.staff.push(person);
    recordChange(next);
  }

  function removeStaffMember(index) {
    if (!content) return;
    const next = structuredClone(content);
    next.staff = (next.staff || []).filter((_, i) => i !== index);
    recordChange(next);
  }

  // Apply proposed AI changes to preview
  function applyAiChanges(newContent) {
    if (!newContent) return;
    recordChange(structuredClone(newContent));
    if (newContent.site?.theme) {
      applyTheme(newContent.site.theme);
    }
  }

  // Discard all changes
  function discardChanges() {
    if (!originalContent) return;
    if (window.confirm('Discard all unsaved changes and revert to the live site?')) {
      setContent(structuredClone(originalContent));
      if (originalContent.site?.theme) {
        applyTheme(originalContent.site.theme);
      }
      setHistory([]);
      setSaveSuccess(false);
      setSaveError('');
    }
  }

  // Publish / Solidify changes
  async function publishChanges() {
    if (!content) return;
    setSaving(true);
    setSaveError('');
    try {
      const saved = await api('/church/content', {
        method: 'PUT',
        body: JSON.stringify(content),
      });
      setContent(structuredClone(saved));
      setOriginalContent(structuredClone(saved));
      setHistory([]);
      setSaveSuccess(true);
      church.refresh();
      // Keep theme active
      if (saved.site?.theme) {
        applyTheme(saved.site.theme);
      }
    } catch (err) {
      setSaveError(err.message || 'Could not save changes. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  // Calculate dirty status & diff
  const changes = useMemo(() => {
    if (!content || !originalContent) return [];
    const list = [];
    if (content.info?.tagline !== originalContent.info?.tagline) {
      list.push({ field: 'Headline / Tagline', from: originalContent.info?.tagline || '', to: content.info?.tagline || '' });
    }
    if (content.info?.about !== originalContent.info?.about) {
      list.push({ field: 'About Text', from: originalContent.info?.about || '', to: content.info?.about || '' });
    }
    if (content.info?.first_visit !== originalContent.info?.first_visit) {
      list.push({ field: 'What to Expect', from: originalContent.info?.first_visit || '', to: content.info?.first_visit || '' });
    }
    // Check staff changes
    const origStaff = originalContent.staff || [];
    const currStaff = content.staff || [];
    if (JSON.stringify(origStaff) !== JSON.stringify(currStaff)) {
      list.push({ field: 'Pastors & Staff', from: `${origStaff.length} member(s)`, to: `${currStaff.length} member(s)` });
    }
    // Check layout changes
    if (JSON.stringify(content.site?.layout) !== JSON.stringify(originalContent.site?.layout)) {
      list.push({ field: 'Page Layout & Order', from: 'Original Layout', to: 'Customized Layout' });
    }
    // Check theme changes
    if (JSON.stringify(content.site?.theme) !== JSON.stringify(originalContent.site?.theme)) {
      list.push({ field: 'Theme Colors & Fonts', from: 'Original Theme', to: 'Customized Theme' });
    }
    // Check pages changes
    const origPages = originalContent.pages || [];
    const currPages = content.pages || [];
    if (JSON.stringify(origPages) !== JSON.stringify(currPages)) {
      list.push({ field: 'Page Content', from: 'Original Pages', to: 'Edited Pages' });
    }
    return list;
  }, [content, originalContent]);

  const dirty = changes.length > 0;

  const value = {
    isEditing,
    isPreviewing,
    content,
    originalContent,
    dirty,
    changes,
    loading,
    saving,
    saveError,
    saveSuccess,
    aiOpen,
    themeOpen,
    diffOpen,
    setAiOpen,
    setThemeOpen,
    setDiffOpen,
    enterEditor,
    exitEditor,
    togglePreview,
    updateInfo,
    updatePageSection,
    reorderPageSections,
    addPageSection,
    updateTheme,
    reorderHomeSections,
    toggleSectionVisibility,
    togglePageVisibility,
    updateStaffMember,
    addStaffMember,
    removeStaffMember,
    applyAiChanges,
    discardChanges,
    publishChanges,
    undo,
    canUndo: history.length > 0,
  };

  return <VisualEditorContext.Provider value={value}>{children}</VisualEditorContext.Provider>;
}
