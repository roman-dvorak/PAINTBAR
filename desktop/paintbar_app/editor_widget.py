from __future__ import annotations

from collections import deque

from PyQt6.QtCore import QPoint, QRectF, Qt, pyqtSignal
from PyQt6.QtGui import QColor, QBrush, QImage, QMouseEvent, QPainter, QPen
from PyQt6.QtWidgets import QWidget

from .bitmap_model import BitmapFrame


class BitmapEditor(QWidget):
    bitmap_changed = pyqtSignal()
    column_selected = pyqtSignal(int)

    def __init__(self, frame: BitmapFrame, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._frame = frame
        self._image = self._image_from_frame(frame)
        self._selected_color = QColor("#ff2020")
        self._active_column = 0
        self._fixed_column_mode = False
        self._tool = "Pen"
        self._mouse_down = False
        self._last_point: tuple[int, int] | None = None
        self._preview_start: tuple[int, int] | None = None
        self._preview_end: tuple[int, int] | None = None
        self._erase_mode = False
        self.setMinimumSize(320, 220)

    @property
    def frame(self) -> BitmapFrame:
        return self._frame

    def set_frame(self, frame: BitmapFrame) -> None:
        self._frame = frame
        self._image = self._image_from_frame(frame)
        self._active_column = max(0, min(self._active_column, frame.width - 1))
        self.update()

    def set_selected_color(self, color: QColor) -> None:
        self._selected_color = QColor(color)

    def selected_color(self) -> QColor:
        return QColor(self._selected_color)

    def set_active_column(self, column: int) -> None:
        self._active_column = max(0, min(column, self._frame.width - 1))
        self.update()

    def set_fixed_column_mode(self, enabled: bool) -> None:
        self._fixed_column_mode = enabled
        self.update()

    def set_tool(self, tool: str) -> None:
        self._tool = tool
        self._erase_mode = tool == "Eraser"
        self._preview_start = None
        self._preview_end = None
        self.update()

    def paintEvent(self, event) -> None:  # noqa: N802
        painter = QPainter(self)
        painter.fillRect(self.rect(), QColor("#202124"))
        painter.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform, False)

        if not self._image.isNull():
            painter.drawImage(self.rect(), self._image)

        cell_width, _ = self._cell_metrics()
        if self._frame.width > 0:
            highlight_rect = QRectF(
                self._active_column * cell_width,
                0,
                cell_width,
                self.height(),
            )
            painter.fillRect(highlight_rect, QColor(255, 255, 255, 24))
            painter.setPen(QPen(QColor("#f5f5f5"), 2))
            painter.drawRect(highlight_rect)

        if self._preview_start and self._preview_end and self._tool in {
            "Line",
            "Rectangle",
            "Rect Fill",
            "Ellipse",
            "Ellipse Fill",
        }:
            self._paint_preview_shape(painter)

    def mousePressEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        point = self._pixel_at(event.position().toPoint())
        if point is None:
            return

        self._mouse_down = True
        self._last_point = point
        x, y = point
        self._set_active_column_from_point(x)
        erase = self._erase_mode or event.button() == Qt.MouseButton.RightButton

        if self._tool in {"Pen", "Eraser"}:
            self._set_pixel(point, erase=erase)
            self._commit_image_change()
        elif self._tool == "Fill":
            self._flood_fill(point, QColor("black") if erase else self._selected_color)
            self._commit_image_change()
        elif self._tool in {"Line", "Rectangle", "Rect Fill", "Ellipse", "Ellipse Fill"}:
            self._preview_start = point
            self._preview_end = point
            self.update()

    def mouseMoveEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        if not self._mouse_down:
            return
        point = self._pixel_at(event.position().toPoint())
        if point is None:
            return

        if self._tool in {"Pen", "Eraser"}:
            if self._last_point is not None:
                self._draw_line(
                    self._last_point,
                    point,
                    QColor("black") if (self._erase_mode or event.buttons() & Qt.MouseButton.RightButton) else self._selected_color,
                )
                self._commit_image_change()
            self._last_point = point
        elif self._tool in {"Line", "Rectangle", "Rect Fill", "Ellipse", "Ellipse Fill"}:
            self._preview_end = point
            self.update()

    def mouseReleaseEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        if not self._mouse_down:
            return
        self._mouse_down = False

        if self._tool == "Line" and self._preview_start and self._preview_end:
            self._draw_line(self._preview_start, self._preview_end, self._selected_color)
            self._commit_image_change()
        elif self._tool == "Rectangle" and self._preview_start and self._preview_end:
            self._draw_rectangle(self._preview_start, self._preview_end, self._selected_color)
            self._commit_image_change()
        elif self._tool == "Rect Fill" and self._preview_start and self._preview_end:
            self._draw_rectangle(self._preview_start, self._preview_end, self._selected_color, filled=True)
            self._commit_image_change()
        elif self._tool == "Ellipse" and self._preview_start and self._preview_end:
            self._draw_ellipse(self._preview_start, self._preview_end, self._selected_color)
            self._commit_image_change()
        elif self._tool == "Ellipse Fill" and self._preview_start and self._preview_end:
            self._draw_ellipse(self._preview_start, self._preview_end, self._selected_color, filled=True)
            self._commit_image_change()

        self._preview_start = None
        self._preview_end = None
        self._last_point = None
        self.update()

    def _paint_preview_shape(self, painter: QPainter) -> None:
        assert self._preview_start is not None
        assert self._preview_end is not None
        cell_width, cell_height = self._cell_metrics()
        painter.setPen(QPen(QColor("#ffffff"), 2))
        x1, y1 = self._preview_start
        x2, y2 = self._preview_end

        if self._tool == "Line":
            painter.drawLine(
                int((x1 + 0.5) * cell_width),
                int((y1 + 0.5) * cell_height),
                int((x2 + 0.5) * cell_width),
                int((y2 + 0.5) * cell_height),
            )
            return

        left = min(x1, x2) * cell_width
        top = min(y1, y2) * cell_height
        width = (abs(x2 - x1) + 1) * cell_width
        height = (abs(y2 - y1) + 1) * cell_height
        rect = QRectF(left, top, width, height)

        if self._tool == "Rectangle":
            painter.drawRect(rect)
        elif self._tool == "Rect Fill":
            painter.fillRect(rect, QColor(255, 255, 255, 64))
            painter.drawRect(rect)
        elif self._tool == "Ellipse":
            painter.drawEllipse(rect)
        elif self._tool == "Ellipse Fill":
            painter.setBrush(QBrush(QColor(255, 255, 255, 64)))
            painter.drawEllipse(rect)

    def _pixel_at(self, point: QPoint) -> tuple[int, int] | None:
        cell_width, cell_height = self._cell_metrics()
        x = self._active_column if self._fixed_column_mode else int(point.x() / cell_width)
        y = int(point.y() / cell_height)
        if x < 0 or y < 0 or x >= self._frame.width or y >= self._frame.height:
            return None
        return x, y

    def _cell_metrics(self) -> tuple[float, float]:
        width = max(1, self._frame.width)
        height = max(1, self._frame.height)
        return self.width() / width, self.height() / height

    def _set_active_column_from_point(self, x: int) -> None:
        if self._fixed_column_mode:
            return
        self._active_column = x
        self.column_selected.emit(x)

    def _set_pixel(self, point: tuple[int, int], erase: bool = False) -> None:
        x, y = point
        self._image.setPixelColor(x, y, QColor("black") if erase else self._selected_color)

    def _draw_line(self, start: tuple[int, int], end: tuple[int, int], color: QColor) -> None:
        painter = QPainter(self._image)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, False)
        painter.setPen(QPen(color, 1))
        painter.drawLine(QPoint(*start), QPoint(*end))
        painter.end()

    def _draw_rectangle(self, start: tuple[int, int], end: tuple[int, int], color: QColor, filled: bool = False) -> None:
        x1, y1 = start
        x2, y2 = end
        left = min(x1, x2)
        right = max(x1, x2)
        top = min(y1, y2)
        bottom = max(y1, y2)
        painter = QPainter(self._image)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, False)
        painter.setPen(QPen(color, 1))
        painter.setBrush(QBrush(color) if filled else Qt.BrushStyle.NoBrush)
        painter.drawRect(left, top, right - left, bottom - top)
        painter.end()

    def _draw_ellipse(self, start: tuple[int, int], end: tuple[int, int], color: QColor, filled: bool = False) -> None:
        x1, y1 = start
        x2, y2 = end
        left = min(x1, x2)
        right = max(x1, x2)
        top = min(y1, y2)
        bottom = max(y1, y2)
        painter = QPainter(self._image)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, False)
        painter.setPen(QPen(color, 1))
        painter.setBrush(QBrush(color) if filled else Qt.BrushStyle.NoBrush)
        painter.drawEllipse(left, top, right - left, bottom - top)
        painter.end()

    def _flood_fill(self, start: tuple[int, int], color: QColor) -> None:
        x, y = start
        target = self._image.pixelColor(x, y)
        if target == color:
            return

        queue: deque[tuple[int, int]] = deque([(x, y)])
        while queue:
            px, py = queue.popleft()
            if px < 0 or py < 0 or px >= self._frame.width or py >= self._frame.height:
                continue
            if self._image.pixelColor(px, py) != target:
                continue
            self._image.setPixelColor(px, py, color)
            queue.append((px + 1, py))
            queue.append((px - 1, py))
            queue.append((px, py + 1))
            queue.append((px, py - 1))

    def _commit_image_change(self) -> None:
        self._sync_frame_from_image()
        self.bitmap_changed.emit()
        self.update()

    def _sync_frame_from_image(self) -> None:
        for x in range(self._frame.width):
            for y in range(self._frame.height):
                self._frame.set_color(x, y, self._image.pixelColor(x, y))

    def _image_from_frame(self, frame: BitmapFrame) -> QImage:
        image = QImage(frame.width, frame.height, QImage.Format.Format_RGB32)
        image.fill(QColor("black"))
        for x in range(frame.width):
            for y in range(frame.height):
                image.setPixelColor(x, y, frame.color(x, y))
        return image
