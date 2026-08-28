"""Serve the Zura classifier over HTTP.

Two things this does that `python -m http.server` does not:

1. Binds dual-stack. Windows resolves "localhost" to ::1 (IPv6) before
   127.0.0.1, so an IPv4-only server makes the browser fail with
   ERR_EMPTY_RESPONSE even though http://127.0.0.1:8000 works perfectly.
2. Sends no-cache headers, so edits to app.js and styles.css show up on
   reload instead of being served from the browser cache.

localhost and 127.0.0.1 both count as secure origins, so the camera works.
Opening index.html directly (file://) does not - Chrome blocks getUserMedia.
"""

import http.server
import os
import socket
import socketserver
import sys
import webbrowser

DEFAULT_PORT = 8000
MAX_TRIES = 10


class DualStackServer(socketserver.TCPServer):
    """Listens on IPv6 with V6ONLY cleared, so IPv4 clients are served too."""

    address_family = socket.AF_INET6
    allow_reuse_address = True

    def server_bind(self):
        try:
            self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        except OSError:
            pass  # some stacks refuse; IPv6-only still beats failing outright
        super().server_bind()


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        # Keep the console readable: report failures, stay quiet about 200s.
        status = str(args[1]) if len(args) > 1 else ""
        if not status.startswith("2"):
            sys.stderr.write("  %s %s\n" % (status, args[0] if args else ""))


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    os.chdir(os.path.dirname(os.path.abspath(__file__)))

    for attempt in range(MAX_TRIES):
        try:
            httpd = DualStackServer(("::", port), Handler)
            break
        except OSError:
            print(f"  port {port} is busy, trying {port + 1}")
            port += 1
    else:
        print(f"  no free port in {DEFAULT_PORT}-{DEFAULT_PORT + MAX_TRIES}. Close something and retry.")
        return 1

    url = f"http://localhost:{port}"
    print(f"\n  Zura - smart waste bins\n  Open:  {url}\n  Stop:  Ctrl+C\n")
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
