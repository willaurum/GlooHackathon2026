import unittest
from backend.app import visual_editor, church_content, db


class VisualEditorTests(unittest.TestCase):
    def setUp(self):
        self.sample_content = {
            'info': {
                'name': 'Grace Community Church',
                'city': 'Springfield',
                'address': '123 Main St',
                'tagline': 'A place to belong, grow and give.',
                'about': 'We love our city.',
                'services': [{'day': 'Sunday', 'time': '10:00 AM', 'note': ''}],
            },
            'staff': [
                {'name': 'Pastor Bob', 'role': 'Lead Pastor', 'email': 'bob@grace.org', 'bio': 'Serving since 2015'},
                {'name': 'Sarah Smith', 'role': 'Worship Director', 'email': 'sarah@grace.org', 'bio': ''},
            ],
            'site': {
                'layout': {
                    'home': ['features', 'about', 'ministries', 'service_times', 'leaders'],
                    'hidden': [],
                    'hidden_pages': [],
                },
                'theme': {'primary': '#1f3a5f', 'accent': '#c2571a'},
            },
            'pages': [
                {
                    'slug': 'our-story',
                    'title': 'Our Story',
                    'sections': [{'heading': 'Who We Are', 'level': 2, 'text': 'Our history is rich.', 'links': [], 'embeds': []}],
                }
            ],
        }

    def test_pastor_leave_regex(self):
        ops = visual_editor._custom_rule_ops(
            "we had Pastor Bob leave, can you change the pastor name to Pastor John",
            self.sample_content,
        )
        self.assertIsNotNone(ops)
        self.assertEqual(len(ops), 1)
        self.assertEqual(ops[0]['op'], 'edit_person')
        self.assertEqual(ops[0]['new_name'], 'Pastor John')

    def test_pastor_name_change_regex(self):
        ops = visual_editor._custom_rule_ops(
            "change the pastor name to Pastor David",
            self.sample_content,
        )
        self.assertIsNotNone(ops)
        self.assertEqual(ops[0]['op'], 'edit_person')
        self.assertEqual(ops[0]['new_name'], 'Pastor David')

    def test_change_bottom_section(self):
        ops = visual_editor._custom_rule_ops(
            "change the section at the bottom of the home page to ministries",
            self.sample_content,
        )
        self.assertIsNotNone(ops)
        self.assertEqual(ops[0]['op'], 'move')
        self.assertEqual(ops[0]['section'], 'ministries')
        self.assertEqual(ops[0]['to'], 'bottom')

    def test_header_size_adjust(self):
        ops = visual_editor._custom_rule_ops(
            "hey that header doesn't look the right size",
            self.sample_content,
            viewing='p/our-story',
        )
        self.assertIsNotNone(ops)
        self.assertEqual(ops[0]['op'], 'adjust_header_size')

    def test_apply_pastor_leave(self):
        content = copy_content = dict(self.sample_content)
        ops = visual_editor._custom_rule_ops(
            "we had Pastor Bob leave, can you change the pastor name to Pastor John",
            content,
        )
        for op in ops:
            clean_op, content = visual_editor.builder_customize.check(content, op)
        self.assertEqual(content['staff'][0]['name'], 'Pastor John')


if __name__ == '__main__':
    unittest.main()
