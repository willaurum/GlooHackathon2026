"""JSON-to-site flow, without extraction, AI or Cloudflare."""
import json
import os
import secrets
import shutil
import subprocess
import queue
import threading
import unittest
from pathlib import Path
from unittest import mock

import httpx
from fastapi.testclient import TestClient

from backend.app import builder, builder_export, church_content, main
from backend.tests.test_churches import ChurchTestCase

ROOT = Path(__file__).resolve().parents[2]
FILES = {'church.json': {'info': {'name': 'Meadow Lantern Chapel', 'address': '123 Lantern Lane (fictional)',
          'phone': '555-0101', 'email': 'office@lantern.example', 'services': [{'day': 'Sunday', 'time': '10:00 AM'}]},
          'faqs': [{'question': 'Where?', 'answer': 'Meadow Hall.'}], 'events': [{'name': 'Welcome lunch'}],
          'groups': [{'name': 'Lantern group'}]},
         'ministries.json': {'ministries': [{'name': 'Welcome team', 'head': 'Alex Example', 'shifts': [{'date': '2026-10-11', 'start_time': '09:00', 'end_time': '11:00', 'total': 3}]}]},
         'events.json': {'calendar': [{'title': 'Community lunch', 'date': '2026-10-11', 'time': '12:00'}]},
         'regions.json': {'regions': [{'country': 'Canada', 'country_code': 'CAN', 'codename': 'Lantern Team'}]},
         'builder.json': {'site': {'theme': {'primary': '#446644'}, 'layout': {'home': ['service_times', 'sermons']},
          'assets': [{'url': 'https://lantern.example/photo.jpg', 'rights': True}, {'url': 'https://lantern.example/held.jpg', 'rights': False}]}, 'staff': [{'name': 'Alex Example', 'role': 'Pastor'}],
          'locations': [{'name': 'Meadow Hall', 'address': '123 Lantern Lane (fictional)'}],
          'sermons': [{'title': 'A welcoming place', 'url': 'https://lantern.example/message'}],
          'pages': [{'slug': 'welcome', 'title': 'Welcome', 'sections': [{'heading': 'Hello', 'text': 'Welcome to our church.'}]}]}}


class JsonImportTests(ChurchTestCase):
    def setUp(self):
        super().setUp()
        builder.import_limiter.reset()
        self.addCleanup(builder.import_limiter.reset)
        self.client = TestClient(main.app)
        self.addCleanup(self.client.close)

    def test_json_is_preserved_across_reload_preview_export_and_apply(self):
        content = builder_export.load(FILES)
        with mock.patch.object(builder, 'build_content', side_effect=AssertionError('Extraction called')):
            response = self.client.post('/api/builder/drafts/json', json=FILES)
            self.assertEqual(response.status_code, 201, response.text)
            draft = response.json()
            self.assertEqual(draft['status'], 'review')
            self.assertEqual(draft['questions'], [])
            self.assertNotIn('json_content', draft)
            path = '/api/builder/drafts/' + draft['id']
            self.assertEqual(self.client.get(path).json()['import_kind'], 'json')
            self.assertEqual(self.client.post(path + '/preview').json()['content'], content)
            self.assertEqual(self.client.get(path + '/site').json(), church_content.public_site(content))
            self.assertEqual(builder_export.load(self.client.get(path + '/files').json()['files']), content)
            response = self.client.post(path + '/apply', headers={'X-Church': 'json-chapel'})
            self.assertEqual(response.status_code, 200, response.text)
            for route, expected in [('info', content['info']), ('church', church_content.public_church(content)),
                                    ('ministries', church_content.public_ministries(content)), ('events', church_content.public_events(content))]:
                self.assertEqual(self.client.get('/api/' + route, headers={'X-Church': 'json-chapel'}).json(), expected)
            page = self.client.get('/api/church/pages/welcome', headers={'X-Church': 'json-chapel'})
            self.assertEqual(page.status_code, 200, page.text)
            self.assertEqual(page.json()['sections'], content['pages'][0]['sections'])
            self.assertEqual(self.client.get(path).status_code, 404)

    def test_versioned_church_and_site_files_from_pr_102(self):
        content = builder_export.load(FILES)
        header = {'schema_version': '1.0', 'generated_by': 'tekton', 'generated_at': '', 'source_url': ''}
        evidence = {'info': {'name': [{'title': 'Home', 'url': 'https://lantern.example/',
                    'quote': 'Meadow Lantern Chapel', 'prefix': '', 'suffix': ''}]}, 'items': {}}
        files = {'church.json': {**header, 'kind': 'church', 'sources': evidence,
                 **{key: value for key, value in content.items() if key in builder_export.CHURCH_FIELDS}},
                 'site.json': {**header, 'kind': 'site', 'site': content['site'], 'pages': content['pages'],
                 'calendars': [{'id': 'c1', 'provider': 'ical', 'feed_url': 'https://lantern.example/events.ics', 'status': 'found'}]}}
        response = self.client.post('/api/builder/drafts/json', json=files)
        self.assertEqual(response.status_code, 201, response.text)
        path = '/api/builder/drafts/' + response.json()['id']
        self.assertEqual(self.client.post(path + '/preview').json()['content'], {k: v for k, v in content.items() if k != 'regions'})
        self.assertEqual(self.client.get(path + '/site').json()['provenance'], evidence)
        exported = self.client.get(path + '/files').json()['files']
        self.assertEqual(exported['church.json']['sources'], evidence)
        self.assertEqual(exported['site.json']['calendars'][0]['feed_url'], 'https://lantern.example/events.ics')
        self.assertEqual(exported['site.json']['calendars'][0]['status'], 'found')
        self.assertEqual(builder_export.load(exported), {k: v for k, v in content.items() if k != 'regions'})
        updated = self.client.post(path + '/answers', json={'field': 'name', 'value': 'New Lantern Chapel'})
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(self.client.get(path + '/site').json()['provenance']['info']['name'][0]['title'], 'You confirmed this')
        for bad in ({**files, 'site.json': {**files['site.json'], 'schema_version': '2.0'}},
                    {**files, 'site.json': {**files['site.json'], 'calendars': [{'id': 'c1', 'provider': 'ical', 'count': -1}]}},
                    {**files, 'church.json': {**files['church.json'], 'kind': 'site'}},
                    {**files, 'church.json': {**files['church.json'], 'sources': {'info': {'name': 1}}}},
                    {**files, 'ministries.json': {'ministries': []}}):
            self.assertEqual(self.client.post('/api/builder/drafts/json', json=bad).status_code, 400)

    def test_minimal_church_and_name_change(self):
        response = self.client.post('/api/builder/drafts/json', json={'church.json': {'info': {'name': 'Meadow Chapel'}}})
        self.assertEqual(response.status_code, 201, response.text)
        path = '/api/builder/drafts/' + response.json()['id']
        updated = self.client.post(path + '/answers', json={'field': 'name', 'value': 'Lantern Chapel'})
        self.assertEqual(updated.status_code, 200, updated.text)
        content = self.client.post(path + '/preview').json()['content']
        self.assertEqual(content['info']['name'], 'Lantern Chapel')
        site = self.client.get(path + '/site').json()
        for key in ('staff', 'locations', 'sermons'):
            self.assertEqual(site['church'][key], [])
        self.assertEqual(site['events'], [])
        for route, body in [('items', {'collection': 'staff', 'value': {'name': 'Alex'}}),
                            ('parts', {'part': 'pages'}), ('beliefs', {'confirmed': True}),
                            ('edits', {'request': 'Hide sermons'}), ('edits/undo', None),
                            ('answers', {'field': 'address', 'value': 'Other place'})]:
            self.assertEqual(self.client.post(path + '/' + route, json=body).status_code, 409)
        self.assertEqual(self.client.post(path + '/apply').status_code, 403)
        self.assertEqual(self.client.get(path).status_code, 200)

    def test_bad_json_unknown_sections_missing_info_and_size_limit(self):
        for body in ([], None, {}, {'church.json': {}}, {'unknown.json': {}},
                     {'church.json': {'info': {'name': ''}}}, {'builder.json': {'pages': []}},
                     {'church.json': {'info': {'name': 'Chapel'}}, 'events.json': {'calendar': [{'title': 'Lunch', 'date': 'bad'}]}}):
            with self.subTest(body=body):
                response = self.client.post('/api/builder/drafts/json', content=json.dumps(body), headers={'Content-Type': 'application/json'})
                self.assertEqual(response.status_code, 400, response.text)
        for value in ('NaN', 'Infinity', '-Infinity', '1e400'):
            response = self.client.post('/api/builder/drafts/json', content='{"church.json":{"info":{"name":"Chapel","extra":' + value + '}}}', headers={'Content-Type': 'application/json'})
            self.assertEqual(response.status_code, 400, response.text)
        for data in (b'{broken', b'\xff', b' ' * (builder.MAX_JSON_BYTES + 1)):
            self.assertEqual(self.client.post('/api/builder/drafts/json', content=data, headers={'Content-Type': 'application/json'}).status_code, 400)
        self.assertEqual(self.client.post('/api/builder/drafts/json', content='{}').status_code, 400)
        self.assertEqual(builder.import_limiter.running, 0)

    def test_import_limits_apply_to_json(self):
        with mock.patch.object(builder, 'IMPORTS_PER_ADDRESS', 1):
            self.assertEqual(self.client.post('/api/builder/drafts/json', json=FILES).status_code, 201)
            self.assertEqual(self.client.post('/api/builder/drafts/json', json=FILES).status_code, 429)

    def test_create_owner_with_local_giving_adapter_then_apply(self):
        node = shutil.which('node')
        if not node or not (ROOT / 'api-giving' / 'node_modules').is_dir():
            self.skipTest('Integration requires Node 24 and api-giving dependencies')
        invite = secrets.token_urlsafe(24)
        process = subprocess.Popen([node, 'test/local-worker.mjs'], cwd=ROOT / 'api-giving',
                                   env={**os.environ, 'TEKTON_INVITE_CODES': invite, 'LOCAL_TEST_PORT': '0'}, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.addCleanup(process.stdout.close)
        self.addCleanup(lambda: process.wait(timeout=5))
        self.addCleanup(process.terminate)
        ready = queue.Queue()
        threading.Thread(target=lambda: ready.put(process.stdout.readline()), daemon=True).start()
        try:
            line = ready.get(timeout=10).decode().strip()
        except queue.Empty:
            self.fail('Local giving adapter did not become ready')
        self.assertTrue(line.startswith('Direct SQLite adapter ready on '), 'Local giving adapter failed to start')
        origin = 'http://127.0.0.1:' + line.rsplit(' ', 1)[1]
        account = {'name': 'Meadow Lantern Chapel', 'city': 'Meadowville (fictional)', 'ownerName': 'Alex Example',
                   'ownerEmail': 'alex@lantern.example', 'password': secrets.token_urlsafe(24)}
        self.assertEqual(httpx.post(origin + '/api/churches', json=account).status_code, 403)
        response = httpx.post(origin + '/api/churches', json={**account, 'inviteCode': invite})
        self.assertEqual(response.status_code, 201, 'Local church creation failed')
        church = response.json()
        self.assertTrue(church['token'])
        session = httpx.get(origin + '/api/churches/' + church['slug'] + '/admin/session',
                            headers={'Authorization': 'Bearer ' + church['token']})
        self.assertEqual(session.status_code, 200)
        self.assertEqual(session.json()['me']['role'], 'owner')
        self.assertEqual(session.json()['me']['email'], account['ownerEmail'])
        self.assertFalse(session.json()['me']['shared'])
        draft = self.client.post('/api/builder/drafts/json', json=FILES).json()
        # Run the real Worker's registry lookup, access rule and token check before forwarding its headers.
        gate = """
import { access, findChurch, requireStaff, churchHeaders } from './api/churches.ts';
let raw = ''; for await (const chunk of process.stdin) raw += chunk;
const { origin, slug, token } = JSON.parse(raw);
const env = { GIVING: { fetch: (url, init) => fetch(origin + new URL(url).pathname, init) } };
const church = await findChurch(env, slug);
if (!church || church === 'unavailable') throw new Error('Registry lookup failed');
if (access('POST', '/api/builder/drafts/draft/apply', false) !== 'staff') throw new Error('Apply is public');
const request = new Request(origin, { headers: { Authorization: 'Bearer ' + token } });
if (await requireStaff(request, env, slug)) throw new Error('Owner token denied');
const denied = await requireStaff(new Request(origin), env, slug);
if (denied?.status !== 401) throw new Error('Unauthenticated apply allowed');
console.log(JSON.stringify(Object.fromEntries(churchHeaders(request.headers, church))));
"""
        checked = subprocess.run([node, '--input-type=module', '-e', gate], cwd=ROOT,
                                 input=json.dumps({'origin': origin, 'slug': church['slug'], 'token': church['token']}),
                                 capture_output=True, text=True, timeout=10)
        self.assertEqual(checked.returncode, 0, checked.stderr)
        headers = json.loads(checked.stdout)
        self.assertEqual(headers['x-church'], church['slug'])
        applied = self.client.post('/api/builder/drafts/' + draft['id'] + '/apply', headers=headers)
        self.assertEqual(applied.status_code, 200, applied.text)
        site = self.client.get('/api/church', headers={'X-Church': church['slug']}).json()
        self.assertEqual(site['staff'][0]['name'], 'Alex Example')
        self.assertEqual(site['locations'][0]['name'], 'Meadow Hall')
        self.assertEqual(site['sermons'][0]['title'], 'A welcoming place')
        self.assertEqual(self.client.get('/api/church/pages/welcome', headers={'X-Church': church['slug']}).status_code, 200)
