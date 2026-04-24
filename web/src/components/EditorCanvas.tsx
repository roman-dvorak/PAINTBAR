import { useCallback, useLayoutEffect, useRef, useState } from "react"
import type { BitmapFrame } from "../lib/bitmap"
import { drawEllipse, drawLine, drawRect, floodFill, pickCssRgb } from "../lib/editorUtils"

const TOOLS = [
  "Pen",
  "Eraser",
  "Line",
  "Rectangle",
  "Rect Fill",
  "Ellipse",
  "Ellipse Fill",
  "Fill",
] as const

export type Tool = (typeof TOOLS)[number]

type Props = {
  frame: BitmapFrame
  /** změna číselného tiku překreslí (mutace bufferu) */
  tick: number
  color: string
  tool: Tool
  activeColumn: number
  fixedColumn: boolean
  onColumnChange: (c: number) => void
  onChange: () => void
}

function cellSize(w: number, h: number, el: HTMLDivElement) {
  const r = el.getBoundingClientRect()
  const cw = r.width / Math.max(1, w)
  const ch = r.height / Math.max(1, h)
  return { cw, ch, r }
}

function pixelAt(
  clientX: number,
  clientY: number,
  el: HTMLDivElement,
  frame: BitmapFrame,
  activeColumn: number,
  fixed: boolean,
) {
  const { cw, ch, r } = cellSize(frame.width, frame.height, el)
  const x = fixed ? activeColumn : Math.floor((clientX - r.left) / cw)
  const y = Math.floor((clientY - r.top) / ch)
  if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) return null
  return { x, y } as const
}

export function EditorCanvas({
  frame,
  tick,
  color,
  tool,
  activeColumn,
  fixedColumn,
  onColumnChange,
  onChange,
}: Props) {
  const wrap = useRef<HTMLDivElement>(null)
  const cvs = useRef<HTMLCanvasElement>(null)
  const [preview, setPreview] = useState<{
    a: [number, number]
    b: [number, number]
  } | null>(null)
  const last = useRef<{ x: number; y: number } | null>(null)
  const down = useRef(false)
  const eraseRef = useRef(false)

  const draw = useCallback(() => {
    const cv = cvs.current
    const w = wrap.current
    if (!cv || !w) return
    const ctx = cv.getContext("2d")
    if (!ctx) return
    const { width, height } = w.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    cv.width = width * dpr
    cv.height = height * dpr
    cv.style.width = width + "px"
    cv.style.height = height + "px"
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = "#1a1b1e"
    ctx.fillRect(0, 0, width, height)
    const cw = width / Math.max(1, frame.width)
    const ch = height / Math.max(1, frame.height)
    for (let y = 0; y < frame.height; y++) for (let x = 0; x < frame.width; x++) {
      const [r, g, b] = frame.getRgb(x, y)
      ctx.fillStyle = `rgb(${r},${g},${b})`
      ctx.fillRect(x * cw, y * ch, cw + 0.5, ch + 0.5)
    }
    ctx.fillStyle = "rgba(255,255,255,0.08)"
    ctx.fillRect(activeColumn * cw, 0, cw, height)
    ctx.strokeStyle = "rgba(255,255,255,0.45)"
    ctx.lineWidth = 1
    ctx.strokeRect(activeColumn * cw + 0.5, 0.5, cw - 1, height - 1)
    if (preview) {
      const [x0, y0] = preview.a
      const [x1, y1] = preview.b
      ctx.strokeStyle = "rgba(255,255,255,0.6)"
      ctx.lineWidth = 1
      if (tool === "Line") {
        ctx.beginPath()
        ctx.moveTo((x0 + 0.5) * cw, (y0 + 0.5) * ch)
        ctx.lineTo((x1 + 0.5) * cw, (y1 + 0.5) * ch)
        ctx.stroke()
      } else if (tool === "Rectangle" || tool === "Rect Fill") {
        const l = Math.min(x0, x1) * cw
        const t = Math.min(y0, y1) * ch
        const tw = (Math.abs(x1 - x0) + 1) * cw
        const th = (Math.abs(y1 - y0) + 1) * ch
        if (tool === "Rect Fill") {
          ctx.fillStyle = "rgba(255,255,255,0.12)"
          ctx.fillRect(l, t, tw, th)
        }
        ctx.strokeRect(l, t, tw, th)
      } else if (tool === "Ellipse" || tool === "Ellipse Fill") {
        const l = Math.min(x0, x1) * cw
        const t2 = Math.min(y0, y1) * ch
        const tw = (Math.abs(x1 - x0) + 1) * cw
        const th = (Math.abs(y1 - y0) + 1) * ch
        if (tool === "Ellipse Fill") {
          ctx.fillStyle = "rgba(255,255,255,0.12)"
          ctx.beginPath()
          ctx.ellipse(l + tw / 2, t2 + th / 2, tw / 2, th / 2, 0, 0, Math.PI * 2)
          ctx.fill()
        }
        ctx.beginPath()
        ctx.ellipse(l + tw / 2, t2 + th / 2, tw / 2, th / 2, 0, 0, Math.PI * 2)
        ctx.stroke()
      }
    }
  }, [frame, activeColumn, preview, tool, tick])

  useLayoutEffect(() => {
    draw()
  }, [draw])

  const colorRgb = () => (tool === "Eraser" ? ([0, 0, 0] as const) : pickCssRgb(color))

  const onDown = (clientX: number, clientY: number, erase: boolean) => {
    if (!wrap.current) return
    const p = pixelAt(clientX, clientY, wrap.current, frame, activeColumn, fixedColumn)
    if (!p) return
    if (!fixedColumn) onColumnChange(p.x)
    const useE = tool === "Eraser" || erase
    const rgb = useE ? [0, 0, 0] : pickCssRgb(color)
    if (tool === "Pen" || tool === "Eraser") {
      last.current = p
      frame.setRgb(p.x, p.y, rgb[0]!, rgb[1]!, rgb[2]!)
      onChange()
    } else if (tool === "Fill") {
      floodFill(frame, p.x, p.y, [rgb[0], rgb[1], rgb[2]])
      onChange()
    } else {
      setPreview({ a: [p.x, p.y], b: [p.x, p.y] })
    }
  }

  const onMove = (clientX: number, clientY: number) => {
    if (!down.current || !wrap.current) return
    const useE = tool === "Eraser" || eraseRef.current
    const p = pixelAt(clientX, clientY, wrap.current, frame, activeColumn, fixedColumn)
    if (!p) return
    if (!fixedColumn) onColumnChange(p.x)
    const rgb = useE ? [0, 0, 0] : pickCssRgb(color)
    if (tool === "Pen" || tool === "Eraser") {
      if (last.current) {
        drawLine(
          frame,
          last.current.x,
          last.current.y,
          p.x,
          p.y,
          [rgb[0], rgb[1], rgb[2]],
        )
        onChange()
      }
      last.current = p
    } else {
      setPreview((pr) => (pr ? { a: pr.a, b: [p.x, p.y] } : null))
    }
  }

  const onUp = () => {
    down.current = false
    last.current = null
    setPreview((pr) => {
      if (pr) {
        const [x0, y0] = pr.a
        const [x1, y1] = pr.b
        const c = colorRgb() as [number, number, number]
        if (tool === "Line") drawLine(frame, x0, y0, x1, y1, c)
        else if (tool === "Rectangle") drawRect(frame, x0, y0, x1, y1, c, false)
        else if (tool === "Rect Fill") drawRect(frame, x0, y0, x1, y1, c, true)
        else if (tool === "Ellipse") drawEllipse(frame, x0, y0, x1, y1, c, false)
        else if (tool === "Ellipse Fill") drawEllipse(frame, x0, y0, x1, y1, c, true)
        onChange()
      }
      return null
    })
  }

  return (
    <div
      ref={wrap}
      className="editor-canvas"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        down.current = true
        eraseRef.current = e.button === 2 || (tool === "Eraser" && e.button === 0)
        onDown(
          e.clientX,
          e.clientY,
          eraseRef.current,
        )
      }}
      onPointerMove={(e) => {
        onMove(e.clientX, e.clientY)
      }}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      <canvas ref={cvs} className="editor-canvas__layer" />
    </div>
  )
}

export { TOOLS }
