import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'

const SCRAMBLE_CHARS = '!@#$%^&*01アイウエオカキクケコ▓░■□◆◇'

function ScrambleText({ text }: { text: string }) {
  const [displayChars, setDisplayChars] = useState<Array<{ char: string; scrambling: boolean }>>([])
  const [trigger, setTrigger] = useState(0)

  useEffect(() => {
    const targetWord = text || 'INITIALIZING...'
    setDisplayChars(targetWord.split('').map(char => ({ char, scrambling: true })))

    let iter = 0
    const interval = setInterval(() => {
      setDisplayChars(() => {
        return targetWord.split('').map((char, idx) => {
          if (char === ' ') {
            return { char: ' ', scrambling: false }
          }
          if (idx < iter) {
            return { char, scrambling: false }
          } else {
            const randomChar = SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)]
            return { char: randomChar, scrambling: true }
          }
        })
      })

      iter++
      if (iter > targetWord.length) {
        clearInterval(interval)
        const timeout = setTimeout(() => {
          setTrigger(t => t + 1)
        }, 3200)
        return () => clearTimeout(timeout)
      }
      return undefined
    }, 55)

    return () => clearInterval(interval)
  }, [text, trigger])

  return (
    <span className="scramble-container">
      {displayChars.map((item, idx) => (
        <span
          key={idx}
          className={`ch ${item.scrambling ? 'scrambling' : ''}`}
        >
          {item.char}
        </span>
      ))}
    </span>
  )
}

interface Props {
  status?: string
}

export default function SplashScreen({ status }: Props) {
  const { t } = useTranslation()

  return (
    <div className="splash-screen">
      <div className="bg-grid"></div>
      <div className="vignette"></div>

      <div className="stage">
        <div className="icon-wrap">
          <div className="scan-layer"></div>
          <svg viewBox="0 0 512 512" width="512" height="512" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <filter id="mg" x="-60%" y="-60%" width="220%" height="220%" colorInterpolationFilters="sRGB">
                <feGaussianBlur in="SourceGraphic" stdDeviation="6" result="b1" />
                <feGaussianBlur in="SourceGraphic" stdDeviation="16" result="b2" />
                <feMerge><feMergeNode in="b2" /><feMergeNode in="b1" /><feMergeNode in="SourceGraphic" /></feMerge>
              </filter>
              <filter id="cg" x="-60%" y="-60%" width="220%" height="220%" colorInterpolationFilters="sRGB">
                <feGaussianBlur in="SourceGraphic" stdDeviation="3.5" result="b1" />
                <feGaussianBlur in="SourceGraphic" stdDeviation="9" result="b2" />
                <feMerge><feMergeNode in="b2" /><feMergeNode in="b1" /><feMergeNode in="SourceGraphic" /></feMerge>
              </filter>
              <filter id="vp" x="-300%" y="-300%" width="700%" height="700%"><feGaussianBlur stdDeviation="18" /></filter>
              <filter id="vpc" x="-150%" y="-150%" width="400%" height="400%"><feGaussianBlur stdDeviation="6" /></filter>
              <radialGradient id="bgr" cx="50%" cy="45%" r="70%">
                <stop offset="0%" stopColor="#110020" />
                <stop offset="55%" stopColor="#0d0019" />
                <stop offset="100%" stopColor="#060010" />
              </radialGradient>
              <clipPath id="rnd"><rect width="512" height="512" rx="90" /></clipPath>
            </defs>
            <rect width="512" height="512" fill="url(#bgr)" rx="90" />
            <g clipPath="url(#rnd)" opacity="0.038">
              {Array.from({ length: 38 }).map((_, i) => (
                <line key={i} x1="0" y1={i * 14} x2="512" y2={i * 14} stroke="#ff0055" strokeWidth="0.7" />
              ))}
            </g>
            <g filter="url(#cg)">
              <line id="wl" x1="172" y1="184" x2="256" y2="318" stroke="#00ccff" strokeWidth="1.8" opacity="0.92" />
              <line id="wr" x1="340" y1="184" x2="256" y2="318" stroke="#00ccff" strokeWidth="1.8" opacity="0.92" />
              <line x1="256" y1="184" x2="256" y2="318" stroke="#00ccff" strokeWidth="0.9" opacity="0.30" />
              <line id="dl1" x1="190.8" y1="214" x2="321.2" y2="214" stroke="#00ccff" strokeWidth="1.60" opacity="0.90" />
              <line id="dl2" x1="208.4" y1="242" x2="303.6" y2="242" stroke="#00ccff" strokeWidth="1.37" opacity="0.78" />
              <line id="dl3" x1="225.3" y1="269" x2="286.7" y2="269" stroke="#00ccff" strokeWidth="1.14" opacity="0.66" />
              <line id="dl4" x1="241.0" y1="294" x2="271.0" y2="294" stroke="#00ccff" strokeWidth="0.91" opacity="0.54" />
              <line id="fl" x1="148" y1="436" x2="256" y2="318" stroke="#00ccff" strokeWidth="1.2" opacity="0.52" />
              <line id="fr" x1="364" y1="436" x2="256" y2="318" stroke="#00ccff" strokeWidth="1.2" opacity="0.52" />
              <line x1="202.9" y1="376" x2="309.1" y2="376" stroke="#00ccff" strokeWidth="1.00" opacity="0.42" />
              <line x1="175.5" y1="406" x2="336.5" y2="406" stroke="#00ccff" strokeWidth="0.85" opacity="0.29" />
            </g>
            <circle id="vpg" cx="256" cy="318" r="36" fill="#00ccff" opacity="0.28" filter="url(#vp)" />
            <circle id="vpc" cx="256" cy="318" r="12" fill="#00ccff" opacity="0.65" filter="url(#vpc)" />
            <circle id="vpd" cx="256" cy="318" r="4" fill="#ffffff" />
            <polygon id="kasagi" points="72,122 90,80 110,76 402,76 422,80 440,122 440,136 422,96 402,92 110,92 90,96 72,136" fill="#ff0055" filter="url(#mg)" />
            <rect id="nuki" x="148" y="168" width="216" height="16" rx="3" fill="#ff0055" filter="url(#mg)" />
            <rect id="lpillar" x="148" y="184" width="24" height="252" rx="3" fill="#ff0055" filter="url(#mg)" />
            <rect id="rpillar" x="340" y="184" width="24" height="252" rx="3" fill="#ff0055" filter="url(#mg)" />
            <g stroke="#00ccff" strokeWidth="1.3" opacity="0.48" fill="none">
              <polyline points="148,250 108,250 108,282" />
              <polyline points="148,322 100,322" />
              <circle id="td1" cx="108" cy="282" r="3.2" fill="#00ccff" stroke="none" opacity="0.75" />
              <circle id="td2" cx="100" cy="322" r="3.2" fill="#00ccff" stroke="none" opacity="0.75" />
              <polyline points="364,266 404,266 404,294" />
              <polyline points="364,336 412,336" />
              <circle id="td3" cx="404" cy="294" r="3.2" fill="#00ccff" stroke="none" opacity="0.75" />
              <circle id="td4" cx="412" cy="336" r="3.2" fill="#00ccff" stroke="none" opacity="0.75" />
            </g>
            <g stroke="#ff0055" strokeWidth="3" strokeLinecap="square" opacity="0.42">
              <line x1="30" y1="60" x2="30" y2="30" /><line x1="30" y1="30" x2="60" y2="30" />
              <line x1="482" y1="60" x2="482" y2="30" /><line x1="482" y1="30" x2="452" y2="30" />
              <line x1="30" y1="452" x2="30" y2="482" /><line x1="30" y1="482" x2="60" y2="482" />
              <line x1="482" y1="452" x2="482" y2="482" /><line x1="482" y1="482" x2="452" y2="482" />
            </g>
          </svg>
        </div>

        <div className="logotype">
          <div className="line1">CHIBA</div>
          <div className="line2">TUNNEL</div>
          <div className="tagline">Decentralized · Private · Open</div>
        </div>

        <div className="scramble-title">
          <ScrambleText text={t('common.loading')} />
        </div>

        {status && (
          <div className="status" style={{ marginTop: 4 }}>
            <span className="status-dot"></span>
            {status}
          </div>
        )}
      </div>

      <style dangerouslySetInnerHTML={{ __html: `
        .splash-screen {
          position: fixed; inset: 0; z-index: 9999;
          background: #0d0019;
          display: flex; flex-direction: column; align-items: center; justify-content: center;
          font-family: 'JetBrains Mono', 'Courier New', monospace;
          overflow: hidden;
        }
        .splash-screen .bg-grid {
          position: fixed; inset: 0; pointer-events: none; z-index: 0;
          background-image:
            linear-gradient(#ff005516 1px, transparent 1px),
            linear-gradient(90deg, #ff005516 1px, transparent 1px);
          background-size: 44px 44px;
          animation: grid-scroll 18s linear infinite;
        }
        @keyframes grid-scroll {
          from { background-position: 0 0; }
          to   { background-position: 0 44px; }
        }
        .splash-screen .vignette {
          position: fixed; inset: 0; pointer-events: none; z-index: 1;
          background: radial-gradient(ellipse at 50% 45%, transparent 35%, #0d0019f0 100%);
        }
        .splash-screen .stage {
          position: relative; z-index: 2;
          display: flex; flex-direction: column; align-items: center; gap: 36px;
        }
        .splash-screen .icon-wrap {
          position: relative;
          width: clamp(200px, 35vmin, 320px);
          height: clamp(200px, 35vmin, 320px);
        }
        .splash-screen .icon-wrap svg {
          width: 100%; height: 100%;
          filter: drop-shadow(0 0 18px #ff005555) drop-shadow(0 0 44px #ff005522);
          animation: levitate 6s ease-in-out infinite;
        }
        @keyframes levitate {
          0%,100% { transform: translateY(0px); }
          50%     { transform: translateY(-10px); }
        }
        .splash-screen .scan-layer {
          position: absolute; inset: 0; border-radius: 22px;
          background: repeating-linear-gradient(0deg, transparent, transparent 13px, #ff005509 13px, #ff005509 14px);
          animation: scan-drift 8s linear infinite;
          pointer-events: none;
        }
        @keyframes scan-drift {
          from { background-position: 0 0; }
          to   { background-position: 0 14px; }
        }
        .splash-screen .logotype { text-align: center; user-select: none; }
        .splash-screen .line1 {
          font-size: clamp(32px, 8vw, 70px);
          font-weight: 700; letter-spacing: .06em;
          color: #ff0055; text-shadow: 0 0 10px #ff0055dd, 0 0 28px #ff005555;
          animation: flicker 7s ease-in-out infinite;
        }
        .splash-screen .line2 {
          font-size: clamp(14px, 3.5vw, 32px);
          font-weight: 400; letter-spacing: .44em;
          color: #00ccff; text-shadow: 0 0 8px #00ccffbb, 0 0 22px #00ccff44;
          margin-top: 2px;
        }
        .splash-screen .tagline {
          font-size: clamp(8px, 1.2vw, 10px);
          letter-spacing: .32em; color: #ff0055; opacity: .38; margin-top: 16px;
          text-transform: uppercase;
        }
        @keyframes flicker {
          0%,91%,100% { text-shadow: 0 0 10px #ff0055dd, 0 0 28px #ff005555; }
          92%  { text-shadow: none; opacity: .82; }
          93%  { text-shadow: 0 0 10px #ff0055dd; opacity: 1; }
          96%  { text-shadow: none; opacity: .88; }
          97%  { text-shadow: 0 0 10px #ff0055dd, 0 0 28px #ff005555; }
        }
        .splash-screen .scramble-title {
          font-size: 13px;
          font-weight: 700;
          letter-spacing: .25em;
          text-transform: uppercase;
          height: 20px;
          display: flex;
          justify-content: center;
          align-items: center;
          margin-bottom: 2px;
        }
        .splash-screen .ch {
          display: inline-block;
          transition: color .08s;
          color: #ff0055;
          text-shadow: 0 0 8px rgba(255,0,85,.8), 0 0 24px rgba(255,0,85,.4);
        }
        .splash-screen .ch.scrambling {
          color: rgba(0, 204, 255, 0.9);
          text-shadow: 0 0 8px rgba(0, 204, 255, 0.9);
        }
        .splash-screen .status {
          display: flex; align-items: center; gap: 10px;
          font-size: 10px; letter-spacing: .26em; color: #00ccff; opacity: .55; text-transform: uppercase;
        }
        .splash-screen .status-dot {
          width: 7px; height: 7px; border-radius: 50%;
          background: #00ccff; box-shadow: 0 0 8px #00ccff;
          animation: dot-beat 2s ease-in-out infinite;
        }
        @keyframes dot-beat { 0%,100%{opacity:1} 50%{opacity:.18} }

        #vpc  { animation: vp-p 2.2s ease-in-out infinite; }
        #vpg  { animation: vp-g 2.2s ease-in-out infinite; }
        #vpd  { animation: vp-d 2.2s ease-in-out infinite; }
        @keyframes vp-p { 0%,100%{opacity:.65} 45%{opacity:1} }
        @keyframes vp-g { 0%,100%{opacity:.28} 45%{opacity:.65} }
        @keyframes vp-d { 0%,100%{r:4} 45%{r:6} }

        #wl { stroke-dasharray:14 144; animation: dp 1.8s 0.0s linear infinite; }
        #wr { stroke-dasharray:14 144; animation: dp 1.8s 0.9s linear infinite; }
        @keyframes dp { to{stroke-dashoffset:-158} }

        #dl4 { animation: dz 2.6s 0.00s ease-in-out infinite; }
        #dl3 { animation: dz 2.6s 0.25s ease-in-out infinite; }
        #dl2 { animation: dz 2.6s 0.50s ease-in-out infinite; }
        #dl1 { animation: dz 2.6s 0.75s ease-in-out infinite; }
        @keyframes dz {
          0%,100%{opacity:.06;stroke-width:.4}
          22%    {opacity:.95;stroke-width:2.2}
          60%    {opacity:.12;stroke-width:.5}
        }

        #td1,#td3 { animation: db 1.8s 0.0s ease-in-out infinite; }
        #td2,#td4 { animation: db 1.8s 0.9s ease-in-out infinite; }
        @keyframes db { 0%,100%{opacity:.75} 50%{opacity:.08} }

        #kasagi,#nuki,#lpillar,#rpillar { animation: tb 4s ease-in-out infinite; }
        @keyframes tb { 0%,100%{opacity:.94} 50%{opacity:1} }
      `}} />
    </div>
  )
}
