from __future__ import annotations

import asyncio
import json
from dataclasses import asdict
from collections.abc import Callable

from bleak import BleakClient, BleakScanner
from bleak.backends.characteristic import BleakGATTCharacteristic

from .bitmap_model import BitmapFrame
from .protocol import (
    BITMAP_CHAR_UUID,
    CONFIG_CHAR_UUID,
    CONTROL_CHAR_UUID,
    DEFAULT_CHUNK_SIZE,
    SERVICE_UUID,
    BitmapCommand,
    ControlCommand,
    PlaybackConfig,
)


class PaintbarBleClient:
    def __init__(self) -> None:
        self._client: BleakClient | None = None
        self._download_buffer = bytearray()
        self._download_complete: asyncio.Event | None = None
        self._status_callback: Callable[[str], None] | None = None
        self._chars: dict[str, BleakGATTCharacteristic] = {}

    def set_status_callback(self, callback: Callable[[str], None]) -> None:
        self._status_callback = callback

    def _emit(self, message: str) -> None:
        if self._status_callback:
            self._status_callback(message)

    async def discover(self) -> list[tuple[str, str]]:
        self._emit("Skenuji BLE zařízení (timeout 4 s)...")
        devices = await BleakScanner.discover(return_adv=True, timeout=4.0)
        self._emit(f"Nalezeno celkem {len(devices)} BLE zařízení:")
        results: list[tuple[str, str]] = []
        for address, (device, adv) in devices.items():
            uuids = {uuid.lower() for uuid in adv.service_uuids or []}
            self._emit(
                f"  [{address}] name={device.name!r}  rssi={adv.rssi}  "
                f"uuids={list(adv.service_uuids or [])}"
            )
            if SERVICE_UUID.lower() in uuids or (device.name and "PAINTBAR" in device.name.upper()):
                self._emit(f"    -> PAINTBAR zařízení nalezeno!")
                results.append((device.name or "Unknown", address))
            else:
                self._emit(f"    -> přeskočeno (neshoduje se UUID ani název)")
        if not results:
            self._emit("Žádné PAINTBAR zařízení nebylo nalezeno.")
        return results

    async def connect(self, address: str) -> None:
        self._client = BleakClient(address)
        await self._client.connect()
        self._emit(f"Připojeno: {address}")
        services = self._client.services
        self._chars.clear()
        self._emit("Nalezené GATT služby a charakteristiky:")
        for service in services:
            self._emit(f"  service {service.uuid}")
            for char in service.characteristics:
                properties = ",".join(char.properties)
                self._emit(f"    char {char.uuid}  props=[{properties}]  handle={char.handle}")
                self._chars[char.uuid.lower()] = char

    async def disconnect(self) -> None:
        if self._client and self._client.is_connected:
            await self._client.disconnect()
            self._emit("Odpojeno")

    async def read_config(self) -> PlaybackConfig:
        self._ensure_client()
        config_char = self._require_char(CONFIG_CHAR_UUID, "read")
        payload = await self._client.read_gatt_char(config_char)
        self._emit(f"Config raw ({len(payload)} B): {payload.hex(' ')}")
        try:
            text = payload.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise RuntimeError(
                "Konfigurační charakteristika nevrátila UTF-8 JSON. "
                f"Raw payload: {payload.hex(' ')}"
            ) from exc
        self._emit(f"Config text: {text}")
        data = json.loads(text)
        return PlaybackConfig(**data)

    async def write_config(self, config: PlaybackConfig) -> None:
        self._ensure_client()
        config_char = self._require_char(CONFIG_CHAR_UUID, "write")
        payload = json.dumps(asdict(config)).encode("utf-8")
        await self._client.write_gatt_char(config_char, payload, response=True)
        self._emit("Konfigurace nahrána")

    async def send_control(self, command: ControlCommand) -> None:
        self._ensure_client()
        control_char = self._require_char(CONTROL_CHAR_UUID, "write")
        await self._client.write_gatt_char(control_char, bytes([command]), response=True)

    async def upload_bitmap(self, frame: BitmapFrame) -> None:
        self._ensure_client()
        bitmap_char = self._require_char(BITMAP_CHAR_UUID, "write")
        payload = frame.to_rgb_bytes()
        chunk_count = (len(payload) + DEFAULT_CHUNK_SIZE - 1) // DEFAULT_CHUNK_SIZE
        self._emit(
            f"Nahrávám bitmapu {frame.width} x {frame.height}, {len(payload)} B, {chunk_count} chunků"
        )
        header = bytearray([BitmapCommand.START_UPLOAD])
        header.extend(frame.width.to_bytes(2, "little"))
        header.extend(frame.height.to_bytes(2, "little"))
        header.extend(len(payload).to_bytes(4, "little"))
        await self._client.write_gatt_char(bitmap_char, bytes(header), response=True)

        next_progress = 25
        for offset in range(0, len(payload), DEFAULT_CHUNK_SIZE):
            chunk = payload[offset : offset + DEFAULT_CHUNK_SIZE]
            packet = bytearray([BitmapCommand.DATA])
            packet.extend(offset.to_bytes(4, "little"))
            packet.extend(chunk)
            await self._client.write_gatt_char(bitmap_char, bytes(packet), response=True)
            progress = ((offset + len(chunk)) * 100) // max(1, len(payload))
            if progress >= next_progress:
                self._emit(f"Upload bitmapy: {progress} %")
                next_progress += 25

        await self._client.write_gatt_char(
            bitmap_char,
            bytes([BitmapCommand.COMMIT]),
            response=True,
        )
        await asyncio.sleep(0.2)
        self._emit("Bitmapa nahrána")

    async def preview_column(self, frame: BitmapFrame, column: int) -> None:
        self._ensure_client()
        bitmap_char = self._require_char(BITMAP_CHAR_UUID, "write")
        payload = frame.column_to_rgb_bytes(column)

        header = bytearray([BitmapCommand.START_COLUMN_PREVIEW])
        header.extend(column.to_bytes(2, "little"))
        header.extend(len(payload).to_bytes(2, "little"))
        await self._client.write_gatt_char(bitmap_char, bytes(header), response=True)

        for offset in range(0, len(payload), DEFAULT_CHUNK_SIZE):
            chunk = payload[offset : offset + DEFAULT_CHUNK_SIZE]
            packet = bytearray([BitmapCommand.COLUMN_PREVIEW_DATA])
            packet.extend(offset.to_bytes(2, "little"))
            packet.extend(chunk)
            await self._client.write_gatt_char(bitmap_char, bytes(packet), response=True)

        await self._client.write_gatt_char(
            bitmap_char,
            bytes([BitmapCommand.APPLY_COLUMN_PREVIEW]),
            response=True,
        )
        self._emit(f"Live preview sloupce {column + 1}")

    async def download_bitmap(self, width: int, height: int) -> BitmapFrame:
        self._ensure_client()
        bitmap_char = self._require_char(BITMAP_CHAR_UUID, "write")
        self._download_buffer = bytearray()
        self._download_complete = asyncio.Event()

        await self._client.start_notify(bitmap_char, self._on_bitmap_notify)
        total_bytes = width * height * 3
        offset = 0
        while offset < total_bytes:
            request = bytearray([BitmapCommand.REQUEST_DOWNLOAD])
            request.extend(offset.to_bytes(4, "little"))
            request.extend(DEFAULT_CHUNK_SIZE.to_bytes(2, "little"))
            await self._client.write_gatt_char(bitmap_char, bytes(request), response=True)
            await asyncio.wait_for(self._download_complete.wait(), timeout=3.0)
            self._download_complete.clear()
            offset = len(self._download_buffer)

        await self._client.stop_notify(bitmap_char)
        self._emit("Bitmapa stažena")
        return BitmapFrame.from_rgb_bytes(width, height, bytes(self._download_buffer[:total_bytes]))

    def _on_bitmap_notify(self, _: str, data: bytearray) -> None:
        if not data:
            return
        command = data[0]
        if command == BitmapCommand.DOWNLOAD_CHUNK:
            offset = int.from_bytes(data[1:5], "little")
            length = int.from_bytes(data[5:7], "little")
            chunk = bytes(data[7 : 7 + length])
            if len(self._download_buffer) < offset + length:
                self._download_buffer.extend(b"\x00" * (offset + length - len(self._download_buffer)))
            self._download_buffer[offset : offset + length] = chunk
            if self._download_complete is not None:
                self._download_complete.set()
        elif command == BitmapCommand.DOWNLOAD_END:
            if self._download_complete is not None:
                self._download_complete.set()

    def _ensure_client(self) -> None:
        if not self._client or not self._client.is_connected:
            raise RuntimeError("BLE klient není připojen")

    def _require_char(self, uuid: str, required_property: str) -> BleakGATTCharacteristic:
        characteristic = self._chars.get(uuid.lower())
        if characteristic is None:
            raise RuntimeError(f"Nebyla nalezena BLE charakteristika {uuid}")
        if required_property not in characteristic.properties:
            raise RuntimeError(
                f"Charakteristika {uuid} nemá vlastnost '{required_property}'. "
                f"Dostupné: {characteristic.properties}"
            )
        return characteristic
