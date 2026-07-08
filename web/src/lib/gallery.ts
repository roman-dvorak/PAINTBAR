import type { PlaybackConfig } from "./protocol"
import { BitmapFrame } from "./bitmap"

export type GalleryTheme = {
  name: string
  savedAt: number
  config: PlaybackConfig
  bitmap: { width: number; height: number; rgbBase64: string }
}

const STORAGE_KEY = "paintbar.gallery.v1"

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

export function listThemes(): GalleryTheme[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw) as GalleryTheme[]
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

function saveAll(themes: GalleryTheme[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(themes))
}

export function saveTheme(name: string, config: PlaybackConfig, frame: BitmapFrame): GalleryTheme {
  const theme: GalleryTheme = {
    name,
    savedAt: Date.now(),
    config,
    bitmap: {
      width: frame.width,
      height: frame.height,
      rgbBase64: bytesToBase64(frame.toRgbBytes()),
    },
  }
  const themes = listThemes().filter((t) => t.name !== name)
  themes.push(theme)
  saveAll(themes)
  return theme
}

export function deleteTheme(name: string) {
  saveAll(listThemes().filter((t) => t.name !== name))
}

export function loadThemeFrame(theme: GalleryTheme): BitmapFrame {
  return BitmapFrame.fromRgbBytes(theme.bitmap.width, theme.bitmap.height, base64ToBytes(theme.bitmap.rgbBase64))
}
