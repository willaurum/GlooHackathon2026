import { useEffect, useState } from 'react';
import { useChurch } from './ChurchContext.js';
import ChurchName from './ChurchName.jsx';
import Icon from './Icon.jsx';

// One navigation for every screen size: a sidebar on desktop; on phones, a tab bar holds the
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
  { route: 'staff', label: 'Church staff', icon: 'lock', staffOnly: true },
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

export function Brand() {
  return <a className="tekton-brand" href="/#/new"><Icon name="sparkle" size={26} />Tekton</a>;
}

export function Sidebar({ route, go, savedCount }) {
  const { demo, staff } = useChurch();
  const user = identity(staff);
  return <aside className="sidebar">
    <ChurchName />
    <button className="first-visit" onClick={() => go('guests/plan')}><Icon name="pin" size={18} />First time here?</button>
    <nav aria-label="Main">
      {visibleSections(staff).map(s => <div key={s.route}>
        <button className={'nav-item' + (sectionOf(route) === s.route ? ' active' : '')} aria-current={route === s.route ? 'page' : undefined} onClick={() => go(s.route)}>
          <Icon name={s.icon} />{s.label}
        </button>
        {s.children && sectionOf(route) === s.route && <div className="nav-children">
          {childrenFor(s, demo).map(([r, label]) => <button key={r} className={route === r ? 'active' : ''} aria-current={route === r ? 'page' : undefined} onClick={() => go(r)}>
            {label}{r === 'serve/saved' && savedCount > 0 && <b className="count">{savedCount}</b>}
          </button>)}
        </div>}
      </div>)}
    </nav>
    <div className="profile">
      <Avatar />
      <div><strong>{user.name}</strong><small>{user.role}</small></div>
    </div>
  </aside>;
}

export function TopBar({ go, onAsk }) {
  return <header className="topbar">
    <ChurchName compact />
    <button className="first-visit" onClick={() => go('guests/plan')}>First time here?</button>
    <button className="icon-btn" aria-label="Ask Tekton" onClick={onAsk}><Icon name="chat" /></button>
    <Avatar />
  </header>;
}

// Desktop-only strip in the top-right corner; phones get the avatar in the TopBar instead.
export function WorkspaceBar() {
  const church = useChurch();
  return <div className="workspace-bar">
    {church.demo ? <span className="demo-pill">● Demo workspace</span> : church.staff && <span className="demo-pill">● Signed in as staff</span>}
    <Avatar />
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
