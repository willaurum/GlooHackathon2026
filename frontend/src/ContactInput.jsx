import { useEffect, useRef } from 'react';
import { EMAIL_HINT, EMAIL_OR_PHONE_HINT, PHONE_HINT, isEmail, isEmailOrPhone, isPhone } from './contact.js';

const KINDS = {
  email: { check: isEmail, hint: EMAIL_HINT, type: 'email', inputMode: 'email' },
  phone: { check: isPhone, hint: PHONE_HINT, type: 'tel', inputMode: 'tel' },
  'email-or-phone': { check: isEmailOrPhone, hint: EMAIL_OR_PHONE_HINT, type: 'text', inputMode: 'email' },
};

/** An email, phone, or email-or-phone input that the browser will not submit until it has that shape
 *  (empty is fine unless `required`). The form shows the browser's own message with our hint. */
export default function ContactInput({ kind, value, ...props }) {
  const ref = useRef(null);
  const { check, hint, type, inputMode } = KINDS[kind];
  useEffect(() => {
    const text = String(value ?? '').trim();
    ref.current?.setCustomValidity(text && !check(text) ? hint : '');
  }, [value, check, hint]);
  return <input ref={ref} type={type} inputMode={inputMode} value={value} title={hint} {...props} />;
}
