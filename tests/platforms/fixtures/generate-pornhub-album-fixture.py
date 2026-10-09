"""Documentation of how pornhub-album*.json next to this file were made. NOT run by the test suite.

It runs the real gallery-dl 1.32.16 Pornhub extractor (extractor/pornhub.py, PornhubGalleryExtractor; sdist from PyPI,
sha256 bacd7d63423ad45db98704fedafa1302343db6f250f9e9f69a9e142754ed9e37) with the HTTP layer replaced by synthetic
responses (requests.Session.request), so the printed `--dump-json` output has the shape the real code produces for the
given data. The data is made up (own test user, example CDN host); no request left the machine.

    python3 generate-pornhub-album-fixture.py ok        --config-ignore -j -- https://www.pornhub.com/album/4242
    python3 generate-pornhub-album-fixture.py norights  --config-ignore -j -- https://www.pornhub.com/album/4243
    python3 generate-pornhub-album-fixture.py notfound  --config-ignore -j -- https://www.pornhub.com/album/4244

The scenario `norights` answers the album API without photos (what gallery-dl reports as AuthorizationError), `notfound`
answers the album page with 404. Python needs `requests`; the paths below (/tmp/gdl/...) were the ones used on the
development machine.
"""
import json
import sys

sys.path.insert(0, '/tmp/gdl/site')
sys.path.insert(0, '/tmp/gdl/gallery_dl-1.32.16')
sys.dont_write_bytecode = True

import requests  # noqa: E402
from requests.structures import CaseInsensitiveDict  # noqa: E402
from gallery_dl import main  # noqa: E402

scenario = sys.argv.pop(1)


def respond(status, body=b'', url=''):
    response = requests.Response()
    response.status_code = status
    response.reason = {200: 'OK', 404: 'Not Found'}.get(status, 'Unknown')
    response._content = body if isinstance(body, bytes) else (body.encode() if isinstance(body, str) else json.dumps(body).encode())
    response.headers = CaseInsensitiveDict({})
    response.url = url
    response.encoding = 'utf-8'
    return response


PAGE = '''<html><head><title>Own test album - owntestuser's Photos | Pornhub.com</title></head><body>
<div data-token="FAKE-TOKEN-1"></div>
<div id="albumGreenBar" style="width:96%"></div>
<div id="viewsPhotAlbumCounter">1,234 views</div>
<div id="photoTagsBox"><span>tags</span><span>own</span><span>test</span></div><script></script>
<a href="/photo/111" class="x">first</a>
</body></html>'''
CDN = 'https://ei.phncdn.example.invalid/photos/own/'
PHOTOS = {
    '111': {'img_large': CDN + '111_large.jpg', 'caption': 'one', 'id': '111', 'times_viewed': '10', 'vote_percent': '90', 'next': '222'},
    '222': {'img_large': CDN + '222_large.jpg', 'caption': 'two', 'id': '222', 'times_viewed': '20', 'vote_percent': '91', 'next': '333'},
    '333': {'img_large': CDN + '333_large.png', 'caption': 'three', 'id': '333', 'times_viewed': '30', 'vote_percent': '92', 'next': '111'},
}


def request(self, method, url, **kwargs):
    if '/api/v1/album/' in url and url.endswith('/show_album_json'):
        return respond(200, {'photos': PHOTOS if scenario != 'norights' else {}}, url=url)
    if '/album/' in url:
        return respond(404, b'not found', url=url) if scenario == 'notfound' else respond(200, PAGE, url=url)
    raise AssertionError(f'unexpected request {method} {url}')


requests.Session.request = request
sys.argv = ['gallery-dl'] + sys.argv[1:]
sys.exit(main())
