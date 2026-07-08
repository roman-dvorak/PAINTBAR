from __future__ import annotations

from dataclasses import dataclass
from enum import IntEnum


SERVICE_UUID = "6f65f4de-f8c0-4f77-8a31-8fa7516f1000"
CONFIG_CHAR_UUID = "6f65f4de-f8c0-4f77-8a31-8fa7516f1001"
CONTROL_CHAR_UUID = "6f65f4de-f8c0-4f77-8a31-8fa7516f1002"
BITMAP_CHAR_UUID = "6f65f4de-f8c0-4f77-8a31-8fa7516f1003"


class BitmapCommand(IntEnum):
    START_UPLOAD = 0x01
    DATA = 0x02
    COMMIT = 0x03
    REQUEST_DOWNLOAD = 0x04
    CANCEL = 0x05
    START_COLUMN_PREVIEW = 0x06
    COLUMN_PREVIEW_DATA = 0x07
    APPLY_COLUMN_PREVIEW = 0x08
    DOWNLOAD_CHUNK = 0x84
    DOWNLOAD_END = 0x85
    ACK = 0x90
    ERROR = 0x91


class ControlCommand(IntEnum):
    PLAY = 0x01
    STOP = 0x02
    RESTART = 0x03
    TRIGGER = 0x04
    REQUEST_STATUS = 0x05


@dataclass(slots=True)
class PlaybackConfig:
    led_count: int = 160
    column_count: int = 64
    period_mode: str = "fixed"
    playback_mode: str = "loop"
    start_mode: str = "auto"
    trigger_button_mode: str = "one_shot"
    fixed_column_period_us: int = 20_000
    max_brightness: int = 128
    auto_start_after_upload: bool = True


DEFAULT_CHUNK_SIZE = 180
