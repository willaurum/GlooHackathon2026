import { useState } from 'react';
import { churchAddress } from './church.js';
import { useChurch } from './ChurchContext.js';
import Icon from './Icon.jsx';

// The link staff hand out. Churches cannot find each other on the site, so this link (#/c/<slug>/, or the
// church's subdomain when the build sets VITE_BASE_DOMAIN) is how members and guests reach their church.
export default function ChurchLink() {
  const church = useChurch();
  const [copied, setCopied] = useState(false);
  const link = churchAddress(church.slug);
  function copy() {
    navigator.clipboard?.writeText(link).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }).catch(() => {});
  }
  return <section className="card give-pad church-link">
    <div className="form-title"><span className="icon color1"><Icon name="link" size={22} /></span><div>
      <h2>Share this link with your church.</h2>
      <p>This is how people find {church.name}. Each church has its own link, and churches do not see each other on the site. Put it in your bulletin, on your website or in a text to your members.</p>
    </div></div>
    <div className="give-link"><code>{link}</code><button className="primary" onClick={copy}>{copied ? 'Copied' : 'Copy link'}</button></div>
  </section>;
}
