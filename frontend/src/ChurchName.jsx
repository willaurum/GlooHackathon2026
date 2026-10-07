import { useChurch } from './ChurchContext.js';
import Icon from './Icon.jsx';

// Which church this site is for. Churches do not see each other: a visitor reaches a church by its own
// link (or subdomain), and the remembered church brings them back, so there is no list to switch from.
// Desktop shows it in the header; phones show the compact form in the top bar.
export default function ChurchName({ compact = false }) {
  const church = useChurch();
  const name = church.name || ' ';
  return <div className={'church-name' + (compact ? ' compact' : '')}>
    <div className="church">
      <span aria-hidden="true">{name.trim().charAt(0).toUpperCase() || '·'}</span>
      <div><strong>{name}</strong>{!compact && church.city && <small>{church.city}</small>}
        {!church.missing && <button className="link church-staff" onClick={() => church.go('setup')}>
          {!compact && <Icon name="lock" size={14} />}{church.staff ? 'Church setup' : 'Staff sign in'}
        </button>}
      </div>
    </div>
  </div>;
}
