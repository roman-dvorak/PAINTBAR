import type { BitmapFrame } from "./bitmap"

type Rgb = [number, number, number]

function inBounds(f: BitmapFrame, x: number, y: number) {
  return x >= 0 && y >= 0 && x < f.width && y < f.height
}

export function drawLine(f: BitmapFrame, x0: number, y0: number, x1: number, y1: number, c: Rgb) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 0)
  for (let i = 0; i <= steps; i++) {
    const t = steps ? i / steps : 0
    const x = Math.round(x0 + (x1 - x0) * t)
    const y = Math.round(y0 + (y1 - y0) * t)
    if (inBounds(f, x, y)) f.setRgb(x, y, c[0], c[1], c[2])
  }
}

function drawHLine(f: BitmapFrame, y: number, x0: number, x1: number, c: Rgb) {
  for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
    if (inBounds(f, x, y)) f.setRgb(x, y, c[0], c[1], c[2])
  }
}

export function drawRect(
  f: BitmapFrame,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  c: Rgb,
  filled: boolean,
) {
  const l = Math.min(x0, x1)
  const r = Math.max(x0, x1)
  const t = Math.min(y0, y1)
  const b = Math.max(y0, y1)
  if (filled) {
    for (let y = t; y <= b; y++) for (let x = l; x <= r; x++) if (inBounds(f, x, y)) f.setRgb(x, y, c[0], c[1], c[2])
  } else {
    drawHLine(f, t, l, r, c)
    drawHLine(f, b, l, r, c)
    for (let y = t; y <= b; y++) {
      if (inBounds(f, l, y)) f.setRgb(l, y, c[0], c[1], c[2])
      if (inBounds(f, r, y)) f.setRgb(r, y, c[0], c[1], c[2])
    }
  }
}

export function drawEllipse(
  f: BitmapFrame,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  c: Rgb,
  filled: boolean,
) {
  const l = Math.min(x0, x1)
  const r = Math.max(x0, x1)
  const t2 = Math.min(y0, y1)
  const b2 = Math.max(y0, y1)
  if (l > r || t2 > b2) return
  const rx = (r - l) / 2
  const ry = (b2 - t2) / 2
  const cx = l + rx
  const cy = t2 + ry
  const ax = Math.max(rx, 0.1)
  const ay = Math.max(ry, 0.1)
  const t = 0.22 / (Math.hypot(1 / ax, 1 / ay) + 0.1)
  for (let y = t2; y <= b2; y++) for (let x = l; x <= r; x++) {
    const u = (x - cx) / ax
    const v = (y - cy) / ay
    const s = u * u + v * v
    if (!inBounds(f, x, y)) continue
    if (filled) {
      if (s <= 1.02) f.setRgb(x, y, c[0], c[1], c[2])
    } else {
      if (s <= 1.02 && s >= (1 - t) * (1 - t)) f.setRgb(x, y, c[0], c[1], c[2])
    }
  }
}

export function floodFill(f: BitmapFrame, x: number, y: number, c: Rgb) {
  if (!inBounds(f, x, y)) return
  const target = f.getRgb(x, y)
  if (target[0] === c[0] && target[1] === c[1] && target[2] === c[2]) return
  const q: Array<[number, number]> = [[x, y]]
  const w = f.width
  const h = f.height
  while (q.length) {
    const [a, b] = q.pop()!
    if (a < 0 || b < 0 || a >= w || b >= h) continue
    const p = f.getRgb(a, b)
    if (p[0] !== target[0] || p[1] !== target[1] || p[2] !== target[2]) continue
    f.setRgb(a, b, c[0], c[1], c[2])
    q.push([a + 1, b], [a - 1, b], [a, b + 1], [a, b - 1])
  }
}

export function pickCssRgb(hex: string): Rgb {
  const el = document.createElement("canvas").getContext("2d")
  if (!el) return [0, 0, 0]
  el.fillStyle = hex
  const p = el.fillStyle as string
  const m = p.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])]
  if (p.startsWith("#") && p.length === 7) {
    return [
      parseInt(p.slice(1, 3), 16),
      parseInt(p.slice(3, 5), 16),
      parseInt(p.slice(5, 7), 16),
    ]
  }
  return [0, 0, 0]
}
