"""Proxy a vision request so the API key stays server-side."""

import json
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler

from _shared import UPSTREAM, guard_token_ok, key_for, read_json, send_json


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if not guard_token_ok(self.headers):
            return send_json(self, 401, {"error": "bad or missing proxy token"})
        try:
            req = read_json(self)
        except Exception as e:
            return send_json(self, 400, {"error": f"bad request: {e}"})

        provider = req.get("provider")
        if provider not in UPSTREAM:
            return send_json(self, 400, {"error": f"unknown provider {provider!r}"})
        key = key_for(provider)
        if not key:
            return send_json(self, 503, {"error": f"no {provider} key set on the server"})
        payload = req.get("payload")
        if not isinstance(payload, dict):
            return send_json(self, 400, {"error": "payload must be an object"})

        headers = {"Content-Type": "application/json", "User-Agent": "zura-proxy/1.0"}
        if provider == "groq":
            url = UPSTREAM["groq"]
            headers["Authorization"] = f"Bearer {key}"
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
            return send_json(self, 502, {"error": f"upstream unreachable: {e.reason}"})

        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
