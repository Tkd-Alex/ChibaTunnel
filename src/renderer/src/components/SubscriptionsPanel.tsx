import React, { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiSubscription, ApiNode, ApiPlan } from '../types'
import { Loader2, CreditCard, Calendar, Database, Play, CheckCircle2, Info, ChevronRight, Activity, Server, Shield, ExternalLink } from 'lucide-react'
import NodeTable from './NodeTable'
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
  activeNodeAddress?: string | null
}

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
  activeNodeAddress 
}: Props) {
  const { t } = useTranslation()
  const [selectedSubId, setSelectedSubId] = useState<number | null>(null)
  const [loadingNodes, setLoadingNodes] = useState<Record<number, boolean>>({})
  const [selectedNode, setSelectedNode] = useState<ApiNode | null>(null)
  const [connectingTo, setConnectingTo] = useState<string | null>(null)

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
      // if (name.includes('test') || name.includes('staging')) return false
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
                <span className={`badge ${sub.status === 1 ? 'badge-green' : 'badge-red'}`} style={{ 
                  fontSize: '10px', padding: '2px 10px', borderRadius: '4px',
                  border: `1px solid ${sub.status === 1 ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)'}`
                }}>
                  {sub.status === 1 ? 'ACTIVE' : 'INACTIVE'}
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
                      <Activity size={28} color="var(--cyan)" /> {selectedProv?.name || 'Subscription Details'}
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
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    {selectedNode ? (
                       <button 
                         className="btn btn-primary" 
                         disabled={connectingTo === selectedNode.address}
                         style={{ height: '42px', padding: '0 24px', fontSize: '13px', fontWeight: 700, boxShadow: '0 0 15px rgba(0,255,159,0.2)' }}
                         onClick={async () => {
                           setConnectingTo(selectedNode.address)
                           await onConnect(selectedSub.id, selectedNode.address)
                           setConnectingTo(null)
                         }}
                       >
                         {connectingTo === selectedNode.address ? (
                           <><Loader2 size={16} className="spinner" style={{ marginRight: 8 }} /> {t('common.starting', { defaultValue: 'CONNECTING...' })}</>
                         ) : (
                           <><Play size={16} fill="currentColor" style={{ marginRight: 8 }} /> {activeNodeAddress === selectedNode.address ? 'CONNECTED' : `CONNECT TO ${selectedNode.moniker.toUpperCase()}`}</>
                         )}
                       </button>
                    ) : (
                       <div className={`badge ${selectedSub.status === 1 ? 'badge-green' : 'badge-red'}`} style={{ fontSize: '14px', padding: '8px 20px', fontWeight: 700 }}>
                         {selectedSub.status === 1 ? 'ACTIVE' : 'INACTIVE'}
                       </div>
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
                    <div style={{ fontSize: '11px', color: 'var(--text-3)', textTransform: 'uppercase', marginBottom: '4px' }}>Plan Identity</div>
                    <div style={{ fontSize: '16px', fontWeight: 600, color: 'var(--cyan)' }}>Plan #{selectedSub.planId}</div>
                  </div>
                  <div className="detail-item">
                    <div style={{ fontSize: '11px', color: 'var(--text-3)', textTransform: 'uppercase', marginBottom: '4px' }}>Valid Until</div>
                    <div style={{ fontSize: '16px', fontWeight: 600, color: 'var(--cyan)' }}>{selectedSub.inactiveAt ? new Date(selectedSub.inactiveAt).toLocaleDateString() : 'Never'}</div>
                  </div>
                  <div className="detail-item">
                    <div style={{ fontSize: '11px', color: 'var(--text-3)', textTransform: 'uppercase', marginBottom: '4px' }}>Available Pool</div>
                    <div style={{ fontSize: '16px', fontWeight: 600, color: 'var(--cyan)' }}>{richNodes.length} Nodes</div>
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
                      {!selectedNode && <span style={{ color: 'var(--cyan)', textTransform: 'none', fontWeight: 400 }}>Select a node from the list to enable connection</span>}
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
                    <div className="empty-state-text">No nodes found for this subscription pool.</div>
                 </div>
               )}
            </div>
          </div>
        ) : (
          <div className="empty-state">
            <CreditCard size={48} color="var(--text-3)" style={{ marginBottom: 16, opacity: 0.5 }} />
            <div className="empty-state-text">Select a subscription to manage your access and connect to nodes.</div>
          </div>
        )}
      </div>
    </div>
  )
}
