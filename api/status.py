"""Report which providers have a key, and that this is the hosted build."""

from http.server import BaseHTTPRequestHandler

from _shared import providers_configured, send_json


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        send_json(self, 200, {
            "providers": providers_configured(),
            "source": "vercel environment variables",
            # Vercel's filesystem is read-only apart from an ephemeral /tmp, so
            # correction capture cannot persist here. The page hides it rather
            # than accepting samples it would silently throw away.
            "hosted": True,
            "samples": False,
        })
