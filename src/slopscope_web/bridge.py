"""Launch the firmware repo's USB bridge with this checkout's viewer assets."""
from pathlib import Path


def serve(*args, **kwargs):
    from slopscope_usb.bridge import serve as serve_bridge
    kwargs.setdefault("ui_dir", Path(__file__).with_name("static"))
    kwargs.setdefault("bounded_frames", True)
    return serve_bridge(*args, **kwargs)
