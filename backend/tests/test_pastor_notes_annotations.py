"""Sermon highlights: the same claim tagged twice by the model shows once."""

import unittest

from backend.app.pastor_notes import merge_annotations


def tag(seg_from, seg_to, label, category='inerrancy_claim', confidence=0.8):
    return {'seg_from': seg_from, 'seg_to': seg_to, 'category': category, 'label': label, 'confidence': confidence}


class MergeAnnotationsTest(unittest.TestCase):
    def test_touching_duplicates_become_one(self):
        merged = merge_annotations([tag(5, 5, 'the lifeblood out of christianity'),
                                    tag(5, 6, 'The lifeblood out of Christianity ', confidence=0.9)])
        self.assertEqual(merged, [tag(5, 6, 'the lifeblood out of christianity', confidence=0.9)])

    def test_adjacent_segments_merge(self):
        self.assertEqual(merge_annotations([tag(5, 5, 'x'), tag(6, 7, 'x')]), [tag(5, 7, 'x')])

    def test_distinct_passages_stay(self):
        items = [tag(1, 2, 'Luke 10:27', 'bible_quote'), tag(1, 2, 'Luke 10:27', 'bible_paraphrase'),
                 tag(4, 4, 'x'), tag(9, 9, 'x'), tag(4, 4, 'y')]
        merged = merge_annotations(items)
        self.assertEqual(len(merged), 5)
        self.assertEqual([a['seg_from'] for a in merged], [1, 1, 4, 4, 9])


if __name__ == '__main__':
    unittest.main()
