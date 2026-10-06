import { useChurch } from './ChurchContext.js';
import ChurchName from './ChurchName.jsx';
import Icon from './Icon.jsx';

// One navigation for every screen size: a sidebar on desktop, a tab bar on phones.
export const SECTIONS = [
  { route: '', label: 'Home', icon: 'home' },
  { route: 'guests', label: 'Guests', short: 'Guests', icon: 'pin', children: [['guests/plan', 'Plan your visit'], ['guests/welcome', 'Welcome team']] },
  { route: 'serve', label: 'Serve', icon: 'users', children: [['serve', 'Ministries'], ['serve/find', 'Find a place'], ['serve/saved', 'Saved']] },
  { route: 'notes', label: 'Sermon Notes', short: 'Notes', icon: 'book' },
  { route: 'calendar', label: 'Calendar', short: 'Calendar', icon: 'calendar' },
  { route: 'give', label: 'Give', icon: 'heart', children: [['give', 'Give'], ['give/trips', 'Mission trips'], ['give/staff', 'Giving admin']] },
  { route: 'prayer', label: 'Prayer map', short: 'Prayer', icon: 'compass', children: [['prayer/map', 'Prayer map']] },
  // In the sidebar on desktop and behind the info button in the phone top bar, so the tab bar stays uncrowded.
  { route: 'about', label: 'About', icon: 'info', tab: false, children: [['about', 'Our story'], ['about/beliefs', 'Beliefs'], ['about/news', 'News'], ['about/directory', 'Directory'], ['about/connect', 'Connect'], ['about/blog', 'Blog']] },
];

// The About pages other than the blog hold Grace Community's own text, so only the demo church
// shows them. Other churches see the blog until they have About content of their own.
export const ABOUT_DEMO_ONLY = new Set(['about', 'about/beliefs', 'about/news', 'about/directory', 'about/connect']);
export const ABOUT_TABS = [['about', 'Our story', 'info'], ['about/beliefs', 'Beliefs', 'book'], ['about/news', 'News', 'news'], ['about/directory', 'Directory', 'phone'], ['about/connect', 'Connect', 'mail'], ['about/blog', 'Blog', 'document']];
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

export function Brand({ onClick }) {
  return <a className="brand" href="#/" onClick={e => { e.preventDefault(); onClick(); }}><b>b</b>belong<span>.</span></a>;
}

export function Sidebar({ route, go, onAsk, savedCount }) {
  const { demo, staff } = useChurch();
  const user = identity(staff);
  return <aside className="sidebar">
    <Brand onClick={() => go('')} />
    <ChurchName />
    <button className="first-visit" onClick={() => go('guests/plan')}><Icon name="pin" size={18} />First time here?</button>
    <nav aria-label="Main">
      {SECTIONS.map(s => <div key={s.route}>
        <button className={'nav-item' + (sectionOf(route) === s.route ? ' active' : '')} aria-current={route === s.route ? 'page' : undefined} onClick={() => go(s.route)}>
          <Icon name={s.icon} />{s.label}
        </button>
        {s.children && sectionOf(route) === s.route && <div className="nav-children">
          {s.children.filter(([r]) => demo || !ABOUT_DEMO_ONLY.has(r)).map(([r, label]) => <button key={r} className={route === r ? 'active' : ''} aria-current={route === r ? 'page' : undefined} onClick={() => go(r)}>
            {label}{r === 'serve/saved' && savedCount > 0 && <b className="count">{savedCount}</b>}
          </button>)}
        </div>}
      </div>)}
    </nav>
    <div className="ask-card">
      <Icon name="sparkle" size={22} />
      <strong>Questions?</strong>
      <p>Service times, groups, or a place to serve. Staff review every request.</p>
      <button className="secondary wide" onClick={onAsk}><Icon name="chat" size={18} />Ask Belong</button>
    </div>
    <div className="profile">
      <Avatar />
      <div><strong>{user.name}</strong><small>{user.role}</small></div>
    </div>
  </aside>;
}

export function TopBar({ go, onAsk }) {
  return <header className="topbar">
    <Brand onClick={() => go('')} />
    <ChurchName compact />
    <button className="first-visit" onClick={() => go('guests/plan')}>First time here?</button>
    <button className="icon-btn" aria-label="About and blog" onClick={() => go('about')}><Icon name="info" /></button>
    <button className="icon-btn" aria-label="Ask Belong" onClick={onAsk}><Icon name="chat" /></button>
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

export function TabBar({ route, go, onAsk, chatOpen, savedCount }) {
  return <nav className="tabbar" aria-label="Main">
    {SECTIONS.filter(s => s.tab !== false).map(s => <button key={s.route} className={!chatOpen && sectionOf(route) === s.route ? 'active' : ''} onClick={() => go(s.route)}>
      <span className="tab-icon"><Icon name={s.icon} size={22} />{s.route === 'serve' && savedCount > 0 && <b className="dot" />}</span>{s.short ?? s.label}
    </button>)}
    <button className={chatOpen ? 'active' : ''} onClick={onAsk}><span className="tab-icon"><Icon name="chat" size={22} /></span>Ask</button>
  </nav>;
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
