#!/usr/bin/env python3
"""
ChibaTunnel Brand Asset Generator
===================================
Requirements:  pip install cairosvg pillow
Usage:         python3 gen_logos.py [output_dir]
Default out:   ./output/

Assets generated
----------------
SVG   chibatunnel-icon.svg
SVG   chibatunnel-icon-transparent.svg
SVG   chibatunnel-icon-badge.svg             (icon + app name inside canvas)
SVG   chibatunnel-icon-badge-transparent.svg
SVG   chibatunnel-wordmark.svg
SVG   chibatunnel-wordmark-transparent.svg
SVG   chibatunnel-animated.svg               (CSS-animated loop)
HTML  chibatunnel-animated.html              (rich web animation page)
PNG   chibatunnel-icon-512/256/128/64.png
PNG   chibatunnel-icon-transparent-512/256.png
PNG   chibatunnel-icon-badge-512/256.png
PNG   chibatunnel-wordmark.png               (@2x, 1640x440)
PNG   chibatunnel-wordmark-transparent.png
GIF   chibatunnel-animated.gif               (16-frame loop, 512x512)
"""

import os, sys, math, io

OUT = sys.argv[1] if len(sys.argv) > 1 else "./output"
os.makedirs(OUT, exist_ok=True)

# ═══════════════════════════════════════════════════════════════════════════
#  DESIGN TOKENS
# ═══════════════════════════════════════════════════════════════════════════
MAGENTA = "#ff0055"
CYAN    = "#00ccff"
WHITE   = "#ffffff"
BG0     = "#0d0019"   # deepest bg
BG1     = "#110020"   # lighter bg for gradient centre
FONT    = "'JetBrains Mono', 'Courier New', monospace"

# ═══════════════════════════════════════════════════════════════════════════
#  TORII GEOMETRY  —  512 × 512 canvas, PERFECTLY CENTRED
#
#  Vertical span:  kasagi tips  y = 76
#                  pillar bases y = 436
#  Centre:         (76 + 436) / 2 = 256  ✓  matches canvas centre
#
#  NOTE: the original backup SVG was 26 px too low.
#        Every y coordinate here has had 26 px subtracted.
# ═══════════════════════════════════════════════════════════════════════════

# Kasagi (top crossbeam) polygon — upturned tips, bold ~60 px profile
KASAGI = "72,122 90,80 110,76 402,76 422,80 440,122  440,136 422,96 402,92 110,92 90,96 72,136"

NX, NY, NW, NH = 148, 168, 216, 16      # Nuki (lower crossbeam)
PW              = 24                     # pillar width
LPX, LPY, LPH  = 148, 184, 252          # left pillar  (bottom y = 436)
RPX             = 340                    # right pillar x (same y/h as left)

VPX, VPY = 256, 318                      # vanishing point

GL  = LPX + PW   # 172  inner-left gate edge
GR  = RPX        # 340  inner-right gate edge
GT  = LPY        # 184  gate top y
PB  = LPY + LPH  # 436  pillar base y
FLX = LPX        # 148  floor rail base x (left)
FRX = RPX + PW   # 364  floor rail base x (right)

# ── geometry helpers ────────────────────────────────────────────────────────
def wall_h(y):
    """(x_left, x_right) for a wall depth-horizontal at y  [GT <= y <= VPY]"""
    t = (y - GT) / (VPY - GT)
    return GL + (VPX - GL)*t,  GR + (VPX - GR)*t

def floor_h(y):
    """(x_left, x_right) for a floor depth-horizontal at y  [VPY <= y <= PB]"""
    t = (PB - y) / (PB - VPY)
    return FLX + (VPX - FLX)*t,  FRX + (VPX - FRX)*t

# Precomputed lines (wall: 4 levels; floor: 2 levels)
WDEPTHS = [(y, *wall_h(y))  for y in [214, 242, 269, 294]]
FDEPTHS = [(y, *floor_h(y)) for y in [376, 406]]

# Wall-diagonal length — needed for stroke-dasharray animation
WALL_LEN = math.hypot(VPX - GL, VPY - GT)   # ≈ 158.2

# ═══════════════════════════════════════════════════════════════════════════
#  SHARED SVG FRAGMENTS
# ═══════════════════════════════════════════════════════════════════════════

def scanlines(w, h, color=MAGENTA, step=14, op=0.038):
    lines = "\n".join(
        f'    <line x1="0" y1="{y}" x2="{w}" y2="{y}" stroke="{color}" stroke-width="0.7"/>'
        for y in range(0, h + step, step)
    )
    return f'  <g clip-path="url(#rnd)" opacity="{op}">\n{lines}\n  </g>'

def icon_defs(w=512, h=512, rx=90, extra=""):
    return f"""<defs>
    <filter id="mg" x="-60%" y="-60%" width="220%" height="220%" color-interpolation-filters="sRGB">
      <feGaussianBlur in="SourceGraphic" stdDeviation="6"  result="b1"/>
      <feGaussianBlur in="SourceGraphic" stdDeviation="16" result="b2"/>
      <feMerge><feMergeNode in="b2"/><feMergeNode in="b1"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="cg" x="-60%" y="-60%" width="220%" height="220%" color-interpolation-filters="sRGB">
      <feGaussianBlur in="SourceGraphic" stdDeviation="3.5" result="b1"/>
      <feGaussianBlur in="SourceGraphic" stdDeviation="9"   result="b2"/>
      <feMerge><feMergeNode in="b2"/><feMergeNode in="b1"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="vp"  x="-300%" y="-300%" width="700%" height="700%"><feGaussianBlur stdDeviation="18"/></filter>
    <filter id="vpc" x="-150%" y="-150%" width="400%" height="400%"><feGaussianBlur stdDeviation="6"/></filter>
    <radialGradient id="bgr" cx="50%" cy="45%" r="70%">
      <stop offset="0%"   stop-color="{BG1}"/>
      <stop offset="55%"  stop-color="{BG0}"/>
      <stop offset="100%" stop-color="#060010"/>
    </radialGradient>
    <clipPath id="rnd"><rect width="{w}" height="{h}" rx="{rx}"/></clipPath>{extra}
  </defs>"""

def icon_body(ids=False):
    """Core icon art — shared across all icon variants.
    ids=True adds element IDs for CSS animation targeting."""
    def i(name): return f' id="{name}"' if ids else ""

    wlines = "\n".join(
        f'    <line{i(f"dl{n+1}")} x1="{xl:.1f}" y1="{y}" x2="{xr:.1f}" y2="{y}"'
        f' stroke="{CYAN}" stroke-width="{1.6 - n*0.23:.2f}" opacity="{0.90 - n*0.12:.2f}"/>'
        for n, (y, xl, xr) in enumerate(WDEPTHS)
    )
    flines = "\n".join(
        f'    <line x1="{xl:.1f}" y1="{y}" x2="{xr:.1f}" y2="{y}"'
        f' stroke="{CYAN}" stroke-width="{1.0 - n*0.15:.2f}" opacity="{0.42 - n*0.13:.2f}"/>'
        for n, (y, xl, xr) in enumerate(FDEPTHS)
    )

    return f"""  <!-- ── TUNNEL GRID ── -->
  <g filter="url(#cg)">
    <line{i("wl")} x1="{GL}" y1="{GT}" x2="{VPX}" y2="{VPY}" stroke="{CYAN}" stroke-width="1.8" opacity="0.92"/>
    <line{i("wr")} x1="{GR}" y1="{GT}" x2="{VPX}" y2="{VPY}" stroke="{CYAN}" stroke-width="1.8" opacity="0.92"/>
    <line x1="{VPX}" y1="{GT}" x2="{VPX}" y2="{VPY}" stroke="{CYAN}" stroke-width="0.9" opacity="0.30"/>
{wlines}
    <line{i("fl")} x1="{FLX}" y1="{PB}" x2="{VPX}" y2="{VPY}" stroke="{CYAN}" stroke-width="1.2" opacity="0.52"/>
    <line{i("fr")} x1="{FRX}" y1="{PB}" x2="{VPX}" y2="{VPY}" stroke="{CYAN}" stroke-width="1.2" opacity="0.52"/>
{flines}
  </g>

  <!-- VP glow -->
  <circle{i("vpg")} cx="{VPX}" cy="{VPY}" r="36" fill="{CYAN}" opacity="0.28" filter="url(#vp)"/>
  <circle{i("vpc")} cx="{VPX}" cy="{VPY}" r="12" fill="{CYAN}" opacity="0.65" filter="url(#vpc)"/>
  <circle{i("vpd")} cx="{VPX}" cy="{VPY}" r="4"  fill="{WHITE}"/>

  <!-- ── TORII ── -->
  <polygon{i("kasagi")} points="{KASAGI}" fill="{MAGENTA}" filter="url(#mg)"/>
  <rect{i("nuki")}    x="{NX}" y="{NY}" width="{NW}" height="{NH}" rx="3" fill="{MAGENTA}" filter="url(#mg)"/>
  <rect{i("lpillar")} x="{LPX}" y="{LPY}" width="{PW}" height="{LPH}" rx="3" fill="{MAGENTA}" filter="url(#mg)"/>
  <rect{i("rpillar")} x="{RPX}" y="{LPY}" width="{PW}" height="{LPH}" rx="3" fill="{MAGENTA}" filter="url(#mg)"/>

  <!-- Circuit traces -->
  <g stroke="{CYAN}" stroke-width="1.3" opacity="0.48" fill="none">
    <polyline points="{LPX},250 108,250 108,282"/>
    <polyline points="{LPX},322 100,322"/>
    <circle{i("td1")} cx="108" cy="282" r="3.2" fill="{CYAN}" stroke="none" opacity="0.75"/>
    <circle{i("td2")} cx="100" cy="322" r="3.2" fill="{CYAN}" stroke="none" opacity="0.75"/>
    <polyline points="{FRX},266 404,266 404,294"/>
    <polyline points="{FRX},336 412,336"/>
    <circle{i("td3")} cx="404" cy="294" r="3.2" fill="{CYAN}" stroke="none" opacity="0.75"/>
    <circle{i("td4")} cx="412" cy="336" r="3.2" fill="{CYAN}" stroke="none" opacity="0.75"/>
  </g>

  <!-- HUD corner brackets -->
  <g stroke="{MAGENTA}" stroke-width="3" stroke-linecap="square" opacity="0.42">
    <line x1="30" y1="60" x2="30" y2="30"/><line x1="30" y1="30" x2="60" y2="30"/>
    <line x1="482" y1="60" x2="482" y2="30"/><line x1="482" y1="30" x2="452" y2="30"/>
    <line x1="30" y1="452" x2="30" y2="482"/><line x1="30" y1="482" x2="60" y2="482"/>
    <line x1="482" y1="452" x2="482" y2="482"/><line x1="482" y1="482" x2="452" y2="482"/>
  </g>"""

BADGE_TEXT = f"""
  <!-- Badge name (text inside icon canvas) -->
  <line x1="190" y1="443" x2="322" y2="443" stroke="{MAGENTA}" stroke-width="0.8" opacity="0.28"/>
  <text x="256" y="465"
    font-family="{FONT}" font-size="27" font-weight="700" letter-spacing="3"
    text-anchor="middle" fill="{MAGENTA}" filter="url(#mg)">CHIBA</text>
  <text x="256" y="490"
    font-family="{FONT}" font-size="17" font-weight="400" letter-spacing="9"
    text-anchor="middle" fill="{CYAN}" filter="url(#cg)">TUNNEL</text>"""


# ═══════════════════════════════════════════════════════════════════════════
#  BUILDER FUNCTIONS
# ═══════════════════════════════════════════════════════════════════════════

def build_icon(dark=True, badge=False, anim_ids=False):
    bg = (
        f'  <rect width="512" height="512" fill="url(#bgr)" rx="90"/>\n'
        f'{scanlines(512, 512)}\n'
    ) if dark else ""
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">\n'
        f'  {icon_defs()}\n'
        f'{bg}'
        f'{icon_body(ids=anim_ids)}\n'
        f'{BADGE_TEXT if badge else ""}\n'
        f'</svg>'
    )


def build_wordmark(dark=True):
    W, H, RX = 820, 220, 28
    bg = (
        f'  <rect width="{W}" height="{H}" fill="url(#bgr)" rx="{RX}"/>\n'
        f'{scanlines(W, H, op=0.030)}\n'
    ) if dark else ""

    # Mini-icon scaled to fit the wordmark height
    sc = 0.370
    wlines_mini = "\n".join(
        f'      <line x1="{xl:.1f}" y1="{y}" x2="{xr:.1f}" y2="{y}"'
        f' stroke="{CYAN}" stroke-width="1.5" opacity="{0.88 - n*0.10:.2f}"/>'
        for n, (y, xl, xr) in enumerate(WDEPTHS)
    )
    flines_mini = "\n".join(
        f'      <line x1="{xl:.1f}" y1="{y}" x2="{xr:.1f}" y2="{y}"'
        f' stroke="{CYAN}" stroke-width="1.0" opacity="{0.38 - n*0.10:.2f}"/>'
        for n, (y, xl, xr) in enumerate(FDEPTHS)
    )

    mini_icon = f"""  <g transform="translate(12,16) scale({sc})">
    <g filter="url(#cg)">
      <line x1="{GL}" y1="{GT}" x2="{VPX}" y2="{VPY}" stroke="{CYAN}" stroke-width="1.8" opacity="0.92"/>
      <line x1="{GR}" y1="{GT}" x2="{VPX}" y2="{VPY}" stroke="{CYAN}" stroke-width="1.8" opacity="0.92"/>
{wlines_mini}
      <line x1="{FLX}" y1="{PB}" x2="{VPX}" y2="{VPY}" stroke="{CYAN}" stroke-width="1.1" opacity="0.50"/>
      <line x1="{FRX}" y1="{PB}" x2="{VPX}" y2="{VPY}" stroke="{CYAN}" stroke-width="1.1" opacity="0.50"/>
{flines_mini}
    </g>
    <circle cx="{VPX}" cy="{VPY}" r="28" fill="{CYAN}" opacity="0.20" filter="url(#vp)"/>
    <circle cx="{VPX}" cy="{VPY}" r="9"  fill="{CYAN}" opacity="0.60" filter="url(#vpc)"/>
    <circle cx="{VPX}" cy="{VPY}" r="3.5" fill="{WHITE}"/>
    <polygon points="{KASAGI}" fill="{MAGENTA}" filter="url(#mg)"/>
    <rect x="{NX}" y="{NY}" width="{NW}" height="{NH}" rx="3" fill="{MAGENTA}" filter="url(#mg)"/>
    <rect x="{LPX}" y="{LPY}" width="{PW}" height="{LPH}" rx="3" fill="{MAGENTA}" filter="url(#mg)"/>
    <rect x="{RPX}" y="{LPY}" width="{PW}" height="{LPH}" rx="3" fill="{MAGENTA}" filter="url(#mg)"/>
    <g stroke="{CYAN}" stroke-width="1.3" opacity="0.42" fill="none">
      <polyline points="{LPX},250 108,250 108,282"/>
      <polyline points="{FRX},266 404,266 404,294"/>
      <circle cx="108" cy="282" r="3" fill="{CYAN}" stroke="none" opacity="0.72"/>
      <circle cx="404" cy="294" r="3" fill="{CYAN}" stroke="none" opacity="0.72"/>
    </g>
  </g>"""

    wm_defs = f"""  <defs>
    <filter id="mg" x="-60%" y="-60%" width="220%" height="220%" color-interpolation-filters="sRGB">
      <feGaussianBlur in="SourceGraphic" stdDeviation="4"  result="b1"/>
      <feGaussianBlur in="SourceGraphic" stdDeviation="12" result="b2"/>
      <feMerge><feMergeNode in="b2"/><feMergeNode in="b1"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="cg" x="-60%" y="-60%" width="220%" height="220%" color-interpolation-filters="sRGB">
      <feGaussianBlur in="SourceGraphic" stdDeviation="2.5" result="b1"/>
      <feGaussianBlur in="SourceGraphic" stdDeviation="7"   result="b2"/>
      <feMerge><feMergeNode in="b2"/><feMergeNode in="b1"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="vp"  x="-300%" y="-300%" width="700%" height="700%"><feGaussianBlur stdDeviation="10"/></filter>
    <filter id="vpc" x="-150%" y="-150%" width="400%" height="400%"><feGaussianBlur stdDeviation="4"/></filter>
    <filter id="ftm" x="-10%" y="-40%" width="120%" height="180%" color-interpolation-filters="sRGB">
      <feGaussianBlur in="SourceGraphic" stdDeviation="3.5" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="ftc" x="-10%" y="-40%" width="120%" height="180%" color-interpolation-filters="sRGB">
      <feGaussianBlur in="SourceGraphic" stdDeviation="2.5" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <radialGradient id="bgr" cx="50%" cy="45%" r="70%">
      <stop offset="0%"   stop-color="{BG1}"/>
      <stop offset="55%"  stop-color="{BG0}"/>
      <stop offset="100%" stop-color="#060010"/>
    </radialGradient>
    <clipPath id="rnd"><rect width="{W}" height="{H}" rx="{RX}"/></clipPath>
  </defs>"""

    text = f"""  <line x1="213" y1="18" x2="213" y2="202" stroke="{MAGENTA}" stroke-width="1" opacity="0.20"/>
  <text x="235" y="112"
    font-family="{FONT}" font-size="90" font-weight="700" letter-spacing="2"
    fill="{MAGENTA}" filter="url(#ftm)">CHIBA</text>
  <text x="239" y="163"
    font-family="{FONT}" font-size="46" font-weight="400" letter-spacing="19"
    fill="{CYAN}" filter="url(#ftc)">TUNNEL</text>
  <text x="239" y="187"
    font-family="{FONT}" font-size="11" letter-spacing="4"
    fill="{MAGENTA}" opacity="0.35">DECENTRALIZED · PRIVATE · OPEN</text>
  <g stroke="{MAGENTA}" stroke-width="2.2" stroke-linecap="square" opacity="0.32">
    <line x1="16" y1="40" x2="16" y2="16"/><line x1="16" y1="16" x2="40" y2="16"/>
    <line x1="804" y1="40" x2="804" y2="16"/><line x1="804" y1="16" x2="780" y2="16"/>
    <line x1="16" y1="180" x2="16" y2="204"/><line x1="16" y1="204" x2="40" y2="204"/>
    <line x1="804" y1="180" x2="804" y2="204"/><line x1="804" y1="204" x2="780" y2="204"/>
  </g>"""

    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}">\n'
        f'{wm_defs}\n'
        f'{bg}'
        f'{mini_icon}\n'
        f'{text}\n'
        f'</svg>'
    )


def build_animated_svg():
    """Pure SVG with embedded CSS @keyframes — works in all modern browsers."""
    gap = WALL_LEN - 14
    anim = f"""  <style>
    /* VP orb heartbeat */
    #vpc  {{ animation: vp-p 2.2s ease-in-out infinite; }}
    #vpg  {{ animation: vp-g 2.2s ease-in-out infinite; }}
    #vpd  {{ animation: vp-d 2.2s ease-in-out infinite; }}
    @keyframes vp-p {{ 0%,100%{{opacity:.65}} 45%{{opacity:1.0}} }}
    @keyframes vp-g {{ 0%,100%{{opacity:.28}} 45%{{opacity:.65}} }}
    @keyframes vp-d {{ 0%,100%{{r:4}}          45%{{r:6}} }}

    /* Data-packets travel along wall diagonals toward VP */
    #wl {{ stroke-dasharray:14 {gap:.0f}; animation: dp 2.0s 0.0s linear infinite; }}
    #wr {{ stroke-dasharray:14 {gap:.0f}; animation: dp 2.0s 1.0s linear infinite; }}
    @keyframes dp {{ to {{ stroke-dashoffset:-{WALL_LEN:.0f}; }} }}

    /* Tunnel zoom: depth lines rush from VP toward viewer */
    #dl4 {{ animation: dz 2.6s 0.00s ease-in-out infinite; }}
    #dl3 {{ animation: dz 2.6s 0.25s ease-in-out infinite; }}
    #dl2 {{ animation: dz 2.6s 0.50s ease-in-out infinite; }}
    #dl1 {{ animation: dz 2.6s 0.75s ease-in-out infinite; }}
    @keyframes dz {{
      0%,100% {{ opacity:.06; stroke-width:.4; }}
      22%     {{ opacity:.95; stroke-width:2.2; }}
      60%     {{ opacity:.12; stroke-width:.5; }}
    }}

    /* Circuit dots blink offset */
    #td1,#td3 {{ animation: db 1.8s 0.0s ease-in-out infinite; }}
    #td2,#td4 {{ animation: db 1.8s 0.9s ease-in-out infinite; }}
    @keyframes db {{ 0%,100%{{opacity:.75}} 50%{{opacity:.08}} }}

    /* Torii slow glow breathe */
    #kasagi,#nuki,#lpillar,#rpillar {{ animation: tb 4.0s ease-in-out infinite; }}
    @keyframes tb {{ 0%,100%{{opacity:.94}} 50%{{opacity:1.0}} }}

    /* Scanline scroll */
    #scanlayer {{ animation: ss 8s linear infinite; }}
    @keyframes ss {{ from{{transform:translateY(0)}} to{{transform:translateY(14px)}} }}

    @media (prefers-reduced-motion: reduce) {{
      *, *::before, *::after {{ animation: none !important; }}
    }}
  </style>"""

    scan = (
        '  <g id="scanlayer" clip-path="url(#rnd)" opacity="0.040">\n' +
        "\n".join(
            f'    <line x1="0" y1="{y}" x2="512" y2="{y}" stroke="{MAGENTA}" stroke-width="0.7"/>'
            for y in range(-14, 530, 14)
        ) +
        "\n  </g>"
    )

    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">\n'
        f'  {icon_defs()}\n'
        f'{anim}\n'
        f'  <rect width="512" height="512" fill="url(#bgr)" rx="90"/>\n'
        f'{scan}\n'
        f'{icon_body(ids=True)}\n'
        f'</svg>'
    )


def build_animated_html():
    gap = WALL_LEN - 14
    svg_inline = build_icon(dark=True, anim_ids=True)

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ChibaTunnel — Animated Logo</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{
    background: {BG0};
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    font-family: 'JetBrains Mono', 'Courier New', monospace;
    overflow: hidden;
    color: #ccc;
  }}

  /* Scrolling background grid */
  .bg-grid {{
    position: fixed; inset: 0; pointer-events: none; z-index: 0;
    background-image:
      linear-gradient({MAGENTA}16 1px, transparent 1px),
      linear-gradient(90deg, {MAGENTA}16 1px, transparent 1px);
    background-size: 44px 44px;
    animation: grid-scroll 18s linear infinite;
  }}
  @keyframes grid-scroll {{
    from {{ background-position: 0 0; }}
    to   {{ background-position: 0 44px; }}
  }}

  /* Radial vignette */
  .vignette {{
    position: fixed; inset: 0; pointer-events: none; z-index: 1;
    background: radial-gradient(ellipse at 50% 45%, transparent 35%, {BG0}f0 100%);
  }}

  .stage {{
    position: relative; z-index: 2;
    display: flex; flex-direction: column;
    align-items: center; gap: 36px;
  }}

  /* Icon container */
  .icon-wrap {{
    position: relative;
    width: clamp(240px, 40vmin, 380px);
    height: clamp(240px, 40vmin, 380px);
  }}
  .icon-wrap svg {{
    width: 100%; height: 100%;
    filter:
      drop-shadow(0 0 18px {MAGENTA}55)
      drop-shadow(0 0 44px {MAGENTA}22);
    animation: levitate 6s ease-in-out infinite;
  }}
  @keyframes levitate {{
    0%,100% {{ transform: translateY(0px); }}
    50%     {{ transform: translateY(-10px); }}
  }}

  /* Scanline overlay on icon */
  .scan-layer {{
    position: absolute; inset: 0;
    border-radius: 22px;
    background: repeating-linear-gradient(
      0deg,
      transparent, transparent 13px,
      {MAGENTA}09 13px, {MAGENTA}09 14px
    );
    animation: scan-drift 8s linear infinite;
    pointer-events: none;
  }}
  @keyframes scan-drift {{
    from {{ background-position: 0 0; }}
    to   {{ background-position: 0 14px; }}
  }}

  /* Logo text */
  .logotype {{ text-align: center; user-select: none; }}
  .line1 {{
    font-size: clamp(40px, 9vw, 80px);
    font-weight: 700;
    letter-spacing: .06em;
    color: {MAGENTA};
    text-shadow: 0 0 10px {MAGENTA}dd, 0 0 28px {MAGENTA}55;
    animation: flicker 7s ease-in-out infinite;
  }}
  .line2 {{
    font-size: clamp(18px, 4vw, 38px);
    font-weight: 400;
    letter-spacing: .44em;
    color: {CYAN};
    text-shadow: 0 0 8px {CYAN}bb, 0 0 22px {CYAN}44;
    margin-top: 2px;
  }}
  .tagline {{
    font-size: clamp(9px, 1.4vw, 11px);
    letter-spacing: .32em;
    color: {MAGENTA};
    opacity: .38;
    margin-top: 16px;
    text-transform: uppercase;
  }}
  @keyframes flicker {{
    0%,91%,100% {{ text-shadow: 0 0 10px {MAGENTA}dd, 0 0 28px {MAGENTA}55; }}
    92%  {{ text-shadow: none; opacity: .82; }}
    93%  {{ text-shadow: 0 0 10px {MAGENTA}dd; opacity: 1; }}
    96%  {{ text-shadow: none; opacity: .88; }}
    97%  {{ text-shadow: 0 0 10px {MAGENTA}dd, 0 0 28px {MAGENTA}55; }}
  }}

  /* Status pill */
  .status {{
    display: flex; align-items: center; gap: 10px;
    font-size: 10px; letter-spacing: .26em;
    color: {CYAN}; opacity: .55; text-transform: uppercase;
  }}
  .status-dot {{
    width: 7px; height: 7px; border-radius: 50%;
    background: {CYAN};
    box-shadow: 0 0 8px {CYAN};
    animation: dot-beat 2s ease-in-out infinite;
  }}
  @keyframes dot-beat {{ 0%,100%{{opacity:1}} 50%{{opacity:.18}} }}

  /* ─── SVG element animations ─────────────────────────────── */
  #vpc  {{ animation: vp-p 2.2s ease-in-out infinite; }}
  #vpg  {{ animation: vp-g 2.2s ease-in-out infinite; }}
  #vpd  {{ animation: vp-d 2.2s ease-in-out infinite; }}
  @keyframes vp-p {{ 0%,100%{{opacity:.65}} 45%{{opacity:1}} }}
  @keyframes vp-g {{ 0%,100%{{opacity:.28}} 45%{{opacity:.65}} }}
  @keyframes vp-d {{ 0%,100%{{r:4}} 45%{{r:6}} }}

  #wl {{ stroke-dasharray:14 {gap:.0f}; animation: dp 1.8s 0.0s linear infinite; }}
  #wr {{ stroke-dasharray:14 {gap:.0f}; animation: dp 1.8s 0.9s linear infinite; }}
  @keyframes dp {{ to{{stroke-dashoffset:-{WALL_LEN:.0f}}} }}

  #dl4 {{ animation: dz 2.6s 0.00s ease-in-out infinite; }}
  #dl3 {{ animation: dz 2.6s 0.25s ease-in-out infinite; }}
  #dl2 {{ animation: dz 2.6s 0.50s ease-in-out infinite; }}
  #dl1 {{ animation: dz 2.6s 0.75s ease-in-out infinite; }}
  @keyframes dz {{
    0%,100%{{opacity:.06;stroke-width:.4}}
    22%    {{opacity:.95;stroke-width:2.2}}
    60%    {{opacity:.12;stroke-width:.5}}
  }}

  #td1,#td3 {{ animation: db 1.8s 0.0s ease-in-out infinite; }}
  #td2,#td4 {{ animation: db 1.8s 0.9s ease-in-out infinite; }}
  @keyframes db {{ 0%,100%{{opacity:.75}} 50%{{opacity:.08}} }}

  #kasagi,#nuki,#lpillar,#rpillar {{ animation: tb 4s ease-in-out infinite; }}
  @keyframes tb {{ 0%,100%{{opacity:.94}} 50%{{opacity:1}} }}

  @media (prefers-reduced-motion: reduce) {{
    *, *::before, *::after {{ animation: none !important; }}
  }}
</style>
</head>
<body>
  <div class="bg-grid"></div>
  <div class="vignette"></div>

  <div class="stage">
    <div class="icon-wrap">
      <div class="scan-layer"></div>
      {svg_inline}
    </div>

    <div class="logotype">
      <div class="line1">CHIBA</div>
      <div class="line2">TUNNEL</div>
      <div class="tagline">Decentralized &middot; Private &middot; Open</div>
    </div>

    <div class="status">
      <span class="status-dot"></span>
      dVPN Network &mdash; Online
    </div>
  </div>
</body>
</html>"""


def build_gif_frames(n=16):
    """
    Returns n SVG strings for a smooth tunnel-zoom + VP-pulse loop.
    dl4 (deepest) leads, dl1 (nearest gate) follows with 3/n phase lag.
    """
    frames = []
    for f in range(n):
        t = f / n

        # VP pulse (simple sine)
        vpc_op = 0.65 + 0.35 * math.sin(t * 2 * math.pi) ** 2

        # Depth-line tunnel-zoom: each line has its own phase
        def dl_op(phase_frac):
            raw = math.sin((t - phase_frac) * 2 * math.pi)
            return max(0.05, 0.05 + 0.90 * max(0.0, raw) ** 1.5)

        phases = [0.0, 3/48, 6/48, 9/48]  # dl4, dl3, dl2, dl1
        wlines = "\n".join(
            f'    <line x1="{xl:.1f}" y1="{y}" x2="{xr:.1f}" y2="{y}"'
            f' stroke="{CYAN}" stroke-width="{1.6 - ni*0.23:.2f}" opacity="{dl_op(phases[ni]):.3f}"/>'
            for ni, (y, xl, xr) in enumerate(WDEPTHS)
        )
        flines = "\n".join(
            f'    <line x1="{xl:.1f}" y1="{y}" x2="{xr:.1f}" y2="{y}"'
            f' stroke="{CYAN}" stroke-width="{1.0 - ni*0.15:.2f}" opacity="{0.42 - ni*0.13:.2f}"/>'
            for ni, (y, xl, xr) in enumerate(FDEPTHS)
        )

        svg = (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">\n'
            f'  {icon_defs()}\n'
            f'  <rect width="512" height="512" fill="url(#bgr)" rx="90"/>\n'
            f'{scanlines(512, 512)}\n'
            f'  <g filter="url(#cg)">\n'
            f'    <line x1="{GL}" y1="{GT}" x2="{VPX}" y2="{VPY}" stroke="{CYAN}" stroke-width="1.8" opacity="0.92"/>\n'
            f'    <line x1="{GR}" y1="{GT}" x2="{VPX}" y2="{VPY}" stroke="{CYAN}" stroke-width="1.8" opacity="0.92"/>\n'
            f'    <line x1="{VPX}" y1="{GT}" x2="{VPX}" y2="{VPY}" stroke="{CYAN}" stroke-width="0.9" opacity="0.30"/>\n'
            f'{wlines}\n'
            f'    <line x1="{FLX}" y1="{PB}" x2="{VPX}" y2="{VPY}" stroke="{CYAN}" stroke-width="1.2" opacity="0.52"/>\n'
            f'    <line x1="{FRX}" y1="{PB}" x2="{VPX}" y2="{VPY}" stroke="{CYAN}" stroke-width="1.2" opacity="0.52"/>\n'
            f'{flines}\n'
            f'  </g>\n'
            f'  <circle cx="{VPX}" cy="{VPY}" r="38" fill="{CYAN}" opacity="{vpc_op*0.43:.3f}" filter="url(#vp)"/>\n'
            f'  <circle cx="{VPX}" cy="{VPY}" r="12" fill="{CYAN}" opacity="{vpc_op:.3f}" filter="url(#vpc)"/>\n'
            f'  <circle cx="{VPX}" cy="{VPY}" r="4"  fill="{WHITE}"/>\n'
            f'  <polygon points="{KASAGI}" fill="{MAGENTA}" filter="url(#mg)"/>\n'
            f'  <rect x="{NX}" y="{NY}" width="{NW}" height="{NH}" rx="3" fill="{MAGENTA}" filter="url(#mg)"/>\n'
            f'  <rect x="{LPX}" y="{LPY}" width="{PW}" height="{LPH}" rx="3" fill="{MAGENTA}" filter="url(#mg)"/>\n'
            f'  <rect x="{RPX}" y="{LPY}" width="{PW}" height="{LPH}" rx="3" fill="{MAGENTA}" filter="url(#mg)"/>\n'
            f'  <g stroke="{CYAN}" stroke-width="1.3" opacity="0.48" fill="none">\n'
            f'    <polyline points="{LPX},250 108,250 108,282"/>\n'
            f'    <polyline points="{LPX},322 100,322"/>\n'
            f'    <circle cx="108" cy="282" r="3.2" fill="{CYAN}" stroke="none" opacity="0.75"/>\n'
            f'    <circle cx="100" cy="322" r="3.2" fill="{CYAN}" stroke="none" opacity="0.75"/>\n'
            f'    <polyline points="{FRX},266 404,266 404,294"/>\n'
            f'    <polyline points="{FRX},336 412,336"/>\n'
            f'    <circle cx="404" cy="294" r="3.2" fill="{CYAN}" stroke="none" opacity="0.75"/>\n'
            f'    <circle cx="412" cy="336" r="3.2" fill="{CYAN}" stroke="none" opacity="0.75"/>\n'
            f'  </g>\n'
            f'  <g stroke="{MAGENTA}" stroke-width="3" stroke-linecap="square" opacity="0.42">\n'
            f'    <line x1="30" y1="60" x2="30" y2="30"/><line x1="30" y1="30" x2="60" y2="30"/>\n'
            f'    <line x1="482" y1="60" x2="482" y2="30"/><line x1="482" y1="30" x2="452" y2="30"/>\n'
            f'    <line x1="30" y1="452" x2="30" y2="482"/><line x1="30" y1="482" x2="60" y2="482"/>\n'
            f'    <line x1="482" y1="452" x2="482" y2="482"/><line x1="482" y1="482" x2="452" y2="482"/>\n'
            f'  </g>\n'
            f'</svg>'
        )
        frames.append(svg)
    return frames


# ═══════════════════════════════════════════════════════════════════════════
#  MAIN
# ═══════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    try:
        import cairosvg
    except ImportError:
        print("ERROR: cairosvg not found.  Run: pip install cairosvg")
        sys.exit(1)

    try:
        from PIL import Image
        HAS_PIL = True
    except ImportError:
        HAS_PIL = False
        print("WARNING: Pillow not found — GIF skipped.  Run: pip install pillow")

    # ── 1. SVGs ──────────────────────────────────────────────────────────────
    svgs = {
        "chibatunnel-icon.svg":                  build_icon(dark=True,  badge=False),
        "chibatunnel-icon-transparent.svg":       build_icon(dark=False, badge=False),
        "chibatunnel-icon-badge.svg":             build_icon(dark=True,  badge=True),
        "chibatunnel-icon-badge-transparent.svg": build_icon(dark=False, badge=True),
        "chibatunnel-wordmark.svg":               build_wordmark(dark=True),
        "chibatunnel-wordmark-transparent.svg":   build_wordmark(dark=False),
        "chibatunnel-animated.svg":               build_animated_svg(),
    }
    for name, svg in svgs.items():
        with open(os.path.join(OUT, name), "w", encoding="utf-8") as fh:
            fh.write(svg)
        print(f"SVG   {name}")

    # ── 2. HTML ───────────────────────────────────────────────────────────────
    with open(os.path.join(OUT, "chibatunnel-animated.html"), "w", encoding="utf-8") as fh:
        fh.write(build_animated_html())
    print("HTML  chibatunnel-animated.html")

    # ── 3. PNGs ───────────────────────────────────────────────────────────────
    pngs = [
        ("chibatunnel-icon.svg",               "chibatunnel-icon-512.png",              512,  512),
        ("chibatunnel-icon.svg",               "chibatunnel-icon-256.png",              256,  256),
        ("chibatunnel-icon.svg",               "chibatunnel-icon-128.png",              128,  128),
        ("chibatunnel-icon.svg",               "chibatunnel-icon-64.png",               64,   64),
        ("chibatunnel-icon-transparent.svg",   "chibatunnel-icon-transparent-512.png",  512,  512),
        ("chibatunnel-icon-transparent.svg",   "chibatunnel-icon-transparent-256.png",  256,  256),
        ("chibatunnel-icon-badge.svg",         "chibatunnel-icon-badge-512.png",        512,  512),
        ("chibatunnel-icon-badge.svg",         "chibatunnel-icon-badge-256.png",        256,  256),
        ("chibatunnel-wordmark.svg",           "chibatunnel-wordmark.png",             1640,  440),
        ("chibatunnel-wordmark-transparent.svg","chibatunnel-wordmark-transparent.png", 1640,  440),
    ]
    for src, dst, w, h in pngs:
        cairosvg.svg2png(
            url=os.path.join(OUT, src),
            write_to=os.path.join(OUT, dst),
            output_width=w, output_height=h,
        )
        kb = os.path.getsize(os.path.join(OUT, dst)) // 1024
        print(f"PNG   {dst}  ({kb} KB)")

    # ── 4. GIF (tunnel-zoom loop) ─────────────────────────────────────────────
    if HAS_PIL:
        print("GIF   rendering 16 frames…", flush=True)
        frames_svg = build_gif_frames(16)
        pil_frames = []
        for svg_str in frames_svg:
            png_bytes = cairosvg.svg2png(
                bytestring=svg_str.encode(),
                output_width=512, output_height=512,
            )
            pil_frames.append(Image.open(io.BytesIO(png_bytes)).convert("RGBA"))

        gif_path = os.path.join(OUT, "chibatunnel-animated.gif")
        pil_frames[0].save(
            gif_path,
            save_all=True, append_images=pil_frames[1:],
            loop=0, duration=120, disposal=2,
        )
        kb = os.path.getsize(gif_path) // 1024
        print(f"GIF   chibatunnel-animated.gif  ({kb} KB)")
    else:
        print("GIF   skipped")

    print(f"\n✓  All assets in: {os.path.abspath(OUT)}/")
