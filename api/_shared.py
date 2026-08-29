"""Shared helpers for the Vercel serverless functions.

serve.py does the same job locally by reading a dotenv file. On Vercel there is
no filesystem to read from, so keys come from environment variables set in the
project dashboard. The browser never receives them either way.
"""

import json
import os

LABELS = ("BIODEGRADABLE", "RECYCLABLE", "NON_RECYCLABLE")

UPSTREAM = {
    "groq": "https://api.groq.com/openai/v1/chat/completions",
    "gemini": ("https://generativelanguage.googleapis.com/v1beta/models/"
               "{model}:generateContent?key={key}"),
}

# Accept either naming so the same env file works locally and on Vercel.
KEY_VARS = {
    "groq": ("GROQ_API_KEY", "GROQ", "groq"),
    "gemini": ("GEMINI_API_KEY", "GEMINI", "gemini", "GOOGLE_API_KEY"),
}


def key_for(provider):
    for name in KEY_VARS.get(provider, ()):
        value = os.environ.get(name)
        if value:
            return value.strip()
    return None


def providers_configured():
    return {p: bool(key_for(p)) for p in ("groq", "gemini")}


def guard_token_ok(headers):
    """Optional shared secret.

    The local proxy refuses non-loopback callers, which cannot work here - every
    caller is remote. If ZURA_PROXY_TOKEN is set, callers must present it, so a
    public URL does not become an open door to the API quota. If it is unset the
    proxy is open, which is a deliberate choice the deployer has to make.
    """
    want = os.environ.get("ZURA_PROXY_TOKEN")
    if not want:
        return True
    return headers.get("x-zura-token", "") == want


def send_json(handler, code, obj):
    body = json.dumps(obj).encode()
    handler.send_response(code)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def read_json(handler, limit=12 * 1024 * 1024):
    length = int(handler.headers.get("Content-Length", "0"))
    if length <= 0 or length > limit:
        raise ValueError("missing or oversized body")
    return json.loads(handler.rfile.read(length))
