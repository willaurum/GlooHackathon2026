"""What counts as an email address or a phone number. The frontend (frontend/src/contact.js) and the
giving API (api-giving/index.ts) check the same shapes."""

import re

# name@domain.tld: no spaces, one @, and a domain with a dot and a 2+ character ending.
EMAIL = re.compile(r'^[^\s@]+@[^\s@]+\.[^\s@.]{2,}$')
# Digits with the usual + ( ) - . and spaces: at least 10 (a US number with its area code) and at most
# 15 (the international maximum, ITU E.164), so +44 20 7946 0958 works and a 9-digit number does not.
PHONE_CHARS = re.compile(r'^\+?[\d\s().-]+$')
PHONE_MIN_DIGITS, PHONE_MAX_DIGITS = 10, 15

EMAIL_HINT = 'Enter an email like name@example.com.'
PHONE_HINT = 'Enter a phone number with at least 10 digits, like (555) 010-0140 or +44 20 7946 0958.'
EMAIL_OR_PHONE_HINT = 'Enter an email like name@example.com or a phone number with at least 10 digits, like (555) 010-0140.'


def is_email(value):
    return bool(EMAIL.match(str(value or '').strip()))


def is_phone(value):
    text = str(value or '').strip()
    digits = sum(c.isdigit() for c in text)
    return bool(PHONE_CHARS.match(text)) and PHONE_MIN_DIGITS <= digits <= PHONE_MAX_DIGITS


def is_email_or_phone(value):
    return is_email(value) or is_phone(value)
