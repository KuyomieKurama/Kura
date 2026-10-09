"""Documentation of how the ytdlp-*.json / ytdlp-*.txt fixtures next to this file were made. NOT run by the test suite.

The real yt-dlp 2026.8.19 (sdist from PyPI, extracted to /tmp/ytdlp/yt_dlp-2026.8.19) is started with the exact
argument lists that Kura builds (see yt-dlp-adapter.ts). Only the network layer is replaced:

  * YouTube: YoutubeTabIE._real_extract / YoutubeIE._real_extract return what the real helper methods
    (YoutubeTabBaseInfoExtractor._extract_video, _extract_metadata_from_tabs, raise_no_formats ...) build from
    synthetic renderer data. Flat entries, playlist keys, format selection (-J of a video) and the error lines
    on stderr are therefore produced by the real yt-dlp code; the YouTube page itself is made up.
  * Pornhub: PornHubBaseIE._download_webpage(_handle) return synthetic HTML; the real list and error extraction
    runs on it (PornHubPagedPlaylistBaseIE._extract_entries, PornHubIE._real_extract).

No request leaves the machine. All data is made up (own test channel, example hosts).

    python3 generate-ytdlp-fixtures.py            # writes every fixture into this directory

Run it from this directory; the path of the yt-dlp sources is YTDLP_SRC (default /tmp/ytdlp/yt_dlp-2026.8.19).
"""
import contextlib
import io
import json
import os
import sys

sys.path.insert(0, os.environ.get('YTDLP_SRC', '/tmp/ytdlp/yt_dlp-2026.8.19'))
sys.dont_write_bytecode = True

import yt_dlp  # noqa: E402
from yt_dlp.extractor.youtube import YoutubeIE, YoutubeTabIE  # noqa: E402
from yt_dlp.extractor.pornhub import PornHubBaseIE, PornHubIE  # noqa: E402
from yt_dlp.utils import ExtractorError  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
CHANNEL_ID = 'UC1234567890abcdefghijkl'


def run(argv):
    """Runs the real command line and returns (exit code, stdout, stderr)."""
    out, err = io.StringIO(), io.StringIO()
    code = 0
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            yt_dlp.main(argv)
        except SystemExit as exit_:
            code = exit_.code or 0
    return code, out.getvalue(), err.getvalue()


def write(name, text):
    with open(os.path.join(HERE, name), 'w', encoding='utf-8') as handle:
        handle.write(text)


# --- YouTube: flat listings -----------------------------------------------------------------------------------

def text(value):
    return {'runs': [{'text': value}]}


def video_renderer(video_id, title, *, length='10:00', ago='2 days ago', live=False, upcoming=None, members=False, short=False):
    renderer = {
        'videoId': video_id,
        'title': text(title),
        'lengthText': {'simpleText': length},
        'publishedTimeText': {'simpleText': ago},
        'viewCountText': {'simpleText': '1,234 views'},
        'ownerText': text('Own Test Channel'),
        'shortBylineText': {'runs': [{
            'text': 'Own Test Channel',
            'navigationEndpoint': {
                'browseEndpoint': {'browseId': CHANNEL_ID, 'canonicalBaseUrl': '/@owntestchannel'},
                'commandMetadata': {'webCommandMetadata': {'url': '/@owntestchannel'}},
            },
        }]},
        'thumbnailOverlays': [],
        'badges': [],
        'ownerBadges': [],
    }
    if live:
        renderer['thumbnailOverlays'].append({'thumbnailOverlayTimeStatusRenderer': {'style': 'LIVE', 'text': text('LIVE')}})
        renderer['badges'].append({'metadataBadgeRenderer': {'style': 'BADGE_STYLE_TYPE_LIVE_NOW', 'label': 'LIVE NOW'}})
    if upcoming:
        renderer['upcomingEventData'] = {'startTime': str(upcoming)}
    if members:
        renderer['badges'].append({'metadataBadgeRenderer': {'style': 'BADGE_STYLE_TYPE_MEMBERS_ONLY', 'label': 'Members only'}})
    if short:
        renderer['navigationEndpoint'] = {'commandMetadata': {'webCommandMetadata': {'url': f'/shorts/{video_id}'}}}
    return renderer


CHANNEL_DATA = {'metadata': {'channelMetadataRenderer': {
    'title': 'Own Test Channel', 'externalId': CHANNEL_ID, 'channelUrl': f'https://www.youtube.com/channel/{CHANNEL_ID}',
    'vanityChannelUrl': 'http://www.youtube.com/@owntestchannel', 'description': 'Own test channel',
}}}
PLAYLIST_DATA = {'metadata': {'playlistMetadataRenderer': {'title': 'Own test playlist', 'description': ''}}}

CHANNEL_VIDEOS = [
    video_renderer('aaaaaaaaaa1', 'Newest upload', length='12:34', ago='1 day ago'),
    video_renderer('aaaaaaaaaa2', 'Live right now', length='', ago='', live=True),
    video_renderer('aaaaaaaaaa3', 'Premiere tomorrow', length='', ago='', upcoming=1900000000),
    video_renderer('aaaaaaaaaa4', 'Members only video', length='5:00', ago='3 days ago', members=True),
    video_renderer('aaaaaaaaaa5', 'Older upload', length='1:02:03', ago='2 years ago'),
    video_renderer('aaaaaaaaaa6', 'Past livestream', length='2:00:00', ago='Streamed 1 month ago'),
]


def fake_tab_extractor(entries_of, metadata_data, item_id):
    def real_extract(self, url, *args, **kwargs):
        entries = [self._extract_video(renderer) for renderer in entries_of]
        metadata = self._extract_metadata_from_tabs(item_id, metadata_data)
        return self.playlist_result(entries, **metadata)
    return real_extract


def flat_listing(name, url, renderers, data, item_id, max_entries=50):
    YoutubeTabIE._real_extract = fake_tab_extractor(renderers, data, item_id)
    argv = [
        '--ignore-config', '--no-update', '--no-cache-dir', '--yes-playlist', '--no-warnings',
        '--flat-playlist', '--dump-single-json', '--playlist-items', f'1:{max_entries}', '--', url,
    ]
    code, out, err = run(argv)
    assert code == 0, (name, err)
    write(name, out)


# --- YouTube: single video, format selection ------------------------------------------------------------------

def fmt(format_id, ext, vcodec, acodec, width=None, height=None, abr=None, tbr=1000):
    item = {
        'format_id': format_id, 'ext': ext, 'vcodec': vcodec, 'acodec': acodec, 'tbr': tbr,
        'url': f'https://rr1.example.invalid/videoplayback?sig=SECRET{format_id}', 'protocol': 'https',
        'format_note': 'made up',
    }
    if width:
        item.update(width=width, height=height, fps=30)
    if abr:
        item['abr'] = abr
    return item


FORMATS_MODERN = [
    fmt('137', 'mp4', 'avc1.640028', 'none', 1920, 1080, tbr=4000),
    fmt('313', 'webm', 'vp09.00.50.08', 'none', 3840, 2160, tbr=12000),
    fmt('140', 'm4a', 'none', 'mp4a.40.2', abr=129, tbr=129),
    fmt('251', 'webm', 'none', 'opus', abr=140, tbr=140),
]
FORMATS_H264_ONLY = [
    fmt('137', 'mp4', 'avc1.640028', 'none', 1920, 1080, tbr=4000),
    fmt('140', 'm4a', 'none', 'mp4a.40.2', abr=129, tbr=129),
]


def video_info(video_id, formats, **extra):
    info = {
        'id': video_id, 'title': 'Own test video', 'formats': formats, 'uploader': 'Own Test Channel',
        'channel': 'Own Test Channel', 'channel_id': CHANNEL_ID, 'uploader_id': '@owntestchannel', 'duration': 42,
        'upload_date': '20260105', 'webpage_url': f'https://www.youtube.com/watch?v={video_id}', 'extractor': 'youtube',
        'extractor_key': 'Youtube',
    }
    info.update(extra)
    return info


def single_video(name, video_id, info):
    YoutubeIE._real_extract = lambda self, url, *args, **kwargs: info
    argv = [
        '--ignore-config', '--no-update', '--no-cache-dir', '--no-playlist', '--no-warnings',
        '-f', 'bestvideo*+bestaudio/best', '--merge-output-format', 'mp4/webm/mkv',
        '--dump-single-json', '--', f'https://www.youtube.com/watch?v={video_id}',
    ]
    code, out, err = run(argv)
    assert code == 0, (name, err)
    write(name, out)


# --- error lines (stderr of the real command line) ------------------------------------------------------------

def failing_video(name, video_id, reason, *, login_hint=False):
    """The same wording steps as YoutubeIE._real_extract: a 'sign in' reason gets the real cookies hint appended."""
    def real_extract(self, url, *args, **kwargs):
        message = reason
        if login_hint:
            message = f'{reason.rstrip(".")}. {self._youtube_login_hint}'
        self.raise_no_formats(message, expected=True)
    YoutubeIE._real_extract = real_extract
    argv = ['--ignore-config', '--no-update', '--no-cache-dir', '--no-playlist', '--no-warnings',
            '--dump-single-json', '--', f'https://www.youtube.com/watch?v={video_id}']
    code, _out, err = run(argv)
    assert code != 0, name
    write(name, err)


def failing_tab(name, url, message):
    def real_extract(self, *args, **kwargs):
        raise ExtractorError(message, expected=True)
    YoutubeTabIE._real_extract = real_extract
    argv = ['--ignore-config', '--no-update', '--no-cache-dir', '--yes-playlist', '--no-warnings',
            '--flat-playlist', '--dump-single-json', '--playlist-items', '1:50', '--', url]
    code, _out, err = run(argv)
    assert code != 0, name
    write(name, err)


def http_429_video(name, video_id):
    from yt_dlp.networking.exceptions import HTTPError

    class FakeResponse:
        status = 429
        reason = 'Too Many Requests'
        url = 'https://www.youtube.com/watch'
        headers = {}

        def read(self, *_):
            return b''

        def close(self):
            pass

    def real_extract(self, url, *args, **kwargs):
        raise ExtractorError('Unable to download webpage: HTTP Error 429: Too Many Requests', cause=HTTPError(FakeResponse()))
    YoutubeIE._real_extract = real_extract
    argv = ['--ignore-config', '--no-update', '--no-cache-dir', '--no-playlist', '--no-warnings',
            '--dump-single-json', '--', f'https://www.youtube.com/watch?v={video_id}']
    code, _out, err = run(argv)
    assert code != 0, name
    write(name, err)


# --- Pornhub --------------------------------------------------------------------------------------------------

def ph_list_page(keys_and_titles, has_more):
    rows = '\n'.join(
        f'<li><a href="/view_video.php?viewkey={key}" title="{title}" class="thumb">x</a></li>' for key, title in keys_and_titles)
    more = '<li class="page_next"><a href="?page=2">Next</a></li>' if has_more else ''
    return f'<html><body><div class="container"><ul>{rows}</ul>{more}</div></body></html>'


def pornhub_listing(name, url, pages):
    def download_webpage(self, url_or_request, video_id, note=None, *args, **kwargs):
        page = int((kwargs.get('query') or {}).get('page', 1))
        return pages[min(page, len(pages)) - 1]
    PornHubBaseIE._download_webpage = download_webpage
    argv = ['--ignore-config', '--no-update', '--no-cache-dir', '--yes-playlist', '--no-warnings',
            '--flat-playlist', '--dump-single-json', '--playlist-items', '1:50', '--', url]
    code, out, err = run(argv)
    assert code == 0, (name, err)
    write(name, out)


def pornhub_video_page(name, viewkey, html, *, redirect_to=None):
    class Handle:
        def __init__(self, target):
            self.url = target

    def download_webpage_handle(self, url_or_request, video_id, *args, **kwargs):
        return html, Handle(redirect_to or f'https://www.pornhub.com/view_video.php?viewkey={viewkey}')
    PornHubBaseIE._download_webpage_handle = download_webpage_handle
    argv = ['--ignore-config', '--no-update', '--no-cache-dir', '--no-playlist', '--no-warnings',
            '--dump-single-json', '--', f'https://www.pornhub.com/view_video.php?viewkey={viewkey}']
    code, _out, err = run(argv)
    assert code != 0, name
    write(name, err)


def main():
    flat_listing('ytdlp-youtube-channel-flat.json', f'https://www.youtube.com/@owntestchannel/videos',
                 CHANNEL_VIDEOS, CHANNEL_DATA, CHANNEL_ID)
    flat_listing('ytdlp-youtube-channel-flat-cap2.json', f'https://www.youtube.com/@owntestchannel/videos',
                 CHANNEL_VIDEOS, CHANNEL_DATA, CHANNEL_ID, max_entries=2)
    flat_listing('ytdlp-youtube-playlist-flat.json', 'https://www.youtube.com/playlist?list=PLabcdefghijklmnop',
                 CHANNEL_VIDEOS[:3], PLAYLIST_DATA, 'PLabcdefghijklmnop')
    flat_listing('ytdlp-youtube-shorts-flat.json', 'https://www.youtube.com/@owntestchannel/shorts',
                 [video_renderer('sssssssss01', 'A short', length='0:30', short=True)], CHANNEL_DATA, CHANNEL_ID)

    single_video('ytdlp-youtube-video-modern.json', 'dQw4w9WgXcQ', video_info('dQw4w9WgXcQ', FORMATS_MODERN))
    single_video('ytdlp-youtube-video-h264.json', 'dQw4w9WgXcQ', video_info('dQw4w9WgXcQ', FORMATS_H264_ONLY))
    single_video('ytdlp-youtube-video-live.json', 'dQw4w9WgXcQ', video_info(
        'dQw4w9WgXcQ', [fmt('91', 'mp4', 'avc1.4d400c', 'mp4a.40.5', 256, 144)], is_live=True, live_status='is_live', duration=None))

    failing_video('ytdlp-error-youtube-bot.txt', 'dQw4w9WgXcQ', 'Sign in to confirm you\u2019re not a bot', login_hint=True)
    failing_video('ytdlp-error-youtube-age.txt', 'dQw4w9WgXcQ', 'Sign in to confirm your age. This video may be inappropriate for some users', login_hint=True)
    failing_video('ytdlp-error-youtube-private.txt', 'dQw4w9WgXcQ', 'Private video. Sign in if you\u2019ve been granted access to this video', login_hint=True)
    failing_video('ytdlp-error-youtube-members.txt', 'dQw4w9WgXcQ', 'Join this channel to get access to members-only content like this video, and other exclusive perks.')
    failing_video('ytdlp-error-youtube-unavailable.txt', 'dQw4w9WgXcQ', 'Video unavailable. This video has been removed by the uploader')
    failing_video('ytdlp-error-youtube-geo.txt', 'dQw4w9WgXcQ', 'The uploader has not made this video available in your country')
    failing_video('ytdlp-error-youtube-premiere.txt', 'dQw4w9WgXcQ', 'Premieres in 2 hours')
    failing_video('ytdlp-error-youtube-live-upcoming.txt', 'dQw4w9WgXcQ', 'This live event will begin in 3 hours.')
    failing_video('ytdlp-error-youtube-trylater.txt', 'dQw4w9WgXcQ', 'This content isn\u2019t available, try again later. The current session has been rate-limited by YouTube for up to an hour.')
    http_429_video('ytdlp-error-youtube-http429.txt', 'dQw4w9WgXcQ')
    failing_tab('ytdlp-error-youtube-channel-missing.txt', 'https://www.youtube.com/@doesnotexist/videos',
                'The channel/playlist does not exist and the URL redirected to youtube.com home page')
    failing_tab('ytdlp-error-youtube-no-tab.txt', 'https://www.youtube.com/@owntestchannel/streams',
                'This channel does not have a streams tab')
    failing_tab('ytdlp-error-youtube-playlist-missing.txt', 'https://www.youtube.com/playlist?list=PLabcdefghijklmnop',
                'Failed to resolve url (does the playlist exist?)')

    pornhub_listing('ytdlp-pornhub-model-videos.json', 'https://www.pornhub.com/model/owntestmodel/videos', [
        ph_list_page([('ph5aaaaaaaaaaa1', 'Own clip one'), ('ph5aaaaaaaaaaa2', 'Own clip two')], True),
        ph_list_page([('ph5aaaaaaaaaaa3', 'Own clip three')], False),
    ])
    pornhub_video_page('ytdlp-error-pornhub-removed.txt', 'ph5aaaaaaaaaaa1',
                       '<html><body><div class="removed"><p>This video has been removed at the request of the uploader.</p></div></body></html>')
    pornhub_video_page('ytdlp-error-pornhub-geo.txt', 'ph5aaaaaaaaaaa1',
                       '<html><body><div class="geoBlocked">This content is unavailable in your country</div></body></html>')
    pornhub_video_page('ytdlp-error-pornhub-redirect.txt', 'ph5aaaaaaaaaaa1', '<html><body>ok</body></html>',
                       redirect_to='https://www.pornhub.com/')


if __name__ == '__main__':
    main()
