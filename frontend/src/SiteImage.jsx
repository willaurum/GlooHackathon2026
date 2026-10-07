import { useState } from 'react';

export default function SiteImage({ asset, className, alt, loading = 'lazy' }) {
  const [failed, setFailed] = useState('');
  if (!asset || failed === asset.url) return null;
  return <img className={className} src={asset.url} alt={alt ?? asset.alt ?? ''} loading={loading}
    referrerPolicy="no-referrer" onError={() => setFailed(asset.url)} />;
}
