# SlopScope web UI

Live two-channel scope control through direct WebUSB, with an optional Python
bridge. This repository owns the browser UI. The Python USB library and bridge
live with the firmware under `SlopScope/host`, as the `slopscope-usb` package.

## Direct WebUSB

Serve `src/slopscope_web/static/` with any static web server. There is no
JavaScript build step or runtime dependency. For a convenient local launcher:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -e .
.venv/bin/slopscope-web --no-browser
```

Open http://127.0.0.1:8766/ in Chrome or Edge, choose **Connect USB**, and select
the scope. Disconnect any other scope application first. WebUSB requires HTTPS
or localhost and a browser device grant. The app can also be hosted as static
files over HTTPS without a Python process. Safari/Firefox users can use the
Python bridge.

Direct mode uses the scope's existing vendor interface (`DEAF:BABE`, bulk IN/OUT
endpoint 1). It serializes USB transactions, validates FRAME7/record CRCs and
calibration identity, and closes failed sessions without replaying uncertain
control writes. A reconnect requires the Connect USB button. See the
[Chrome WebUSB guide](https://developer.chrome.com/docs/capabilities/usb).

## Python bridge

The simplest route is `./bridge` from the SlopScope firmware repo. It installs
the included USB library, starts the local bridge, and finds a sibling viewer
checkout automatically. The viewer otherwise comes from its published Pages site.
To use this repo's launcher instead, install `SlopScope/host` into the same Python
environment first, then:

```sh
.venv/bin/slopscope-web --bridge --no-browser
```

The bridge owns USB in one worker and supplies HTTP controls and events to the
same UI. The header indicates **Python bridge**. Choose **Use WebUSB** to release its
USB interface, then **Connect USB** for direct browser access. Choose **Use
Python bridge** to switch back; a connected WebUSB session is closed first.
Active record/calibration operations must finish or be cancelled before switching.
For failure capture, `--bridge --no-usb-recovery` pauses after the first USB
error or timeout, preserving the failure without USB reset/reconnect. Restart
or switch transports explicitly when ready to recover.

The bridge normally retains bounded reconnect and
USB-reset recovery. Grounded zero/offset self-calibration currently uses this
mode; saved factory/reference corrections, profile calibration and voltage
conversion work in both modes.

The LCD USB icon follows the active WebUSB or Python bridge session, rather
than cable presence. Normal polling renews it even while acquisition is stopped.
Disconnect or a transport switch closes the session; an unexpectedly closed tab
or failed process expires within three seconds. Separate green TX (scope to PC)
and amber RX (PC to scope) lamps hold activity for 250 ms. Continuous streaming
can keep them lit. The Python bridge remains a scope client while it is running,
including when no browser page is open.

## Features

The header lists scopes by USB serial. The Python bridge automatically connects
when exactly one scope is present; with multiple scopes, select one explicitly.
Selection stays pinned to that unit through disconnects and recovery. The bridge
can also start with `slopscope-web --bridge --serial SS-...`. Other scopes remain
available to separate serial-addressed Python clients or viewers.

In direct WebUSB mode, use Add scope to authorize a device in the browser chooser.
Authorized devices appear in the serial selector; choosing one disconnects the
previous scope. Browser permission is required before a device can be listed.
Older firmware with duplicate `DEV0001` serials must be updated first.

- Run/Stop/Single/Force, channel voltage scales/positions, coupling, probe ratios,
  bandwidth, visibility/inversion, timebase and capture-window controls.
- Edge, sampled Pulse and recovered Video controls; experimental modes stay
  disabled. Native Video controls retain their current firmware limitations.
- Live/rolling previews, 1K/10K single/paired record download and cancellation.
- Measurements, channel timing, averaging, peak envelopes, persistence, math,
  arbitrary-length FFT, XY, cursors and PNG/CSV export.
- Scope save/recall, portable JSON setup files and local display preferences.
- Scope LCD theme, 1–100% backlight, native Autoset/cancellation, LCD cursors and
  Math controls in both WebUSB and bridge modes. Graph cursors share the scope's
  cursor positions and source; editing either UI updates the other. Tools Math selections
  mirror Off/Add/Subtract/Multiply/Divide/XY/FFT onto the scope LCD. Both raw channels
  still stream; the host calculates its own calibrated graph. FFT source, six window
  choices, and Vrms/dBV units are mirrored too. The LCD uses 1024 points; the host
  uses the full received record, so spectral resolution can differ.
- Checked LCD screenshot download (800×480 BMP), including the last physical Copy.
  Downloads run in small batches with progress/cancellation while live polling continues.
  LCD cursor/Math state is session-only on the scope and included in web setup profiles.

Run/Autoset and timebase stay above the waveform. The sidebar groups controls into
Channels, Trigger, Acquisition, Tools and Setup. Tools contains the shared cursor
controls; click the graph to place A and B. Cursor positions snap to the LCD's pixel
resolution. The `H:` readout beside the timebase shows signed horizontal delay:
positive delay moves the waveform left, and stock placement displays zero.

Both transports display downloaded records, not gapless continuous history.
Hardware Peak reports extrema only; timing/RMS/FFT remain suppressed. Video
standard/field qualification and exact high-rate trigger placement retain the
firmware's documented limits. Factory records are reused in place.

Space toggles Run/Stop, S arms Single, and Escape stops acquisition. Editing a
control suppresses shortcuts. CSV time is labelled `nominal_time_s`.

The live status stays at **ACQUIRING** with a blinking activity dot, including
during trigger/buffer waits. Detailed record progress remains in its controls.
Both channels show peak-to-peak voltage below the plot. Frequency and period
readouts use a median of up to five recent valid captures to reduce display
jitter; the raw measurements remain available unchanged. Invalid timing clears
the readout immediately, and acquisition changes reset the filter.

Drag the colored plot triangles to preview channel positions and the white
numbered triangle to preview trigger level. Release sends one update; Escape
cancels. The white triangle shows the trigger source (1 or 2); click it to choose
CH1 or CH2. Separate handle lanes keep overlapping channel markers selectable.
The drag uses the selected probe factor, voltage scale and inversion, including
raw-code trigger mode. These controls work through either transport.

## Development and packaging

Python packaging includes all static assets. `npm install` supplies optional
Prettier/Playwright development tools; `npm run format` formats owned UI assets.
The installed launcher defaults to static/WebUSB mode. Its optional bridge mode
delegates to `slopscope_usb.bridge` from the firmware repo; it does not maintain
a second USB server implementation.

Only SlopScope firmware is supported. The historical stock viewer and VISA code
are archived outside these release repos. Captures and private bench artifacts
belong outside source control.

## Qualification

The Python bridge uses bounded frame transfers by default with
`slopscope-web --bridge` on firmware advertising `frame_chunks`.
It consumes small ID/offset/CRC-checked replies rather than a single FRAME7
response. The library also exposes incremental reading and cancellation; the
viewer still renders complete frames. Direct WebUSB continues using FRAME7.
This extension is independent of the unresolved USB transaction-error diagnosis.

Direct WebUSB streamed real high-speed FRAME7 captures in Chrome on macOS.
Browser measurements and FFT match the Python implementation on checked data.
The separated Python bridge also streamed live captures. Extended direct-control
browser checks remain pending a device grant, and grounded self-calibration is
currently bridge-only. Other OS/browser combinations have not been qualified.

With recent firmware, background settings refresh first checks `UI REVISION`.
Unchanged controls avoid the full settings sweep while waveform and activity
polling continue; firmware without that command retains periodic full refreshes.

Arithmetic Math is rendered as a magenta trace on the primary waveform grid,
using the LCD Math scale and position. FFT and XY use the primary graph with
frequency or voltage axes. Both transports calculate these results on the host
from the incoming raw channels. Panel/LCD Math selections, including subtraction
order, update the host calculation when settings are read back; changes also
reprocess a stopped capture. Tools selections continue to mirror back to the LCD.

## Hosting

The files in `src/slopscope_web/static/` can be served directly over HTTPS,
including GitHub Pages. Direct WebUSB needs Chrome/Edge and the user's explicit
USB-device permission. Python bridge mode runs locally through the firmware
repo's included USB package.

Repository privacy and website privacy are separate. Pages from a private repo
normally publishes a public site and requires an eligible paid plan. Private
Pages sites require an Enterprise Cloud organization. A public site necessarily
makes its deployed HTML and JavaScript downloadable even if its repo is private.

## License

First-party code is MIT-licensed; see [LICENSE](LICENSE). Development dependencies
are installed separately and retain their own licenses.
