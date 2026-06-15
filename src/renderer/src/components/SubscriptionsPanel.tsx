import React, { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiSubscription, ApiNode, ApiPlan } from '../types'
import { Loader2, CreditCard, Calendar, Database, Play, Activity, Server, Shield, ExternalLink, ChevronDown } from 'lucide-react'
import NodeTable from './NodeTable'
import ConfirmModal from './ConfirmModal'
import { formatDataQuota } from '../utils'

interface Props {
  subscriptions: ApiSubscription[]
  plans: ApiPlan[]
  loading: boolean
  globalNodes: ApiNode[]
  providerNamesCache: Record<string, any>
  setProviderNamesCache: React.Dispatch<React.SetStateAction<Record<string, any>>>
  planNodesCache: Record<number, ApiNode[]>
  setPlanNodesCache: React.Dispatch<React.SetStateAction<Record<number, ApiNode[]>>>
  bookmarks: string[]
  onToggleBookmark: (address: string) => void
  onConnect: (subId: number, nodeAddr: string) => void
  onUpdateSub: () => void
  activeNodeAddress?: string | null
}

export const POLICIES = [
  { value: 0, labelKey: 'renewal.policy_0', descKey: 'renewal.desc_0' },
  { value: 1, labelKey: 'renewal.policy_1', descKey: 'renewal.desc_1' },
  { value: 2, labelKey: 'renewal.policy_2', descKey: 'renewal.desc_2' },
  { value: 3, labelKey: 'renewal.policy_3', descKey: 'renewal.desc_3' },
  { value: 4, labelKey: 'renewal.policy_4', descKey: 'renewal.desc_other' },
  { value: 5, labelKey: 'renewal.policy_5', descKey: 'renewal.desc_other' },
  { value: 6, labelKey: 'renewal.policy_6', descKey: 'renewal.desc_other' },
  { value: 7, labelKey: 'renewal.policy_7', descKey: 'renewal.desc_7' }
]

export default function SubscriptionsPanel({ 
  subscriptions, 
  plans, 
  loading, 
  globalNodes,
  providerNamesCache,
  setProviderNamesCache,
  planNodesCache,
  setPlanNodesCache,
  bookmarks,
  onToggleBookmark,
  onConnect, 
  onUpdateSub,
  activeNodeAddress 
}: Props) {
  const { t } = useTranslation()
  const [selectedSubId, setSelectedSubId] = useState<number | null>(null)
  const [loadingNodes, setLoadingNodes] = useState<Record<number, boolean>>({})
  const [selectedNode, setSelectedNode] = useState<ApiNode | null>(null)
  const [connectingTo, setConnectingTo] = useState<string | null>(null)
  const [showPolicyDropdown, setShowPolicyDropdown] = useState(false)
  const [updatingPolicy, setUpdatingPolicy] = useState(false)
  const [confirmingCancel, setConfirmingCancel] = useState<number | null>(null)
  const [canceling, setCanceling] = useState(false)

  const handleCancelSubscription = async () => {
    if (!confirmingCancel) return
    setCanceling(true)
    try {
      const res = await window.api.cancelSubscription(confirmingCancel)
      if (res.success) {
        setConfirmingCancel(null)
        onUpdateSub()
      } else {
        alert(t('common.error') + ': ' + res.error)
      }
    } catch (e) {
      alert(t('common.error') + ': ' + String(e))
    } finally {
      setCanceling(false)
    }
  }

  const getStatusInfo = (status: number) => {
    switch (status) {
      case 1: return { label: t('sessions.status.active'), cls: 'badge-green' }
      case 2: return { label: t('sessions.status.inactive_pending'), cls: 'badge-yellow' }
      case 3: return { label: t('sessions.status.inactive'), cls: 'badge-red' }
      default: return { label: t('common.error'), cls: 'badge-red' }
    }
  }

  // Fetch provider monikers
  useEffect(() => {
    subscriptions.forEach(async (sub) => {
      const plan = plans.find(p => p.id === sub.planId)
      if (!plan || providerNamesCache[plan.provAddress]) return
      try {
        const res = await window.api.fetchProviderInfo(plan.provAddress)
        if (res.success && res.provider) {
          setProviderNamesCache(prev => ({ ...prev, [plan.provAddress]: res.provider }))
        }
      } catch (e) {
        console.error('Failed to fetch provider moniker', e)
      }
    })
  }, [subscriptions, plans, providerNamesCache, setProviderNamesCache])

  const filteredSubscriptions = useMemo(() => {
    return subscriptions.filter(sub => {
      const plan = plans.find(p => p.id === sub.planId)
      if (!plan) return true
      const moniker = providerNamesCache[plan.provAddress]?.name || ''
      const name = moniker.toLowerCase()
      return true
    })
  }, [subscriptions, plans, providerNamesCache])

  // Select first sub by default
  useEffect(() => {
    if (selectedSubId === null && filteredSubscriptions.length > 0) {
      setSelectedSubId(filteredSubscriptions[0].id)
    }
  }, [filteredSubscriptions, selectedSubId])

  const fetchPlanNodes = async (planId: number) => {
    if (planNodesCache[planId]) return
    setLoadingNodes(prev => ({ ...prev, [planId]: true }))
    try {
      const res = await window.api.fetchPlanNodes(planId)
      if (res.success) {
        setPlanNodesCache(prev => ({ ...prev, [planId]: res.nodes }))
      }
    } catch (e) {
      console.error(e)
    } finally {
      setLoadingNodes(prev => ({ ...prev, [planId]: false }))
    }
  }

  // Trigger nodes fetch when sub selection changes
  useEffect(() => {
    if (selectedSubId !== null) {
      const sub = filteredSubscriptions.find(s => s.id === selectedSubId)
      if (sub) {
        fetchPlanNodes(sub.planId)
      }
    }
  }, [selectedSubId, filteredSubscriptions])

  const selectedSub = filteredSubscriptions.find(s => s.id === selectedSubId)
  const selectedPlan = selectedSub ? plans.find(p => p.id === selectedSub.planId) : null
  const selectedProv = selectedPlan ? providerNamesCache[selectedPlan.provAddress] : null

  // Cross-reference nodes
  const richNodes = useMemo(() => {
    if (!selectedSub || !planNodesCache[selectedSub.planId]) return []
    return planNodesCache[selectedSub.planId].map(pn => {
      const globalNode = globalNodes.find(gn => gn.address === pn.address)
      if (globalNode) return globalNode
      return pn
    })
  }, [selectedSub, planNodesCache, globalNodes])

  // Update selectedNode if activeNodeAddress changes or richNodes change
  useEffect(() => {
    if (activeNodeAddress) {
       const found = richNodes.find(n => n.address === activeNodeAddress)
       if (found) setSelectedNode(found)
    }
  }, [activeNodeAddress, richNodes])

  if (loading && subscriptions.length === 0) {
    return (
      <div className="empty-state">
        <Loader2 className="spinner" size={32} />
        <div className="empty-state-text">{t('subs.fetching')}</div>
      </div>
    )
  }

  if (filteredSubscriptions.length === 0) {
    return (
      <div className="empty-state">
        <CreditCard size={32} color="var(--text-3)" />
        <div className="empty-state-text">{t('subs.no_subs')}</div>
      </div>
    )
  }

  return (
    <div className="subs-panel-layout" style={{ display: 'flex', flex: 1, height: '100%', overflow: 'hidden' }}>
      {/* Left Column: Subscriptions Sidebar */}
      <div className="subs-sidebar" style={{ 
        width: '450px', 
        flexShrink: 0, 
        borderRight: '1px solid var(--border)', 
        overflowY: 'auto', 
        padding: '20px', 
        display: 'flex', 
        flexDirection: 'column', 
        gap: '16px',
        background: 'rgba(0,0,0,0.3)'
      }}>
        <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.15em', marginBottom: '4px' }}>
          {t('subs.title')}
        </div>
        {filteredSubscriptions.map(sub => {
          const plan = plans.find(p => p.id === sub.planId)
          const provInfo = plan ? providerNamesCache[plan.provAddress] : null
          const provName = provInfo?.name || (plan ? plan.provAddress.slice(0, 12) + '...' : `Plan #${sub.planId}`)
          const isSelected = selectedSubId === sub.id
          
          return (
            <div 
              key={sub.id} 
              className={`card sub-card ${isSelected ? 'active' : ''}`}
              onClick={() => setSelectedSubId(sub.id)}
              style={{ 
                background: isSelected ? 'rgba(6, 182, 212, 0.05)' : 'var(--bg-1)', 
                border: `1px solid ${isSelected ? 'var(--cyan)' : 'var(--border)'}`,
                borderRadius: '12px',
                padding: '20px',
                cursor: 'pointer',
                transition: 'all 0.2s',
                display: 'flex',
                flexDirection: 'column',
                gap: '12px',
                boxShadow: isSelected ? '0 0 15px rgba(6, 182, 212, 0.15)' : 'none',
                position: 'relative',
                overflow: 'hidden'
              }}
            >
              {isSelected && <div style={{ position: 'absolute', top: 0, left: 0, width: '4px', height: '100%', background: 'var(--cyan)' }} />}

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontSize: '15px', fontWeight: 600, color: isSelected ? 'var(--cyan)' : 'var(--text-1)', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Shield size={16} /> {provName}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-3)', marginTop: '4px' }}>
                    {t('subs.sub_id', { id: sub.id })} • Plan #{sub.planId}
                  </div>
                </div>
                <span className={`badge ${getStatusInfo(sub.status).cls}`} style={{ fontSize: '10px' }}>
                  {getStatusInfo(sub.status).label}
                </span>
              </div>

              <div style={{ display: 'flex', gap: '20px', marginTop: '4px' }}>
                <div style={{ fontSize: '12px', color: 'var(--text-2)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Calendar size={14} style={{ opacity: 0.7 }} />
                  {t('subs.expires')}: <strong>{sub.inactiveAt ? new Date(sub.inactiveAt).toLocaleDateString() : 'N/A'}</strong>
                </div>
                <div style={{ fontSize: '12px', color: 'var(--text-2)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Database size={14} style={{ opacity: 0.7 }} />
                  {t('subs.quota')}: <strong>{plan ? formatDataQuota(plan.bytes) : '...'}</strong>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Right Column: Header + Node Table */}
      <div className="subs-main" style={{ flex: 1, display: 'flex', flexDirection: 'column', background: 'var(--bg-0)', overflow: 'hidden' }}>
        {selectedSub ? (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {/* Row 1: Header Area */}
            <div style={{ padding: '24px 30px', borderBottom: '1px solid var(--border)', background: 'rgba(255,255,255,0.02)' }}>
               <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                  <div style={{ minWidth: 0, flex: 1, marginRight: 20 }}>
                    <h2 style={{ fontSize: '22px', fontWeight: 700, color: 'var(--text-1)', marginBottom: '4px', display: 'flex', alignItems: 'center', gap: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <Activity size={28} color="var(--cyan)" /> {selectedProv?.name || t('subs.details_title')}
                    </h2>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                       <p style={{ fontSize: '12px', color: 'var(--text-3)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis' }}>Sub ID: #{selectedSub.id} • Acc: {selectedSub.accAddress.slice(0, 20)}...</p>
                       {selectedProv?.website && (
                          <a href={selectedProv.website} target="_blank" rel="noreferrer" style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--cyan)', fontSize: '11px', textDecoration: 'none' }}>
                             <ExternalLink size={12} /> {selectedProv.website.replace('https://', '')}
                          </a>
                       )}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0, display: 'flex', alignItems: 'center', gap: '12px' }}>
                    {selectedNode ? (
                      <button
                        className="btn btn-primary"
                        disabled={connectingTo === selectedNode.address}
                        style={{ height: '42px', padding: '0 24px', fontSize: '13px', fontWeight: 700, boxShadow: '0 0 15px rgba(0,255,159,0.2)' }}
                        onClick={() => {
                          setConnectingTo(selectedNode.address)
                          onConnect(selectedSub.id, selectedNode.address)
                          setTimeout(() => setConnectingTo(null), 500)
                        }}
                      >
                        <Play size={16} fill="currentColor" style={{ marginRight: 8 }} />
                        {activeNodeAddress === selectedNode.address
                          ? t('subs.connected').toUpperCase()
                          : `${t('subs.connect').toUpperCase()} ${selectedNode.moniker.toUpperCase()}`}
                      </button>
                    ) : (
                      <div className={`badge ${getStatusInfo(selectedSub.status).cls}`} style={{ fontSize: '14px', padding: '8px 20px', fontWeight: 700 }}>
                        {getStatusInfo(selectedSub.status).label}
                      </div>
                    )}
                    {selectedSub.status === 1 && (
                      <button 
                        className="btn btn-danger btn-sm"
                        style={{ height: '42px', padding: '0 20px', fontSize: '13px', fontWeight: 700 }}
                        onClick={() => setConfirmingCancel(selectedSub.id)}
                      >
                        {t('subs.cancel')}
                      </button>
                    )}
                  </div>
               </div>

               {selectedProv?.description && (
                  <p style={{ fontSize: '13px', color: 'var(--text-2)', marginBottom: '20px', maxWidth: '800px', lineHeight: 1.6 }}>
                    {selectedProv.description}
                  </p>
               )}

               <div style={{ display: 'flex', gap: '40px' }}>
                  <div className="detail-item">
                    <div style={{ fontSize: '11px', color: 'var(--text-3)', textTransform: 'uppercase', marginBottom: '4px' }}>{t('subs.plan_identity')}</div>
                    <div style={{ fontSize: '16px', fontWeight: 600, color: 'var(--cyan)' }}>Plan #{selectedSub.planId}</div>
                  </div>
                  <div className="detail-item">
                    <div style={{ fontSize: '11px', color: 'var(--text-3)', textTransform: 'uppercase', marginBottom: '4px' }}>{t('subs.valid_until')}</div>
                    <div style={{ fontSize: '16px', fontWeight: 600, color: 'var(--cyan)' }}>{selectedSub.inactiveAt ? new Date(selectedSub.inactiveAt).toLocaleDateString() : t('common.never')}</div>
                  </div>
                  <div className="detail-item" style={{ position: 'relative' }}>
                    <div style={{ fontSize: '11px', color: 'var(--text-3)', textTransform: 'uppercase', marginBottom: '4px' }}>{t('renewal.title')}</div>
                    <button 
                      className="btn btn-secondary btn-sm" 
                      style={{ fontSize: '12px', padding: '4px 10px', display: 'flex', alignItems: 'center', gap: 6, opacity: updatingPolicy ? 0.5 : 1 }}
                      onClick={() => setShowPolicyDropdown(!showPolicyDropdown)}
                      disabled={updatingPolicy}
                    >
                      {updatingPolicy ? <Loader2 size={12} className="spinner" /> : null}
                      {t(POLICIES.find(p => p.value === (selectedSub.renewalPricePolicy || 0))?.labelKey || 'renewal.policy_0')}
                      <ChevronDown size={14} />
                    </button>
                    {showPolicyDropdown && (
                      <div style={{
                        position: 'absolute', top: '100%', left: 0, marginTop: '8px', width: '280px',
                        background: 'var(--bg-1)', border: '1px solid var(--border)', borderRadius: '8px',
                        boxShadow: '0 4px 20px rgba(0,0,0,0.5)', zIndex: 100, overflow: 'hidden'
                      }}>
                        {POLICIES.map(p => {
                          const isCurrent = p.value === (selectedSub.renewalPricePolicy || 0)
                          return (
                            <div 
                              key={p.value}
                              onClick={async () => {
                                setShowPolicyDropdown(false)
                                if (isCurrent) return
                                setUpdatingPolicy(true)
                                try {
                                  const res = await window.api.updateSubscription(selectedSub.id, p.value)
                                  if (res.success) onUpdateSub()
                                  else alert(t('common.error') + ': ' + res.error)
                                } catch (e) { alert(String(e)) }
                                finally { setUpdatingPolicy(false) }
                              }}
                              style={{ 
                                padding: '12px 16px', cursor: 'pointer', borderBottom: '1px solid var(--bg-0)',
                                background: isCurrent ? 'rgba(6, 182, 212, 0.1)' : 'transparent',
                                transition: 'background 0.2s'
                              }}
                              onMouseOver={e => { if (!isCurrent) e.currentTarget.style.background = 'var(--bg-2)' }}
                              onMouseOut={e => { if (!isCurrent) e.currentTarget.style.background = 'transparent' }}
                            >
                              <div style={{ fontSize: '12px', fontWeight: 600, color: isCurrent ? 'var(--cyan)' : 'var(--text-1)', marginBottom: '4px' }}>
                                {t(p.labelKey)}
                              </div>
                              <div style={{ fontSize: '10px', color: 'var(--text-3)', lineHeight: 1.4 }}>
                                {t(p.descKey)}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                  <div className="detail-item">
                    <div style={{ fontSize: '11px', color: 'var(--text-3)', textTransform: 'uppercase', marginBottom: '4px' }}>{t('subs.available_pool')}</div>
                    <div style={{ fontSize: '16px', fontWeight: 600, color: 'var(--cyan)' }}>{richNodes.length} {t('common.nodes')}</div>
                  </div>
               </div>
            </div>

            {/* Row 2: Node Table Area */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
               {loadingNodes[selectedSub.planId] ? (
                 <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px' }}>
                   <Loader2 className="spinner" size={32} />
                   <div style={{ fontSize: '12px', color: 'var(--text-3)' }}>{t('common.fetching_nodes')}</div>
                 </div>
               ) : richNodes.length > 0 ? (
                 <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                   <div style={{ padding: '16px 30px 8px', fontSize: '11px', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', display: 'flex', justifyContent: 'space-between' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Server size={12} /> {t('subs.nodes_in_plan')}</div>
                      {!selectedNode && <span style={{ color: 'var(--cyan)', textTransform: 'none', fontWeight: 400 }}>{t('subs.select_node_hint')}</span>}
                   </div>
                   <div style={{ flex: 1, overflowY: 'auto' }}>
                      <NodeTable 
                        nodes={richNodes} 
                        onSelect={(node) => setSelectedNode(node)}
                        bookmarks={bookmarks}
                        onToggleBookmark={onToggleBookmark}
                        activeNodeAddress={activeNodeAddress}
                      />
                   </div>
                 </div>
               ) : (
                 <div className="empty-state">
                    <div className="empty-state-text">{t('subs.no_nodes_for_sub')}</div>
                 </div>
               )}
            </div>
          </div>
        ) : (
          <div className="empty-state">
            <CreditCard size={48} color="var(--text-3)" style={{ marginBottom: 16, opacity: 0.5 }} />
            <div className="empty-state-text">{t('subs.select_sub_hint')}</div>
          </div>
        )}
      </div>

      {confirmingCancel && (
        <ConfirmModal
          title={t('sessions.cancel_confirm_title')}
          message={t('sessions.cancel_confirm_msg')}
          danger
          onConfirm={handleCancelSubscription}
          onCancel={() => !canceling && setConfirmingCancel(null)}
          confirmLabel={canceling ? t('common.starting') : t('subs.cancel')}
          cancelLabel={canceling ? "" : t('common.cancel')}
        />
      )}
    </div>
  )
}