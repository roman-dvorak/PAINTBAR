# PAINTBAR

**Paint with light.**

PAINTBAR turns an LED strip into a brush. Draw an image in your browser, send it to the
board over Bluetooth, and sweep the strip through a long-exposure photograph — the picture
you drew appears in mid-air, painted in light.

No app to install and no cables once it is flashed. The web editor talks to the board
directly over Web Bluetooth, so you can redraw a frame, push it, and shoot the next take in
seconds. The board remembers everything: your artwork, your timing, and your last settings
all survive a power cycle.

- **Draw anywhere** — browser-based editor, nothing to install
- **Wireless** — Bluetooth LE, no cable during a shoot
- **Instant iteration** — live column preview while you draw
- **Camera-friendly** — free-run at a fixed speed, or lock the sweep to an external trigger
- **Remembers your work** — artwork and settings persist in flash

---

## Hardware

The project currently targets `Seeed Studio XIAO ESP32-S3` driving a `WS2812B` strip.

| Signal | Pin |
| --- | --- |
| LED data | `D10` / `GPIO9` |
| External trigger | `D1` / `GPIO2` |
| Trigger button | `D0` / `GPIO1` |

Pin assignments live in [`firmware/include/app_config.h`](firmware/include/app_config.h).

Both trigger inputs are active-low with internal pull-ups — the switch or sensor pulls the
pin to `GND` when active. The firmware uses the explicit `WS2812B` driver with `GRB` colour
order, and supports up to `320` LEDs (`kMaxLedCount`).

A pull-down resistor on the LED data line is recommended. Until the ROM bootloader hands
control to the firmware, `GPIO9` floats, and the first WS2812 may latch noise as a bright
white pixel.

## Repository layout

| Path | Contents |
| --- | --- |
| `firmware/` | ESP32-S3 firmware, built with PlatformIO |
| `web/` | React + TypeScript editor, deployed to GitHub Pages |
| `desktop/` | PyQt6 desktop editor (BLE, alternative to the web app) |

## How it works

A frame is a `width x height` matrix:

- `height` — number of LEDs in the strip
- `width` — number of columns along the time axis

Each column is one instant of the whole strip. The firmware plays the columns one at a
time; the camera's open shutter turns that sequence into a two-dimensional image.

Column period is either:

- `fixed` — a configured interval in microseconds
- `external` — derived from the measured period of the external trigger

Playback modes are `once`, `loop`, and `ping_pong`. Playback starts either automatically
(on power-up, and after an upload when `auto_start_after_upload` is set) or from a trigger.

### Idle state

When playback is not running, `idle_display_mode` decides what the strip shows:

- `edge` — the first or last column of the frame
- `black` — strip off
- `solid` — the last solid colour set from the UI

The solid colour is stored in the configuration, so it survives a reboot. Precedence rule:
a remembered solid colour wins over auto-start, otherwise playback would immediately paint
over it. Pressing **Play** or uploading a new frame clears the solid state and returns
`idle_display_mode` to `edge` — the most recent action wins.

### Trigger button

The trigger button (`D0`) has three modes, selectable in the UI via `trigger_button_mode`:

- `one_shot` — a press starts or restarts playback
- `hold` — playback runs only while the button is held
- `reset` — a press returns playback to the first column

The external trigger (`D1`) measures the period between edges. With
`period_mode=external` / `start_mode=trigger` it both starts playback and derives the
column period.

### Startup signal

After boot the firmware blinks the first and last LED of the strip together with the
board's user LED three times, at roughly 10 % brightness. It confirms that the firmware is
running and that both ends of the strip are alive.

### Persistence

The frame and the configuration are written to internal flash (`LittleFS`) as
`/bitmap.raw` and `/config.json`, and reloaded on boot.

## Firmware

Requirements: `PlatformIO` and a `Seeed Studio XIAO ESP32-S3`.

```bash
pio run                  # build
pio run -t upload        # flash
pio device monitor       # serial log, 115200 baud
```

FastLED is pinned to `3.6.0` rather than a caret range: `^3.6.0` also resolves to `3.10.x`,
which switches to a different RMT driver on the ESP32-S3.

## Web app

```bash
cd web
npm install
npm run dev              # development server
npm run build            # production build into web/dist
```

Web Bluetooth requires a Chromium-based browser and a secure context (`https://` or
`localhost`). Pushing to `main` deploys the app to GitHub Pages via
`.github/workflows/`; set `VITE_BASE_PATH` if the app is not served from the domain root.

## Desktop app

Requirements: Python 3.11+ and a BLE adapter.

```bash
cd desktop
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m paintbar_app
```

## BLE protocol

The device advertises as `PAINTBAR` with one service and three characteristics:

| Characteristic | UUID | Purpose |
| --- | --- | --- |
| Service | `6f65f4de-f8c0-4f77-8a31-8fa7516f1000` | — |
| `config` | `...1001` | playback configuration, JSON |
| `control` | `...1002` | commands and runtime status |
| `bitmap` | `...1003` | chunked frame upload and download |

### Configuration

`config` is read and written as a JSON object:

```json
{
  "led_count": 320,
  "column_count": 64,
  "period_mode": "fixed",
  "playback_mode": "loop",
  "start_mode": "auto",
  "trigger_button_mode": "one_shot",
  "idle_display_mode": "edge",
  "solid_color_r": 0,
  "solid_color_g": 0,
  "solid_color_b": 0,
  "fixed_column_period_us": 20000,
  "max_brightness": 128,
  "auto_start_after_upload": true
}
```

Writes are partial-friendly: fields absent from the written JSON keep their current value.

### Control commands

| Command | Byte | Payload |
| --- | --- | --- |
| `PLAY` | `0x01` | — |
| `STOP` | `0x02` | — |
| `RESTART` | `0x03` | — |
| `TRIGGER` | `0x04` | — |
| `REQUEST_STATUS` | `0x05` | — |
| `SET_SOLID_COLOR` | `0x06` | `r`, `g`, `b` |
| `STATUS` | `0x80` | notification, JSON |

### Bitmap transfer

Upload:

1. `START_UPLOAD` (`0x01`) with `width`, `height`, and total byte count
2. repeated `DATA` (`0x02`), each carrying a 32-bit offset and its payload
3. `COMMIT` (`0x03`)

Each step is answered with `ACK` (`0x90`) or `ERROR` (`0x91`). The commit acknowledgement
is sent as soon as the frame is live in RAM; the flash write happens afterwards, because a
full-size frame takes longer to persist than a client would reasonably wait.

Download:

1. `REQUEST_DOWNLOAD` (`0x04`)
2. the device notifies with `DOWNLOAD_CHUNK` (`0x84`)
3. `DOWNLOAD_END` (`0x85`)

A single column can also be previewed without touching the stored frame, using
`START_COLUMN_PREVIEW` (`0x06`), `COLUMN_PREVIEW_DATA` (`0x07`), and
`APPLY_COLUMN_PREVIEW` (`0x08`). `CANCEL` (`0x05`) aborts an upload in progress.
