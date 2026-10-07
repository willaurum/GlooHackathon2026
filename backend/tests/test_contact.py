"""The email and phone shapes (frontend/src/contact.test.js checks the same cases)."""

import unittest

from backend.app import contact


class ContactTests(unittest.TestCase):
    def test_emails(self):
        for ok in ('sam@example.com', 'sam.rivera+serve@church.org.uk', ' pat@grace.church '):
            self.assertTrue(contact.is_email(ok), ok)
        for bad in ('', 'sam', 'sam@', '@example.com', 'sam@example', 'sam@example.c', 'sam @example.com',
                    'sam@@example.com', 'sam@example.com.'):
            self.assertFalse(contact.is_email(bad), bad)

    def test_phones_have_10_to_15_digits_so_international_numbers_work(self):
        for ok in ('(555) 010-0140', '555-010-0140', '555.010.0140', '5550100140', '+1 (555) 010-0140', '1-555-010-0140',
                   '+44 20 7946 0958', '+61 2 9374 4000', '+49 30 901820 12345'):
            self.assertTrue(contact.is_phone(ok), ok)
        for bad in ('', '555', '555-0100', '555-010-014', '+44 20 7946', '+1 555 010 0140 0000 00',
                    'call me', '(555) 010-0140 ext 2', 'sam@example.com', '555-O1O-0140'):
            self.assertFalse(contact.is_phone(bad), bad)

    def test_email_or_phone(self):
        self.assertTrue(contact.is_email_or_phone('sam@example.com'))
        self.assertTrue(contact.is_email_or_phone('(555) 010-0140'))
        self.assertFalse(contact.is_email_or_phone('next Sunday'))


if __name__ == '__main__':
    unittest.main()
