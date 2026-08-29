"""Proxy a vision request so the API key stays server-side.

Self-contained on purpose - see the note in status.py.
"""

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler

UPSTREAM = {
    "groq": "https://api.groq.com/openai/v1/chat/completions",
    "gemini": ("https://generativelanguage.googleapis.com/v1beta/models/"
               "{model}:generateContent?key={key}"),
}
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
    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        # Optional shared secret. The local proxy refuses non-loopback callers,
        # which cannot work here - every caller is remote.
        want = os.environ.get("ZURA_PROXY_TOKEN")
        if want and self.headers.get("x-zura-token", "") != want:
            return self._json(401, {"error": "bad or missing proxy token"})

        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 12 * 1024 * 1024:
                raise ValueError("missing or oversized body")
            req = json.loads(self.rfile.read(length))
        except Exception as e:
            return self._json(400, {"error": f"bad request: {e}"})

        provider = req.get("provider")
        if provider not in UPSTREAM:
            return self._json(400, {"error": f"unknown provider {provider!r}"})
        key = key_for(provider)
        if not key:
            return self._json(503, {"error": f"no {provider} key set on the server"})
        payload = req.get("payload")
        if not isinstance(payload, dict):
            return self._json(400, {"error": "payload must be an object"})

        headers = {"Content-Type": "application/json", "User-Agent": "zura-proxy/1.0"}
        if provider == "groq":
            url = UPSTREAM["groq"]
            headers["Authorization"] = "Bearer " + key
        else:
            model = str(req.get("model") or "gemini-2.5-flash")
            url = UPSTREAM["gemini"].format(model=model, key=urllib.parse.quote(key))

        try:
            up = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                        headers=headers, method="POST")
            with urllib.request.urlopen(up, timeout=60) as r:
                body, code = r.read(), r.status
        except urllib.error.HTTPError as e:
            body, code = e.read(), e.code
        except urllib.error.URLError as e:
            return self._json(502, {"error": f"upstream unreachable: {e.reason}"})

        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
