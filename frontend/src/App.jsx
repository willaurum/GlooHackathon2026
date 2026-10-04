import { useEffect, useState } from 'react';
import ChatWidget from './ChatWidget.jsx';
import Give from './Give.jsx';
import Home from './Home.jsx';
import { ABOUT_TABS, PageHeader, Sidebar, SubNav, TabBar, TopBar } from './Layout.jsx';
import PastorNotes from './PastorNotes.jsx';
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

const ROUTES = ['', 'serve', 'serve/find', 'serve/saved', 'notes', 'give', 'calendar', 'guests', 'guests/plan', 'guests/welcome', 'prayer', 'prayer/map', 'about', 'about/beliefs', 'about/news', 'about/directory', 'connect'];

// Routes live in the hash (#/serve/find). Stripe returns to /give?session_id=…, so that path opens Give too.
function currentRoute() {
  const hash = window.location.hash.replace(/^#\/?/, '');
  if (ROUTES.includes(hash) && (hash || !window.location.pathname.startsWith('/give'))) return hash;
  return window.location.pathname.startsWith('/give') ? 'give' : '';
}

const ABOUT_TITLES = { about: 'Who we are.', 'about/beliefs': 'What we believe.', 'about/news': 'What’s happening.', 'about/directory': 'Who to contact.' };
const ABOUT_TEXT = {
  about: 'The story, the people and the heart behind Grace Community Church.',
  'about/beliefs': 'The convictions that shape our teaching and our life together.',
  'about/news': 'Announcements and stories from church life.',
  'about/directory': 'Pastors, staff and ministry leaders, and how to reach them.',
};

export default function App() {
  const [route, setRoute] = useState(currentRoute),
    [chatOpen, setChatOpen] = useState(false),
    [requestsVersion, setRequestsVersion] = useState(0),
    [savedCount, setSavedCount] = useState(0);
  const params = new URLSearchParams(window.location.search);
  const giveSession = window.location.pathname.startsWith('/give') ? params.get('session_id') || '' : '';
  const giveStatus = giveSession ? params.get('status') || '' : '';

  useEffect(() => {
    const sync = () => setRoute(currentRoute());
    window.addEventListener('popstate', sync);
    window.addEventListener('hashchange', sync);
    return () => { window.removeEventListener('popstate', sync); window.removeEventListener('hashchange', sync); };
  }, []);
  // Lock page scroll behind the full-screen chat on phones.
  useEffect(() => { document.body.classList.toggle('chat-open', chatOpen); }, [chatOpen]);

  function go(next) {
    // Drops any /give?session_id=… left over from a checkout return.
    if (next !== route || window.location.search) window.history.pushState(null, '', '/#/' + next);
    setRoute(next);
    setChatOpen(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const section = route.split('/')[0];
  return <div className="app">
    <Sidebar route={route} go={go} onAsk={() => setChatOpen(true)} savedCount={savedCount} />
    <TopBar go={go} onAsk={() => setChatOpen(true)} />
    <div className="content">
      <main>
        {section === '' && <Home go={go} onAsk={() => setChatOpen(true)} />}
        {/* Kept mounted so the saved/pending count stays live in the nav. */}
        <div hidden={section !== 'serve'}><Serve route={section === 'serve' ? route : 'serve'} go={go} requestsVersion={requestsVersion} onCount={setSavedCount} /></div>
        {section === 'notes' && <div className="page">
          <PageHeader eyebrow="Sermon Notes" title="Sermons you can ask." text="Every Sunday message, transcribed. Ask a question and get the pastor’s own words back, with timestamps." />
          <PastorNotes />
        </div>}
        {section === 'give' && <div className="page">
          <PageHeader eyebrow="Give" title="Give with confidence." text="Every gift moves the mission forward. Give online in a couple of taps." />
          <Give sessionId={giveSession} status={giveStatus} />
        </div>}
        {section === 'calendar' && <div className="page">
          <PageHeader eyebrow="Calendar" title="Church life & gatherings." text="Every service, class, and outreach — with optional AI summaries. Add the next thing on the calendar." />
          <Calendar />
        </div>}
        {section === 'guests' && <div className="page">
          <PageHeader eyebrow="Guests" title={route === 'guests/plan' ? 'Plan your visit.' : 'Welcome team.'} text={route === 'guests/plan' ? 'Everything a first-time guest needs, and a way to let us know they’re coming.' : 'See who has arrived and get them to the right person.'} />
          {route === 'guests/plan' && <VisitPage />}
          {route === 'guests/welcome' && <WelcomeTeam />}
        </div>}
        {section === 'prayer' && <div className="page">
          <PageHeader eyebrow="Prayer map" title="Sharp facts. Soft people." text="Real news gets a real pin. People in sensitive places never do." />
          <PrayerMap />
        </div>}
        {section === 'about' && <div className="page">
          <PageHeader eyebrow="About" title={ABOUT_TITLES[route]} text={ABOUT_TEXT[route]} />
          <SubNav tabs={ABOUT_TABS} route={route} go={go} />
          {route === 'about' && <About go={go} />}
          {route === 'about/beliefs' && <Beliefs />}
          {route === 'about/news' && <News go={go} />}
          {route === 'about/directory' && <Directory />}
        </div>}
        {section === 'connect' && <div className="page">
          <PageHeader eyebrow="Connect" title="Let’s get you connected." text="Whether you are new, curious or ready to jump in, here are a few ways to take the next step." />
          <Connect go={go} onAsk={() => setChatOpen(true)} />
        </div>}
        <footer className="site-footer">
          <b>belong.</b>
          <span>Grace Community Church · Helping people find their people.</span>
          <nav className="footer-links" aria-label="About">
            {ABOUT_TABS.map(([r, label]) => <a key={r} href={'#/' + r} onClick={e => { e.preventDefault(); go(r); }}>{label}</a>)}
            <a href="#/connect" onClick={e => { e.preventDefault(); go('connect'); }}>Connect</a>
          </nav>
        </footer>
      </main>
    </div>
    <TabBar route={route} go={go} onAsk={() => setChatOpen(true)} chatOpen={chatOpen} savedCount={savedCount} />
    <ChatWidget open={chatOpen} setOpen={setChatOpen} onRequestFiled={() => setRequestsVersion(v => v + 1)} />
  </div>;
}
