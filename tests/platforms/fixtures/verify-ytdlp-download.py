"""Checks how the real yt-dlp 2026.8.19 behaves with the exact download argument list of Kura. NOT run by the test suite.

A local HTTP server on 127.0.0.1 serves a small file; YoutubeIE._real_extract is replaced by a stand-in that returns one
progressive format pointing at it. Everything else (format selection, the downloader, the output template, the
file-size check, the sleep before the download, the clean-up of temporary files) is the real yt-dlp code. Nothing leaves
the machine. The merge of two separate streams needs ffmpeg and is NOT checked here (no ffmpeg on the development machine).

    python3 verify-ytdlp-download.py

Prints the files that the run leaves in its working directory; Kura's staging accepts exactly one regular file.
"""
import contextlib
import http.server
import io
import os
import sys
import tempfile
import threading

sys.path.insert(0, os.environ.get('YTDLP_SRC', '/tmp/ytdlp/yt_dlp-2026.8.19'))
sys.dont_write_bytecode = True

import yt_dlp  # noqa: E402
from yt_dlp.extractor.youtube import YoutubeIE  # noqa: E402

PAYLOAD = bytes([0, 0, 0, 0x18]) + b'ftypmp42' + b'own test video ' * 2000


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        self.send_response(200)
        self.send_header('Content-Type', 'video/mp4')
        self.send_header('Content-Length', str(len(PAYLOAD)))
        self.end_headers()
        self.wfile.write(PAYLOAD)

    def log_message(self, *args):
        pass


server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
url = f'http://127.0.0.1:{server.server_port}/video.mp4'

VIDEO_ID = 'dQw4w9WgXcQ'
YoutubeIE._real_extract = lambda self, *args, **kwargs: {
    'id': VIDEO_ID, 'title': 'Own test video', 'extractor': 'youtube', 'extractor_key': 'Youtube',
    'formats': [{'format_id': '18', 'ext': 'mp4', 'vcodec': 'avc1.42001E', 'acodec': 'mp4a.40.2', 'url': url, 'protocol': 'http', 'width': 640, 'height': 360}],
}

# The argument list of YtDlpAdapter.stage() with maxBytes = 10 MiB, as recorded from the adapter (see the report).
ARGV = [
    '--ignore-config', '--no-update', '--no-cache-dir', '--no-warnings', '--no-playlist',
    '--extractor-retries', '0', '--sleep-requests', '1', '--sleep-interval', '1', '--max-sleep-interval', '2',
    '--no-progress', '--no-mtime', '--max-filesize', str(10 * 1024 * 1024),
    '-f', 'bestvideo*+bestaudio/best', '--merge-output-format', 'mp4/webm/mkv', '--abort-on-unavailable-fragments',
    '-o', 'asset.%(ext)s', '--', f'https://www.youtube.com/watch?v={VIDEO_ID}',
]

with tempfile.TemporaryDirectory() as directory:
    os.chdir(directory)
    out, err = io.StringIO(), io.StringIO()
    code = 0
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            yt_dlp.main(ARGV)
        except SystemExit as exit_:
            code = exit_.code or 0
    print('exit code:', code)
    print('files left behind:', sorted((name, os.path.getsize(name)) for name in os.listdir('.')))
    print('stderr:', err.getvalue().strip() or '(empty)')
server.shutdown()
