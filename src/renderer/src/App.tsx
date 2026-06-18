import React, { useState, useEffect, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import TitleBar           from './components/TitleBar'
import WalletSetup        from './components/WalletSetup'
import WalletBar          from './components/WalletBar'
import FiltersBar         from './components/FiltersBar'
import NodeTable          from './components/NodeTable'
import Globe              from './components/Globe'
import NodeConnectModal   from './components/NodeConnectModal'
import ConnectedBar       from './components/ConnectedBar'
import BinarySetup    from './components/BinarySetup'
import SessionPanel       from './components/SessionPanel'
import SettingsPanel      from './components/SettingsPanel'
import WalletManager      from './components/WalletManager'
import ConfirmModal       from './components/ConfirmModal'
import PlansPanel         from './components/PlansPanel'
import SubscriptionsPanel from './components/SubscriptionsPanel'
import SplashScreen       from './components/SplashScreen'
import { ApiNode, ApiPlan, ApiSubscription, NodeFilters, ConnectionState, BinaryStatus, INITIAL_CONNECTION } from './types'
import { 
  Globe as GlobeIcon, 
  Hexagon, 
  LayoutGrid, 
  Settings, 
  AlertTriangle, 
  RefreshCw, 
  RotateCcw, 
  X, 
  Circle, 
  Heart, 
  Star, 
  Home,
  Play,
  Ticket,
  CreditCard
} from 'lucide-react'

type AppScreen = 'loading' | 'setup' | 'main'
type Tab       = 'globe' | 'nodes' | 'plans' | 'my_subs' | 'sessions' | 'manage'

const GLOBE_DEFAULTS: NodeFilters = {
  search: '', country: '', city: '', type: '',
  onlyActive: true, onlyHealthy: true, onlyWhitelisted: false,
  hideResidential: false, hideDuplicate: false, bookmarksOnly: false,
}
const TABLE_DEFAULTS: NodeFilters = {
  search: '', country: '', city: '', type: '',
  onlyActive: true, onlyHealthy: true, onlyWhitelisted: false,
  hideResidential: false, hideDuplicate: false, bookmarksOnly: false,
}

export default function App() {
  const { t, i18n } = useTranslation()
  const isRtl = i18n.language === 'ar' || i18n.language === 'fa'

  useEffect(() => {
    document.documentElement.dir = isRtl ? 'rtl' : 'ltr'
    document.documentElement.lang = i18n.language
  }, [i18n.language, isRtl])

  const [screen, setScreen]         = useState<AppScreen>('loading')
  const [currentRpc, setCurrentRpc] = useState('')
  const [activeTab, setActiveTab]   = useState<Tab>('globe')
  const [binaries, setBinaries]     = useState<BinaryStatus | null>(null)
  const [showBinaryCheck, setShowBinaryCheck] = useState(false)

  const [nodes, setNodes]               = useState<ApiNode[]>([])
  const [nodesLoading, setNodesLoading] = useState(false)
  const [nodesError, setNodesError]     = useState<string | null>(null)

  const [plans, setPlans]               = useState<ApiPlan[]>([])
  const [plansLoading, setPlansLoading] = useState(false)
  const [subscriptions, setSubscriptions] = useState<ApiSubscription[]>([])
  const [subsLoading, setSubsLoading]     = useState(false)
  const [sessions, setSessions]         = useState<any[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(false)

  const [planNodesCache, setPlanNodesCache]         = useState<Record<number, ApiNode[]>>({})
  const [providerNamesCache, setProviderNamesCache] = useState<Record<string, string>>({})
  const [scannedOnce, setScannedOnce]               = useState(false)

  const [globeFilters, setGlobeFilters] = useState<NodeFilters>(GLOBE_DEFAULTS)
  const [tableFilters, setTableFilters] = useState<NodeFilters>(TABLE_DEFAULTS)

  const [bookmarks, setBookmarks] = useState<string[]>([])

  const [modalNode, setModalNode]           = useState<ApiNode | null>(null)
  const [modalInfoOnly, setModalInfoOnly]   = useState(false)
  const [reuseSessionId, setReuseSessionId] = useState<number | null>(null)
  const [reuseSubscriptionId, setReuseSubscriptionId] = useState<number | null>(null)
  
  const [showIpModal, setShowIpModal]           = useState(false)
  
  const [showQuitConfirm, setShowQuitConfirm]     = useState(false)
  const [showForgetConfirm, setShowForgetConfirm] = useState(false)
  const [showDnsRetryConfirm, setShowDnsRetryConfirm] = useState(false)
  const [quitting, setQuitting]                   = useState(false)

  const [vpnWarning, setVpnWarning]         = useState<string | null>(null)
  const [activeConnection, setActiveConnection] = useState<ConnectionState | null>(null)
  const [reconnectMsg, setReconnectMsg]     = useState<string | null>(null)
  const [ipInfo, setIpInfo]                 = useState<any>(null)

  const refreshIp = useCallback(async () => {
    console.log('[App] Refreshing public IP...')
    try {
      const res = await window.api.getPublicIp()
      console.log('[App] IP Refresh result:', res)
      setIpInfo(res)
    } catch (e) { 
      console.error('[App] Failed to refresh IP', e)
      setIpInfo({ error: String(e) })
    }
  }, [])

  const fetchNodes = useCallback(async () => {
    setNodesLoading(true); setNodesError(null)
    try {
      const res = await window.api.fetchNodes()
      if (res.success) setNodes(res.nodes as ApiNode[])
      else setNodesError((res as { error?: string }).error ?? 'Failed')
    } catch (e) { setNodesError(String(e)) }
    finally { setNodesLoading(false) }
  }, [])

  const fetchPlans = useCallback(async () => {
    setPlansLoading(true)
    try {
      const res = await window.api.fetchPlans()
      if (res.success) setPlans(res.plans as ApiPlan[])
    } catch (e) { console.error(e) }
    finally { setPlansLoading(false) }
  }, [])

  const fetchSubscriptions = useCallback(async () => {
    setSubsLoading(true)
    try {
      const res = await window.api.fetchSubscriptions()
      if (res.success) setSubscriptions(res.subscriptions as ApiSubscription[])
    } catch (e) { console.error(e) }
    finally { setSubsLoading(false) }
  }, [])

  const fetchSessions = useCallback(async () => {
    setSessionsLoading(true)
    try {
      const res = await window.api.fetchSessions()
      if (res.success) setSessions((res.sessions ?? []).filter((s: any) => typeof s.id === 'number'))
    } catch (e) { console.error(e) }
    finally { setSessionsLoading(false) }
  }, [])

  useEffect(() => {
    async function boot() {
      const startTime = Date.now()
      refreshIp()
      
      const rpcPromise  = window.api.getCurrentRpc()
      const binsPromise = window.api.checkBinaries()
      const bmsPromise  = window.api.listBookmarks()
      const hasMnemonicPromise = window.api.hasMnemonic()

      const [rpc, bins, bms, hasMnemonic] = await Promise.all([
        rpcPromise, binsPromise, bmsPromise, hasMnemonicPromise
      ])

      setCurrentRpc(rpc as string)
      setBinaries(bins as BinaryStatus)
      if (!(bins as BinaryStatus).wireguard || !(bins as BinaryStatus).v2ray) setShowBinaryCheck(true)
      setBookmarks(bms as string[])

      let nextScreen: AppScreen = 'setup'
      
      if (hasMnemonic) {
        const res = await window.api.loadStoredWallet()
        if (res.success) {
          setCurrentRpc((res as { rpc?: string }).rpc ?? (rpc as string))
          
          // Fetch main data in background while splash is showing
          const [nRes, pRes, sRes, sessRes] = await Promise.all([
            window.api.fetchNodes(),
            window.api.fetchPlans(),
            window.api.fetchSubscriptions(),
            window.api.fetchSessions()
          ])

          if ((nRes as any).success) setNodes((nRes as any).nodes)
          if ((pRes as any).success) {
            setPlans((pRes as any).plans)
            // Heavy Background Scan (Plans analysis)
            const planIds = (pRes as any).plans.map((p: any) => p.id)
            const uniqueProviders = Array.from(new Set((pRes as any).plans.map((p: any) => p.provAddress)))
            window.api.fetchProvidersBatch(uniqueProviders).then((res: any) => {
              if (res.success) setProviderNamesCache(prev => ({ ...prev, ...res.providers }))
            })
            window.api.scanPlanNodes(planIds).then((res: any) => {
              if (res.success) {
                setPlanNodesCache(prev => ({ ...prev, ...res.nodesMap }))
                setScannedOnce(true)
              }
            })
          }
          if ((sRes as any).success) setSubscriptions((sRes as any).subscriptions)
          if ((sessRes as any).success) setSessions(((sessRes as any).sessions ?? []).filter((s: any) => typeof s.id === 'number'))

          nextScreen = 'main'
        }
      }

      const elapsed = Date.now() - startTime
      const remaining = Math.max(0, 2500 - elapsed)
      setTimeout(() => setScreen(nextScreen), remaining)
    }
    boot()
  }, [refreshIp]) // Removed fetch dependencies to avoid re-triggering boot

  useEffect(() => { 
    // This is now handled in boot() for the initial load, 
    // but kept for reference if screen state changes later
  }, [screen, fetchNodes, fetchPlans, fetchSubscriptions])

  useEffect(() => {
    const u1 = window.api.onVpnStatus((d: any) => {
      if (d.status === 'connected' || d.step === 'connected') {
        // Se il main dice che siamo connessi, assicuriamoci che lo stato sia aggiornato
        setActiveConnection(prev => ({
          ...(prev || INITIAL_CONNECTION),
          step: 'connected',
          sessionId: d.sessionId || prev?.sessionId || null,
          node: d.node || prev?.node || null
        }))
      }
    })
    const u2 = window.api.onVpnDisconnect((d: any) => {
      const reason = d?.reason ?? 'Disconnected'
      if (reason === 'manual') {
        setReconnectMsg(null)
        setActiveConnection(null)
      } else {
        setReconnectMsg(`${reason} — attempting reconnect…`)
        setActiveConnection(null)
      }
      setTimeout(refreshIp, 1000)
    })
    const u3 = window.api.onReconnect((d: unknown) => {
      const ev = d as { status: string; attempt?: number; delay?: number }
      if (ev.status === 'connected') {
        setReconnectMsg(null)
        setTimeout(refreshIp, 2000)
      }
      else if (ev.status === 'failed')  setReconnectMsg('Auto-reconnect failed after 5 attempts.')
      else if (ev.status === 'reconnecting') setReconnectMsg(`Reconnecting… (attempt ${ev.attempt})`)
      else if (ev.status === 'waiting') setReconnectMsg(`Reconnecting in ${Math.round((ev.delay ?? 0) / 1000)}s…`)
    })
    const u4 = window.api.onVpnWarning((d: unknown) => {
      const w = (d as { message?: string }).message ?? 'VPN warning'
      setVpnWarning(w)
      setTimeout(() => setVpnWarning(null), 8000)
    })
    const u5 = window.api.onCloseRequest(() => setShowQuitConfirm(true))
    const u6 = window.api.onDnsRetryAsk(() => setShowDnsRetryConfirm(true))
    return () => { u1(); u2(); u3(); u4(); u5(); u6() }
  }, [refreshIp])

  function applyFilters(nodes: ApiNode[], f: NodeFilters, bms: string[]): ApiNode[] {
    return nodes.filter(n => {
      const q = f.search.toLowerCase()
      if (q) {
        const ok = (n.moniker ?? '').toLowerCase().includes(q)
          || (n.address ?? '').toLowerCase().includes(q)
          || (n.city    ?? '').toLowerCase().includes(q)
        if (!ok) return false
      }
      if (f.country         && n.country !== f.country)          return false
      if (f.city            && n.city    !== f.city)             return false
      if (f.type            && n.type    !== parseInt(f.type))   return false
      if (f.onlyActive      && !n.isActive)                      return false
      if (f.onlyHealthy     && !n.isHealthy)                     return false
      if (f.onlyWhitelisted && !n.isWhitelisted)                 return false
      if (f.hideResidential && n.isResidential)                  return false
      if (f.hideDuplicate   && n.isDuplicate)                    return false
      if (f.bookmarksOnly   && !bms.includes(n.address))         return false
      return true
    })
  }

  const globeNodes = useMemo(() => applyFilters(nodes, globeFilters, bookmarks), [nodes, globeFilters, bookmarks])
  const tableNodes = useMemo(() => applyFilters(nodes, tableFilters, bookmarks), [nodes, tableFilters, bookmarks])

  async function toggleBookmark(address: string) {
    const res = await window.api.toggleBookmark(address) as { bookmarks: string[] }
    setBookmarks(res.bookmarks)
  }

  async function handleForgetWallet() {
    setShowForgetConfirm(true)
  }

  async function doForgetWallet() {
    setShowForgetConfirm(false)
    await window.api.forgetWallet()
    setActiveConnection(null); setNodes([]); setScreen('setup')
  }

  async function handleDisconnect() {
    await window.api.disconnectNode()
    setActiveConnection(null); setReconnectMsg(null)
    setTimeout(refreshIp, 1000)
  }

  async function handleConnectSession(nodeAddr: string, sid: number) {
    let target = nodes.find(n => n.address === nodeAddr)
    if (!target) {
      try {
        const res = await window.api.fetchNodeInfo(nodeAddr)
        if (res.success) target = (res.info as any).result || res.info
      } catch (e) { console.error('Failed to fetch node info', e) }
    }
    if (!target) { alert(`Node not found: ${nodeAddr}`); return }
    setReuseSessionId(sid); setModalInfoOnly(false); setModalNode(target)
  }

  async function handleConnectSubscription(subId: number, nodeAddr: string) {
    let target = nodes.find(n => n.address === nodeAddr)
    if (!target) {
      try {
        const res = await window.api.fetchNodeInfo(nodeAddr)
        if (res.success) target = (res.info as any).result || res.info
      } catch (e) { console.error('Failed to fetch node info', e) }
    }
    if (!target) { alert(`Node not found: ${nodeAddr}`); return }
    setReuseSubscriptionId(subId); setModalInfoOnly(false); setModalNode(target)
  }

  const tabs: Array<{ id: Tab; label: string; icon: React.ReactNode }> = [
    { id: 'globe',    label: t('tabs.globe'),    icon: <GlobeIcon size={14} /> },
    { id: 'nodes',    label: t('tabs.nodes'),    icon: <Hexagon size={14} /> },
    { id: 'plans',    label: t('tabs.plans'),    icon: <Ticket size={14} /> },
    { id: 'my_subs',  label: t('tabs.my_subs'),  icon: <CreditCard size={14} /> },
    { id: 'sessions', label: t('tabs.sessions'), icon: <LayoutGrid size={14} /> },
    { id: 'manage',   label: t('tabs.manage'),   icon: <Settings size={14} /> },
  ]

  useEffect(() => {
    if (activeConnection?.step === 'connected') {
      window.api.startTraffic()
    } else if (!activeConnection) {
      window.api.stopTraffic()
    }
  }, [activeConnection])

  if (screen === 'loading') return <SplashScreen />

  if (screen === 'setup') return (
    <div className="app-shell" dir={isRtl ? 'rtl' : 'ltr'}>
      <TitleBar />
      <WalletSetup onSuccess={(_, rpc) => { setCurrentRpc(rpc); setScreen('main') }} />
    </div>
  )

  return (
    <div className="app-shell" dir={isRtl ? 'rtl' : 'ltr'}>
      <TitleBar 
        showRpc currentRpc={currentRpc} 
        onRpcChanged={url => { setCurrentRpc(url); fetchNodes() }} 
        ipInfo={ipInfo}
        onRefreshIp={refreshIp}
      />

      {showBinaryCheck && binaries && (
        <BinarySetup
          status={binaries}
          onDismiss={() => setShowBinaryCheck(false)}
          onRecheck={async () => {
            const b = await window.api.checkBinaries() as BinaryStatus
            setBinaries(b); return b
          }}
        />
      )}

      <div className="content-area">
        <div className="main-layout">
          <WalletBar onForget={handleForgetWallet} />

          <div className="tab-bar">
            {tabs.map(t => (
              <button key={t.id} className={`tab-btn ${activeTab === t.id ? 'active' : ''}`}
                onClick={() => setActiveTab(t.id)}>
                <span className="tab-icon" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{t.icon}</span>{t.label}
              </button>
            ))}
            <div style={{ flex: 1 }} />
            {binaries && (!binaries.wireguard || !binaries.v2rayPath) && (
              <button className="tab-btn" style={{ color: 'var(--yellow)', display: 'inline-flex', alignItems: 'center', gap: 6 }}
                onClick={() => setShowBinaryCheck(true)}>
                <AlertTriangle size={14} /> {t('common.missing_deps')}
              </button>
            )}
          </div>

          <div className="tab-content">
            {activeTab === 'globe' && (
              <div className="globe-tab-layout">
                <Globe nodes={globeNodes} bookmarks={bookmarks}
                  onSelect={node => { setModalInfoOnly(false); setModalNode(node) }} />
                <div className="globe-sidebar">
                  <div className="globe-sidebar-header">{t('filters.title')}</div>
                  <input className="form-input" style={{ fontSize: 11, padding: '6px 10px', marginBottom: 10 }}
                    placeholder={t('common.search')} value={globeFilters.search}
                    onChange={e => setGlobeFilters(f => ({ ...f, search: e.target.value }))} />
                  {([
                    ['onlyActive',      <Circle size={10} fill="currentColor" style={{ opacity: 0.8 }} />, t('filters.only_active')],
                    ['onlyHealthy',     <Heart size={10} fill="currentColor" style={{ opacity: 0.8 }} />, t('filters.only_healthy')],
                    ['bookmarksOnly',   <Star size={10} fill="currentColor" style={{ opacity: 0.8 }} />, t('filters.bookmarks_only')],
                    ['hideResidential', <Home size={10} fill="currentColor" style={{ opacity: 0.8 }} />, t('filters.hide_residential')],
                  ] as [keyof NodeFilters, React.ReactNode, string][]).map(([key, icon, label]) => (
                    <label key={key} className="globe-filter-check">
                      <input type="checkbox" checked={!!globeFilters[key]}
                        onChange={e => setGlobeFilters(f => ({ ...f, [key]: e.target.checked }))} />
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>{icon} {label}</span>
                    </label>
                  ))}
                  <div style={{ marginTop: 10 }}>
                    <div style={{ fontSize: 9, color: 'var(--text-3)', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 6 }}>{t('filters.type')}</div>
                    <select className="filter-select" style={{ width: '100%' }}
                      value={globeFilters.type}
                      onChange={e => setGlobeFilters(f => ({ ...f, type: e.target.value as NodeFilters['type'] }))}>
                      <option value="">{t('filters.all')}</option>
                      <option value="1">{t('filters.wireguard')}</option>
                      <option value="2">{t('filters.v2ray')}</option>
                    </select>
                  </div>
                  <button className="btn btn-secondary btn-sm" style={{ marginTop: 10, display: 'inline-flex', alignItems: 'center', gap: 6 }}
                    onClick={() => setGlobeFilters(GLOBE_DEFAULTS)}>
                    <RotateCcw size={12} /> {t('filters.reset')}
                  </button>
                </div>
              </div>
            )}

            {activeTab === 'nodes' && (
              <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
                <FiltersBar filters={tableFilters} onChange={setTableFilters} nodes={nodes} filteredCount={tableNodes.length} />
                {nodesLoading && nodes.length === 0
                  ? <div className="empty-state"><div className="spinner" style={{ width: 32, height: 32 }} /><div className="empty-state-text">Fetching nodes…</div></div>
                  : nodesError
                    ? <div className="empty-state">
                        <div className="empty-state-icon"><AlertTriangle size={32} color="var(--red)" /></div>
                        <div className="empty-state-text" style={{ color: 'var(--red)' }}>{nodesError}</div>
                        <button className="btn btn-secondary btn-sm" onClick={fetchNodes}>Retry</button>
                      </div>
                    : <NodeTable nodes={tableNodes} onSelect={node => { 
                        const isConnected = activeConnection?.node?.address === node.address;
                        setModalInfoOnly(isConnected); 
                        setModalNode(node); 
                      }}
                        activeNodeAddress={activeConnection?.node?.address}
                        bookmarks={bookmarks} onToggleBookmark={toggleBookmark} />
                }
              </div>
            )}

            {activeTab === 'plans' && (
              <PlansPanel 
                plans={plans} 
                loading={plansLoading} 
                globalNodes={nodes}
                planNodesCache={planNodesCache}
                setPlanNodesCache={setPlanNodesCache}
                providerNamesCache={providerNamesCache}
                setProviderNamesCache={setProviderNamesCache}
                scannedOnce={scannedOnce}
                setScannedOnce={setScannedOnce}
                bookmarks={bookmarks}
                onToggleBookmark={toggleBookmark}
                activeNodeAddress={activeConnection?.node?.address}
                onSelectNode={node => { setModalInfoOnly(true); setModalNode(node) }}
                onSubscribe={() => fetchSubscriptions()} 
              />
            )}

            {activeTab === 'my_subs' && (
              <SubscriptionsPanel 
                subscriptions={subscriptions} 
                plans={plans} 
                loading={subsLoading}
                globalNodes={nodes}
                providerNamesCache={providerNamesCache}
                setProviderNamesCache={setProviderNamesCache}
                planNodesCache={planNodesCache}
                setPlanNodesCache={setPlanNodesCache}
                bookmarks={bookmarks}
                onToggleBookmark={toggleBookmark}
                activeNodeAddress={activeConnection?.node?.address}
                onConnect={handleConnectSubscription}
                onUpdateSub={fetchSubscriptions}
              />
            )}

            {activeTab === 'sessions' && <SessionPanel nodes={nodes} subscriptions={subscriptions} plans={plans} onConnectSession={handleConnectSession} />}

            {activeTab === 'manage' && (
              <div className="manage-tab-layout">
                <div className="manage-sidebar">
                  <div className="manage-sidebar-top">
                    <WalletManager onSwitched={(_, __, rpc) => { 
                      setCurrentRpc(rpc); 
                      fetchNodes();
                      setTimeout(refreshIp, 1000);
                    }} />
                  </div>
                  
                  <div className="manage-binaries-section">
                    <div className="settings-section-label" style={{ marginBottom: 12 }}>{t('settings.binaries_title')}</div>
                    {binaries ? (
                      <BinarySetup
                        status={binaries}
                        onRecheck={async () => {
                          const fresh = await window.api.checkBinaries() as BinaryStatus
                          setBinaries(fresh)
                          return fresh
                        }}
                        embedded
                      />
                    ) : (
                      <div className="spinner" style={{ width: 20, height: 20, margin: '20px auto' }} />
                    )}
                  </div>
                </div>
                
                <div className="manage-main">
                  <SettingsPanel currentRpc={currentRpc} />
                </div>
              </div>
            )}
          </div>

          <div className="bottom-bar">
            <button className="btn btn-secondary btn-sm" onClick={fetchNodes} disabled={nodesLoading}>
              {nodesLoading ? <><div className="spinner" style={{ width: 10, height: 10 }} /> {t('common.fetching_nodes')}</> : <><RefreshCw size={10} style={{ marginRight: 6 }} /> {t('common.refresh')}</>}
            </button>
            <span style={{ fontSize: 10, color: 'var(--text-3)' }}>{nodes.length} {t('common.nodes')}</span>
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 10, color: 'var(--text-3)' }}>{(currentRpc || '').replace('https://', '').split(':')[0]}</span>
          </div>

          {(activeConnection?.step === 'connected' || reconnectMsg) && (
            <ConnectedBar
              connection={activeConnection ?? { step: 'connected', node: null, subscriptionType: 'gigabytes', amount: 0, sessionId: null, vpnType: null, configStr: null, wgQrCode: null, shareLinks: [], v2rayQrCodes: [], inbounds: null, error: null }}
              reconnectMsg={reconnectMsg} onDisconnect={handleDisconnect}
              onManage={() => { if (activeConnection?.node) { setModalInfoOnly(true); setModalNode(activeConnection.node) } }}
            />
          )}
        </div>
      </div>

      {modalNode && (
        <NodeConnectModal
          node={modalNode} bookmarked={bookmarks.includes(modalNode.address)}
          onBookmark={() => toggleBookmark(modalNode.address)}
          onClose={() => { setModalNode(null); setModalInfoOnly(false); setReuseSessionId(null); setReuseSubscriptionId(null) }}
          onConnected={state => {
            setActiveConnection(state); setModalNode(null); setModalInfoOnly(false); setReuseSessionId(null); setReuseSubscriptionId(null)
            setTimeout(refreshIp, 2000)
          }}
          infoOnly={modalInfoOnly}
          initialSessionId={reuseSessionId ? reuseSessionId.toString() : null}
          initialSubscriptionId={reuseSubscriptionId ? reuseSubscriptionId.toString() : null}
        />
      )}

      {showForgetConfirm && (
        <ConfirmModal
          title={t('wallet.forget_confirm_title')} danger confirmLabel={t('wallet.forget_confirm_btn')} cancelLabel={t('common.cancel')}
          onCancel={() => setShowForgetConfirm(false)} onConfirm={doForgetWallet}
          message={t('wallet.forget_confirm_msg')}
        />
      )}

      {showQuitConfirm && (
        <ConfirmModal
          title={quitting ? t('modals.quit.title_quitting') : t('modals.quit.title_active')} 
          danger confirmLabel={quitting ? "" : t('modals.quit.confirm_quit')} cancelLabel={quitting ? "" : t('common.cancel')}
          onCancel={() => !quitting && setShowQuitConfirm(false)} 
          onConfirm={async () => { setQuitting(true); await window.api.quitApp(true) }}
          message={
            quitting ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20, padding: '20px 0' }}>
                <div className="spinner" style={{ width: 32, height: 32 }} />
                <div style={{ fontSize: 11, color: 'var(--text-3)', letterSpacing: '0.1em', textAlign: 'center' }}>
                  {t('modals.quit.terminating_on_chain')}<br/>
                  <span style={{ fontSize: 9, opacity: 0.7, marginTop: 8, display: 'block' }}>
                    {t('modals.quit.password_warning')}
                  </span>
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <p style={{ color: 'var(--text-2)' }}>{t('modals.quit.message')}</p>
                <button className="btn btn-secondary btn-full" onClick={async () => { await window.api.quitApp(false) }}>{t('modals.quit.quit_only')}</button>
              </div>
            )
          }
        />
      )}

      {showDnsRetryConfirm && (
        <ConfirmModal
          title={t('modals.dns.title')} confirmLabel={t('modals.dns.confirm')} cancelLabel={t('common.cancel')}
          onCancel={() => setShowDnsRetryConfirm(false)}
          onConfirm={() => { setShowDnsRetryConfirm(false); window.api.approveDnsRetry() }}
          message={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <p style={{ color: 'var(--text-2)' }}>{t('modals.dns.message')}</p>
              <p style={{ color: 'var(--yellow)', fontWeight: 600 }}>{t('modals.dns.retrying_msg')}</p>
            </div>
          }
        />
      )}

      {vpnWarning && (
        <div className="vpn-toast" onClick={() => setVpnWarning(null)}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><AlertTriangle size={14} /> {vpnWarning}</span>
          <span className="vpn-toast-close"><X size={14} /></span>
        </div>
      )}
    </div>
  )
}
