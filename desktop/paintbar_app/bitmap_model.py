from __future__ import annotations

from dataclasses import dataclass, field

from PyQt6.QtGui import QColor


@dataclass(slots=True)
class BitmapFrame:
    width: int
    height: int
    pixels: list[QColor] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not self.pixels:
            self.pixels = [QColor("black") for _ in range(self.width * self.height)]

    def index(self, x: int, y: int) -> int:
        return x * self.height + y

    def color(self, x: int, y: int) -> QColor:
        return self.pixels[self.index(x, y)]

    def set_color(self, x: int, y: int, color: QColor) -> None:
        self.pixels[self.index(x, y)] = QColor(color)

    def clear(self, color: QColor | None = None) -> None:
        fill = color or QColor("black")
        for idx in range(len(self.pixels)):
            self.pixels[idx] = QColor(fill)

    def resize(self, width: int, height: int) -> None:
        old = self.pixels[:]
        old_width = self.width
        old_height = self.height
        self.width = width
        self.height = height
        self.pixels = [QColor("black") for _ in range(width * height)]
        for x in range(min(width, old_width)):
            for y in range(min(height, old_height)):
                self.pixels[self.index(x, y)] = old[x * old_height + y]

    def to_rgb_bytes(self) -> bytes:
        raw = bytearray()
        for color in self.pixels:
            raw.extend((color.red(), color.green(), color.blue()))
        return bytes(raw)

    def column_to_rgb_bytes(self, x: int) -> bytes:
        raw = bytearray()
        for y in range(self.height):
            color = self.color(x, y)
            raw.extend((color.red(), color.green(), color.blue()))
        return bytes(raw)

    @classmethod
    def from_rgb_bytes(cls, width: int, height: int, payload: bytes) -> "BitmapFrame":
        expected = width * height * 3
        if len(payload) != expected:
            raise ValueError(f"Expected {expected} bytes, got {len(payload)}")
        frame = cls(width=width, height=height)
        for idx in range(width * height):
            base = idx * 3
            frame.pixels[idx] = QColor(payload[base], payload[base + 1], payload[base + 2])
        return frame
