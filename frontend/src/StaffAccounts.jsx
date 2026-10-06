import { useEffect, useState } from 'react';
import { rotateStaffToken } from './church.js';
import { friendly, revokeStaffToken, staffApi } from './giving.js';

export default function StaffAccounts({ slug, demo }) {
  const empty = { name: '', email: '', role: 'site_admin', password: '' };
  const [data, setData] = useState(null), [f, setF] = useState(empty), [busy, setBusy] = useState(false), [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    staffApi(slug, '/users').then(d => { if (live) { setData(d); if (!d.users.length) setF(v => ({ ...v, role: 'owner' })); } }).catch(e => { if (live) setErr(friendly(e)); });
    return () => { live = false; };
  }, [slug]);
  const set = key => e => setF(v => ({ ...v, [key]: e.target.value }));
  async function add(e) {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      setData(await staffApi(slug, '/users', { method: 'POST', body: JSON.stringify(f) }));
      setF(empty);
    } catch (e2) { setErr(friendly(e2)); }
    finally { setBusy(false); }
  }
  async function remove(user) {
    if (!window.confirm(`Remove ${user.name}? Their sessions will be signed out immediately.`)) return;
    setBusy(true); setErr('');
    try { setData(await staffApi(slug, '/users/' + encodeURIComponent(user.id), { method: 'DELETE' })); }
    catch (e) { setErr(friendly(e)); }
    finally { setBusy(false); }
  }
  return <div className="give-col">
    {err && <div className="banner error" role="alert">{err}</div>}
    {!data ? <div className="card give-pad"><p role="status">{err ? 'Could not load staff accounts.' : 'Loading staff accounts…'}</p></div> : <>
      <section className="card give-pad">
        <h3>Staff accounts</h3><p className="form-note">{data.me.name} · {data.me.role === 'owner' ? 'Owner' : 'Site admin'}</p><p>Owners and site admins have all staff permissions. Owners can also add and remove staff accounts.</p>
        {data.me.shared && !data.users.length && <p className="form-note">Create your Owner account first using the form below. Then sign out and sign in with your email and new password. You can then add Site admins.</p>}
        {data.me.shared && !!data.users.length && <p className="form-note">You are using the shared password. Sign in with your own staff email and password next time.</p>}
        {!data.users.length && <p>No staff accounts yet.</p>}
        {data.users.map(user => <div className="give-fund-row" key={user.id}>
          <div className="give-fund-row-main"><strong>{user.name}{user.you ? ' (you)' : ''}</strong><small>{user.email} · {user.role === 'owner' ? 'Owner' : 'Site admin'}</small></div>
          {data.canManage && <button className="ghost" disabled={busy || user.you} onClick={() => remove(user)}>Remove</button>}
        </div>)}
      </section>
      {data.canManage && <form className="card give-pad" onSubmit={add}>
        <h3>Add staff</h3>
        <label className="field">Name<input required minLength={2} maxLength={80} value={f.name} autoComplete="name" onChange={set('name')} /></label>
        <label className="field">Email<input required type="email" maxLength={200} value={f.email} autoComplete="off" onChange={set('email')} /></label>
        <label className="field">Role<select value={f.role} onChange={set('role')} disabled={!data.users.length}><option value="owner">Owner</option><option value="site_admin">Site admin</option></select></label>
        <label className="field">Temporary password <small>10 or more characters</small><input required type="password" minLength={10} maxLength={200} value={f.password} autoComplete="new-password" onChange={set('password')} /></label>
        <p className="form-note">Share the temporary password privately. Staff can change their own password below.</p>
        <button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Add staff'}</button>
      </form>}
      {(!data.me.shared || (!demo && !data.users.length)) && <AccountPassword slug={slug} />}
    </>}
  </div>;
}

function AccountPassword({ slug }) {
  const [pw, setPw] = useState({ current: '', next: '' }), [msg, setMsg] = useState(''), [err, setErr] = useState('');
  async function changePassword(e) {
    e.preventDefault(); setMsg(''); setErr('');
    try {
      const res = await rotateStaffToken(slug, () => staffApi(slug, '/password', { method: 'POST', body: JSON.stringify(pw) }));
      // Signed out while the change was in flight: don't leave the new session behind.
      if (!res.installed) return revokeStaffToken(slug, res.token);
      setPw({ current: '', next: '' });
      setMsg('Password changed. Your other sessions were signed out.');
    } catch (e2) { setErr(friendly(e2)); }
  }
  return <section className="card give-pad">
    <h3>Your password</h3>
    <form onSubmit={changePassword} className="give-password">
      <div className="form-row">
        <label className="field">Current password<input type="password" autoComplete="current-password" value={pw.current} onChange={e => setPw({ ...pw, current: e.target.value })} /></label>
        <label className="field">New password<input type="password" autoComplete="new-password" value={pw.next} onChange={e => setPw({ ...pw, next: e.target.value })} /></label>
      </div>
      <button className="secondary" disabled={!pw.current || pw.next.length < 10}>Change password</button>
    </form>
    {msg && <p className="form-note" role="status">{msg}</p>}
    {err && <div className="banner error" role="alert">{err}</div>}
  </section>;
}
