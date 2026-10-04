import { useEffect, useState } from 'react';
import { fmt } from './api.js';
import Icon from './Icon.jsx';
import GiveChurchBar from './GiveChurchBar.jsx';
import { churchApi, friendly, savedManageLinks, splitManageToken } from './giving.js';

const day = iso => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }) : '');

// "Manage or cancel a monthly gift". With a private link (#/give/manage/<token>)
// it shows that one gift; without one it explains how to find your gift.
export default function GiveManage({ token, church, slug, go, onPickChurch, onChanged }) {
  if (token) return <ManagedGift token={token} go={go} onChanged={onChanged} />;
  return <>
    <GiveChurchBar church={church} slug={slug} onPick={onPickChurch} label="Monthly gifts to" />
    {church ? <FindGift church={church} go={go} /> : <div className="card give-pad"><p role="status">Loading…</p></div>}
  </>;
}

function FindGift({ church, go }) {
  if (church.manage === 'portal' && church.portalUrl) return <div className="card give-pad give-manage">
    <div className="form-title"><span className="icon color1"><Icon name="calendar" size={22} /></span><div><h2>Manage your monthly gift</h2><p>For gifts to {church.name}.</p></div></div>
    <ol className="give-manage-steps">
      <li>Open the secure Stripe page below.</li>
      <li>Enter the email you used when you gave. Stripe emails you a short code.</li>
      <li>Enter the code. You can cancel your monthly gift, update your card or see past receipts.</li>
    </ol>
    <a className="primary give-portal" href={church.portalUrl} rel="noopener noreferrer">Open the secure page<Icon name="arrow" size={18} /></a>
    <p className="form-note">Canceling stops future gifts right away. Gifts already made are not refunded.</p>
  </div>;
  if (church.mode === 'demo' || church.manage === 'link') return <SavedGifts church={church} go={go} />;
  return <div className="card give-pad give-manage">
    <h2>Online canceling is almost ready.</h2>
    <p>{church.name} has not finished setting it up yet. Until then, church staff can stop a monthly gift for you from their giving records.</p>
  </div>;
}

// Demo mode: each monthly gift has a private link. Links from this browser are listed here.
function SavedGifts({ church, go }) {
  const [gifts, setGifts] = useState(null);
  useEffect(() => {
    let live = true;
    const mine = savedManageLinks().map(x => ({ ...x, ...splitManageToken(x.token) })).filter(x => x.slug === church.slug);
    Promise.all(mine.map(x => churchApi(x.slug, '/manage/' + x.secret).then(g => ({ ...g, token: x.token })).catch(() => null)))
      .then(list => live && setGifts(list.filter(Boolean)));
    return () => { live = false; };
  }, [church.slug]);
  return <div className="card give-pad give-manage">
    <div className="form-title"><span className="icon color1"><Icon name="calendar" size={22} /></span><div><h2>Your monthly gifts</h2><p>To {church.name}, made in this browser.</p></div></div>
    {gifts === null ? <p role="status">Looking for your gifts…</p>
      : gifts.length ? <ul className="give-manage-list">
        {gifts.map(g => <li key={g.token}>
          <div><strong>{fmt(g.amount, g.currency)} each month</strong><small>{g.fund} · {g.canceled ? 'Canceled ' + day(g.canceledAt) : 'Started ' + day(g.startedAt)}</small></div>
          <button className={g.canceled ? 'ghost' : 'secondary'} onClick={() => go('give/manage/' + g.token)}>{g.canceled ? 'View' : 'Manage'}</button>
        </li>)}
      </ul>
      : <p>No monthly gifts from this browser yet. After you set one up, the thank-you screen has a private "Manage or cancel" link, and it shows up here too.</p>}
    <p className="form-note">Gave from another device? Use the link from that thank-you screen, or ask church staff to stop the gift for you.</p>
  </div>;
}

function ManagedGift({ token, go, onChanged }) {
  const parts = splitManageToken(token);
  const [gift, setGift] = useState(null), [err, setErr] = useState(''), [confirming, setConfirming] = useState(false), [busy, setBusy] = useState(false), [done, setDone] = useState(false);
  useEffect(() => {
    if (!parts) return setErr('This link does not work. It may be old or copied wrong.');
    churchApi(parts.slug, '/manage/' + parts.secret).then(setGift).catch(e => setErr(friendly(e)));
  }, [token]);
  async function cancel() {
    setBusy(true); setErr('');
    try {
      setGift(await churchApi(parts.slug, '/manage/' + parts.secret + '/cancel', { method: 'POST' }));
      setDone(true);
      setConfirming(false);
      onChanged?.();
    } catch (e) { setErr(friendly(e)); }
    finally { setBusy(false); }
  }
  if (!gift) return <div className="card give-confirm give-manage-gift" aria-live="polite">
    {err ? <><h2>We could not open this gift.</h2><p>{err}</p><button className="primary give-again" onClick={() => go('give/manage')}>Find my monthly gift</button></> : <p role="status">Looking up your gift…</p>}
  </div>;
  const amount = fmt(gift.amount, gift.currency);
  return <div className="card give-confirm give-manage-gift" aria-live="polite">
    <div className="give-mark"><Icon name={gift.canceled ? 'check' : 'calendar'} size={28} /></div>
    <div className="eyebrow">{gift.church}</div>
    <h2>{done ? 'Your monthly gift is canceled.' : amount + ' each month'}</h2>
    <p>{done ? `No more ${amount} gifts will be made to ${gift.fund}. Thank you for your generosity.` : 'To ' + gift.fund + '.'}</p>
    <div className={'give-status ' + (gift.canceled ? 'canceled' : 'active')}>
      {gift.canceled ? 'Canceled on ' + day(gift.canceledAt) + '. You will not be charged again.' : 'Active since ' + day(gift.startedAt) + '.'}
    </div>
    {gift.demo && <p className="form-note">Demo gift: no card was ever charged.</p>}
    {err && <div className="banner error" role="alert">{err}</div>}
    {!gift.canceled && (confirming
      ? <div className="give-manage-confirm" role="group" aria-label="Confirm cancel">
        <p><b>Cancel your {amount} monthly gift?</b> Gifts already made stay with the church. No new ones will be made.</p>
        <div className="give-row">
          <button className="primary danger" disabled={busy} onClick={cancel}>{busy ? 'Canceling…' : 'Yes, cancel it'}</button>
          <button className="secondary" disabled={busy} onClick={() => setConfirming(false)}>Keep my gift</button>
        </div>
      </div>
      : <button className="secondary give-again" onClick={() => setConfirming(true)}>Cancel this monthly gift</button>)}
    <div><button className="link give-again" onClick={() => go('give')}>Back to Give<Icon name="arrow" size={16} /></button></div>
  </div>;
}
