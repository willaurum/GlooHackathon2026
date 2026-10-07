// What counts as an email address or a phone number in any form on the site. The church API
// (backend/app/contact.py) and the giving API (api-giving/index.ts) check the same shapes.

// name@domain.tld: no spaces, one @, and a domain with a dot and a 2+ character ending.
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@.]{2,}$/;
// Digits with the usual + ( ) - . and spaces: at least 10 (a US number with its area code) and at most
// 15 (the international maximum, ITU E.164), so +44 20 7946 0958 works and a 9-digit number does not.
const PHONE_CHARS = /^\+?[\d\s().-]+$/;
export const PHONE_MIN_DIGITS = 10, PHONE_MAX_DIGITS = 15;

export const isEmail = value => EMAIL.test(String(value ?? '').trim());

export function isPhone(value) {
  const text = String(value ?? '').trim();
  const digits = text.replace(/\D/g, '').length;
  return PHONE_CHARS.test(text) && digits >= PHONE_MIN_DIGITS && digits <= PHONE_MAX_DIGITS;
}

export const isEmailOrPhone = value => isEmail(value) || isPhone(value);

export const EMAIL_HINT = 'Enter an email like name@example.com.';
export const PHONE_HINT = 'Enter a phone number with at least 10 digits, like (555) 010-0140 or +44 20 7946 0958.';
export const EMAIL_OR_PHONE_HINT = 'Enter an email like name@example.com or a phone number with at least 10 digits, like (555) 010-0140.';
