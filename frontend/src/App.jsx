import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, churchCapabilities, gapi, setApiChurch, startApiPreview, stopApiPreview, whenCapabilitiesKnown } from './api.js';
import { ChurchContext } from './ChurchContext.js';
import ChatWidget from './ChatWidget.jsx';
import { DEMO_CHURCH, DEMO_INFO, forgetSavedChurch, getStaffToken, getVerifiedStaffToken, hashFor, isSlug, needsChurchInHash, resolveChurch, saveChurch, savedChurch, setStaffToken, shareLink } from './church.js';
import ChurchSetup from './ChurchSetup.jsx';
import Builder from './Builder.jsx';
import { draftApi } from './builderApi.js';
import { ChurchMissing, ChurchNotReady } from './ChurchStates.jsx';
import Give from './Give.jsx';
import { churchApi, givingCapabilities, verifyStaffSession } from './giving.js';
import Home from './Home.jsx';
import { ABOUT_DEMO_ONLY, Brand, PageHeader, SECTIONS, Sidebar, SubNav, TabBar, TopBar, WorkspaceBar, aboutTabsFor } from './Layout.jsx';
import PastorNotes from './PastorNotes.jsx';
import Platform from './Platform.jsx';
import Serve from './Serve.jsx';
import Calendar from './Calendar.jsx';
import VisitPage from './VisitPage.jsx';
import WelcomeTeam from './WelcomeTeam.jsx';
import PrayerMap from './PrayerMap.jsx';
import About from './About.jsx';
import Beliefs from './Beliefs.jsx';
import News from './News.jsx';
import Directory from './Directory.jsx';
import Connect from './Connect.jsx';

const ROUTES = ['', 'serve', 'serve/find', 'serve/saved', 'about', 'about/beliefs', 'about/news', 'about/directory', 'about/connect', 'notes', 'give', 'give/trips', 'staff', 'calendar', 'guests', 'guests/plan', 'guests/welcome', 'prayer', 'setup', 'new', 'platform'];
// One sermon has its own route (#/notes/<id>), so it can be opened full-page and linked to.
const SERMON_ROUTE = /^notes\/[\w-]+$/;
// Managing a monthly gift: #/give/manage, or a gift's private link #/give/manage/<church>.<token>.
const GIVE_MANAGE = /^give\/manage(\/[a-z0-9-]{1,40}\.[\w-]{20,100})?$/;

// [eyebrow, title, intro] for each About page.
const ABOUT_PAGES = {
  about: ['About', 'Who we are.', 'The story, the people and the heart behind Grace Community Church.'],
  'about/beliefs': ['About', 'What we believe.', 'The convictions that shape our teaching and our life together.'],
  'about/news': ['News', 'What’s happening.', 'Quick updates on what’s coming up, and longer articles from our pastors and ministry leaders.'],
  'about/directory': ['About', 'Who to contact.', 'Pastors, staff and ministry leaders, and how to reach them.'],
  'about/connect': ['Connect', 'Let’s get you connected.', 'Whether you are new, curious or ready to jump in, here are a few ways to take the next step.'],
};
const GUEST_TABS = [['guests/plan', 'Plan your visit', 'pin'], ['guests/welcome', 'Welcome team', 'users']];
// Pages that work before the church API knows about new churches: giving has its own API.
// #/platform (every church, for the platform team) is not tied to the church showing.
const WORKS_WITHOUT_CHURCH_API = new Set(['give', 'staff', 'platform']);

// A section whose own route has no page (Guests, Prayer) opens its first sub-page,
// so tapping it in the phone tab bar never lands on an empty page.
// Other churches have no Our story, Beliefs, Directory or Connect content yet, so About opens News.
function withDefault(route, demo = true) {
  if (!demo && ABOUT_DEMO_ONLY.has(route)) return 'about/news';
  const s = SECTIONS.find(x => x.route === route);
  return s?.children && !s.children.some(([r]) => r === route) ? s.children[0][0] : route;
}

// Stripe returns to /give?church=<slug>&session_id=..., so that path opens Give for that church.
const onGivePath = () => window.location.pathname.startsWith('/give');

/** The church and page in the address bar. See church.js for the order churches are picked in. */
function readLocation() {
  const preview = /^#\/new\/preview(?:\/(.*))?$/.exec(window.location.hash);
  if (preview) {
    const route = preview[1] || '';
    return { slug: 'builder-preview', source: 'preview',
      route: withDefault((ROUTES.includes(route) && !['new', 'platform'].includes(route)) || SERMON_ROUTE.test(route) ? route : '', false) };
  }
  const where = resolveChurch({ host: window.location.host, hash: window.location.hash, saved: savedChurch() });
  const back = new URLSearchParams(window.location.search).get('church');
  if (onGivePath() && isSlug(back) && where.source !== 'subdomain') Object.assign(where, { slug: back, source: 'link' });
  // The blog became part of News, Church staff moved out of Give, and the prayer map lost its one sub-page;
  // keep the old links (#/blog, #/about/blog, #/give/staff, #/start, #/prayer/map) working.
  let route = ['start', 'give/start', 'give/staff'].includes(where.route) ? 'staff'
    : ['blog', 'about/blog'].includes(where.route) ? 'about/news' : where.route === 'prayer/map' ? 'prayer' : where.route;
  if ((ROUTES.includes(route) || SERMON_ROUTE.test(route) || GIVE_MANAGE.test(route)) && (route || !onGivePath())) route = withDefault(route, where.slug === DEMO_CHURCH);
  else route = onGivePath() ? 'give' : '';
  // A link that names a church becomes this browser's church, so plain links (#/serve) stay on it.
  if (where.source === 'link') saveChurch(where.slug);
  return { ...where, route };
}

// The browser tab shows the church itself: its name as the title, and its letter badge (the same
// sand-colored initial as beside the church name in the sidebar) as the icon.
const xmlEscape = text => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
function churchIcon(name) {
  const letter = xmlEscape(name.trim().charAt(0).toUpperCase() || '·');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#f3ecdd"/><text x="16" y="23" font-family="Georgia,serif" font-size="20" fill="#8f7a4f" text-anchor="middle">${letter}</text></svg>`;
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

const titleCase = slug => slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

const inPreview = () => /^#\/new\/preview(?:\/|$)/.test(window.location.hash);

export default function App() {
  const [preview, setPreview] = useState(inPreview);
  useEffect(() => {
    const sync = () => {
      if (!inPreview()) stopApiPreview();
      setPreview(inPreview());
    };
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
    };
  }, []);
  if (preview) return <BuilderPreview />;
  stopApiPreview();
  return <SiteApp />;
}

function BuilderPreview() {
  const [snapshot, setSnapshot] = useState(null), [error, setError] = useState('');
  useEffect(() => {
    document.title = 'Site preview · Tekton';
    let live = true;
    const controller = new AbortController();
    let id;
    try { id = sessionStorage.getItem('tekton-new-draft'); } catch { /* Storage may be unavailable. */ }
    if (!id) setError('Open the builder and import your website to preview your site.');
    else draftApi('/' + encodeURIComponent(id) + '/site', { signal: controller.signal })
      .then(data => { if (live) setSnapshot(data); })
      .catch(err => { if (live) setError(err.status === 404 ? 'This draft has expired or could not be found. Start a new import in the builder.' : err.message); });
    return () => { live = false; controller.abort(); stopApiPreview(); };
  }, []);
  if (!snapshot) return <div className="standalone-builder">
    <header><Brand /></header>
    <main><p role={error ? 'alert' : 'status'}>{error || 'Loading your site preview…'}</p><a href="#/new">Back to the builder</a></main>
  </div>;
  return <SiteApp snapshot={snapshot} />;
}

function SiteApp({ snapshot }) {
  const previewBanner = useRef(null);
  const [where, setWhere] = useState(readLocation),
    [chatOpen, setChatOpen] = useState(false),
    [requestsVersion, setRequestsVersion] = useState(0),
    [savedCount, setSavedCount] = useState(0),
    [scrollTarget, setScrollTarget] = useState(null),
    [apiReady, setApiReady] = useState(null),
    [listing, setListing] = useState(snapshot?.info || null),
    [listingVersion, setListingVersion] = useState(0),
    [staffVersion, setStaffVersion] = useState(0);
  const { slug, source, route } = where;
  const demo = !snapshot && slug === DEMO_CHURCH;
  if (snapshot) startApiPreview(snapshot);
  // Every api() call from here down is for this church.
  setApiChurch(slug);
  const params = new URLSearchParams(window.location.search);
  const giveSession = !snapshot && onGivePath() ? params.get('session_id') || '' : '';
  const giveStatus = giveSession ? params.get('status') || '' : '';
  const giveChurch = giveSession ? params.get('church') || '' : '';

  useLayoutEffect(() => {
    if (!snapshot) return;
    const banner = previewBanner.current;
    const resize = () => banner.parentElement.style.setProperty('--preview-height', banner.offsetHeight + 'px');
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(banner);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const sync = () => {
      const next = readLocation();
      if (needsChurchInHash(window.location.hash, next.source, onGivePath())) window.history.replaceState(null, '', '/' + hashFor(next.slug, next.route, next.source));
      setWhere(next);
    };
    const staffChanged = () => setStaffVersion(v => v + 1);
    window.addEventListener('popstate', sync);
    window.addEventListener('hashchange', sync);
    window.addEventListener('belong-staff', staffChanged);
    // The older giving link (#/give/c/<slug>) becomes the sitewide form (#/c/<slug>/give), and a plain link
    // (#/serve, or no hash) gains the church it opened, so copying the address bar keeps the church.
    // A checkout return (/give?session_id=…) keeps its address until the Give page has read it.
    if (needsChurchInHash(window.location.hash, source, onGivePath())) window.history.replaceState(null, '', '/' + hashFor(slug, route, source));
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('belong-staff', staffChanged);
    };
  }, []);
  useEffect(() => snapshot ? undefined : whenCapabilitiesKnown(churchCapabilities, setApiReady), []);
  // The name and city come from the church registry (the giving service), then the church API.
  useEffect(() => {
    if (snapshot) { setListing(snapshot.info); return; }
    let live = true;
    setListing(demo ? DEMO_INFO : null);
    if (demo) return;
    (async () => {
      let found = null, missing = false;
      if ((await givingCapabilities()).churches) {
        try { found = await gapi('/api/directory/' + encodeURIComponent(slug)); } catch (err) { missing = err.status === 404; }
        // An older giving service has no /api/directory route, so a 404 there is not proof the church
        // is missing. Its public church page has the same name and city, so ask that before giving up.
        if (missing) {
          try { found = await churchApi(slug); missing = false; } catch (err) { missing = err.status === 404; }
        }
      }
      if (!found && !missing && (await churchCapabilities()).churches) found = await api('/info').catch(() => null);
      if (missing) forgetSavedChurch(slug);
      if (live) setListing(found ? { slug, name: found.name, city: found.city || '' } : { slug, name: titleCase(slug), city: '', missing });
    })();
    return () => { live = false; };
  }, [slug, listingVersion]);
  // Restored tokens require validation. Fresh login/password responses already verified the session.
  const staffToken = snapshot ? '' : getStaffToken(slug);
  useEffect(() => {
    let live = true, retry;
    if (!staffToken || getVerifiedStaffToken(slug) === staffToken) return;
    async function verify() {
      try {
        const valid = await verifyStaffSession(slug);
        if (!live || getStaffToken(slug) !== staffToken) return;
        setStaffToken(slug, valid ? staffToken : '', { verified: valid });
      } catch (err) {
        // A rejected token is cleared by staffApi; transient failures retry without discarding it.
        if (live && getStaffToken(slug) === staffToken && err.status !== 401) retry = setTimeout(verify, 5000);
      }
    }
    verify();
    return () => { live = false; clearTimeout(retry); };
  }, [slug, staffToken, staffVersion]);
  // Lock page scroll behind the full-screen chat on phones.
  useEffect(() => { document.body.classList.toggle('chat-open', chatOpen); }, [chatOpen]);

  // sectionId (from a chat suggestion) scrolls to that element instead of the top of the page.
  function go(next, sectionId) {
    next = withDefault(['start', 'give/start', 'give/staff'].includes(next) ? 'staff' : next === 'prayer/map' ? 'prayer' : next, demo);
    // Drops any /give?session_id=… left over from a checkout return.
    const hash = snapshot ? '#/new/preview' + (next ? '/' + next : '') : hashFor(slug, next, source);
    if (next !== route || window.location.search) window.history.pushState(null, '', '/' + hash);
    setWhere(w => ({ ...w, route: next }));
    setChatOpen(false);
    setScrollTarget({ id: sectionId ?? null });
  }
  // Open an existing church, or the demo church from the not-found page.
  function choose(next, nextRoute = '') {
    if (snapshot) { go(nextRoute); return; }
    saveChurch(next);
    if (source === 'subdomain') {
      window.location.href = shareLink(next, nextRoute);
      return;
    }
    window.history.pushState(null, '', '/' + hashFor(next, nextRoute));
    setSavedCount(0);
    setWhere({ slug: next, source: next === DEMO_CHURCH ? 'saved' : 'link', route: nextRoute });
    setChatOpen(false);
    setScrollTarget({ id: null });
  }
  useEffect(() => {
    if (!scrollTarget) return;
    const top = () => window.scrollTo({ top: 0, behavior: 'smooth' });
    // Do not return the value of top(): newer browsers return a Promise from scrollTo, and React
    // would call it as this effect cleanup on the next navigation and crash the app.
    if (!scrollTarget.id) { top(); return; }
    // A section can render only after its page loads data, so wait up to 5 seconds for it.
    let tries = 0;
    const timer = setInterval(() => {
      const element = document.getElementById(scrollTarget.id);
      if (!element && ++tries < 50) return;
      clearInterval(timer);
      element ? element.scrollIntoView({ behavior: 'smooth', block: 'start' }) : top();
    }, 100);
    return () => clearInterval(timer);
  }, [scrollTarget]);

  const name = listing?.name || (demo ? DEMO_INFO.name : '');
  useEffect(() => {
    if (route === 'new') { document.title = 'Create your church site · Tekton'; return; }
    if (!name) return;
    document.title = name;
    let icon = document.querySelector('link[rel="icon"]');
    if (!icon) { icon = document.createElement('link'); icon.rel = 'icon'; document.head.appendChild(icon); }
    icon.href = churchIcon(name);
  }, [name, route]);
  const ready = !!snapshot || demo || apiReady === true;
  const staff = !!staffToken && getVerifiedStaffToken(slug) === staffToken;
  const church = useMemo(() => ({
    slug, source, demo, name, city: listing?.city || '', missing: !!listing?.missing, ready, staff, choose, go,
    // After staff rename the church in Church setup.
    refresh: () => setListingVersion(v => v + 1),
  }), [slug, source, demo, name, listing?.city, listing?.missing, ready, staff, route, staffVersion]);

  const section = route.split('/')[0];
  if (section === 'new') return <ChurchContext.Provider value={church}>
    <div className="standalone-builder">
      <header><Brand /></header>
      <main><Builder /></main>
    </div>
  </ChurchContext.Provider>;
  // A new church on an older church API: everything but giving waits for the deploy.
  const blocked = !ready && apiReady !== null && !WORKS_WITHOUT_CHURCH_API.has(section) && !giveSession;
  let page;
  if (listing?.missing && section !== 'platform') page = <ChurchMissing />;
  else if (blocked) page = <ChurchNotReady section={section} />;
  else page = <>
    {section === '' && <Home go={go} onAsk={() => setChatOpen(true)} />}
    {/* Kept mounted so the saved/pending count stays live in the nav. */}
    {ready && <div hidden={section !== 'serve'}><Serve route={section === 'serve' ? route : 'serve'} go={go} requestsVersion={requestsVersion} onCount={setSavedCount} /></div>}
    {section === 'about' && <div className="page">
      <PageHeader eyebrow={ABOUT_PAGES[route]?.[0] ?? 'About'} title={ABOUT_PAGES[route]?.[1]} text={ABOUT_PAGES[route]?.[2]} />
      {demo && <SubNav tabs={aboutTabsFor(demo)} route={route} go={go} />}
      {route === 'about/news' && <News go={go} />}
      {demo && route === 'about' && <About go={go} />}
      {demo && route === 'about/beliefs' && <Beliefs />}
      {demo && route === 'about/directory' && <Directory />}
      {demo && route === 'about/connect' && <Connect go={go} onAsk={() => setChatOpen(true)} />}
    </div>}
    {section === 'notes' && <div className="page">
      <PageHeader eyebrow="Sermon Notes" title="Sermons you can ask." text="Every Sunday message, transcribed. Ask a question and get the pastor’s own words back, with timestamps." />
      <PastorNotes route={route} go={go} />
    </div>}
    {(section === 'give' || section === 'staff') && <div className="page">
      <Give route={route} go={go} sessionId={giveSession} status={giveStatus} returnChurch={giveChurch} />
    </div>}
    {section === 'calendar' && <div className="page">
      <PageHeader eyebrow="Calendar" title="Church Life & Gatherings." text="Explore upcoming gatherings, services, and outreach with AI-generated summaries." />
      <Calendar />
    </div>}
    {section === 'guests' && <div className="page">
      <PageHeader eyebrow="Guests" title={route === 'guests/plan' ? 'Plan your visit.' : 'Welcome team.'} text={route === 'guests/plan' ? 'Everything a first-time guest needs, and a way to let us know they’re coming.' : 'See who has arrived and get them to the right person.'} />
      <SubNav tabs={GUEST_TABS} route={route} go={go} />
      {route === 'guests/plan' && <VisitPage />}
      {route === 'guests/welcome' && <WelcomeTeam />}
    </div>}
    {section === 'prayer' && <div className="page">
      <PageHeader eyebrow="Prayer map" title="Sharp facts. Soft people." text="Real news gets a real pin. People in sensitive places never do." />
      <PrayerMap />
    </div>}
    {section === 'setup' && <div className="page"><ChurchSetup /></div>}
    {section === 'platform' && <div className="page"><Platform /></div>}
  </>;

  return <ChurchContext.Provider value={church}>
    <div className={'app' + (snapshot ? ' site-preview' : '')}>
      {snapshot && <div className="site-preview-banner" ref={previewBanner}><span>Preview of {name || 'Your church'}. Nothing here is live yet.</span><a href="#/new">Back to the builder</a></div>}
      <Sidebar route={route} go={go} savedCount={savedCount} />
      <TopBar go={go} onAsk={() => setChatOpen(true)} />
      <div className="content">
        <WorkspaceBar />
        {/* Reload pages when the church or access changes, so staff data is cleared on sign-out. */}
        <main key={slug + ':' + (staff ? 'staff' : 'visitor')}>
          {page}
          <footer className="site-footer">
            <span>{name || 'Your church'} · Helping people find their people.</span>
            {demo && <small>Demo site. Church details, people and contacts are fictional.</small>}
            <small className="powered-by">Powered by Tekton</small>
          </footer>
        </main>
      </div>
      <TabBar route={route} go={go} chatOpen={chatOpen} savedCount={savedCount} />
      <ChatWidget key={slug} open={chatOpen} setOpen={setChatOpen} onRequestFiled={() => setRequestsVersion(v => v + 1)} onNavigate={go} />
    </div>
  </ChurchContext.Provider>;
}
