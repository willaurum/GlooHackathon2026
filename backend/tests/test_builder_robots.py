"""robots.txt (RFC 9309) and Crawl-delay: what the builder may fetch, and how fast."""
import os
import unittest
from unittest import mock

from backend.app import builder, builder_crawl
from backend.app.builder_crawl import HostPolicy, Robots, robots_from

SITE = 'https://church.test'


class RobotsRuleTests(unittest.TestCase):
    def test_wildcards_end_anchors_and_longest_match(self):
        robots = Robots('User-agent: *\nDisallow: /assets/*\nDisallow: /data/\nAllow: /data/public$\n'
                        'Disallow: /*.pdf$\nDisallow: /private\nAllow: /private/open\n')
        for path, allowed in [('/assets/img/a.jpg', False), ('/assets', True), ('/data/x', False),
                              ('/data/public', True), ('/data/public/more', False), ('/files/bulletin.pdf', False),
                              ('/files/bulletin.pdf?v=2', True), ('/private/x', False), ('/private/open/page', True),
                              ('/about', True), ('/robots.txt', True)]:
            with self.subTest(path=path):
                self.assertEqual(robots.allowed(SITE + path), allowed)

    def test_allow_wins_a_tie_and_percent_encoding_matches(self):
        robots = Robots('User-agent: *\nDisallow: /page\nAllow: /page\nDisallow: /caf%C3%A9\n')
        self.assertTrue(robots.allowed(SITE + '/page'))
        self.assertFalse(robots.allowed(SITE + '/café'))
        self.assertFalse(robots.allowed(SITE + '/caf%C3%A9/menu'))

    def test_our_group_replaces_the_star_group(self):
        text = ('User-agent: OtherBot\nDisallow: /\n\nUser-agent: *\nDisallow: /\n\n'
                'User-agent: TektonBuilder\nUser-agent: SomethingElse\nDisallow: /members\nCrawl-delay: 1.5\n')
        robots = Robots(text)
        self.assertTrue(robots.allowed(SITE + '/about'))
        self.assertFalse(robots.allowed(SITE + '/members/list'))
        self.assertEqual(robots.crawl_delay(), 1.5)
        self.assertFalse(Robots('User-agent: OtherBot\nDisallow: /\nUser-agent: *\nDisallow: /\n').allowed(SITE + '/'))

    def test_crawl_delay_is_capped_and_bad_values_ignored(self):
        self.assertEqual(Robots('User-agent: *\nCrawl-delay: 600\n').crawl_delay(), builder_crawl.MAX_CRAWL_DELAY)
        self.assertEqual(Robots('User-agent: *\nCrawl-delay: soon\n').crawl_delay(), 0.0)
        self.assertEqual(Robots('User-agent: *\nCrawl-delay: 2\n').crawl_delay(), 2.0)

    def test_sitemaps_and_comments(self):
        robots = Robots('# hi\nSitemap: https://church.test/sitemap.xml\nUser-agent: * # all\nDisallow: /x # no\n')
        self.assertEqual(robots.sitemaps, ['https://church.test/sitemap.xml'])
        self.assertFalse(robots.allowed(SITE + '/x'))

    def test_fetch_results(self):
        ok = robots_from(('ok', (SITE + '/robots.txt', 'text/plain', 'User-agent: *\nDisallow: /a\n')))
        self.assertFalse(ok.allowed(SITE + '/a'))
        self.assertTrue(robots_from(('ok', (SITE + '/robots.txt', 'text/html', '<p>Disallow: /</p>'))).allowed(SITE + '/'))
        for error in (FileNotFoundError(), ValueError('That page answered 404.'), ValueError('That page answered 403.'),
                      ValueError('not a feed')):
            with self.subTest(error=error):
                self.assertTrue(robots_from(('error', error)).allowed(SITE + '/'))
        for result in (('error', ValueError('That page answered 503.')), ('error', TimeoutError()), None):
            with self.subTest(result=result):
                robots = robots_from(result)
                self.assertTrue(robots.disallow_all)
                self.assertFalse(robots.allowed(SITE + '/'))


class FakeClock:
    def __init__(self):
        self.time, self.sleeps = 1000.0, []

    def now(self):
        return self.time

    def sleep(self, seconds):
        self.sleeps.append(round(seconds, 3))
        self.time += seconds


class HostPolicyTests(unittest.TestCase):
    def policy(self, robots_by_host, clock=None):
        fetched = []

        def fetch_feed(url):
            fetched.append(url)
            host = builder_crawl.urlparse(url).netloc
            if host not in robots_by_host:
                raise FileNotFoundError(url)
            return url, 'text/plain', robots_by_host[host]
        clock = clock or FakeClock()
        run = lambda urls, f: builder._fetch_each(urls, f, builder._now() + 5, 1)
        return HostPolicy(fetch_feed, run, now=clock.now, sleep=clock.sleep), fetched, clock

    def test_robots_is_read_once_per_host(self):
        policy, fetched, _ = self.policy({'church.test': 'User-agent: *\nDisallow: /x\n'})
        self.assertFalse(policy.allowed(SITE + '/x'))
        self.assertTrue(policy.allowed(SITE + '/y'))
        self.assertTrue(policy.allowed('https://cdn.test/img.png'))
        self.assertEqual(fetched, [SITE + '/robots.txt', 'https://cdn.test/robots.txt'])

    def test_crawl_delay_spaces_requests_per_host_and_respects_the_deadline(self):
        policy, _, clock = self.policy({'church.test': 'User-agent: *\nCrawl-delay: 2\n'})
        deadline = clock.time + 5
        self.assertEqual([policy.wait(SITE + f'/{n}', deadline) for n in range(4)], [True, True, True, False])
        self.assertEqual(clock.sleeps, [2.0, 2.0])
        self.assertTrue(policy.wait('https://other.test/', deadline))  # no delay asked there

    def test_without_a_feed_reader_everything_is_allowed(self):
        policy = HostPolicy()
        self.assertTrue(policy.allowed(SITE + '/anything'))
        self.assertTrue(policy.wait(SITE + '/anything', 0))


def html(body, title='Grace Church'):
    return f'<html><head><title>{title}</title></head><body>{body}</body></html>'


class CrawlRobotsTests(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.dict(os.environ, {'BUILDER_ALLOW_PRIVATE': '1'})
        patcher.start()
        self.addCleanup(patcher.stop)

    def site(self, robots, pages, feeds=None):
        fetched = []

        def fetch(url):
            fetched.append(url)
            path = builder_crawl.urlparse(url).path or '/'
            if path not in pages:
                raise FileNotFoundError(url)
            return url, 'text/html', pages[path]

        def fetch_feed(url):
            fetched.append(url)
            if url.endswith('/robots.txt'):
                if isinstance(robots, Exception):
                    raise robots
                if robots is None:
                    raise FileNotFoundError(url)
                return url, 'text/plain', robots
            if feeds and url in feeds:
                return url, 'text/calendar', feeds[url]
            raise FileNotFoundError(url)
        return fetch, fetch_feed, fetched

    def test_an_unreadable_robots_file_stops_the_import(self):
        fetch, fetch_feed, fetched = self.site(ValueError('That page answered 503.'), {'/': html('Hi')})
        with self.assertRaises(ValueError) as caught:
            builder.crawl(SITE + '/', fetch, fetch_feed=fetch_feed)
        self.assertIn('robots.txt could not be read', str(caught.exception))
        self.assertEqual(fetched, [SITE + '/robots.txt'])

    def test_disallowed_pages_and_feeds_are_not_fetched(self):
        pages = {'/': html('<a href="/assets/staff.html">Staff</a><a href="/about">About</a>'
                           '<a href="/cal/events.ics">Calendar</a><a href="/ok.ics">Other</a>'),
                 '/assets/staff.html': html('Pastor'), '/about': html('About us')}
        robots = 'User-agent: *\nDisallow: /assets/*\nDisallow: /cal/\n'
        fetch, fetch_feed, fetched = self.site(robots, pages, {SITE + '/ok.ics': 'BEGIN:VCALENDAR\nEND:VCALENDAR'})
        feeds = []
        sources = builder.crawl(SITE + '/', fetch, fetch_feed=fetch_feed, feeds=feeds)
        self.assertEqual([s['url'] for s in sources], [SITE + '/', SITE + '/about'])
        self.assertNotIn(SITE + '/assets/staff.html', fetched)
        read = builder.read_feeds(feeds, fetch_feed, 3, builder._now() + 5)
        self.assertEqual([s['url'] for s in read], [SITE + '/ok.ics'])
        self.assertNotIn(SITE + '/cal/events.ics', fetched)

    def test_crawl_delay_reads_one_page_at_a_time_and_says_so(self):
        links = ''.join(f'<a href="/p{n}">Page {n}</a>' for n in range(30))
        pages = {'/': html(links), **{f'/p{n}': html(f'Page {n} text') for n in range(30)}}
        fetch, fetch_feed, fetched = self.site('User-agent: *\nCrawl-delay: 2\n', pages)
        clock = FakeClock()
        policy = HostPolicy(fetch_feed, lambda urls, f: builder._fetch_each(urls, f, builder._now() + 5, 1),
                            now=clock.now, sleep=clock.sleep)
        notes = []
        sources = builder.crawl(SITE + '/', fetch, deadline=builder._now() + 20, notes=notes, fetch_feed=fetch_feed,
                                policy=policy, max_pages=40)
        # 20 s at one page per 2 s, minus a fifth kept for sitemaps: at most 8 pages.
        self.assertLessEqual(len(sources), 8)
        self.assertGreater(len(sources), 1)
        self.assertTrue(all(s == 2.0 for s in clock.sleeps))
        self.assertTrue(any('pause 2 seconds' in n for n in notes))

    def test_images_follow_robots(self):
        fetched = []

        def fetch_bytes(url):
            fetched.append(url)
            return 'image/png', b'png'
        policy = HostPolicy(lambda url: (url, 'text/plain', 'User-agent: *\nDisallow: /private/\n'),
                            lambda urls, f: builder._fetch_each(urls, f, builder._now() + 5, 1))
        page = {'id': 's1', 'url': SITE + '/', 'title': 'Home',
                'images': [SITE + '/private/bulletin.png', SITE + '/bulletin.png']}
        builder.read_images([page], fetch_bytes, lambda data, ct: 'Sunday worship at 10am every week.',
                            deadline=builder._now() + 5, policy=policy)
        self.assertEqual(fetched, [SITE + '/bulletin.png'])


if __name__ == '__main__':
    unittest.main()
