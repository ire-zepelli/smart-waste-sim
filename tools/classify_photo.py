"""Classify a photo as BIODEGRADABLE / RECYCLABLE / NON_RECYCLABLE using Groq.

Same model, same prompt and same JSON contract the web app uses - the prompt is
read straight out of classifier/app.js, so this cannot drift from what the bins
actually do. Use it to sanity-check the classifier on real photographs without
opening a browser, and to build the accuracy table for the project document.

Usage:
    set GROQ_API_KEY=gsk_...
    python tools/classify_photo.py photo.jpg
    python tools/classify_photo.py photos/*.jpg
    python tools/classify_photo.py --expect RECYCLABLE bottle1.jpg bottle2.jpg

The key is read from the GROQ_API_KEY environment variable and is never written
to a file. Pass --key only if you must; it will be visible in your shell history.
"""

import argparse
import base64
import glob
import json
import os
import pathlib
import re
import sys
import urllib.error
import urllib.request

ENDPOINT = "https://api.groq.com/openai/v1/chat/completions"
DEFAULT_MODEL = "qwen/qwen3.8-27b"   # 3.6 fails JSON validation - do not swap
CLASSES = ("BIODEGRADABLE", "RECYCLABLE", "NON_RECYCLABLE", "NO_MATCH")

ROOT = pathlib.Path(__file__).resolve().parent.parent
APP_JS = ROOT / "classifier" / "app.js"

SUFFIX = (
    'Reply with ONLY this JSON object and nothing else:\n'
    '{"class":"BIODEGRADABLE|RECYCLABLE|NON_RECYCLABLE|NO_MATCH",'
    '"confidence":0.0,"item":"short name","reason":"one sentence"}'
)


def load_prompt():
    """Read VISION_PROMPT out of the web app so the two cannot disagree."""
    try:
        src = APP_JS.read_text(encoding="utf-8")
    except OSError:
        sys.exit(f"cannot read {APP_JS} - run this from inside the project")
    m = re.search(r"const VISION_PROMPT = `(.*?)`;", src, re.S)
    if not m:
        sys.exit("VISION_PROMPT not found in classifier/app.js")
    return m.group(1)


def key_from_env_file(path):
    """Pull a Groq key out of a dotenv-style file without echoing it anywhere."""
    try:
        text = pathlib.Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError as e:
        sys.exit(f"cannot read {path}: {e}")
    for line in text.splitlines():
        m = re.match(r"\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*[\"']?(\S+?)[\"']?\s*$", line)
        if m and m.group(1).lower() in ("groq", "groq_api_key") and m.group(2).startswith("gsk_"):
            return m.group(2)
    sys.exit(f"no groq= or GROQ_API_KEY= line starting with gsk_ found in {path}")


def classify(path, key, model, prompt):
    data = pathlib.Path(path).read_bytes()
    if len(data) > 4 * 1024 * 1024:
        return None, "file is over 4 MB - resize it first"
    mime = "image/png" if path.lower().endswith(".png") else "image/jpeg"
    body = json.dumps({
        "model": model,
        "temperature": 0,
        "max_tokens": 200,
        "response_format": {"type": "json_object"},
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": prompt + "\n\n" + SUFFIX},
            {"type": "image_url", "image_url": {
                "url": f"data:{mime};base64," + base64.b64encode(data).decode()}},
        ]}],
    }).encode()

    # Cloudflare sits in front of api.groq.com and rejects Python's default
    # "Python-urllib/3.x" agent with HTTP 403 error code 1010. A conventional
    # User-Agent is required; this is not an authentication problem, and the
    # error message does not say so.
    req = urllib.request.Request(ENDPOINT, data=body, headers={
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "User-Agent": "zura-waste-classifier/1.0",
    })
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            payload = json.load(r)
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:200]
        if e.code == 401:
            return None, "API key rejected"
        if e.code == 429:
            return None, "rate limited - wait a moment"
        if e.code == 404:
            return None, f'model "{model}" not available on this key'
        return None, f"HTTP {e.code}: {detail}"
    except urllib.error.URLError as e:
        return None, f"network: {e.reason}"

    text = payload["choices"][0]["message"]["content"]
    try:
        out = json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{[\s\S]*\}", text)
        if not m:
            return None, f"unparseable response: {text[:120]}"
        out = json.loads(m.group(0))

    if out.get("class") not in CLASSES:
        return None, f"invalid class {out.get('class')!r}"
    return out, None


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("images", nargs="+", help="image files (globs allowed)")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--expect", choices=CLASSES,
                    help="category every image should get, for scoring accuracy")
    ap.add_argument("--env-file", metavar="PATH",
                    help="read the key from a dotenv-style file (groq=... or GROQ_API_KEY=...)")
    ap.add_argument("--key", help="Groq API key (prefer --env-file or GROQ_API_KEY)")
    args = ap.parse_args()

    key = args.key or os.environ.get("GROQ_API_KEY", "")
    if not key and args.env_file:
        key = key_from_env_file(args.env_file)
    if not key:
        sys.exit("no key: use --env-file, set GROQ_API_KEY, "
                 "or pass --key (which lands in your shell history)")

    paths = []
    for pattern in args.images:
        hits = glob.glob(pattern)
        paths.extend(hits or [pattern])
    paths = [p for p in paths if pathlib.Path(p).is_file()]
    if not paths:
        sys.exit("no readable image files matched")

    prompt = load_prompt()
    print(f"model {args.model} - prompt read from classifier/app.js ({len(prompt)} chars)\n")

    hits = graded = 0
    for p in paths:
        name = pathlib.Path(p).name
        out, err = classify(p, key, args.model, prompt)
        if err:
            print(f"  {name:34} FAILED  {err}")
            continue
        mark = ""
        if args.expect:
            graded += 1
            ok = out["class"] == args.expect
            hits += ok
            mark = "OK  " if ok else "MISS"
        print(f"  {name:34} {mark}{out['class']:16} {out['confidence']:.2f}  {out['item']}")
        print(f"  {'':34}     {out['reason']}")

    if args.expect and graded:
        print(f"\n  {hits}/{graded} classified as {args.expect}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
