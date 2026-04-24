import type { PlaybackConfig } from "./protocol"

export class BitmapFrame {
  width: number
  height: number
  private pixels: Uint8ClampedArray

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
    this.pixels = new Uint8ClampedArray(width * height * 3)
  }

  static fromRgbBytes(width: number, height: number, payload: Uint8Array | ArrayBuffer): BitmapFrame {
    const expected = width * height * 3
    const b = payload instanceof ArrayBuffer ? new Uint8Array(payload) : new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength)
    if (b.length < expected) {
      throw new Error(`Expected ${expected} bytes, got ${b.length}`)
    }
    const frame = new BitmapFrame(width, height)
    for (let i = 0; i < width * height; i++) {
      const base = i * 3
      frame.pixels[base] = b[base]
      frame.pixels[base + 1] = b[base + 1]
      frame.pixels[base + 2] = b[base + 2]
    }
    return frame
  }

  /** Column-major: index = x*height + y, same as Python to_rgb order */
  getRgb(x: number, y: number): [number, number, number] {
    const i = (x * this.height + y) * 3
    return [this.pixels[i], this.pixels[i + 1], this.pixels[i + 2]]
  }

  setRgb(x: number, y: number, r: number, g: number, b: number) {
    const o = (x * this.height + y) * 3
    this.pixels[o] = r
    this.pixels[o + 1] = g
    this.pixels[o + 2] = b
  }

  clear(r = 0, g = 0, b = 0) {
    for (let i = 0; i < this.pixels.length; i += 3) {
      this.pixels[i] = r
      this.pixels[i + 1] = g
      this.pixels[i + 2] = b
    }
  }

  resize(nw: number, nh: number) {
    const w = this.width
    const h = this.height
    const next = new BitmapFrame(nw, nh)
    const mw = Math.min(nw, w)
    const mh = Math.min(nh, h)
    for (let x = 0; x < mw; x++) {
      for (let y = 0; y < mh; y++) {
        const o = (x * h + y) * 3
        const d = (x * nh + y) * 3
        next.pixels[d] = this.pixels[o]
        next.pixels[d + 1] = this.pixels[o + 1]
        next.pixels[d + 2] = this.pixels[o + 2]
      }
    }
    this.width = nw
    this.height = nh
    this.pixels = next.pixels
  }

  toRgbBytes(): Uint8Array {
    return new Uint8Array(this.pixels)
  }

  columnToRgbBytes(x: number): Uint8Array {
    const n = this.height * 3
    const out = new Uint8Array(n)
    const row = (x: number) => (x * this.height) * 3
    let o = 0
    for (let y = 0; y < this.height; y++) {
      const s = row(x) + y * 3
      out[o++] = this.pixels[s]
      out[o++] = this.pixels[s + 1]
      out[o++] = this.pixels[s + 2]
    }
    return out
  }
}

export function readConfigFromDataView(dv: DataView): PlaybackConfig {
  const text = new TextDecoder().decode(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength))
  return JSON.parse(text) as PlaybackConfig
}

export function buildConfigBuffer(config: PlaybackConfig): ArrayBuffer {
  return new TextEncoder().encode(JSON.stringify(config)).buffer
}
