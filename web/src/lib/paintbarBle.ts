import { BitmapFrame, buildConfigBuffer, readConfigFromDataView } from "./bitmap"
import {
  BITMAP_CHAR_UUID,
  CONFIG_CHAR_UUID,
  CONTROL_CHAR_UUID,
  DEFAULT_CHUNK_SIZE,
  BitmapCommand,
  SERVICE_UUID,
  type ControlCommandId,
  type PlaybackConfig,
} from "./protocol"

type Status = (m: string) => void
type ProgressCallback = (pct: number) => void

async function gattWrite(char: BluetoothRemoteGATTCharacteristic, data: ArrayBuffer) {
  if (char.properties.write) {
    await char.writeValueWithResponse(data)
  } else if (char.properties.writeWithoutResponse) {
    await char.writeValueWithoutResponse(new Uint8Array(data))
  } else {
    throw new Error("Char nemá write ani writeWithoutResponse")
  }
}

function le32(n: number): number {
  return n >>> 0
}

export class PaintbarBle {
  private device: BluetoothDevice | null = null
  private service: BluetoothRemoteGATTService | null = null
  private configChar: BluetoothRemoteGATTCharacteristic | null = null
  private controlChar: BluetoothRemoteGATTCharacteristic | null = null
  private bitmapChar: BluetoothRemoteGATTCharacteristic | null = null
  private notifyHandler: ((e: Event) => void) | null = null
  private onStatus: Status = () => {}

  setStatusCallback(fn: Status) {
    this.onStatus = fn
  }

  get connected() {
    return this.device?.gatt?.connected ?? false
  }

  get name() {
    return this.device?.name ?? "PAINTBAR"
  }

  async requestDevice() {
    if (!navigator.bluetooth) {
      throw new Error("Tento prohlížeč nemá Web Bluetooth (použijte Chrome, Edge, nebo Chrome na Androidu).")
    }
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [SERVICE_UUID] }, { namePrefix: "PAINT" }],
      optionalServices: [SERVICE_UUID],
    })
    return this.device
  }

  async connect() {
    if (!this.device?.gatt) {
      throw new Error("Není vybrané zařízení. Nejdřív se připojte.")
    }
    this.onStatus("Připojuji GATT…")
    const server = await this.device.gatt.connect()
    this.service = await server.getPrimaryService(SERVICE_UUID)
    this.configChar = await this.service.getCharacteristic(CONFIG_CHAR_UUID)
    this.controlChar = await this.service.getCharacteristic(CONTROL_CHAR_UUID)
    this.bitmapChar = await this.service.getCharacteristic(BITMAP_CHAR_UUID)
    this.onStatus("Připojeno k „" + (this.device.name || "?") + "“")
  }

  async disconnect() {
    try {
      if (this.bitmapChar && this.notifyHandler) {
        this.bitmapChar.removeEventListener("characteristicvaluechanged", this.notifyHandler)
        this.notifyHandler = null
        try {
          await this.bitmapChar.stopNotifications()
        } catch {
          /* */
        }
      }
      if (this.device?.gatt?.connected) {
        await this.device.gatt.disconnect()
        this.onStatus("Odpojeno")
      }
    } finally {
      this.configChar = null
      this.controlChar = null
      this.bitmapChar = null
      this.service = null
    }
  }

  async readConfig(): Promise<PlaybackConfig> {
    const c = this.configChar
    if (!c) throw new Error("Nejste připojeni")
    this.onStatus("Čtu konfiguraci…")
    const buf = await c.readValue()
    this.onStatus("Config raw (" + buf.byteLength + " B)")
    return readConfigFromDataView(buf)
  }

  async writeConfig(config: PlaybackConfig) {
    const c = this.configChar
    if (!c) throw new Error("Nejste připojeni")
    this.onStatus("Nahrávám konfiguraci…")
    await gattWrite(c, buildConfigBuffer(config))
  }

  async sendControl(cmd: ControlCommandId) {
    const c = this.controlChar
    if (!c) throw new Error("Nejste připojeni")
    await gattWrite(c, new Uint8Array([cmd]).buffer)
  }

  async uploadBitmap(frame: BitmapFrame, onProgress?: ProgressCallback) {
    const c = this.bitmapChar
    if (!c) throw new Error("Nejste připojeni")
    const payload = frame.toRgbBytes()
    const chunkSize = DEFAULT_CHUNK_SIZE
    const n = (payload.length + chunkSize - 1) / chunkSize | 0
    this.onStatus(`Nahrávám bitmapu ${frame.width}×${frame.height}, ${payload.length} B, ${n} chunků`)
    onProgress?.(0)

    const start = new Uint8Array(1 + 2 + 2 + 4)
    start[0] = BitmapCommand.START_UPLOAD
    const v = new DataView(start.buffer)
    v.setUint16(1, frame.width, true)
    v.setUint16(3, frame.height, true)
    v.setUint32(5, le32(payload.length), true)
    await gattWrite(c, start.buffer)

    for (let offset = 0; offset < payload.length; offset += chunkSize) {
      const part = payload.subarray(offset, offset + chunkSize)
      const p = new Uint8Array(1 + 4 + part.length)
      p[0] = BitmapCommand.DATA
      new DataView(p.buffer).setUint32(1, le32(offset), true)
      p.set(part, 5)
      await gattWrite(c, p.buffer)
      const pct = ((offset + part.length) * 100 / Math.max(1, payload.length)) | 0
      if (pct % 25 === 0 && offset > 0) this.onStatus("Upload: " + pct + " %")
      onProgress?.(pct)
    }
    await gattWrite(c, new Uint8Array([BitmapCommand.COMMIT]).buffer)
    await new Promise((r) => setTimeout(r, 200))
    onProgress?.(100)
    this.onStatus("Bitmapa nahrána")
  }

  async previewColumn(frame: BitmapFrame, column: number) {
    const c = this.bitmapChar
    if (!c) throw new Error("Nejste připojeni")
    const body = frame.columnToRgbBytes(column)
    const head = new Uint8Array(1 + 2 + 2)
    head[0] = BitmapCommand.START_COLUMN_PREVIEW
    const hdv = new DataView(head.buffer)
    hdv.setUint16(1, column, true)
    hdv.setUint16(3, body.length, true)
    await gattWrite(c, head.buffer)
    for (let offset = 0; offset < body.length; offset += DEFAULT_CHUNK_SIZE) {
      const part = body.subarray(offset, offset + DEFAULT_CHUNK_SIZE)
      const p = new Uint8Array(1 + 2 + part.length)
      p[0] = BitmapCommand.COLUMN_PREVIEW_DATA
      p[1] = offset & 0xff
      p[2] = (offset >> 8) & 0xff
      p.set(part, 3)
      await gattWrite(c, p.buffer)
    }
    await gattWrite(c, new Uint8Array([BitmapCommand.APPLY_COLUMN_PREVIEW]).buffer)
  }

  async downloadBitmap(w: number, h: number, onProgress?: ProgressCallback): Promise<BitmapFrame> {
    const c = this.bitmapChar
    if (!c) throw new Error("Nejste připojeni")
    const total = w * h * 3
    this.onStatus("Stahuji bitmapu " + w + "×" + h + "…")
    onProgress?.(0)
    const out = new Uint8Array(total)
    const maxChunk = DEFAULT_CHUNK_SIZE
    let filledEnd = 0
    let pendingDone: (() => void) | null = null

    const onNotify = (e: Event) => {
      const t = (e.target as BluetoothRemoteGATTCharacteristic).value
      if (!t) return
      const data = new Uint8Array(t.buffer, t.byteOffset, t.byteLength)
      if (data.length < 1) return
      const op = data[0]
      if (op === BitmapCommand.DOWNLOAD_CHUNK && data.length >= 7) {
        const o =
          (data[1] | (data[2] << 8) | (data[3] << 16) | (data[4] << 24)) >>> 0
        const plen = data[5] | (data[6] << 8)
        const piece = data.subarray(7, 7 + plen)
        if (o + plen <= out.length) {
          out.set(piece, o)
        }
        filledEnd = Math.max(filledEnd, o + plen)
        pendingDone?.()
        pendingDone = null
      } else if (op === BitmapCommand.DOWNLOAD_END) {
        pendingDone?.()
        pendingDone = null
      }
    }
    this.notifyHandler = onNotify
    c.addEventListener("characteristicvaluechanged", onNotify)
    await c.startNotifications()
    let next = 0
    try {
      while (next < total) {
        const req = new Uint8Array(1 + 4 + 2)
        req[0] = BitmapCommand.REQUEST_DOWNLOAD
        new DataView(req.buffer).setUint32(1, le32(next), true)
        new DataView(req.buffer).setUint16(5, maxChunk & 0xffff, true)
        const wait = new Promise<void>((resolve, reject) => {
          const tid = setTimeout(
            () => reject(new Error("Stahování: timeout 3s")),
            3000,
          )
          pendingDone = () => {
            clearTimeout(tid)
            resolve()
          }
        })
        await gattWrite(c, req.buffer)
        await wait
        next = filledEnd
        const pct = Math.min(100, (next * 100) / total)
        if (next < total) this.onStatus("Staženo " + pct + " %")
        onProgress?.(pct)
      }
    } finally {
      c.removeEventListener("characteristicvaluechanged", onNotify)
      this.notifyHandler = null
      try {
        await c.stopNotifications()
      } catch {
        /* */
      }
    }
    onProgress?.(100)
    this.onStatus("Bitmapa stažena")
    return BitmapFrame.fromRgbBytes(w, h, out)
  }
}
