import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { BinaryStatus } from '../types'
import { 
  Hexagon, 
  Play, 
  Shield, 
  Check, 
  Copy, 
  AlertTriangle, 
  X, 
  ChevronUp, 
  ChevronDown, 
  FolderOpen, 
  RefreshCw, 
  Zap
} from 'lucide-react'

interface InstallStep {
  id:      string // internal ID for filtering (debian, arch, fedora, suse)
  label:   string
  code:    string
  note?:   string
}

interface BinaryGuide {
  id:         string
  name:       string
  icon:       React.ReactNode
  found:      boolean
  path:       string | null
  hash:       string | null
  why:        string
  linux:      InstallStep[]
  macos:      InstallStep[]
  windows:    string   // URL
}

const GUIDES = (status: BinaryStatus, t: any): BinaryGuide[] => [
  {
    id:    'wireguard',
    name:  'WireGuard (wg-quick)',
    icon:  <Hexagon size={16} />,
    found: status.wireguard,
    path:  status.wgPath,
    hash:  status.wgHash,
    why:   t('binary.why.wireguard'),
    linux: [
      { id: 'debian', label: 'Ubuntu / Debian', code: 'apt install -y wireguard-tools' },
      { id: 'fedora', label: 'Fedora / RHEL',   code: 'dnf install -y wireguard-tools' },
      { id: 'arch',   label: 'Arch Linux',      code: 'pacman -S --noconfirm wireguard-tools' },
      { id: 'suse',   label: 'openSUSE',        code: 'zypper install -y wireguard-tools' },
    ],
    macos:   [{ id: 'brew', label: 'Homebrew', code: 'brew install wireguard-tools' }],
    windows: 'https://www.wireguard.com/install/',
  },
  {
    id:    'v2ray',
    name:  'V2Ray',
    icon:  <Play size={16} fill="currentColor" />,
    found: status.v2ray,
    path:  status.v2rayPath,
    hash:  status.v2rayHash,
    why:   t('binary.why.v2ray'),
    linux: [
      { id: 'debian', label: 'Official Script', code: 'curl -L https://raw.githubusercontent.com/v2fly/fhs-install-v2ray/master/install-release.sh | bash' },
      { id: 'fedora', label: 'Official Script', code: 'curl -L https://raw.githubusercontent.com/v2fly/fhs-install-v2ray/master/install-release.sh | bash' },
      { id: 'arch',   label: 'Arch Linux',      code: 'pacman -S --noconfirm v2ray' },
    ],
    macos:   [{ id: 'brew', label: 'Homebrew', code: 'brew install v2ray' }],
    windows: 'https://github.com/v2fly/v2ray-core/releases/latest',
  },
  {
    id:    'tun2socks',
    name:  'tun2socks',
    icon:  <Shield size={16} />,
    found: status.tun2socks,
    path:  status.tun2socksPath,
    hash:  status.tun2socksHash,
    why:   t('binary.why.tun2socks'),
    linux: [
      { id: 'debian', label: 'Ubuntu / Debian', code: 'apt install -y tun2socks' },
      { id: 'arch',   label: 'Arch Linux (AUR)', code: 'yay -S --noconfirm tun2socks' },
      { id: 'fedora', label: 'Fedora / RHEL',   code: 'dnf install -y tun2socks' },
    ],
    macos:   [{ id: 'brew', label: 'Homebrew', code: 'brew install tun2socks' }],
    windows: 'https://github.com/xjasonlyu/tun2socks/releases',
  }
]

function ActionBtn({ code, onExec }: { code: string; onExec: (cmd: string) => void }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      <button className="btn btn-secondary btn-sm" onClick={() => { navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500) }}>
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
      <button className="btn btn-primary btn-sm" disabled={busy} onClick={async () => { setBusy(true); await onExec(code); setBusy(false) }}>
        {busy ? <div className="spinner" style={{ width: 10, height: 10 }} /> : <><Zap size={12} style={{ marginRight: 4 }} /> {t('common.exec')}</>}
      </button>
    </div>
  )
}

interface Props {
  status:    BinaryStatus
  onDismiss?: () => void
  onRecheck: () => Promise<BinaryStatus>
  embedded?: boolean
}

export default function BinarySetup({ status, onDismiss, onRecheck, embedded = false }: Props) {
  const { t } = useTranslation()
  const [current, setCurrent]   = useState(status)
  const [checking, setChecking] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    if (embedded) return
    const handleEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss?.() }
    window.addEventListener('keydown', handleEsc)
    return () => window.removeEventListener('keydown', handleEsc)
  }, [onDismiss, embedded])

  async function handleRecheck() {
    setChecking(true); try { const fresh = await onRecheck(); setCurrent(fresh) } finally { setChecking(false) }
  }

  async function handleBrowse(id: string) {
    const isWin = current.platform === 'win32'
    const name = id === 'wireguard' 
      ? (isWin ? 'wireguard.exe' : 'wg-quick')
      : id === 'v2ray' 
        ? (isWin ? 'v2ray.exe' : 'v2ray')
        : (isWin ? 'tun2socks.exe' : 'tun2socks')
    
    const res = await (window.api as any).browseBinary(name)
    if (res.success) {
      handleRecheck()
    }
  }

  async function handleExec(cmd: string) {
    const res = await (window.api as any).installBinary(cmd)
    if (res.success) {
      alert(t('binary.exec_success'))
      handleRecheck()
    } else {
      alert(`${t('common.error')}: ${res.error}`)
    }
  }

  const getFilteredSteps = (g: BinaryGuide) => {
    if (current.platform === 'darwin') return g.macos
    if (current.platform === 'win32') return []
    // Linux: strictly filter by detected distro
    const steps = g.linux.filter(s => s.id === current.distro)
    // If no specific match, show all linux steps as fallback
    return steps.length > 0 ? steps : g.linux
  }

  const guides = GUIDES(current, t).filter(g => !g.found)
  
  const content = (
    <div className={embedded ? "binary-check-embedded" : "binary-check-card"} style={embedded ? {} : { maxWidth: 700 }}>
      {!embedded && <button className="modal-close" style={{ position: 'absolute', top: 20, right: 20 }} onClick={onDismiss}><X size={18} /></button>}

      <div className="binary-check-header">
        <div className="binary-check-icon">
          {guides.length > 0 ? <AlertTriangle size={24} color="var(--yellow)" /> : <Check size={24} color="var(--green)" />}
        </div>
        <div>
          <div className="binary-check-title">{t('binary.integrity_check')}</div>
          <div className="binary-check-sub">{t('binary.env_check', { distro: current.distro.toUpperCase() })}</div>
        </div>
      </div>

      <div className="binary-status-list">
        {GUIDES(current, t).map(g => (
          <div key={g.id} className={`binary-row ${g.found ? 'ok' : 'missing'}`} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className="binary-icon" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{g.icon}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div className="binary-name">{g.name}</div>
                  <span className={`tag ${g.found ? 'tag-green' : 'tag-red'}`}>{g.found ? t('common.verified') : t('common.missing')}</span>
                </div>
                {g.found ? (
                  <>
                    <div className="binary-path" title={g.path ?? ''}>
                      {g.path}
                    </div>
                    {g.hash && (
                      <div style={{ fontSize: 8, color: 'var(--text-3)', fontFamily: 'var(--font-mono)', opacity: 0.8, marginTop: 1, wordBreak: 'break-all' }}>
                        SHA256: {g.hash}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="binary-path" style={{ color: 'var(--red)', opacity: 0.8 }}>{t('binary.not_found')}</div>
                )}
              </div>
              
              {/* Embedded mode browse button (compact) */}
              {embedded && g.found && (current.platform === 'win32' || current.platform === 'darwin') && (
                 <button className="btn btn-secondary btn-xs" onClick={() => handleBrowse(g.id)}>
                   {t('common.browse')}
                 </button>
              )}
            </div>

            {!g.found && (
              <div style={{ borderTop: '1px solid var(--border)', paddingTop: 6, marginTop: 2 }}>
                <button className="btn btn-secondary btn-xs btn-full" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }} onClick={() => setExpanded(expanded === g.id ? null : g.id)}>
                  {expanded === g.id ? <ChevronUp size={10} /> : <ChevronDown size={10} />} {expanded === g.id ? t('binary.hide_guide') : t('binary.view_guide')}
                </button>
                {expanded === g.id && (
                  <div style={{ marginTop: 10 }}>
                    <div style={{ fontSize: 10, color: 'var(--text-3)', marginBottom: 10, lineHeight: 1.5 }}>
                      {g.why}
                      {g.id === 'tun2socks' && current.platform === 'win32' && (
                        <div style={{ marginTop: 6, color: 'var(--orange)', fontWeight: 600, fontSize: 9, display: 'flex', alignItems: 'center', gap: 6 }}>
                          <AlertTriangle size={12} /> {t('binary.wintun_missing')}
                          <br />
                          <a href="https://www.wintun.net/" target="_blank" rel="noreferrer" style={{ color: 'var(--cyan)', textDecoration: 'underline' }}>
                            wintun.net
                          </a>
                        </div>
                      )}
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {/* Platform-specific Actions (Download/Browse) */}
                      <div style={{ display: 'flex', gap: 8 }}>
                        {current.platform === 'win32' && (
                          <a href={g.windows} target="_blank" rel="noreferrer" className="btn btn-primary btn-xs" style={{ flex: 1, textDecoration: 'none' }}>
                            {t('binary.download_windows')}
                          </a>
                        )}
                        {(current.platform === 'win32' || current.platform === 'darwin') && (
                          <button className="btn btn-secondary btn-xs" style={{ flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }} onClick={() => handleBrowse(g.id)}>
                            <FolderOpen size={12} /> {t('common.browse')}
                          </button>
                        )}
                      </div>

                      {/* Manual Terminal Commands */}
                      {current.platform !== 'win32' && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
                          {getFilteredSteps(g).map((step, i) => (
                            <div key={i} style={{ background: 'var(--bg-0)', padding: 8, borderRadius: 4, border: '1px solid var(--border)' }}>
                              <div style={{ fontSize: 8, color: 'var(--text-3)', marginBottom: 4, textTransform: 'uppercase' }}>{step.label}</div>
                              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                <code style={{ flex: 1, fontSize: 9, color: 'var(--cyan)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{step.code}</code>
                                <ActionBtn code={step.code} onExec={handleExec} />
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
        <button className="btn btn-secondary btn-sm" disabled={checking} onClick={handleRecheck} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {checking ? <div className="spinner" style={{ width: 12, height: 12 }} /> : <RefreshCw size={12} />}
          {checking ? t('common.checking') : t('common.refresh')}
        </button>
        {!embedded && <button className="btn btn-primary" style={{ flex: 1 }} onClick={onDismiss}>{t('binary.ignore_continue')}</button>}
      </div>
    </div>
  )

  if (embedded) return content

  if (guides.length === 0) return null

  return (
    <div className="binary-check-overlay" onClick={e => e.target === e.currentTarget && onDismiss?.()}>
      {content}
    </div>
  )
}
