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

    def test_change_serve_section_text(self):
        request_text = 'Can you please change the serve section to say "serve with your community" instead of the current sub-text'
        ops = visual_editor._custom_rule_ops(request_text, self.sample_content)
        self.assertIsNotNone(ops)
        self.assertEqual(len(ops), 1)
        self.assertEqual(ops[0]['op'], 'set_section_text')
        self.assertEqual(ops[0]['section'], 'serve')
        self.assertEqual(ops[0]['text'], 'serve with your community')

        # Apply special op
        desc = visual_editor._apply_special_op(self.sample_content, ops[0])
        self.assertIn('serve with your community', desc)
        self.assertEqual(
            self.sample_content['site']['feature_text']['serve'],
            'serve with your community',
        )

    def test_builder_haiku_model_resolution(self):
        import unittest.mock as mock
        # When Gloo endpoint is configured (with default chat model gloo-qwen-3.7-flash)
        with mock.patch.object(
            visual_editor.ai_client,
            'endpoint',
            return_value={
                'provider': 'gloo',
                'model': 'gloo-qwen-3.7-flash',
                'base_url': 'https://platform.ai.gloo.com/ai/v2/guarded',
                'api_key': 'test-gloo-key',
                'extra_body': {'auto_routing': False},
            },
        ):
            provider, model, extra_body, api_key = visual_editor.get_visual_editor_model()
            self.assertEqual(provider, 'gloo')
            # Must resolve to the builder model of Haiku, NOT the chat model of Qwen!
            self.assertEqual(model, 'gloo-anthropic-claude-haiku-4.5')


if __name__ == '__main__':
    unittest.main()

