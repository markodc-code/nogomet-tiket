"""Džavke prati, pare vrati - lokalno pokretanje. Pokreni: python server.py

Pripremi web/data.json (rezultati, kvote, model) i posluži mapu web/ na
http://127.0.0.1:8765. Ista stranica radi i objavljena na internetu.
"""
import functools
import os
import sys
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import build_data
import model as M

PORT = 8765
WEB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def auto_refresh():
    while True:
        threading.Event().wait(M.MAX_AGE)
        try:
            build_data.build(force=True)
        except Exception as e:
            print("Osvježavanje nije uspjelo:", e)


def main():
    print("Pripremam podatke...")
    try:
        build_data.build()
    except Exception as e:
        if not os.path.exists(build_data.OUT):
            raise
        print("Ne mogu osvježiti podatke, koristim stare:", e)
    url = f"http://127.0.0.1:{PORT}/"
    try:
        srv = ThreadingHTTPServer(("127.0.0.1", PORT), functools.partial(Handler, directory=WEB))
    except OSError:
        print(f"Aplikacija već radi: {url}")
        webbrowser.open(url)
        return
    print(f"\nOtvori u pregledniku: {url}\n(Zatvori ovaj prozor za gašenje aplikacije.)")
    threading.Thread(target=auto_refresh, daemon=True).start()
    if "--no-browser" not in sys.argv:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
