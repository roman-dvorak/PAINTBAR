import { BitmapFrame } from "./bitmap"

export function bitmapToPngBlob(
  f: BitmapFrame,
  scale = 4,
): Promise<Blob | null> {
  const c = document.createElement("canvas")
  c.width = f.width * scale
  c.height = f.height * scale
  const g = c.getContext("2d")
  if (!g) return Promise.resolve(null)
  g.imageSmoothingEnabled = false
  for (let y = 0; y < f.height; y++) for (let x = 0; x < f.width; x++) {
    const [r, gr, b] = f.getRgb(x, y)
    g.fillStyle = `rgb(${r},${gr},${b})`
    g.fillRect(x * scale, y * scale, scale, scale)
  }
  return new Promise((r) => c.toBlob((b) => r(b), "image/png"))
}

export function triggerDownload(data: Blob, name = "paintbar.png") {
  const a = document.createElement("a")
  a.href = URL.createObjectURL(data)
  a.download = name
  a.click()
  URL.revokeObjectURL(a.href)
}

export function loadImageDataToFrame(
  img: HTMLImageElement,
  w: number,
  h: number,
): BitmapFrame {
  const f = new BitmapFrame(w, h)
  const c = document.createElement("canvas")
  c.width = w
  c.height = h
  const g = c.getContext("2d")
  if (!g) return f
  g.imageSmoothingEnabled = false
  g.drawImage(img, 0, 0, w, h)
  const p = g.getImageData(0, 0, w, h).data
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4
    f.setRgb(x, y, p[o]!, p[o + 1]!, p[o + 2]!)
  }
  return f
}
