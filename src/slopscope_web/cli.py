"""Serve the static WebUSB app or its optional Python bridge."""

import argparse
import functools
import json
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

STATIC = Path(__file__).with_name("static")


class StaticHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/options":
            body = json.dumps({"bridge": False}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--bridge", action="store_true", help="Use the SlopScope USB Python bridge")
    parser.add_argument("--serial", help="Scope USB serial for the Python bridge")
    parser.add_argument(
        "--no-usb-recovery",
        action="store_true",
        help="Pause the bridge after a USB error without resetting or reconnecting",
    )
    parser.add_argument(
        "--capture-usb-errors",
        type=Path,
        help="Preserve failed frame bytes and error metadata in this directory",
    )
    parser.add_argument(
        "--usb-read-size",
        type=int,
        choices=(512, 1024, 2048, 4096),
        default=4096,
        help="Bulk frame read size for bridge diagnosis",
    )
    parser.add_argument(
        "--bounded-frames",
        action="store_true",
        help="Use cancellable CRC-checked frame chunks (new firmware required)",
    )
    args = parser.parse_args()
    if args.serial and not args.bridge:
        parser.error("--serial requires --bridge")
    if args.bounded_frames and not args.bridge:
        parser.error("--bounded-frames requires --bridge")
    if args.usb_read_size != 4096 and not args.bridge:
        parser.error("--usb-read-size requires --bridge")
    if args.capture_usb_errors and not args.bridge:
        parser.error("--capture-usb-errors requires --bridge")
    if args.no_usb_recovery and not args.bridge:
        parser.error("--no-usb-recovery requires --bridge")
    if args.bridge:
        try:
            from .bridge import serve
        except ImportError as error:
            parser.error(f"Install the firmware repo’s host package for bridge mode: {error}")
        return serve(
            args.port,
            not args.no_browser,
            recover_usb=not args.no_usb_recovery,
            capture_directory=args.capture_usb_errors,
            frame_read_size=args.usb_read_size,
            bounded_frames=True,
            serial_number=args.serial,
        )
    handler = functools.partial(StaticHandler, directory=str(STATIC))
    server = ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    url = f"http://127.0.0.1:{server.server_port}/"
    print(f"SlopScope WebUSB viewer: {url}", flush=True)
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
