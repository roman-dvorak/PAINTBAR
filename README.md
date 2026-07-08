# PAINTBAR

Aktuálně je projekt připraven pro `Seeed Studio XIAO ESP32-S3` a `WS2812B`.

Firmware aktuálně používá explicitní driver `WS2812B` s pořadím barev `GRB`.
Bitmapa i konfigurace se po nahrání ukládají do interní flash (`LittleFS`), takže po restartu zůstanou zachované.
Výchozí počet LED v řetězu je `160`.

Projekt obsahuje dvě části:

- `firmware/` - firmware pro `ESP32-S3` přes `PlatformIO`
- `desktop/` - desktopová `PyQt6` aplikace pro kreslení bitmapy a BLE přenos

## Funkční model

Bitmapa je uložena jako matice `width x height`, kde:

- `height` odpovídá počtu LED v řetězu
- `width` odpovídá počtu sloupců časové osy
- každý sloupec představuje jeden okamžik vykreslení celého LED pásku

Firmware přehrává sloupce po jednom. Perioda sloupce může být:

- pevná (`fixed`)
- dopočtená z měřeného externího triggeru (`external`)

Podporované režimy přehrávání:

- `once`
- `loop`
- `ping_pong`

Podporované spuštění:

- automaticky po zapnutí / po nahrání bitmapy
- externím triggerem

Po `Nahrát do desky` se bitmapa uloží a při zapnutém `auto_start_after_upload` se okamžitě spustí přehrávání.

## Firmware

Předpoklady:

- `PlatformIO`
- připojená deska `Seeed Studio XIAO ESP32-S3`

Sestavení:

```bash
cd /home/roman/repos/astrometers/PAINTBAR
pio run
```

Nahrání:

```bash
pio run -t upload
pio device monitor
```

Výchozí piny v [firmware/include/app_config.h](/home/roman/repos/astrometers/PAINTBAR/firmware/include/app_config.h:1):

- LED data: `D10 / GPIO9`
- externí trigger: `D1 / GPIO2`
- trigger tlačítko: `D0 / GPIO1`

Oba piny jsou zapojené jako aktivní-low s interním pull-upem (spínač/senzor stahuje pin na GND při aktivaci).

Externí trigger (`D1`) měří periodu mezi hranami a v režimu `period_mode=external`/`start_mode=trigger` slouží ke spouštění přehrávání a odvození periody sloupce, stejně jako dosud.

Trigger tlačítko (`D0`) má tři konfigurovatelné režimy (nastavitelné z webového UI, pole `trigger_button_mode`):

- `one_shot` — stisk spustí/restartuje přehrávání
- `hold` — přehrávání běží jen po dobu držení tlačítka
- `reset` — stisk vrátí přehrávání na první sloupec

Po bootu firmware spustí diagnostický LED test:

- běžící jedna LED v barvách `red`, `green`, `blue`
- potom vyplní celý aktivní řetěz barvami `red`, `green`, `blue`, `white`
- nakonec zhasne

## Desktop aplikace

Předpoklady:

- Python 3.11+
- BLE adaptér

Instalace:

```bash
cd /home/roman/repos/astrometers/PAINTBAR/desktop
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m paintbar_app
```

## BLE protokol

Zařízení publikuje službu `PAINTBAR` se třemi charakteristikami:

- `config`: JSON konfigurace přehrávání
- `control`: jednoduché povely a stav
- `bitmap`: chunkovaný upload/download dat bitmapy

Upload bitmapy:

1. `START_UPLOAD`
2. opakované `DATA`
3. `COMMIT`

Download bitmapy:

1. `REQUEST_DOWNLOAD`
2. zařízení posílá notifikace `DOWNLOAD_CHUNK`
3. `DOWNLOAD_END`
