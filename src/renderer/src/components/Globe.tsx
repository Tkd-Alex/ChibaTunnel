import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import * as d3geo from 'd3-geo'
import { feature } from 'topojson-client'
import { ApiNode } from '../types'
import { countryToIsoCode, vpnTypeLabel } from '../utils'
import { CITY_COORDS } from './city_coords'

// In-memory cache: "city||country" → [lon, lat] | null
const geocodeCache = new Map<string, [number, number] | null>()

// Nominatim geocoding queue
let nominatimQueue = Promise.resolve()

async function geocodeCity(city: string, country: string, cacheKey: string, onUpdate: () => void): Promise<void> {
  // Mark as "already in progress" to avoid duplicate requests
  geocodeCache.set(cacheKey, null)

  // Queue the request respecting Nominatim's rate limit
  nominatimQueue = nominatimQueue.then(async () => {
    try {
      const params = new URLSearchParams({ city, country, format: 'json', limit: '1' })
      const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
        headers: {
          'User-Agent': 'ChibaTunnel/1.0 (https://github.com/Tkd-Alex/ChibaTunnel)',
          'Accept-Language': 'en',
        },
      })
      const data = await res.json()
      if (data?.length) {
        const lon = parseFloat(data[0].lon)
        const lat = parseFloat(data[0].lat)
        geocodeCache.set(cacheKey, [
          Math.round(lon * 1000) / 1000,
          Math.round(lat * 1000) / 1000,
        ])
      }
    } catch {
      // Ignore network errors, country centroid fallback is sufficient
    }
    // Respect rate limit of 1 req/s
    await new Promise(r => setTimeout(r, 1100))
  })

  // Wait for completion and trigger re-render
  await nominatimQueue
  onUpdate()
}

// Country centroid fallback
const COUNTRY_COORDS: Record<string, [number, number]> = {
  'United States': [-98, 39], 'Canada': [-96, 56], 'Mexico': [-102, 24],
  'Brazil': [-51, -14], 'Argentina': [-65, -34], 'Chile': [-71, -36],
  'Colombia': [-74, 4], 'Peru': [-76, -10], 'Venezuela': [-66, 8],
  'Ecuador': [-78, -2], 'Uruguay': [-56, -33], 'Bolivia': [-65, -17],
  'Cuba': [-80, 22], 'Dominican Republic': [-70, 19], 'Costa Rica': [-84, 10],
  'Guatemala': [-90, 15], 'Panama': [-80, 9], 'Puerto Rico': [-66, 18],
  'United Kingdom': [-3, 55], 'Germany': [10, 51], 'France': [2, 46],
  'Netherlands': [5, 52], 'Sweden': [15, 62], 'Norway': [8, 62],
  'Finland': [26, 64], 'Switzerland': [8, 47], 'Austria': [14, 47],
  'Belgium': [4, 51], 'Spain': [-4, 40], 'Italy': [12, 42],
  'Portugal': [-8, 39], 'Poland': [20, 52], 'Czech Republic': [15, 50],
  'Romania': [25, 46], 'Hungary': [19, 47], 'Bulgaria': [25, 43],
  'Ukraine': [32, 49], 'Russia': [105, 61], 'Turkey': [35, 39],
  'Greece': [22, 39], 'Denmark': [10, 56], 'Croatia': [16, 45],
  'Serbia': [21, 44], 'Slovakia': [19, 49], 'Lithuania': [24, 56],
  'Latvia': [25, 57], 'Estonia': [25, 59], 'Moldova': [29, 47],
  'Belarus': [28, 53], 'Iceland': [-18, 65], 'Ireland': [-8, 53],
  'Luxembourg': [6, 50], 'Malta': [14, 36], 'Cyprus': [33, 35], 'Slovenia': [15, 46],
  'Japan': [138, 36], 'South Korea': [128, 36], 'China': [104, 35],
  'India': [79, 21], 'Singapore': [104, 1], 'Hong Kong': [114, 22],
  'Taiwan': [121, 24], 'Thailand': [101, 15], 'Vietnam': [106, 16],
  'Indonesia': [118, -5], 'Malaysia': [112, 3], 'Philippines': [122, 13],
  'Pakistan': [70, 30], 'Bangladesh': [90, 24], 'Myanmar': [96, 20],
  'Mongolia': [105, 47], 'Iran': [53, 33], 'Iraq': [44, 33],
  'Israel': [35, 31], 'United Arab Emirates': [54, 24], 'Saudi Arabia': [45, 24],
  'Jordan': [37, 31], 'Kuwait': [48, 29], 'Qatar': [51, 25], 'Lebanon': [35, 34],
  'Australia': [134, -25], 'New Zealand': [174, -41],
  'South Africa': [25, -29], 'Nigeria': [8, 10], 'Kenya': [38, 1],
  'Egypt': [30, 27], 'Morocco': [-7, 32], 'Algeria': [3, 28],
  'Tunisia': [9, 34], 'Ghana': [-1, 8], 'Tanzania': [35, -6],
  'Ethiopia': [40, 9], 'Kazakhstan': [67, 48], 'Georgia': [44, 42],
  'Armenia': [45, 40], 'Azerbaijan': [48, 40],
}

function getCoords(node: ApiNode, onUpdate: () => void): [number, number] | null {
  const cityKey = (node.city ?? '').toLowerCase().trim()
  const cacheKey = `${cityKey}||${node.country ?? ''}`

  // 1. Static dictionary
  if (cityKey && CITY_COORDS[cityKey]) return CITY_COORDS[cityKey]

  // 2. Dynamic cache
  if (geocodeCache.has(cacheKey)) {
    return geocodeCache.get(cacheKey) ?? COUNTRY_COORDS[node.country ?? ''] ?? null
  }

  // 3. Kick off async geocoding (does not block render)
  geocodeCity(cityKey, node.country ?? '', cacheKey, onUpdate)

  // 4. Fallback to country centroid in the meantime
  return COUNTRY_COORDS[node.country ?? ''] ?? null
}

// Cluster key = city||country (city-level precision, country-scoped)
function clusterKey(node: ApiNode): string {
  return `${(node.city ?? '').toLowerCase().trim()}||${node.country ?? ''}`
}

interface Cluster {
  lon: number
  lat: number
  city: string
  country: string
  nodes: ApiNode[]
}

interface Props {
  nodes:     ApiNode[]
  bookmarks: string[]
  onSelect:  (node: ApiNode) => void
}

export default function Globe({ nodes, bookmarks, onSelect }: Props) {
  const { t } = useTranslation()
  const canvasRef     = useRef<HTMLCanvasElement>(null)
  const containerRef  = useRef<HTMLDivElement>(null)
  const topoRef       = useRef<unknown>(null)
  const animRef       = useRef<number>(0)

  const rotRef      = useRef<[number, number]>([10, -20])
  const zoomRef     = useRef<number>(1)
  const dragRef     = useRef<{ x: number; y: number; lambda: number; phi: number } | null>(null)
  const wasDragging = useRef(false)
  const autoRotRef  = useRef(true)

  const [hoveredCluster, setHoveredCluster] = useState<Cluster | null>(null)
  const [tooltip, setTooltip]   = useState<{ x: number; y: number } | null>(null)
  // ── FIX 2: picker state includes scroll position, rendered as a real DOM div ──
  const [picker, setPicker] = useState<{ cluster: Cluster; x: number; y: number } | null>(null)
  const [size, setSize]     = useState({ w: 600, h: 600 })
  const [worldLoaded, setWorldLoaded] = useState(false)
  const [geoVersion, setGeoVersion] = useState(0)

  useEffect(() => {
    import('world-atlas/countries-110m.json').then(mod => {
      topoRef.current = mod.default
      setWorldLoaded(true)
    })
  }, [])

  useEffect(() => {
    if (!containerRef.current) return
    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect
      const s = Math.min(width - 8, height - 8, 680)
      setSize({ w: s, h: s })
    })
    ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [])

  // ── Build clusters by city ──
  const clusters = useMemo(() => {
    const map = new Map<string, Cluster>()
    const triggerReRender = () => setGeoVersion(v => v + 1)
    for (const node of nodes) {
      const coords = getCoords(node, triggerReRender)
      if (!coords) continue
      const key = clusterKey(node)
      if (!map.has(key)) {
        map.set(key, {
          lon: coords[0], lat: coords[1],
          city: node.city ?? '', country: node.country ?? '',
          nodes: [],
        })
      }
      map.get(key)!.nodes.push(node)
    }
    return Array.from(map.values())
  }, [nodes, geoVersion])

  const makeProj = useCallback((w: number, h: number) => {
    const baseR = Math.min(w, h) / 2 - 12
    return d3geo.geoOrthographic()
      .scale(baseR * zoomRef.current)
      .translate([w / 2, h / 2])
      .rotate(rotRef.current)
      .clipAngle(90)
  }, [])

  const getClusterAt = useCallback((cx: number, cy: number): Cluster | null => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    const mx   = (cx - rect.left) * (canvas.width  / rect.width)
    const my   = (cy - rect.top)  * (canvas.height / rect.height)
    const proj = makeProj(canvas.width, canvas.height)
    let best: Cluster | null = null
    let bestDist = 22

    for (const cl of clusters) {
      const pt = proj([cl.lon, cl.lat])
      if (!pt) continue
      const dist = Math.hypot(pt[0] - mx, pt[1] - my)
      if (dist < bestDist) { bestDist = dist; best = cl }
    }
    return best
  }, [clusters, makeProj])

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const topo   = topoRef.current
    if (!canvas || !topo) return

    const ctx  = canvas.getContext('2d')!
    const { width: w, height: h } = canvas
    const proj = makeProj(w, h)
    const path = d3geo.geoPath(proj, ctx)
    const baseR = Math.min(w, h) / 2 - 12
    const r     = baseR * zoomRef.current

    ctx.clearRect(0, 0, w, h)

    // Atmosphere
    const atm = ctx.createRadialGradient(w/2, h/2, r * 0.88, w/2, h/2, r * 1.12)
    atm.addColorStop(0, 'rgba(0,229,255,0.07)')
    atm.addColorStop(1, 'rgba(0,229,255,0)')
    ctx.beginPath(); ctx.arc(w/2, h/2, r * 1.12, 0, Math.PI*2)
    ctx.fillStyle = atm; ctx.fill()

    // Ocean
    ctx.beginPath()
    path({ type: 'Sphere' } as d3geo.GeoPermissibleObjects)
    const ocean = ctx.createRadialGradient(w/2 - r*0.2, h/2 - r*0.2, 0, w/2, h/2, r)
    ocean.addColorStop(0, '#0e1d35')
    ocean.addColorStop(1, '#060810')
    ctx.fillStyle = ocean; ctx.fill()

    // Graticule
    ctx.beginPath()
    path(d3geo.geoGraticule()())
    ctx.strokeStyle = 'rgba(0,229,255,0.045)'; ctx.lineWidth = 0.5; ctx.stroke()

    // Land
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const land = feature(topo as any, (topo as any).objects.countries)
    ctx.beginPath()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    path(land as any)
    ctx.fillStyle = '#0d1f3c'; ctx.fill()
    ctx.strokeStyle = 'rgba(0,229,255,0.18)'; ctx.lineWidth = 0.5; ctx.stroke()

    // Globe border
    ctx.beginPath()
    path({ type: 'Sphere' } as d3geo.GeoPermissibleObjects)
    ctx.strokeStyle = 'rgba(0,229,255,0.35)'; ctx.lineWidth = 1.5; ctx.stroke()

    // Clusters
    for (const cl of clusters) {
      const pt = proj([cl.lon, cl.lat])
      if (!pt) continue
      const [px, py] = pt
      const dx = px - w/2, dy = py - h/2
      if (dx*dx + dy*dy > r*r * 1.01) continue

      const isHovered   = hoveredCluster?.lon === cl.lon && hoveredCluster?.lat === cl.lat
      const isMulti     = cl.nodes.length > 1
      const hasBookmark = cl.nodes.some(n => bookmarks.includes(n.address))
      const hasHealthy  = cl.nodes.some(n => n.isHealthy && n.isActive)
      const hasWg       = cl.nodes.some(n => n.type === 1)

      const color = hasBookmark  ? '#facc15'
        : isHovered              ? '#ffffff'
        : !hasHealthy            ? '#ef4444'
        : hasWg                  ? '#a855f7'
        : '#34d399'

      let radius = 4.5
      if (isMulti) {
        radius = cl.nodes.length > 99 ? 13 : cl.nodes.length > 9 ? 11 : 9.5
        if (isHovered) radius += 2.5
      } else {
        radius = isHovered ? 9 : hasBookmark ? 8 : 4.5
      }

      if (isHovered || hasBookmark) {
        const t = Date.now() % 2000 / 2000
        const pulseR = radius + 4 + t * 8
        const alpha  = (1 - t) * 0.5
        ctx.beginPath()
        ctx.arc(px, py, pulseR, 0, Math.PI * 2)
        ctx.strokeStyle = color + Math.round(alpha * 255).toString(16).padStart(2, '0')
        ctx.lineWidth = 1; ctx.stroke()
      }

      const glow = ctx.createRadialGradient(px, py, 0, px, py, radius + 6)
      glow.addColorStop(0, color + '50')
      glow.addColorStop(1, color + '00')
      ctx.beginPath(); ctx.arc(px, py, radius + 6, 0, Math.PI*2)
      ctx.fillStyle = glow; ctx.fill()

      ctx.beginPath(); ctx.arc(px, py, radius, 0, Math.PI*2)
      ctx.fillStyle = color; ctx.fill()
      ctx.strokeStyle = '#060810'; ctx.lineWidth = 1.2; ctx.stroke()

      if (isMulti) {
        ctx.fillStyle = (color === '#ffffff' || color === '#facc15' || color === '#34d399') ? '#060810' : '#ffffff'
        ctx.font = `bold ${cl.nodes.length > 99 ? 7.5 : cl.nodes.length > 9 ? 8.5 : 9.5}px "Share Tech Mono", "JetBrains Mono", monospace`
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
        ctx.fillText(String(cl.nodes.length), px, py)
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
      }
    }

    if (zoomRef.current !== 1) {
      ctx.fillStyle = 'rgba(0,229,255,0.5)'
      ctx.font = '10px monospace'
      ctx.fillText(`${zoomRef.current.toFixed(1)}×`, 12, h - 12)
    }
  }, [clusters, hoveredCluster, bookmarks, makeProj])

  useEffect(() => {
    if (!worldLoaded) return
    let last = performance.now()
    const loop = (ts: number) => {
      const dt = ts - last; last = ts
      if (autoRotRef.current && !dragRef.current)
        rotRef.current = [rotRef.current[0] + dt * 0.006, rotRef.current[1]]
      if (autoRotRef.current || dragRef.current || hoveredCluster || bookmarks.length > 0)
        draw()
      animRef.current = requestAnimationFrame(loop)
    }
    animRef.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(animRef.current)
  }, [worldLoaded, draw, hoveredCluster, bookmarks.length])

  useEffect(() => { if (worldLoaded) draw() }, [worldLoaded, draw, size, clusters])

  // Close picker when clicking outside
  useEffect(() => {
    if (!picker) return
    const handler = (e: MouseEvent) => {
      const el = document.getElementById('globe-picker')
      if (el && !el.contains(e.target as Node)) setPicker(null)
    }
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [picker])

  const onMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    wasDragging.current = false
    dragRef.current = { x: e.clientX, y: e.clientY, lambda: rotRef.current[0], phi: rotRef.current[1] }
    autoRotRef.current = false
    setPicker(null)
  }, [])

  const onMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (dragRef.current) {
      const dx = e.clientX - dragRef.current.x
      const dy = e.clientY - dragRef.current.y
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) wasDragging.current = true
      rotRef.current = [
        dragRef.current.lambda + dx * 0.35,
        Math.max(-80, Math.min(80, dragRef.current.phi - dy * 0.35))
      ]
    }
    if (picker) return  // don't change hover while picker is open
    const cl = getClusterAt(e.clientX, e.clientY)
    setHoveredCluster(cl)
    setTooltip(cl ? { x: e.clientX, y: e.clientY } : null)
  }, [getClusterAt, picker])

  const onMouseUp = useCallback(() => { dragRef.current = null }, [])

  const onClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (wasDragging.current) return
    const cl = getClusterAt(e.clientX, e.clientY)
    if (!cl) { setPicker(null); return }
    if (cl.nodes.length === 1) {
      // connect immediately
      onSelect(cl.nodes[0])
    } else {
      setPicker({ cluster: cl, x: e.clientX, y: e.clientY })
      setTooltip(null)
    }
  }, [getClusterAt, onSelect])

  const onDoubleClick = useCallback(() => { autoRotRef.current = !autoRotRef.current }, [])

  const onWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault()
    zoomRef.current = Math.max(0.5, Math.min(40, zoomRef.current * (e.deltaY < 0 ? 1.1 : 0.9)))
    draw()
  }, [draw])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === '+' || e.key === '=') { zoomRef.current = Math.min(40, zoomRef.current * 1.15); draw() }
      if (e.key === '-')                   { zoomRef.current = Math.max(0.5, zoomRef.current * 0.87); draw() }
      if (e.key === '0')                   { zoomRef.current = 1; autoRotRef.current = true; draw() }
      if (e.key === 'Escape')              { setPicker(null) }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [draw])

  const tooltipNode = useMemo(() => {
    if (!hoveredCluster) return null
    return hoveredCluster.nodes.find(n => bookmarks.includes(n.address))
      ?? hoveredCluster.nodes.find(n => n.isHealthy && n.isActive)
      ?? hoveredCluster.nodes[0]
  }, [hoveredCluster, bookmarks])

  // Compute safe picker position so it doesn't overflow viewport
  const pickerStyle = useMemo((): React.CSSProperties => {
    if (!picker) return {}
    const W = window.innerWidth, H = window.innerHeight
    const pickerW = 240, pickerH = Math.min(320, picker.cluster.nodes.length * 36 + 48)
    let left = picker.x + 14
    let top  = picker.y - 10
    if (left + pickerW > W - 8) left = picker.x - pickerW - 8
    if (top  + pickerH > H - 8) top  = H - pickerH - 8
    return { left, top }
  }, [picker])

  return (
    <div ref={containerRef} className="globe-container">
      <canvas
        ref={canvasRef}
        width={size.w}
        height={size.h}
        className="globe-canvas"
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onWheel={onWheel}
        style={{ cursor: hoveredCluster ? 'pointer' : dragRef.current ? 'grabbing' : 'grab' }}
      />

      <div className="globe-legend">
        <div className="globe-legend-item"><span style={{ background: '#a855f7' }} />{t('filters.wireguard')}</div>
        <div className="globe-legend-item"><span style={{ background: '#34d399' }} />{t('filters.v2ray')}</div>
        <div className="globe-legend-item"><span style={{ background: '#facc15' }} />{t('common.bookmarks')}</div>
        <div className="globe-legend-item"><span style={{ background: '#ef4444' }} />{t('table.inactive_status')}</div>
      </div>

      <div className="globe-hint">{t('globe.hint')}</div>

      <div className="globe-zoom-btns">
        <button className="globe-zoom-btn" onClick={() => { zoomRef.current = Math.min(40, zoomRef.current * 1.25); draw() }}>+</button>
        <button className="globe-zoom-btn" onClick={() => { zoomRef.current = 1; autoRotRef.current = true; draw() }}>⊙</button>
        <button className="globe-zoom-btn" onClick={() => { zoomRef.current = Math.max(0.5, zoomRef.current * 0.8); draw() }}>−</button>
      </div>

      {/* Tooltip (hover) — hidden while picker is open */}
      {tooltipNode && tooltip && !picker && (
        <div className="globe-tooltip" style={{ left: tooltip.x + 14, top: tooltip.y - 10 }}>
          <div className="gt-name">
            <span className={`fi fi-${countryToIsoCode(tooltipNode.country ?? '')}`} style={{ marginRight: 6, borderRadius: 1 }} />
            {hoveredCluster && hoveredCluster.nodes.length > 1
              ? `${hoveredCluster.nodes.length} ${t('common.nodes')} · ${hoveredCluster.city || hoveredCluster.country}`
              : tooltipNode.moniker}
          </div>
          <div className="gt-row"><span>{t('table.type')}</span><span>{vpnTypeLabel(tooltipNode.type)}</span></div>
          <div className="gt-row"><span>{t('ip.location')}</span><span>{tooltipNode.city}, {tooltipNode.country}</span></div>
          <div className="gt-row"><span>{t('table.peers')}</span><span style={{ color: 'var(--cyan)' }}>{tooltipNode.peers}</span></div>
          <div className="gt-row"><span>{t('table.sessions')}</span><span>{tooltipNode.sessions}</span></div>
          <div className="gt-connect">
            {hoveredCluster && hoveredCluster.nodes.length > 1
              ? t('globe.tooltip.click_choose')
              : t('globe.tooltip.click_details')}
          </div>
        </div>
      )}

      {/* Scrollable picker */}
      {picker && (
        <div
          id="globe-picker"
          style={{
            position: 'fixed',
            zIndex: 1100,
            background: 'var(--bg-1)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            boxShadow: '0 8px 32px rgba(0,0,0,.7)',
            minWidth: 240,
            maxWidth: 300,
            display: 'flex',
            flexDirection: 'column',
            animation: 'fade-in .1s ease',
            ...pickerStyle,
          }}
          onMouseDown={e => e.stopPropagation()}
        >
          {/* Header */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '10px 12px 8px',
            borderBottom: '1px solid var(--border)',
            flexShrink: 0,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span
                className={`fi fi-${countryToIsoCode(picker.cluster.country)}`}
                style={{ borderRadius: 1 }}
              />
              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-1)' }}>
                {picker.cluster.city || picker.cluster.country}
              </span>
              <span style={{
                fontSize: 10, background: 'var(--bg-2)', color: 'var(--cyan)',
                borderRadius: 4, padding: '1px 5px', fontVariantNumeric: 'tabular-nums',
              }}>
                {picker.cluster.nodes.length}
              </span>
            </div>
            <button
              onClick={() => setPicker(null)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--text-3)', fontSize: 14, lineHeight: 1, padding: '0 2px',
              }}
            >✕</button>
          </div>

          {/* Scrollable list */}
          <div style={{
            overflowY: 'auto',
            maxHeight: 280,
            padding: '4px 0',
          }}>
            {picker.cluster.nodes.map(node => {
              const isBookmark = bookmarks.includes(node.address)
              const isHealthy  = node.isHealthy && node.isActive
              const dot = isBookmark ? '#facc15'
                : isHealthy ? (node.type === 1 ? '#a855f7' : '#34d399')
                : '#ef4444'

              return (
                <div
                  key={node.address}
                  onClick={() => {
                    setPicker(null)
                    onSelect(node)
                  }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '6px 12px', cursor: 'pointer',
                    transition: 'background 0.12s',
                    userSelect: 'none',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'rgba(0,229,255,0.07)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <span style={{
                    width: 8, height: 8, borderRadius: '50%',
                    background: dot, flexShrink: 0,
                  }} />
                  <span style={{
                    flex: 1, fontSize: 11, color: 'var(--text-1)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {node.moniker}
                  </span>
                  <span style={{
                    fontSize: 9, color: 'var(--cyan)', opacity: 0.7,
                    flexShrink: 0, letterSpacing: '0.04em',
                  }}>
                    {vpnTypeLabel(node.type)}
                  </span>
                  {node.peers != null && (
                    <span style={{ fontSize: 9, color: 'var(--text-3)', flexShrink: 0 }}>
                      {node.peers}p
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
