"""Report which providers have a key configured on the server.

Self-contained on purpose: Vercel did not resolve a `from _shared import ...`
sibling import and every call failed with FUNCTION_INVOCATION_FAILED. The small
duplication between the two functions is worth more than the shared module.
"""

import json
import os
from http.server import BaseHTTPRequestHandler

KEY_VARS = {
    "groq": ("GROQ_API_KEY", "GROQ", "groq"),
    "gemini": ("GEMINI_API_KEY", "GEMINI", "gemini", "GOOGLE_API_KEY"),
}


def key_for(provider):
    for name in KEY_VARS.get(provider, ()):
        v = os.environ.get(name)
        if v:
            return v.strip()
    return None


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({
            "providers": {p: bool(key_for(p)) for p in ("groq", "gemini")},
            "source": "vercel environment variables",
            "hosted": True,
            # Vercel's filesystem is read-only apart from an ephemeral /tmp, so
            # correction capture cannot persist. The page hides it rather than
            # accepting samples it would silently discard.
            "samples": False,
        }).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
