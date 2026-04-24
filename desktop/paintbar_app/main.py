from __future__ import annotations

import sys
import asyncio
import threading
from concurrent.futures import TimeoutError
from dataclasses import asdict

from PyQt6.QtCore import QSignalBlocker, QTimer, Qt, pyqtSignal
from PyQt6.QtGui import QColor
from PyQt6.QtWidgets import (
    QApplication,
    QCheckBox,
    QColorDialog,
    QComboBox,
    QDialog,
    QFormLayout,
    QGridLayout,
    QHBoxLayout,
    QLabel,
    QListWidget,
    QMainWindow,
    QMessageBox,
    QProgressBar,
    QPushButton,
    QSpinBox,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from .bitmap_model import BitmapFrame
from .ble_client import PaintbarBleClient
from .editor_widget import BitmapEditor
from .protocol import ControlCommand, PlaybackConfig


class AsyncRunner:
    def __init__(self) -> None:
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._run_loop, daemon=True)
        self._thread.start()

    def _run_loop(self) -> None:
        asyncio.set_event_loop(self._loop)
        self._loop.run_forever()

    def submit(self, coro):
        return asyncio.run_coroutine_threadsafe(coro, self._loop)

    def shutdown(self) -> None:
        self._loop.call_soon_threadsafe(self._loop.stop)
        self._thread.join(timeout=2)


class BusyDialog(QDialog):
    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setWindowTitle("Probíhá operace")
        self.setModal(True)
        self.setWindowFlag(Qt.WindowType.WindowContextHelpButtonHint, False)
        self.setWindowFlag(Qt.WindowType.WindowCloseButtonHint, False)
        self.setMinimumWidth(320)

        layout = QVBoxLayout(self)
        self._label = QLabel("Pracuji...")
        self._label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._bar = QProgressBar()
        self._bar.setRange(0, 0)

        layout.addWidget(self._label)
        layout.addWidget(self._bar)

    def set_message(self, text: str) -> None:
        self._label.setText(text)


class MainWindow(QMainWindow):
    log_signal = pyqtSignal(str)

    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("PAINTBAR Editor")
        self.resize(1200, 700)

        self._runner = AsyncRunner()
        self._client = PaintbarBleClient()
        self.log_signal.connect(self._append_log)
        self._client.set_status_callback(self.log_signal.emit)
        self._frame = BitmapFrame(width=64, height=160)
        self._editor = BitmapEditor(self._frame)
        self._selected_device: str | None = None

        self._device_list = QListWidget()
        self._led_count = QSpinBox()
        self._column_count = QSpinBox()
        self._period_us = QSpinBox()
        self._period_mode = QComboBox()
        self._playback_mode = QComboBox()
        self._start_mode = QComboBox()
        self._draw_mode = QCheckBox("Kreslici rezim")
        self._fixed_column = QCheckBox("Fixni sloupec")
        self._active_column = QSpinBox()
        self._tool_selector = QComboBox()
        self._preview_debounce_ms = QSpinBox()
        self._log = QTextEdit()
        self._log.setReadOnly(True)
        self._preview_timer = QTimer(self)
        self._preview_timer.setSingleShot(True)
        self._preview_timer.setInterval(120)
        self._preview_timer.timeout.connect(self._send_preview_now)
        self._action_buttons: list[QWidget] = []
        self._busy_dialog = BusyDialog(self)

        self._build_ui()

    def _build_ui(self) -> None:
        container = QWidget()
        layout = QHBoxLayout(container)

        left = QVBoxLayout()
        left.addWidget(QLabel("BLE zařízení"))
        left.addWidget(self._device_list)

        scan_btn = QPushButton("Najít zařízení")
        connect_btn = QPushButton("Připojit")
        read_btn = QPushButton("Načíst z desky")
        upload_btn = QPushButton("Nahrát do desky")
        upload_canvas_btn = QPushButton("Upload canvas")
        play_btn = QPushButton("Play")
        stop_btn = QPushButton("Stop")
        trigger_btn = QPushButton("Trigger")
        choose_color_btn = QPushButton("Barva")
        clear_btn = QPushButton("Smazat vše")
        fill_all_btn = QPushButton("Fill all")

        for button in [
            scan_btn,
            connect_btn,
            read_btn,
            upload_btn,
            upload_canvas_btn,
            play_btn,
            stop_btn,
            trigger_btn,
            choose_color_btn,
            clear_btn,
            fill_all_btn,
        ]:
            left.addWidget(button)

        form = QFormLayout()
        self._led_count.setRange(1, 256)
        self._led_count.setValue(160)
        self._column_count.setRange(1, 512)
        self._column_count.setValue(64)
        self._period_us.setRange(1, 5_000_000)
        self._period_us.setValue(20_000)
        self._period_mode.addItems(["fixed", "external"])
        self._playback_mode.addItems(["once", "loop", "ping_pong"])
        self._start_mode.addItems(["auto", "trigger"])
        self._draw_mode.setChecked(False)
        self._fixed_column.setChecked(False)
        self._active_column.setRange(1, self._column_count.value())
        self._active_column.setValue(1)
        self._tool_selector.addItems(
            ["Pen", "Eraser", "Line", "Rectangle", "Rect Fill", "Ellipse", "Ellipse Fill", "Fill"]
        )
        self._preview_debounce_ms.setRange(0, 2000)
        self._preview_debounce_ms.setValue(120)
        self._preview_debounce_ms.setSuffix(" ms")

        form.addRow("Počet LED", self._led_count)
        form.addRow("Počet sloupců", self._column_count)
        form.addRow("Perioda sloupce [us]", self._period_us)
        form.addRow("Režim periody", self._period_mode)
        form.addRow("Přehrávání", self._playback_mode)
        form.addRow("Start", self._start_mode)
        form.addRow(self._draw_mode)
        form.addRow(self._fixed_column)
        form.addRow("Aktivní sloupec", self._active_column)
        form.addRow("Nástroj", self._tool_selector)
        form.addRow("Preview debounce", self._preview_debounce_ms)
        left.addLayout(form)
        left.addWidget(QLabel("Log"))
        left.addWidget(self._log)

        right = QVBoxLayout()
        right.addWidget(self._editor, stretch=1)

        resize_grid = QGridLayout()
        apply_size_btn = QPushButton("Použít rozměr editoru")
        resize_grid.addWidget(QLabel("Bitmapa se kreslí po sloupcích."), 0, 0, 1, 2)
        resize_grid.addWidget(apply_size_btn, 1, 0, 1, 2)
        right.addLayout(resize_grid)

        layout.addLayout(left, stretch=0)
        layout.addLayout(right, stretch=1)
        self.setCentralWidget(container)
        self._action_buttons = [
            scan_btn,
            connect_btn,
            read_btn,
            upload_btn,
            upload_canvas_btn,
            play_btn,
            stop_btn,
            trigger_btn,
            choose_color_btn,
            clear_btn,
            fill_all_btn,
            self._led_count,
            self._column_count,
            self._period_us,
            self._period_mode,
            self._playback_mode,
            self._start_mode,
            self._draw_mode,
            self._fixed_column,
            self._active_column,
            self._tool_selector,
            self._preview_debounce_ms,
        ]

        scan_btn.clicked.connect(self._scan)
        connect_btn.clicked.connect(self._connect_selected)
        upload_btn.clicked.connect(self._upload)
        upload_canvas_btn.clicked.connect(self._upload_canvas)
        read_btn.clicked.connect(self._download)
        play_btn.clicked.connect(lambda: self._control(ControlCommand.PLAY))
        stop_btn.clicked.connect(lambda: self._control(ControlCommand.STOP))
        trigger_btn.clicked.connect(lambda: self._control(ControlCommand.TRIGGER))
        choose_color_btn.clicked.connect(self._choose_color)
        clear_btn.clicked.connect(self._clear_bitmap)
        fill_all_btn.clicked.connect(self._fill_all_bitmap)
        apply_size_btn.clicked.connect(self._apply_editor_size)
        self._led_count.valueChanged.connect(self._apply_editor_size)
        self._column_count.valueChanged.connect(self._apply_editor_size)
        self._active_column.valueChanged.connect(self._on_active_column_changed)
        self._tool_selector.currentTextChanged.connect(self._editor.set_tool)
        self._preview_debounce_ms.valueChanged.connect(self._preview_timer.setInterval)
        self._fixed_column.toggled.connect(self._on_fixed_column_toggled)
        self._draw_mode.toggled.connect(self._on_draw_mode_toggled)
        self._editor.bitmap_changed.connect(self._on_bitmap_changed)
        self._editor.column_selected.connect(self._on_editor_column_selected)
        self._editor.set_tool(self._tool_selector.currentText())
        self._on_draw_mode_toggled(self._draw_mode.isChecked())

    def _run_task(self, coro):
        return self._run_task_with_message(coro, "Pracuji...")

    def _run_quiet_task(self, coro):
        future = self._runner.submit(coro)
        try:
            while True:
                try:
                    return future.result(timeout=0.05)
                except TimeoutError:
                    QApplication.processEvents()
        except Exception as exc:  # noqa: BLE001
            self.log_signal.emit(f"Chyba: {exc}")
            return None

    def _run_task_with_message(self, coro, message: str):
        future = self._runner.submit(coro)
        self._set_busy(True, message)
        try:
            while True:
                try:
                    return future.result(timeout=0.05)
                except TimeoutError:
                    QApplication.processEvents()
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "Chyba", str(exc))
            self.log_signal.emit(f"Chyba: {exc}")
            return None
        finally:
            self._set_busy(False, "")

    def _scan(self) -> None:
        self._run_task_with_message(self._client.disconnect(), "Odpojuji předchozí spojení...")
        self._selected_device = None
        self._device_list.clear()
        devices = self._run_task_with_message(self._client.discover(), "Vyhledávám BLE zařízení...")
        if devices is None:
            return
        for name, address in devices:
            self._device_list.addItem(f"{name} | {address}")
        self.log_signal.emit(f"Nalezeno zařízení: {len(devices)}")

    def _connect_selected(self) -> None:
        item = self._device_list.currentItem()
        if not item:
            raise RuntimeError("Vyber BLE zařízení")
        self._selected_device = item.text().split("|")[-1].strip()
        if self._run_task_with_message(self._client.connect(self._selected_device), "Připojuji k zařízení...") is None:
            return
        config = self._run_task_with_message(self._client.read_config(), "Načítám konfiguraci...")
        if config is None:
            return
        self._apply_config(config)

    def _upload(self) -> None:
        config = self._collect_config(auto_start_after_upload=False)
        if self._run_task_with_message(self._client.write_config(config), "Ukládám konfiguraci do desky...") is None:
            return
        if self._run_task_with_message(self._client.upload_bitmap(self._frame), "Ukládám bitmapu do desky...") is None:
            return

    def _upload_canvas(self) -> None:
        self._preview_timer.stop()
        config = self._collect_config(auto_start_after_upload=True)
        if self._run_task_with_message(self._client.send_control(ControlCommand.STOP), "Zastavuji přehrávání...") is None:
            return
        if self._run_task_with_message(self._client.write_config(config), "Nahrávám canvas a konfiguraci...") is None:
            return
        if self._run_task_with_message(self._client.upload_bitmap(self._frame), "Nahrávám canvas a konfiguraci...") is None:
            return
        self._append_log("Canvas byl nahrán a firmware ho má ihned přehrávat.")

    def _download(self) -> None:
        config = self._run_task_with_message(self._client.read_config(), "Načítám konfiguraci z desky...")
        if config is None:
            return
        if config.led_count < 1 or config.column_count < 1:
            self.log_signal.emit("Chyba: deska vratila neplatnou konfiguraci, stahovani bitmapy preskoceno")
            return
        self._apply_config(config)
        frame = self._run_task_with_message(
            self._client.download_bitmap(config.column_count, config.led_count),
            "Stahuji bitmapu z desky...",
        )
        if frame is None:
            return
        self._frame = frame
        self._editor.set_frame(frame)

    def _control(self, command: ControlCommand) -> None:
        self._run_task_with_message(self._client.send_control(command), "Posílám příkaz do zařízení...")

    def _apply_editor_size(self) -> None:
        self._sync_frame_dimensions(self._column_count.value(), self._led_count.value())

    def _choose_color(self) -> None:
        color = QColorDialog.getColor(parent=self)
        if color.isValid():
            self._editor.set_selected_color(color)

    def _clear_bitmap(self) -> None:
        self._frame.clear(QColor("black"))
        self._editor.set_frame(self._frame)
        self._push_active_column_preview()

    def _fill_all_bitmap(self) -> None:
        color = self._editor.selected_color()
        self._frame.clear(color)
        self._editor.set_frame(self._frame)
        self._push_active_column_preview()

    def _apply_config(self, config: PlaybackConfig) -> None:
        if config.led_count < 1 or config.column_count < 1:
            self._append_log(f"Neplatna konfigurace z desky ignorovana: {asdict(config)}")
            return
        with QSignalBlocker(self._led_count), QSignalBlocker(self._column_count):
            self._led_count.setValue(config.led_count)
            self._column_count.setValue(config.column_count)
        with QSignalBlocker(self._period_us), QSignalBlocker(self._period_mode), QSignalBlocker(self._playback_mode), QSignalBlocker(self._start_mode):
            self._period_us.setValue(config.fixed_column_period_us)
            self._period_mode.setCurrentText(config.period_mode)
            self._playback_mode.setCurrentText(config.playback_mode)
            self._start_mode.setCurrentText(config.start_mode)
        self._sync_frame_dimensions(config.column_count, config.led_count)
        self._editor.set_active_column(self._active_column.value() - 1)
        self._append_log(f"Konfigurace načtena: {asdict(config)}")

    def _collect_config(self, auto_start_after_upload: bool) -> PlaybackConfig:
        width = self._column_count.value()
        height = self._led_count.value()
        self._sync_frame_dimensions(width, height)
        return PlaybackConfig(
            led_count=height,
            column_count=width,
            period_mode=self._period_mode.currentText(),
            playback_mode=self._playback_mode.currentText(),
            start_mode=self._start_mode.currentText(),
            fixed_column_period_us=self._period_us.value(),
            auto_start_after_upload=auto_start_after_upload,
        )

    def _append_log(self, message: str) -> None:
        print(message, flush=True)
        self._log.append(message)

    def _on_active_column_changed(self, value: int) -> None:
        self._editor.set_active_column(value - 1)
        self._push_active_column_preview()

    def _on_editor_column_selected(self, column: int) -> None:
        if self._fixed_column.isChecked():
            self._editor.set_active_column(self._active_column.value() - 1)
            return
        self._active_column.blockSignals(True)
        self._active_column.setValue(column + 1)
        self._active_column.blockSignals(False)
        self._editor.set_active_column(column)
        self._push_active_column_preview()

    def _on_bitmap_changed(self) -> None:
        self._push_active_column_preview()

    def _push_active_column_preview(self) -> None:
        if not self._draw_mode.isChecked():
            return
        if not self._selected_device:
            return
        self._preview_timer.start(self._preview_debounce_ms.value())

    def _send_preview_now(self) -> None:
        if not self._draw_mode.isChecked():
            return
        if not self._selected_device:
            return
        column = self._active_column.value() - 1
        self._run_quiet_task(self._client.preview_column(self._frame, column))

    def _on_fixed_column_toggled(self, checked: bool) -> None:
        self._editor.set_fixed_column_mode(checked and self._draw_mode.isChecked())

    def _on_draw_mode_toggled(self, checked: bool) -> None:
        self._fixed_column.setEnabled(checked)
        self._preview_debounce_ms.setEnabled(checked)
        self._active_column.setEnabled(checked)
        self._editor.set_fixed_column_mode(checked and self._fixed_column.isChecked())
        if not checked:
            self._preview_timer.stop()

    def _sync_frame_dimensions(self, width: int, height: int) -> None:
        target_width = max(1, width)
        target_height = max(1, height)
        if self._frame.width != target_width or self._frame.height != target_height:
            self._frame.resize(target_width, target_height)
            self._editor.set_frame(self._frame)
        current_column = min(self._active_column.value(), target_width)
        with QSignalBlocker(self._active_column):
            self._active_column.setRange(1, target_width)
            self._active_column.setValue(max(1, current_column))
        self._editor.set_active_column(self._active_column.value() - 1)

    def _set_busy(self, busy: bool, text: str) -> None:
        for widget in self._action_buttons:
            widget.setEnabled(not busy)
        self._busy_dialog.set_message(text or "Pracuji...")
        if busy:
            self._busy_dialog.show()
            self._busy_dialog.raise_()
            self._busy_dialog.activateWindow()
        else:
            self._busy_dialog.hide()
        QApplication.processEvents()

    def closeEvent(self, event) -> None:  # noqa: N802
        try:
            self._run_task(self._client.disconnect())
        except Exception:
            pass
        self._runner.shutdown()
        super().closeEvent(event)


def run() -> None:
    app = QApplication(sys.argv)
    app.setStyle("Fusion")
    window = MainWindow()
    window.show()
    sys.exit(app.exec())
