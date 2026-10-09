"""Documentation of how the *.json fixtures next to this file were made. NOT run by the test suite.

It runs the real gallery-dl 1.32.16 Patreon and Pixiv extractors (sdist from PyPI, sha256
bacd7d63423ad45db98704fedafa1302343db6f250f9e9f69a9e142754ed9e37) with the HTTP layer replaced by synthetic
responses (requests.Session.request), so the printed `--dump-json` output has the shape the real code produces
for the given data. The data itself is made up (own test creator, example CDN URLs); no request left the machine.
Python needs `requests`; the paths below (/tmp/gdl/...) were the ones used on the development machine.

    python3 generate-fixtures.py patreon creator   --config-ignore -j --post-range 1-50 -- https://www.patreon.com/c/owntestcreator/posts
    python3 generate-fixtures.py patreon post      --config-ignore -j -- https://www.patreon.com/posts/own-post-1001
    python3 generate-fixtures.py pixiv   user      --config-ignore -c pixiv.conf -j --post-range 1-50 -- https://www.pixiv.net/users/4242/artworks
    python3 generate-fixtures.py pixiv   artwork   --config-ignore -c pixiv.conf -j -- https://www.pixiv.net/artworks/7001

A scenario name selects the data: creator / post / user / artwork give normal output; auth, notfound and ratelimit
make the API answer 403 / 404 / 429 so the error entry or the log lines can be captured. The Pixiv scenarios read
the refresh token from the configuration file given with -c and write what the token request received to the file
named by the environment variable KURA_FIXTURE_REQUEST_LOG (it contains the made-up token only).
"""
import json
import os
import sys

sys.path.insert(0, '/tmp/gdl/site')
sys.path.insert(0, '/tmp/gdl/gallery_dl-1.32.16')
sys.dont_write_bytecode = True

import requests
from requests.structures import CaseInsensitiveDict
from gallery_dl import main

platform = sys.argv.pop(1)
scenario = sys.argv.pop(1)
REQUEST_LOG = os.environ.get('KURA_FIXTURE_REQUEST_LOG')


def respond(status, body=b'', headers=None, url='', reason=None):
    response = requests.Response()
    response.status_code = status
    response.reason = reason or {200: 'OK', 302: 'Found', 403: 'Forbidden', 404: 'Not Found', 429: 'Too Many Requests', 503: 'Service Unavailable'}.get(status, 'Unknown')
    response._content = body if isinstance(body, bytes) else json.dumps(body).encode()
    response.headers = CaseInsensitiveDict(headers or {})
    response.url = url
    response.encoding = 'utf-8'
    return response


def log_request(method, url, kwargs):
    if REQUEST_LOG:
        with open(REQUEST_LOG, 'a') as handle:
            handle.write(json.dumps({'method': method, 'url': url, 'data': kwargs.get('data')}) + '\n')


# --- Patreon ---------------------------------------------------------------------------------------------------
CDN = 'https://c10.patreonusercontent.com/4/patreon-media/p/post'
MD5 = lambda n: f'{n:032x}'  # 32 hex characters, the shape gallery-dl's _filehash() looks for


def patreon_post(post_id, title, published, **attributes):
    base = {
        'title': title, 'published_at': published, 'content': '', 'current_user_can_view': True, 'post_type': 'text_only',
        'post_file': None, 'embed': None, 'image': None, 'url': f'https://www.patreon.com/posts/{post_id}',
        'patreon_url': f'/posts/{post_id}', 'teaser_text': None, 'content_json_string': None
    }
    base.update(attributes)
    return {'id': str(post_id), 'type': 'post', 'attributes': base, 'relationships': {
        'user': {'data': {'id': '55', 'type': 'user'}, 'links': {'related': 'https://www.patreon.com/api/user/55'}},
        'campaign': {'data': {'id': '4242', 'type': 'campaign'}},
        'images': {'data': []}, 'attachments': {'data': []}, 'attachments_media': {'data': []},
        'user_defined_tags': {'data': []}
    }}


def with_media(post, key, ids):
    post['relationships'][key] = {'data': [{'id': i, 'type': 'media' if key != 'attachments' else 'attachment'} for i in ids]}
    return post


P_IMAGES = with_media(patreon_post(1001, 'Sketches and a bonus file', '2026-03-03T10:00:00.000+00:00', post_type='image_file',
                                   post_file={'url': f'{CDN}/1001/{MD5(1)}/cover.jpg?token-time=1', 'name': 'cover.jpg'},
                                   content=f'<p>Own post</p><figure><img src="{CDN}/1001/{MD5(5)}/inline.png?x=1" media_id="9005"></figure>'), 'images', ['9001', '9002'])
P_IMAGES['relationships']['attachments'] = {'data': [{'id': 'a1', 'type': 'attachment'}]}
P_EMBED = patreon_post(1002, 'A video hosted elsewhere', '2026-03-02T10:00:00.000+00:00', post_type='video_embed',
                       embed={'provider': 'YouTube', 'provider_url': 'https://www.youtube.com', 'subject': 'Own video', 'url': 'https://www.youtube.com/watch?v=OWNVIDEO001', 'description': ''})
P_LOCKED = patreon_post(1003, 'Members only', '2026-03-01T10:00:00.000+00:00', post_type='image_file', current_user_can_view=False,
                        post_file={'url': f'{CDN}/1003/{MD5(3)}/locked.jpg?token-time=1', 'name': 'locked.jpg'})
P_STREAM = patreon_post(1004, 'A hosted video', '2026-02-28T10:00:00.000+00:00', post_type='video_external_file',
                        post_file={'url': 'https://stream.mux.com/OWNPLAYBACKID.m3u8?token=x', 'name': None})
P_OLD = with_media(patreon_post(1005, 'An older picture', '2026-02-20T10:00:00.000+00:00', post_type='image_file'), 'images', ['9003'])
INCLUDED = [
    {'id': '55', 'type': 'user', 'attributes': {'full_name': 'Own Test Creator', 'image_url': 'https://example.test/a.png', 'url': 'https://www.patreon.com/owntestcreator'}},
    {'id': '4242', 'type': 'campaign', 'attributes': {'name': 'Own Test Creator', 'url': 'https://www.patreon.com/owntestcreator'}},
    {'id': '9001', 'type': 'media', 'attributes': {'download_url': f'{CDN}/1001/{MD5(11)}/page-1.jpg?a=1&p=1', 'file_name': 'page-1.jpg', 'image_urls': {}, 'metadata': {}}},
    {'id': '9002', 'type': 'media', 'attributes': {'download_url': f'{CDN}/1001/{MD5(12)}/page-2.png?a=1&p=1', 'file_name': 'page-2.png', 'image_urls': {}, 'metadata': {}}},
    {'id': '9003', 'type': 'media', 'attributes': {'download_url': f'{CDN}/1005/{MD5(13)}/old.jpg?a=1&p=1', 'file_name': 'old.jpg', 'image_urls': {}, 'metadata': {}}},
    {'id': 'a1', 'type': 'attachment', 'attributes': {'name': 'bonus-files.zip', 'url': 'https://www.patreon.com/file?h=1001&i=1'}},
]
PAGE_ONE = [P_IMAGES, P_EMBED, P_LOCKED]
PAGE_TWO = [P_STREAM, P_OLD]


def patreon_request(self, method, url, **kwargs):
    log_request(method, url, kwargs)
    url = url.replace('/api//', '/api/')  # gallery-dl itself builds 'api/' + '/posts/ID' for a single post
    if scenario == 'auth' and '/api/' in url and '/api/user/' not in url:
        return respond(403, {'errors': [{'code_name': 'ForbiddenError'}]}, url=url)
    if scenario == 'ratelimit' and '/api/' in url and '/api/user/' not in url:
        return respond(429, {}, url=url)
    if scenario == 'notfound':
        return respond(404, {}, url=url)
    if url.startswith('https://www.patreon.com/api/user/'):
        return respond(200, {'data': {'id': '55', 'attributes': {'full_name': 'Own Test Creator', 'created': '2020-01-01T00:00:00.000+00:00', 'url': 'https://www.patreon.com/owntestcreator'}}}, url=url)
    if url.startswith('https://www.patreon.com/file?'):
        return respond(302, b'', {'location': f'https://c10.patreonusercontent.com/4/patreon-media/p/post/1001/{MD5(21)}/bonus-files.zip?token=x'}, url=url)
    if url.startswith(CDN):
        return respond(200, b'', {'content-disposition': 'attachment; filename="inline-picture.png"'}, url=url)
    if url.startswith('https://www.patreon.com/api/posts/'):
        post = {'1001': P_IMAGES, '1002': P_EMBED, '1003': P_LOCKED, '1004': P_STREAM, '1005': P_OLD}.get(url.split('/api/posts/')[1].split('?')[0])
        return respond(200, {'data': post, 'included': INCLUDED}, url=url) if post else respond(404, {}, url=url)
    if url.startswith('https://www.patreon.com/api/posts'):
        if 'page%5Bcursor%5D=NEXT' in url or 'page[cursor]=NEXT' in url:
            return respond(200, {'data': PAGE_TWO, 'included': INCLUDED, 'links': {}}, url=url)
        return respond(200, {'data': PAGE_ONE, 'included': INCLUDED, 'links': {'next': 'https://www.patreon.com/api/posts?page[cursor]=NEXT&sort=-published_at'}}, url=url)
    if url.startswith('https://www.patreon.com/'):
        page = '<script id="__NEXT_DATA__" type="application/json">' + json.dumps({'props': {'pageProps': {'bootstrapEnvelope': {'pageBootstrap': {'campaign': {'data': {'id': '4242'}}}}}}}) + '</script>'
        return respond(200, page.encode(), {'content-type': 'text/html'}, url=url)
    raise AssertionError(f'unexpected request {method} {url}')


# --- Pixiv -----------------------------------------------------------------------------------------------------
IMG = 'https://i.pximg.net/img-original/img/2026/03/01/10/00/00'


def pixiv_user():
    return {'id': 4242, 'name': 'Own Test Artist', 'account': 'owntestartist', 'profile_image_urls': {'medium': 'https://example.test/p_170.png'}, 'is_followed': False}


def pixiv_work(work_id, kind, title, date, pages=1, ugoira=False):
    work = {
        'id': work_id, 'title': title, 'type': kind, 'image_urls': {'square_medium': 'x', 'medium': 'x', 'large': 'x'}, 'caption': 'Own work',
        'restrict': 0, 'user': pixiv_user(), 'tags': [{'name': 'own', 'translated_name': None}], 'tools': [], 'create_date': date,
        'page_count': pages, 'width': 800, 'height': 1200, 'sanity_level': 2, 'x_restrict': 0, 'series': None,
        'meta_single_page': {}, 'meta_pages': [], 'total_view': 1, 'total_bookmarks': 1, 'is_bookmarked': False,
        'visible': True, 'is_muted': False, 'total_comments': 0, 'illust_ai_type': 0, 'illust_book_style': 0
    }
    if pages == 1:
        suffix = '_ugoira0.jpg' if ugoira else '_p0.png'
        work['meta_single_page'] = {'original_image_url': f'{IMG}/{work_id}{suffix}'}
    else:
        work['meta_pages'] = [{'image_urls': {'square_medium': 'x', 'medium': 'x', 'large': 'x', 'original': f'{IMG}/{work_id}_p{n}.png'}} for n in range(pages)]
    return work


WORKS = [
    pixiv_work(7003, 'manga', 'Own manga chapter', '2026-03-03T10:00:00+09:00', pages=3),
    pixiv_work(7002, 'ugoira', 'Own animation', '2026-03-02T10:00:00+09:00', ugoira=True),
    pixiv_work(7001, 'illust', 'Own single illustration', '2026-03-01T10:00:00+09:00'),
]
OLDER = [pixiv_work(7000, 'illust', 'Own older illustration', '2026-02-01T10:00:00+09:00', pages=2)]
FRAMES = [{'file': f'{n:06d}.jpg', 'delay': 70 if n % 2 == 0 else 100} for n in range(4)]


def pixiv_request(self, method, url, **kwargs):
    log_request(method, url, kwargs)
    # gallery-dl passes the query separately (params=...), the stand-in matches on the whole URL.
    if kwargs.get('params'):
        url = url + '?' + '&'.join(f'{key}={value}' for key, value in kwargs['params'].items())
    if 'oauth.secure.pixiv.net/auth/token' in url:
        if kwargs.get('data', {}).get('refresh_token') == 'FAKE-REVOKED-TOKEN':
            return respond(400, {'error': 'invalid_grant'}, url=url)
        return respond(200, {'response': {'access_token': 'FAKE-ACCESS-TOKEN', 'refresh_token': 'FAKE-NEW-REFRESH', 'user': {'id': '1', 'name': 'me', 'account': 'me'}}}, url=url)
    if scenario == 'ratelimit' and 'app-api.pixiv.net' in url:
        return respond(429, {}, url=url)
    if scenario == 'notfound' and 'app-api.pixiv.net' in url:
        return respond(404, {'error': {'user_message': '', 'message': 'Not Found'}}, url=url)
    if scenario == 'forbidden' and 'app-api.pixiv.net' in url:
        return respond(403, {'error': {'user_message': '', 'message': 'Forbidden'}}, url=url)
    if 'app-api.pixiv.net/v1/user/illusts' in url:
        if 'offset=30' in url:
            return respond(200, {'user': pixiv_user(), 'illusts': OLDER, 'next_url': None}, url=url)
        return respond(200, {'user': pixiv_user(), 'illusts': WORKS, 'next_url': 'https://app-api.pixiv.net/v1/user/illusts?user_id=4242&filter=for_ios&offset=30'}, url=url)
    if 'app-api.pixiv.net/v1/illust/detail' in url:
        work_id = int(url.split('illust_id=')[1].split('&')[0])
        found = next((w for w in WORKS + OLDER if w['id'] == work_id), None)
        return respond(200, {'illust': found}, url=url) if found else respond(404, {'error': {'user_message': '', 'message': 'Not Found'}}, url=url)
    if 'app-api.pixiv.net/v1/ugoira/metadata' in url:
        return respond(200, {'ugoira_metadata': {'zip_urls': {'medium': 'https://i.pximg.net/img-zip-ugoira/img/2026/03/02/10/00/00/7002_ugoira600x600.zip'}, 'frames': FRAMES}}, url=url)
    raise AssertionError(f'unexpected request {method} {url}')


requests.Session.request = patreon_request if platform == 'patreon' else pixiv_request
sys.argv = ['gallery-dl'] + sys.argv[1:]
sys.exit(main())
