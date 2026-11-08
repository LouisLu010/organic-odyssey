import { useEffect, useRef, useState } from 'react'
import type { PointerEvent } from 'react'
import type { HanddrawPoint, HanddrawStroke } from '../lib/handdraw'

interface HanddrawCanvasProps {
  strokes: HanddrawStroke[]
  onStroke: (stroke: HanddrawStroke) => void
  onDrawingChange: (drawing: boolean) => void
}

function strokePath(points: readonly HanddrawPoint[]): string {
  return points.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ')
}

export default function HanddrawCanvas({ strokes, onStroke, onDrawingChange }: HanddrawCanvasProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const pointerRef = useRef<number | null>(null)
  const pointsRef = useRef<HanddrawStroke>([])
  const pointersRef = useRef(new Set<number>())
  const [activeStroke, setActiveStroke] = useState<HanddrawStroke>([])
  const [size, setSize] = useState({ width: 640, height: 360 })
  let width = size.width
  let height = size.height
  for (const stroke of strokes) for (const point of stroke) {
    width = Math.max(width, point.x)
    height = Math.max(height, point.y)
  }

  useEffect(() => {
    const observer = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect
      if (width && height) setSize({ width, height })
    })
    if (svgRef.current) observer.observe(svgRef.current)
    return () => observer.disconnect()
  }, [])

  function pointFromEvent(event: PointerEvent<SVGSVGElement>): HanddrawPoint {
    const matrix = svgRef.current?.getScreenCTM()
    if (!matrix) return { x: 0, y: 0 }
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse())
    return { x: point.x, y: point.y }
  }

  function cancelStroke() {
    pointerRef.current = null
    pointsRef.current = []
    setActiveStroke([])
    onDrawingChange(false)
  }

  function pointerDown(event: PointerEvent<SVGSVGElement>) {
    if (event.button !== 0) return
    event.preventDefault()
    pointersRef.current.add(event.pointerId)
    event.currentTarget.setPointerCapture(event.pointerId)
    if (pointersRef.current.size !== 1) { cancelStroke(); return }
    pointerRef.current = event.pointerId
    pointsRef.current = [pointFromEvent(event)]
    setActiveStroke(pointsRef.current)
    onDrawingChange(true)
  }

  function pointerMove(event: PointerEvent<SVGSVGElement>) {
    if (pointerRef.current !== event.pointerId || pointersRef.current.size !== 1) return
    event.preventDefault()
    const point = pointFromEvent(event)
    const previous = pointsRef.current.at(-1)!
    if (Math.hypot(point.x - previous.x, point.y - previous.y) < 1.5) return
    // 限制单笔采样，长按和慢画不会无限堆积坐标。
    if (pointsRef.current.length >= 1024) pointsRef.current = pointsRef.current.filter((_, index) => index % 2 === 0)
    pointsRef.current = [...pointsRef.current, point]
    setActiveStroke(pointsRef.current)
  }

  function pointerUp(event: PointerEvent<SVGSVGElement>) {
    pointersRef.current.delete(event.pointerId)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (pointerRef.current !== event.pointerId) return
    const stroke = [...pointsRef.current, pointFromEvent(event)]
    cancelStroke()
    if (stroke.length > 2) onStroke(stroke)
  }

  return <svg ref={svgRef} className="handdraw-canvas" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="手绘键线式画布，用手指或笔绘制碳骨架" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={event => { pointersRef.current.delete(event.pointerId); cancelStroke() }}>
    {!strokes.length && !activeStroke.length ? <g className="handdraw-empty" pointerEvents="none"><path d={`M${width / 2 - 72} ${height / 2 + 14}l36 -30 36 30 36 -30 36 30`} /><text x={width / 2} y={height / 2 + 52} textAnchor="middle">像在纸上一样画，画完点「识别并整理」</text></g> : null}
    {strokes.map((stroke, index) => <path key={index} className="handdraw-stroke" d={strokePath(stroke)} />)}
    {activeStroke.length ? <path className="handdraw-stroke active" d={strokePath(activeStroke)} /> : null}
  </svg>
}
