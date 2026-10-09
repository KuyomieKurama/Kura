"""Documentation of how the *.json fixtures next to this file were made. NOT run by the test suite.

It runs the real gallery-dl 1.32.16 Instagram extractor (sdist from PyPI, sha256
bacd7d63423ad45db98704fedafa1302343db6f250f9e9f69a9e142754ed9e37) with the API layer replaced by synthetic REST
data, so the printed `--dump-json` output has the shape the real code produces. The post data itself is made up
(own test account, example CDN URLs); no request to Instagram was made. Python needs `requests`; the paths below
(/tmp/gdl/...) were the ones used on the development machine.

    python3 generate-fixtures.py normal --config-ignore -j -o extractor.instagram.videos=merged -- https://www.instagram.com/p/DCarous0001/
    python3 generate-fixtures.py normal ... --post-range 1-50 -- https://www.instagram.com/own_test_account/posts/
    python3 generate-fixtures.py feed-with-extra ... (profile-posts-newer.json: one newer post at the top)
"""
"""Runs the real gallery-dl 1.32.16 Instagram extractor with a patched API layer (synthetic REST data, no network)."""
import sys, json
sys.path.insert(0, '/tmp/gdl/site'); sys.path.insert(0, '/tmp/gdl/gallery_dl-1.32.16')
sys.dont_write_bytecode = True
from gallery_dl import main, exception
from gallery_dl.extractor import instagram as ig

scenario = sys.argv.pop(1)

def user(name='own_test_account'):
    return {'pk': '4242424242', 'id': '4242424242', 'username': name, 'full_name': 'Own Test Account', 'is_private': False}

def img(w=1080, h=1350, tag='a'):
    return {'candidates': [{'url': f'https://scontent.cdninstagram.com/v/t51.2885-15/{tag}_n.jpg?stp=dst-jpg_e35&_nc_ht=scontent.cdninstagram.com&oh=SECRET', 'width': w, 'height': h}]}

def photo(pk, code, tag):
    return {'pk': pk, 'code': code, 'media_type': 1, 'image_versions2': img(tag=tag), 'original_width': 1080, 'original_height': 1350, 'taken_at': 1767225600, 'user': user(), 'caption': {'text': 'Own photo #test'}, 'like_count': 3}

def video_item(pk, code, tag):
    return {'pk': pk, 'code': code, 'media_type': 2, 'image_versions2': img(720, 1280, tag), 'video_versions': [{'url': f'https://scontent.cdninstagram.com/o1/v/t16/{tag}.mp4?efg=SECRET', 'width': 720, 'height': 1280, 'type': 101}], 'original_width': 720, 'original_height': 1280, 'taken_at': 1767225600}

def carousel(pk, code):
    return {'pk': pk, 'code': code, 'media_type': 8, 'taken_at': 1767225600, 'user': user(), 'caption': {'text': 'Own carousel'}, 'like_count': 5,
            'carousel_media': [photo('9001', 'cA', 'c1') | {'user': None}, photo('9002', 'cB', 'c2') | {'user': None}, video_item('9003', 'cC', 'c3')]}

def reel(pk, code):
    r = video_item(pk, code, 'r' + code)
    r.update({'user': user(), 'caption': {'text': 'Own reel'}, 'like_count': 7, 'product_type': 'clips', 'clips_metadata': {'x': 1}, 'taken_at': 1767312000})
    return r

def dated(post, taken_at):
    post['taken_at'] = taken_at
    return post

PINNED = dated(photo('3000000000000000101', 'DPinned0001', 'pin'), 1735689600) | {'timeline_pinned_user_ids': ['4242424242']}
NEWEST = dated(reel('3000000000000000105', 'DNewReel001'), 1767571200)
CAROUSEL_P = dated(carousel('3000000000000000104', 'DCarous0001'), 1767484800)
PHOTO_P = dated(photo('3000000000000000103', 'DPhoto00001', 'ph'), 1767398400)
OLDER = dated(photo('3000000000000000102', 'DOlder00001', 'old'), 1767312000)
EXTRA = dated(photo('3000000000000000106', 'DExtraNew01', 'ext'), 1767657600)
POSTS = {p['code']: p for p in (PINNED, NEWEST, CAROUSEL_P, PHOTO_P, OLDER, EXTRA)}
FEED = [PINNED, NEWEST, CAROUSEL_P, PHOTO_P, OLDER]
if scenario == 'feed-with-extra':
    FEED = [PINNED, EXTRA, NEWEST, CAROUSEL_P, PHOTO_P, OLDER]
    scenario = 'normal'

def media(self, shortcode):
    if shortcode in POSTS:
        return [POSTS[shortcode]]
    raise exception.NotFoundError('post')
ig.InstagramAPI.media = media
ig.InstagramAPI.user = lambda self, handle, check_private=True: self.extractor._assign_user(user(handle))
def feed(self, handle):
    self.user(handle)
    yield from FEED
ig.InstagramAPI.user_feed = feed
def reels(self, handle):
    self.user(handle)
    yield {'media': {'code': 'DNewReel001'}}
ig.InstagramAPI.user_reels = reels

if scenario == 'auth':
    def boom(self, shortcode): raise exception.AuthRequired('cookies', 'post')
    ig.InstagramAPI.media = boom
elif scenario == 'notfound':
    ig.InstagramAPI.media = lambda self, s: (_ for _ in ()).throw(exception.NotFoundError('user'))
elif scenario == 'ratelimit':
    class R:  # minimal response stand-in
        status_code = 429; reason = 'Too Many Requests'; url = 'https://www.instagram.com/api/v1/media/1/info/'
    ig.InstagramAPI.media = lambda self, s: (_ for _ in ()).throw(exception.HttpError('', R()))
elif scenario == 'redirect':
    def red(self, s): raise exception.AbortExtraction('HTTP redirect to login page (https://www.instagram.com/accounts/login/)')
    ig.InstagramAPI.media = red

sys.argv = ['gallery-dl'] + sys.argv[1:]
sys.exit(main())
