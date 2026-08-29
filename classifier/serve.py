"""Serve the Zura classifier, and proxy vision API calls so the key stays local.

Three things this does that `python -m http.server` does not:

1. Binds dual-stack. Windows resolves "localhost" to ::1 (IPv6) before
   127.0.0.1, so an IPv4-only server makes the browser fail with
   ERR_EMPTY_RESPONSE even though http://127.0.0.1:8000 works perfectly.
2. Sends no-cache headers, so edits to app.js and styles.css show up on
   reload instead of being served from the browser cache.
3. Reads API keys from a dotenv-style file and proxies /api/classify to Groq
   or Gemini with the key attached server-side. The browser never receives the
   key, so it cannot leak through devtools, a screenshot or a screen share.

Key resolution order, first hit wins:
    --env-file PATH
    $ZURA_ENV_FILE
    $GROQ_API_KEY / $GEMINI_API_KEY
    the candidate paths in ENV_CANDIDATES below

Accepted variable names: groq / GROQ_API_KEY, gemini / GEMINI_API_KEY.

The proxy binds to localhost by default and refuses non-local callers. Do not
expose it on a public interface: it is an unauthenticated hole to your quota.

localhost and 127.0.0.1 both count as secure origins, so the camera works.
Opening index.html directly (file://) does not - Chrome blocks getUserMedia.
"""

import argparse
import http.server
import ipaddress
import json
import os
import pathlib
import re
import socket
import socketserver
import sys
import urllib.error
import urllib.parse
import urllib.request
import base64
import datetime
import secrets
import webbrowser

DEFAULT_PORT = 8000
MAX_TRIES = 10
HERE = pathlib.Path(__file__).resolve().parent

ENV_CANDIDATES = [
    HERE.parent / ".env",
    pathlib.Path.home() / "OneDrive" / "Documents" / "personal-shi" / "access-token.env",
    pathlib.Path.home() / ".config" / "zura" / "keys.env",
]

VAR_NAMES = {
    "groq":   ("groq", "groq_api_key"),
    "gemini": ("gemini", "gemini_api_key", "google_api_key"),
}

UPSTREAM = {
    "groq": "https://api.groq.com/openai/v1/chat/completions",
    # Gemini's URL carries the model and the key, so it is built per request.
    "gemini": "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}",
}

KEYS = {}
KEY_SOURCE = "none"

# Corrections captured from the UI. An override is a human saying the model was
# wrong, so the frame plus the corrected label is exactly the sample a later
# on-device model would be fine-tuned on. This SIMULATES the collection stage of
# that pipeline - nothing here trains anything.
DATASET = HERE.parent / "dataset"
LABELS = ("BIODEGRADABLE", "RECYCLABLE", "NON_RECYCLABLE")


def parse_env(path):
    out = {}
    try:
        text = pathlib.Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return out
    for line in text.splitlines():
        m = re.match(r"\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*[\"']?(\S+?)[\"']?\s*$", line)
        if not m:
            continue
        name, value = m.group(1).lower(), m.group(2)
        for provider, aliases in VAR_NAMES.items():
            if name in aliases and value and not value.startswith("#"):
                out[provider] = value
    return out


def load_keys(explicit):
    """Find keys without ever printing one."""
    global KEY_SOURCE
    for path in filter(None, [explicit, os.environ.get("ZURA_ENV_FILE")]):
        found = parse_env(path)
        if found:
            KEY_SOURCE = str(path)
            return found
        print(f"  no usable key in {path}")

    env = {}
    if os.environ.get("GROQ_API_KEY"):
        env["groq"] = os.environ["GROQ_API_KEY"]
    if os.environ.get("GEMINI_API_KEY"):
        env["gemini"] = os.environ["GEMINI_API_KEY"]
    if env:
        KEY_SOURCE = "environment variables"
        return env

    for path in ENV_CANDIDATES:
        found = parse_env(path)
        if found:
            KEY_SOURCE = str(path)
            return found
    return {}


class DualStackServer(socketserver.ThreadingTCPServer):
    """IPv6 with V6ONLY cleared, so IPv4 clients are served too."""

    address_family = socket.AF_INET6
    allow_reuse_address = True
    daemon_threads = True

    def server_bind(self):
        try:
            self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        except OSError:
            pass
        super().server_bind()


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(HERE), **kw)

    # ── helpers ──────────────────────────────────────────────────────────
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _save_sample(self):
        """File one human correction under its corrected label.

        Writes dataset/<LABEL>/<timestamp>.jpg plus a row in labels.csv holding
        what the model said versus what the human said - the disagreement is the
        interesting part, and without it the image is just an unlabelled photo.
        """
        if not self._is_local():
            return self._json(403, {"error": "local connections only"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 8 * 1024 * 1024:
                return self._json(413, {"error": "missing or oversized body"})
            req = json.loads(self.rfile.read(length))
        except (ValueError, OSError) as e:
            return self._json(400, {"error": f"bad request: {e}"})

        label = str(req.get("label", ""))
        if label not in LABELS:                      # whitelist: no path traversal
            return self._json(400, {"error": f"unknown label {label!r}"})
        try:
            img = base64.b64decode(req.get("image", ""), validate=True)
        except Exception:
            return self._json(400, {"error": "image is not valid base64"})
        if len(img) < 512:
            return self._json(400, {"error": "image too small to be a frame"})

        folder = DATASET / label
        folder.mkdir(parents=True, exist_ok=True)
        stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
        name = f"{stamp}-{secrets.token_hex(3)}.jpg"
        (folder / name).write_bytes(img)

        csv = DATASET / "labels.csv"
        new = not csv.exists()
        with csv.open("a", encoding="utf-8", newline="") as fh:
            if new:
                fh.write("timestamp,file,human_label,model_said,confidence,target_bin\n")
            fh.write(",".join([
                datetime.datetime.now().isoformat(timespec="seconds"),
                f"{label}/{name}",
                label,
                str(req.get("modelSaid", "")).replace(",", " "),
                str(req.get("confidence", "")),
                str(req.get("target", "")),
            ]) + "\n")

        counts = self._sample_counts()
        print(f"  correction saved: {label}/{name} (model said "
              f"{req.get('modelSaid') or 'nothing'})")
        return self._json(200, {"saved": f"{label}/{name}",
                                "counts": counts, "total": sum(counts.values())})

    def _is_local(self):
        raw = self.client_address[0]
        if raw.startswith("::ffff:"):
            raw = raw[7:]
        try:
            return ipaddress.ip_address(raw).is_loopback
        except ValueError:
            return False

    def log_message(self, fmt, *args):
        status = str(args[1]) if len(args) > 1 else ""
        if not status.startswith("2"):
            sys.stderr.write("  %s %s\n" % (status, args[0] if args else ""))

    # ── routes ───────────────────────────────────────────────────────────
    def _sample_counts(self):
        counts = {}
        for lab in LABELS:
            d = DATASET / lab
            counts[lab] = len(list(d.glob("*.jpg"))) if d.is_dir() else 0
        return counts

    def do_GET(self):
        if self.path.split("?")[0] == "/api/samples":
            c = self._sample_counts()
            return self._json(200, {"counts": c, "total": sum(c.values()),
                                    "dir": str(DATASET)})
        if self.path.split("?")[0] == "/api/status":
            return self._json(200, {
                "providers": {p: bool(KEYS.get(p)) for p in ("groq", "gemini")},
                "source": KEY_SOURCE if KEYS else None,
            })
        return super().do_GET()

    def do_POST(self):
        route = self.path.split("?")[0]
        if route == "/api/sample":
            return self._save_sample()
        if route != "/api/classify":
            return self._json(404, {"error": "unknown endpoint"})
        if not self._is_local():
            return self._json(403, {"error": "proxy accepts local connections only"})

        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 12 * 1024 * 1024:
                return self._json(413, {"error": "missing or oversized body"})
            req = json.loads(self.rfile.read(length))
        except (ValueError, OSError) as e:
            return self._json(400, {"error": f"bad request: {e}"})

        provider = req.get("provider")
        if provider not in UPSTREAM:
            return self._json(400, {"error": f"unknown provider {provider!r}"})
        key = KEYS.get(provider)
        if not key:
            return self._json(503, {"error": f"no {provider} key configured on the server"})

        payload = req.get("payload")
        if not isinstance(payload, dict):
            return self._json(400, {"error": "payload must be an object"})

        headers = {"Content-Type": "application/json",
                   "User-Agent": "zura-classifier-proxy/1.0"}
        if provider == "groq":
            url = UPSTREAM["groq"]
            headers["Authorization"] = f"Bearer {key}"
        else:
            model = str(req.get("model") or "gemini-2.5-flash")
            if not re.fullmatch(r"[A-Za-z0-9._\-]{1,80}", model):
                return self._json(400, {"error": "invalid model name"})
            url = UPSTREAM["gemini"].format(model=model, key=urllib.parse.quote(key))

        try:
            up = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                        headers=headers, method="POST")
            with urllib.request.urlopen(up, timeout=120) as r:
                body, code = r.read(), r.status
        except urllib.error.HTTPError as e:
            body, code = e.read(), e.code
        except urllib.error.URLError as e:
            return self._json(502, {"error": f"upstream unreachable: {e.reason}"})

        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)



def main():
    ap = argparse.ArgumentParser(description="Serve Zura and proxy vision API calls.")
    ap.add_argument("port", nargs="?", type=int, default=DEFAULT_PORT)
    ap.add_argument("--env-file", help="dotenv-style file holding groq= / gemini= keys")
    args = ap.parse_args()

    global KEYS
    KEYS = load_keys(args.env_file)

    port = args.port
    for _ in range(MAX_TRIES):
        try:
            httpd = DualStackServer(("::", port), Handler)
            break
        except OSError:
            print(f"  port {port} is busy, trying {port + 1}")
            port += 1
    else:
        print(f"  no free port in {args.port}-{args.port + MAX_TRIES}.")
        return 1

    url = f"http://localhost:{port}"
    print(f"\n  Zura - smart waste bins\n  Open:  {url}")
    if KEYS:
        # Names only. The values never reach stdout, a log, or the browser.
        print(f"  Keys:  {', '.join(sorted(KEYS))}  (from {KEY_SOURCE})")
        print("         proxied server-side; the browser never receives them")
    else:
        print("  Keys:  none found - paste one into the page, or use --env-file")
    print("  Stop:  Ctrl+C\n")

    webbrowser.open(url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  stopped")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
