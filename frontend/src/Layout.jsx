import { useEffect, useState } from 'react';
import { useChurch } from './ChurchContext.js';
import ChurchName from './ChurchName.jsx';
import Icon from './Icon.jsx';

// One navigation for every screen size: a top navigation bar on desktop; on phones, a tab bar holds the
// sections marked `tab` and everything else sits in the Menu (burger) sheet.
// `staffOnly` sections appear only while church staff are signed in.
export const SECTIONS = [
  { route: '', label: 'Home', icon: 'home', tab: true },
  { route: 'guests', label: 'Guests', short: 'Guests', icon: 'pin', tab: true, children: [['guests/plan', 'Plan your visit'], ['guests/welcome', 'Welcome team']] },
  { route: 'serve', label: 'Serve', icon: 'users', tab: true, children: [['serve', 'Ministries'], ['serve/find', 'Find a place'], ['serve/saved', 'Saved']] },
  { route: 'notes', label: 'Sermon Notes', short: 'Notes', icon: 'book', tab: true },
  { route: 'calendar', label: 'Calendar', short: 'Calendar', icon: 'calendar' },
  { route: 'give', label: 'Give', icon: 'heart', children: [['give', 'Give'], ['give/trips', 'Mission trips']] },
  { route: 'prayer', label: 'Prayer map', short: 'Prayer', icon: 'compass' },
  { route: 'about', label: 'About', icon: 'info', children: [['about', 'Our story'], ['about/beliefs', 'Beliefs'], ['about/news', 'News'], ['about/directory', 'Directory'], ['about/connect', 'Connect']] },
  { route: 'staff', label: 'Church staff', short: 'Staff', icon: 'lock', staffOnly: true },
];
// The sections this visitor can see: staff-only ones are hidden until staff sign in.
export const visibleSections = staff => SECTIONS.filter(s => staff || !s.staffOnly);
const childrenFor = (s, demo) => (s.children || []).filter(([r]) => demo || !ABOUT_DEMO_ONLY.has(r));

// The About pages other than News hold Grace Community's own text, so only the demo church
// shows them. Other churches see their own News until they have About content of their own.
export const ABOUT_DEMO_ONLY = new Set(['about', 'about/beliefs', 'about/directory', 'about/connect']);
export const ABOUT_TABS = [['about', 'Our story', 'info'], ['about/beliefs', 'Beliefs', 'book'], ['about/news', 'News', 'news'], ['about/directory', 'Directory', 'phone'], ['about/connect', 'Connect', 'mail']];
export const aboutTabsFor = demo => ABOUT_TABS.filter(([r]) => demo || !ABOUT_DEMO_ONLY.has(r));

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

// Desktop top bar, pinned while scrolling: the church in place of a site logo, the main navigation,
// and staff sign-in. A section with sub-pages opens them in a dropdown on hover or keyboard focus;
// the section itself still opens its first page.
export function SiteNav({ route, go, savedCount }) {
  const church = useChurch();
  const { demo, staff } = church;
  const current = sectionOf(route);
  // Leave the dropdown once a page is picked (focus would otherwise keep it open).
  const pick = (e, next) => { e.currentTarget.blur(); go(next); };
  return <header className="site-nav">
    <ChurchName staffLink={false} />
    <nav className="site-nav-links" aria-label="Main">
      {visibleSections(staff).map(s => {
        const kids = childrenFor(s, demo);
        return <div key={s.route} className={'site-nav-item' + (kids.length > 1 ? ' has-menu' : '')}>
          <button className={'site-nav-link' + (current === s.route ? ' active' : '')} aria-current={route === s.route ? 'page' : undefined}
            aria-haspopup={kids.length > 1 ? 'true' : undefined} onClick={e => pick(e, s.route)}>
            {/* Narrower screens use the short label (Notes, Prayer) so the bar stays one row. */}
            <span className="label-full">{s.label}</span><span className="label-short">{s.short ?? s.label}</span>
            {s.route === 'serve' && savedCount > 0 && <b className="count">{savedCount}</b>}
            {kids.length > 1 && <svg className="caret" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>}
          </button>
          {kids.length > 1 && <div className="site-nav-menu">
            {kids.map(([r, label]) => <button key={r} className={route === r ? 'active' : ''} aria-current={route === r ? 'page' : undefined} onClick={e => pick(e, r)}>
              {label}{r === 'serve/saved' && savedCount > 0 && <b className="count">{savedCount}</b>}
            </button>)}
          </div>}
        </div>;
      })}
    </nav>
    <div className="site-account">
      {/* Who is browsing, with the staff sign-in (or Church setup, once signed in) just below. */}
      <div className="site-user">
        <strong>{identity(staff).name}</strong>
        {!church.missing && <button className="link site-staff" onClick={e => pick(e, 'setup')}>
          <Icon name="lock" size={13} />{staff ? 'Church setup' : 'Staff sign in'}
        </button>}
      </div>
      <Avatar />
    </div>
  </header>;
}

export function TopBar({ onAsk }) {
  return <header className="topbar">
    <ChurchName compact />
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

export function TabBar({ route, go, chatOpen, savedCount }) {
  const { demo, staff } = useChurch();
  const [menuOpen, setMenuOpen] = useState(false);
  const tabs = SECTIONS.filter(s => s.tab);
  const more = visibleSections(staff).filter(s => !s.tab);
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
        const kids = childrenFor(s, demo);
        return <div key={s.route} className="menu-group">
          <button className={'nav-item' + (current === s.route ? ' active' : '')} onClick={() => open(s.route)}><Icon name={s.icon} />{s.label}</button>
          {kids.length > 1 && <div className="nav-children">
            {kids.map(([r, label]) => <button key={r} className={route === r ? 'active' : ''} aria-current={route === r ? 'page' : undefined} onClick={() => open(r)}>{label}</button>)}
          </div>}
        </div>;
      })}
    </div>}
    <nav className="tabbar" aria-label="Main">
      {tabs.map(s => <button key={s.route} className={!chatOpen && !menuOpen && current === s.route ? 'active' : ''} onClick={() => open(s.route)}>
        <span className="tab-icon"><Icon name={s.icon} size={22} />{s.route === 'serve' && savedCount > 0 && <b className="dot" />}</span>{s.short ?? s.label}
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
  return <div className="subnav" role="tablist">
    {tabs.map(([r, label, icon]) => <button key={r} role="tab" aria-selected={route === r} className={route === r ? 'active' : ''} onClick={() => go(r)}>
      <Icon name={icon} size={18} />{label}{counts[r] > 0 && <b className="count">{counts[r]}</b>}
    </button>)}
  </div>;
}
