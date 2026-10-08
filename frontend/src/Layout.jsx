import { useEffect, useState } from 'react';
import { useChurch } from './ChurchContext.js';
import ChurchName from './ChurchName.jsx';
import Icon from './Icon.jsx';
import { pageHidden, pageOfType } from './churchSite.js';
import { siteMenu } from './site.js';
import { useVisualEditor } from './VisualEditorContext.jsx';

// One navigation for every screen size: a top navigation bar on desktop; on phones, a tab bar holds the
// sections marked `tab` and everything else sits in the Menu (burger) sheet.
// `staffOnly` sections appear only while church staff are signed in.
export const SECTIONS = [
  { route: '', label: 'Home', icon: 'home', tab: true },
  { route: 'guests', label: 'Guests', short: 'Guests', icon: 'pin', tab: true, children: [['guests/plan', 'Plan your visit'], ['guests/welcome', 'Welcome team']] },
  { route: 'serve', label: 'Serve', icon: 'users', tab: true, children: [['serve', 'Ministries'], ['serve/find', 'Find a place']] },
  { route: 'notes', label: 'Sermon Notes', short: 'Notes', icon: 'book', tab: true },
  { route: 'calendar', label: 'Calendar', short: 'Calendar', icon: 'calendar' },
  { route: 'give', label: 'Give', icon: 'heart', children: [['give', 'Give'], ['give/trips', 'Mission trips']] },
  { route: 'prayer', label: 'Prayer map', short: 'Prayer', icon: 'compass' },
  { route: 'about', label: 'About', icon: 'info', children: [['about', 'Our story'], ['about/beliefs', 'Beliefs'], ['about/news', 'News'], ['about/directory', 'Directory'], ['about/connect', 'Connect']] },
  { route: 'staff', label: 'Church staff', short: 'Staff', icon: 'lock', staffOnly: true },
];
// The sections this visitor can see: staff-only ones are hidden until staff sign in.
export const visibleSections = (staff, site) => SECTIONS.filter(s => (staff || !s.staffOnly) && !pageHidden(site, s.route));
const childrenFor = (s, demo, pages, site) => (s.children || []).filter(([r]) => showAbout(r, demo, pages) && !pageHidden(site, r));

// Beliefs holds Grace Community's own statement, so other churches see it only when Tekton imported a
// statement of belief from their website. Our story, News, Directory and Connect use each church's own content.
export const ABOUT_DEMO_ONLY = new Set(['about/beliefs']);
const showAbout = (route, demo, pages) => demo || !ABOUT_DEMO_ONLY.has(route) || !!pageOfType(pages, 'beliefs');
export const ABOUT_TABS = [['about', 'Our story', 'info'], ['about/beliefs', 'Beliefs', 'book'], ['about/news', 'News', 'news'], ['about/directory', 'Directory', 'phone'], ['about/connect', 'Connect', 'mail']];
export const aboutTabsFor = (demo, pages, site) => ABOUT_TABS.filter(([r]) => showAbout(r, demo, pages) && !pageHidden(site, r));

const sectionOf = route => route.split('/')[0];

// Public visitors have no user account; staff sign in for the current church.
function identity(staff) {
  return staff ? { initials: 'ST', name: 'Church staff', role: 'Admin mode' }
    : { initials: 'V', name: 'Visitor', role: 'Browsing without sign-in' };
}

export function Avatar() {
  const user = identity(useChurch().staff);
  return <span className="avatar" role="img" aria-label={user.name}>{user.initials}</span>;
}

export function Brand() {
  return <a className="tekton-brand" href="/#/new"><Icon name="sparkle" size={26} />Tekton</a>;
}

// The church's imported website menu as one list for a dropdown: pages open here, outside links in a new tab.
const flatMenu = items => items.flatMap(item => [item, ...flatMenu(item.children)]).filter(item => item.route || item.href);

// Desktop top bar, pinned while scrolling: the church in place of a site logo, the main navigation,
// and staff sign-in. A section with sub-pages opens them in a dropdown on hover or keyboard focus;
// the section itself still opens its first page.
export function SiteNav({ route, go }) {
  const church = useChurch();
  const editor = useVisualEditor();
  const { demo, staff, pages } = church;
  const current = sectionOf(route);
  const website = flatMenu(siteMenu(church.site, pages));
  // Leave the dropdown once a page is picked (focus would otherwise keep it open).
  const pick = (e, next) => { e.currentTarget.blur(); go(next); };
  return <header className="site-nav">
    <ChurchName staffLink={false} />
    <nav className="site-nav-links" aria-label="Main">
      {visibleSections(staff, church.site).map(s => {
        const kids = childrenFor(s, demo, pages, church.site);
        return <div key={s.route} className={'site-nav-item' + (kids.length > 1 ? ' has-menu' : '')}>
          <button className={'site-nav-link' + (current === s.route ? ' active' : '')} aria-current={route === s.route ? 'page' : undefined}
            aria-haspopup={kids.length > 1 ? 'true' : undefined} onClick={e => pick(e, s.route)}>
            {/* Narrower screens use the short label (Notes, Prayer) so the bar stays one row. */}
            <span className="label-full">{s.label}</span><span className="label-short">{s.short ?? s.label}</span>
            {kids.length > 1 && <svg className="caret" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>}
          </button>
          {kids.length > 1 && <div className="site-nav-menu">
            {kids.map(([r, label]) => <button key={r} className={route === r ? 'active' : ''} aria-current={route === r ? 'page' : undefined} onClick={e => pick(e, r)}>
              {label}
            </button>)}
          </div>}
        </div>;
      })}
      {/* The menu of the website Tekton imported, when the church has one. */}
      {website.length > 0 && <div className="site-nav-item has-menu">
        <button className={'site-nav-link' + (website.some(item => item.route === route) ? ' active' : '')} aria-haspopup="true"
          onClick={e => website[0].route ? pick(e, website[0].route) : e.currentTarget.focus()}>
          <span className="label-full">Our website</span><span className="label-short">Website</span>
          <svg className="caret" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <div className="site-nav-menu">
          {website.map(item => item.route
            ? <button key={'r' + item.route} className={route === item.route ? 'active' : ''} aria-current={route === item.route ? 'page' : undefined} onClick={e => pick(e, item.route)}>{item.label}</button>
            : <a key={'h' + item.href} href={item.href} target="_blank" rel="noopener noreferrer">{item.label}</a>)}
        </div>
      </div>}
    </nav>
    <div className="site-account">
      {/* Who is browsing, with the staff sign-in (or Church setup, once signed in) just below. */}
      <div className="site-user">
        <strong>{identity(staff).name}</strong>
        {!church.missing && <div className="site-staff-actions">
          <button className="link site-staff" onClick={e => pick(e, 'setup')}>
            <Icon name="lock" size={13} />{staff ? 'Church setup' : 'Staff sign in'}
          </button>
          {staff && !church.preview && (
            <button
              className={`link site-visual-edit ${editor?.isEditing ? 'active' : ''}`}
              onClick={() => {
                if (editor?.isEditing) editor.exitEditor();
                else editor?.enterEditor();
              }}
            >
              <Icon name="sparkle" size={13} />{editor?.isEditing ? 'Exit Editor' : 'Visual Editor'}
            </button>
          )}
        </div>}
      </div>
      <Avatar />
    </div>
  </header>;
}

export function TopBar({ onAsk }) {
  const church = useChurch();
  const editor = useVisualEditor();
  return <header className="topbar">
    <ChurchName compact />
    {church.staff && !church.preview && (
      <button
        className="icon-btn"
        aria-label="Visual Editor"
        title={editor?.isEditing ? 'Exit Visual Editor' : 'Open Visual Editor'}
        onClick={() => {
          if (editor?.isEditing) editor.exitEditor();
          else editor?.enterEditor();
        }}
      >
        <Icon name="sparkle" />
      </button>
    )}
    <button className="icon-btn" aria-label="Ask Tekton" onClick={onAsk}><Icon name="chat" /></button>
    <Avatar />
  </header>;
}

// Welcome popup for first-time visitors. It fades in shortly after the site opens, at most once
// per visit (a refresh is the same visit), and never again once "Don't show this again" is
// checked. Not shown on the Guests pages, where a first-time visitor already is.
const HIDE_KEY = 'belong.firstVisitHidden', SEEN_KEY = 'belong.firstVisitSeen';
const stored = (store, key) => { try { return store.getItem(key) === '1'; } catch { return false; } };
const store1 = (store, key) => { try { store.setItem(key, '1'); } catch { /* private mode: just close */ } };

export function FirstVisit({ route, go }) {
  const { name } = useChurch();
  const [state, setState] = useState('hidden'); // hidden → open → closing → hidden
  const [dontShow, setDontShow] = useState(false);
  const onGuests = sectionOf(route) === 'guests';

  useEffect(() => {
    if (onGuests || stored(localStorage, HIDE_KEY) || stored(sessionStorage, SEEN_KEY)) return;
    const t = setTimeout(() => { store1(sessionStorage, SEEN_KEY); setState('open'); }, 700);
    return () => clearTimeout(t);
  }, [onGuests]);

  function close(next) {
    if (dontShow) store1(localStorage, HIDE_KEY);
    setState('closing');
    setTimeout(() => setState('hidden'), 250);
    if (next) go(next);
  }
  useEffect(() => {
    if (state !== 'open') return;
    const onKey = e => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (state === 'hidden') return null;
  return <div className={'welcome' + (state === 'closing' ? ' closing' : '')} onClick={e => e.target === e.currentTarget && close()}>
    <div className="card welcome-card" role="dialog" aria-modal="true" aria-labelledby="welcome-title" aria-describedby="welcome-text">
      <button className="close" aria-label="Close" onClick={() => close()}><Icon name="x" size={20} /></button>
      <h2 id="welcome-title">First time here?</h2>
      <p id="welcome-text">Welcome{name ? ` to ${name}` : ''}! We'd love to help your first Sunday feel easy. See service times, what to expect, where to park and how kids check-in works, and let us know you're coming so someone can say hello.</p>
      <div className="welcome-actions">
        <button className="primary" autoFocus onClick={() => close('guests/plan')}>Plan your visit<Icon name="arrow" size={18} /></button>
        <button className="ghost" onClick={() => close()}>Not now</button>
      </div>
      <label className="field checkbox welcome-hide"><input type="checkbox" checked={dontShow} onChange={e => setDontShow(e.target.checked)} />Don't show this again</label>
    </div>
  </div>;
}

export function TabBar({ route, go, chatOpen }) {
  const { demo, staff, pages, site } = useChurch();
  const [menuOpen, setMenuOpen] = useState(false);
  const tabs = SECTIONS.filter(s => s.tab && !pageHidden(site, s.route));
  const more = visibleSections(staff, site).filter(s => !s.tab);
  const current = sectionOf(route);
  const inMenu = more.some(s => s.route === current);
  function open(next) { setMenuOpen(false); go(next); }
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = e => { if (e.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);
  // Close the menu if the chat opens over it.
  useEffect(() => { if (chatOpen) setMenuOpen(false); }, [chatOpen]);

  return <>
    {menuOpen && <div className="menu-backdrop" onClick={() => setMenuOpen(false)} />}
    {menuOpen && <div className="menu-sheet" id="more-menu" role="dialog" aria-label="More pages">
      {more.map(s => {
        const kids = childrenFor(s, demo, pages, site);
        return <div key={s.route} className="menu-group">
          <button className={'nav-item' + (current === s.route ? ' active' : '')} onClick={() => open(s.route)}><Icon name={s.icon} />{s.label}</button>
          {kids.length > 1 && <div className="nav-children">
            {kids.map(([r, label]) => <button key={r} className={route === r ? 'active' : ''} aria-current={route === r ? 'page' : undefined} onClick={() => open(r)}>{label}</button>)}
          </div>}
        </div>;
      })}
      <SiteMenu route={route} go={go} onNavigate={() => setMenuOpen(false)} />
    </div>}
    <nav className="tabbar" aria-label="Main">
      {tabs.map(s => <button key={s.route} className={!chatOpen && !menuOpen && current === s.route ? 'active' : ''} onClick={() => open(s.route)}>
        <span className="tab-icon"><Icon name={s.icon} size={22} /></span>{s.short ?? s.label}
      </button>)}
      <button className={menuOpen || (!chatOpen && inMenu) ? 'active' : ''} aria-expanded={menuOpen} aria-controls="more-menu" onClick={() => setMenuOpen(o => !o)}>
        <span className="tab-icon"><Icon name={menuOpen ? 'x' : 'menu'} size={22} /></span>Menu
      </button>
    </nav>
  </>;
}

export function PageHeader({ eyebrow, title, text, action }) {
  return <div className="page-header">
    <div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1>{text && <p>{text}</p>}</div>
    {action}
  </div>;
}

export function SubNav({ tabs, route, go, counts = {} }) {
  const site = useChurch()?.site;
  return <div className="subnav" role="tablist">
    {tabs.filter(([r]) => !pageHidden(site, r)).map(([r, label, icon]) => <button key={r} role="tab" aria-selected={route === r} className={route === r ? 'active' : ''} onClick={() => go(r)}>
      <Icon name={icon} size={18} />{label}{counts[r] > 0 && <b className="count">{counts[r]}</b>}
    </button>)}
  </div>;
}

// The imported menu, under the app's own sections: the church's pages and its links elsewhere.
export function SiteMenu({ route, go, onNavigate }) {
  const church = useChurch();
  const items = siteMenu(church?.site, church?.pages);
  if (!items.length) return null;
  const open = next => { onNavigate?.(); go(next); };
  const entry = (item, depth) => <div key={item.label + (item.route || item.href || '')} className={depth ? 'site-menu-child' : ''}>
    {item.route ? <button className={'nav-item' + (route === item.route ? ' active' : '')} aria-current={route === item.route ? 'page' : undefined}
      onClick={() => open(item.route)}>{item.label}</button>
      : item.href ? <a className="nav-item" href={item.href} target="_blank" rel="noopener noreferrer">{item.label}</a>
        : <span className="site-menu-label">{item.label}</span>}
    {item.children.map(child => entry(child, depth + 1))}
  </div>;
  return <nav className="site-menu" aria-label="Church website">
    <div className="eyebrow">Our website</div>
    {items.map(item => entry(item, 0))}
  </nav>;
}
