import { useEffect, useRef, useState } from "react"
import type { PlaybackConfig } from "../lib/protocol"
import { BitmapFrame } from "../lib/bitmap"
import { deleteTheme, listThemes, saveTheme, loadThemeFrame, type GalleryTheme } from "../lib/gallery"

function ThumbCanvas({ frame }: { frame: BitmapFrame }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current
    if (!c) return
    const g = c.getContext("2d")
    if (!g) return
    c.width = frame.width
    c.height = frame.height
    g.imageSmoothingEnabled = false
    for (let y = 0; y < frame.height; y++) {
      for (let x = 0; x < frame.width; x++) {
        const [r, gr, b] = frame.getRgb(x, y)
        g.fillStyle = `rgb(${r},${gr},${b})`
        g.fillRect(x, y, 1, 1)
      }
    }
  }, [frame])
  return <canvas ref={ref} className="gallery__thumb" />
}

export function Gallery({
  currentConfig,
  currentFrame,
  onLoad,
  push,
}: {
  currentConfig: () => PlaybackConfig
  currentFrame: () => BitmapFrame
  onLoad: (config: PlaybackConfig, frame: BitmapFrame) => void
  push: (msg: string) => void
}) {
  const [themes, setThemes] = useState<GalleryTheme[]>(() => listThemes())
  const [name, setName] = useState("")

  const refresh = () => setThemes(listThemes())

  return (
    <>
      <h2>Galerie</h2>
      <div className="btnrow">
        <input
          type="text"
          placeholder="Název motivu"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button
          className="btn sm"
          type="button"
          disabled={!name.trim()}
          onClick={() => {
            try {
              saveTheme(name.trim(), currentConfig(), currentFrame())
              setName("")
              refresh()
            } catch (e) {
              push("Uložení do galerie selhalo: " + String(e))
            }
          }}
        >
          Uložit jako
        </button>
      </div>
      {themes.length === 0 && <p className="app__muted">Zatím žádné uložené motivy.</p>}
      <ul className="gallery__list">
        {themes.map((t) => (
          <li key={t.name} className="gallery__item">
            <ThumbCanvas frame={loadThemeFrame(t)} />
            <span className="gallery__name">{t.name}</span>
            <div className="btnrow">
              <button
                className="btn sm"
                type="button"
                onClick={() => onLoad(t.config, loadThemeFrame(t))}
              >
                Načíst
              </button>
              <button
                className="btn sm"
                type="button"
                onClick={() => {
                  deleteTheme(t.name)
                  refresh()
                }}
              >
                Smazat
              </button>
            </div>
          </li>
        ))}
      </ul>
    </>
  )
}
