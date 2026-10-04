import Icon from './Icon.jsx';

// One navigation for every screen size: a sidebar on desktop, a tab bar on phones.
export const SECTIONS = [
  { route: '', label: 'Home', icon: 'home' },
  { route: 'serve', label: 'Serve', icon: 'users', children: [['serve', 'Ministries'], ['serve/find', 'Find a place'], ['serve/saved', 'Saved']] },
  { route: 'notes', label: 'Sermon Notes', short: 'Notes', icon: 'book' },
  { route: 'calendar', label: 'Calendar', short: 'Calendar', icon: 'calendar' },
  { route: 'give', label: 'Give', icon: 'heart' },
  { route: 'guests', label: 'Guests', short: 'Guests', icon: 'pin', children: [['guests/plan', 'Plan your visit'], ['guests/welcome', 'Welcome team']] },
  { route: 'prayer', label: 'Prayer map', short: 'Prayer', icon: 'compass', children: [['prayer/map', 'Prayer map']] },
];

const sectionOf = route => route.split('/')[0];

// Demo identity shown in the corners of the workspace.
export const USER = { initials: 'AL', name: 'Alex Lewis', role: 'Church leadership · Demo' };

export function Avatar() {
  return <span className="avatar" role="img" aria-label={USER.name}>{USER.initials}</span>;
}

export function Brand({ onClick }) {
  return <a className="brand" href="#/" onClick={e => { e.preventDefault(); onClick(); }}><b>b</b>belong<span>.</span></a>;
}

export function Sidebar({ route, go, onAsk, savedCount }) {
  return <aside className="sidebar">
    <Brand onClick={() => go('')} />
    <div className="church"><span>G</span><div><strong>Grace Community</strong><small>Springfield</small></div></div>
    <button className="first-visit" onClick={() => go('guests/plan')}><Icon name="pin" size={18} />First time here?</button>
    <nav aria-label="Main">
      {SECTIONS.map(s => <div key={s.route}>
        <button className={'nav-item' + (sectionOf(route) === s.route ? ' active' : '')} aria-current={route === s.route ? 'page' : undefined} onClick={() => go(s.route)}>
          <Icon name={s.icon} />{s.label}
        </button>
        {s.children && sectionOf(route) === s.route && <div className="nav-children">
          {s.children.map(([r, label]) => <button key={r} className={route === r ? 'active' : ''} aria-current={route === r ? 'page' : undefined} onClick={() => go(r)}>
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
      <div><strong>{USER.name}</strong><small>{USER.role}</small></div>
    </div>
  </aside>;
}

export function TopBar({ go, onAsk }) {
  return <header className="topbar">
    <Brand onClick={() => go('')} />
    <span className="topbar-church">Grace Community</span>
    <button className="first-visit" onClick={() => go('guests/plan')}>First time here?</button>
    <button className="icon-btn" aria-label="Ask Belong" onClick={onAsk}><Icon name="chat" /></button>
    <Avatar />
  </header>;
}

// Desktop-only strip in the top-right corner; phones get the avatar in the TopBar instead.
export function WorkspaceBar() {
  return <div className="workspace-bar">
    <span className="demo-pill">● Demo workspace</span>
    <Avatar />
  </div>;
}

export function TabBar({ route, go, onAsk, chatOpen, savedCount }) {
  return <nav className="tabbar" aria-label="Main">
    {SECTIONS.map(s => <button key={s.route} className={!chatOpen && sectionOf(route) === s.route ? 'active' : ''} onClick={() => go(s.route)}>
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
