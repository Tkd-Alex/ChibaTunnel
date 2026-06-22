import React, { useState, useEffect, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiPlan, ApiNode } from '../types'
import { Globe, Users, Clock, CreditCard, CheckCircle2, Loader2, Info, ShieldCheck, Server, Search, AlertCircle, Database, ExternalLink, ChevronDown, ChevronUp } from 'lucide-react'
import ConfirmModal from './ConfirmModal'
import NodeTable from './NodeTable'
import { formatDataQuota } from '../utils'
import { POLICIES } from './SubscriptionsPanel'

interface Props {
  plans: ApiPlan[]
  loading: boolean
  globalNodes: ApiNode[]
  planNodesCache: Record<number, ApiNode[]>
  setPlanNodesCache: React.Dispatch<React.SetStateAction<Record<number, ApiNode[]>>>
  providerNamesCache: Record<string, any>
  setProviderNamesCache: React.Dispatch<React.SetStateAction<Record<string, any>>>
  scannedOnce: boolean
  setScannedOnce: React.Dispatch<React.SetStateAction<boolean>>
  bookmarks: string[]
  onToggleBookmark: (address: string) => void
  activeNodeAddress?: string | null
  onSelectNode: (node: ApiNode) => void
  onSubscribe: () => void
}

export default function PlansPanel({ 
  plans, 
  loading, 
  globalNodes,
  planNodesCache,
  setPlanNodesCache,
  providerNamesCache,
  setProviderNamesCache,
  scannedOnce,
  setScannedOnce,
  bookmarks, 
  onToggleBookmark, 
  activeNodeAddress, 
  onSelectNode, 
  onSubscribe 
}: Props) {
  const { t } = useTranslation()
  const [selectedPlanId, setSelectedPlanId] = useState<number | null>(null)
  const [isScanning, setIsScanning] = useState(false)
  const [confirmingPlan, setConfirmingPlan] = useState<ApiPlan | null>(null)
  const [subscribing, setSubscribing] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [showPrivate, setShowPrivate] = useState(false)
  
  const [selectedPolicy, setSelectedPolicy] = useState(0) // Default: Unspecified
  const [showPolicyDropdown, setShowPolicyDropdown] = useState(false)
  // Plan ids whose node scan FAILED (transient RPC throttle) rather than returning a
  // genuine 0-node result. These must NOT be hidden by the "empty plan" filter — doing
  // so on a throttled scan blanked the entire list ("plans/nodes empty, no error").
  const [scanFailed, setScanFailed] = useState<Set<number>>(new Set())

  // Batch Scan logic
  const performBatchScan = useCallback(async () => {
    if (plans.length === 0 || scannedOnce || isScanning) return
    
    setIsScanning(true)
    try {
      // 1. Fetch Providers Batch
      const uniqueProviders = Array.from(new Set(plans.map(p => p.provAddress)))
      const provRes = await window.api.fetchProvidersBatch(uniqueProviders)
      if (provRes.success) {
        setProviderNamesCache(prev => ({ ...prev, ...provRes.providers }))
      }

      // 2. Fetch Nodes Batch for all plans
      const planIds = plans.map(p => p.id)
      const nodesRes = await window.api.scanPlanNodes(planIds)
      if (nodesRes.success) {
        setPlanNodesCache(prev => ({ ...prev, ...nodesRes.nodesMap }))
        setScanFailed(new Set((nodesRes as any).failed ?? []))
      }

      setScannedOnce(true)
    } catch (e) {
      console.error('Batch scan failed', e)
    } finally {
      setIsScanning(false)
    }
  }, [plans, scannedOnce, isScanning, setProviderNamesCache, setPlanNodesCache, setScannedOnce])

  useEffect(() => {
    if (!loading && plans.length > 0 && !scannedOnce) {
      performBatchScan()
    }
  }, [loading, plans, scannedOnce, performBatchScan])

  // Filter out staging/test providers AND empty plans
  const filteredPlans = useMemo(() => {
    return plans.filter(plan => {
      if (!showPrivate && plan.private) return false

      const pInfo = providerNamesCache[plan.provAddress]
      const name = (pInfo?.name || '').toLowerCase()
      // if (name.includes('test') || name.includes('staging')) return false
      
      if (searchTerm) {
        const term = searchTerm.toLowerCase()
        if (!name.includes(term) && !plan.id.toString().includes(term) && !plan.provAddress.toLowerCase().includes(term)) {
          return false
        }
      }

      if (scannedOnce && !scanFailed.has(plan.id)) {
        // Hide genuinely-empty plans, but keep ones whose scan failed (throttled) —
        // otherwise a transient RPC hiccup empties the whole list.
        const nodes = planNodesCache[plan.id]
        if (!nodes || nodes.length === 0) return false
      }

      return true
    })
  }, [plans, providerNamesCache, scannedOnce, planNodesCache, searchTerm, showPrivate, scanFailed])

  // Select first filtered plan by default
  useEffect(() => {
    if (selectedPlanId === null && filteredPlans.length > 0 && scannedOnce) {
      setSelectedPlanId(filteredPlans[0].id)
    }
  }, [filteredPlans, selectedPlanId, scannedOnce])

  const selectedPlan = filteredPlans.find(p => p.id === selectedPlanId)
  const selectedProv = selectedPlan ? providerNamesCache[selectedPlan.provAddress] : null

  // Cross-reference nodes with global list
  const richNodes = useMemo(() => {
    if (selectedPlanId === null || !planNodesCache[selectedPlanId]) return []
    return planNodesCache[selectedPlanId].map(pn => {
      const globalNode = globalNodes.find(gn => gn.address === pn.address)
      if (globalNode) return globalNode
      return pn // Fallback
    })
  }, [selectedPlanId, planNodesCache, globalNodes])

  const handleSubscribe = async () => {
    if (!confirmingPlan) return
    setSubscribing(true)
    const planId = confirmingPlan.id
    const denom = confirmingPlan.prices[0]?.denom || 'udvpn'
    
    try {
      const res = await window.api.subscribeToPlan(planId, denom, selectedPolicy)
      if (res.success) {
        setConfirmingPlan(null)
        onSubscribe()
      } else {
        alert(t('common.error') + ': ' + res.error)
      }
    } catch (e) {
      alert(t('common.error') + ': ' + String(e))
    } finally {
      setSubscribing(false)
    }
  }

  if (loading && plans.length === 0) {
    return (
      <div className="empty-state">
        <Loader2 className="spinner" size={32} />
        <div className="empty-state-text">{t('plans.fetching')}</div>
      </div>
    )
  }

  if (isScanning && !scannedOnce) {
    return (
      <div className="empty-state" style={{ background: 'var(--bg-0)' }}>
        <Loader2 className="spinner" size={48} color="var(--cyan)" />
        <div className="empty-state-text" style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text-1)', marginTop: '16px' }}>
          Analyzing network plans...
        </div>
        <div style={{ fontSize: '12px', color: 'var(--text-3)', marginTop: '8px' }}>
          Filtering for active plans with available nodes.
        </div>
      </div>
    )
  }

  if (scannedOnce && filteredPlans.length === 0) {
    return (
      <div className="empty-state">
        <AlertCircle size={48} color="var(--red)" style={{ opacity: 0.6, marginBottom: 16 }} />
        <div className="empty-state-text" style={{ color: 'var(--red)' }}>No active plans with nodes found.</div>
        <div style={{ fontSize: '11px', color: 'var(--text-3)', marginTop: 8 }}>Try changing your RPC or refreshing the list.</div>
        <button className="btn btn-secondary btn-sm" style={{ marginTop: 16 }} onClick={() => { setScannedOnce(false); performBatchScan() }}>
           <Search size={12} style={{ marginRight: 8 }} /> Retry Network Scan
        </button>
      </div>
    )
  }

  return (
    <div className="plans-panel-layout" style={{ display: 'flex', flex: 1, height: '100%', overflow: 'hidden' }}>
      {/* Left Column: Plan Cards */}
      <div className="plans-sidebar" style={{ 
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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.15em' }}>
            {t('plans.title')}
          </div>
          <div style={{ fontSize: '10px', color: 'var(--green)', fontWeight: 600 }}>{filteredPlans.length} ACTIVE</div>
        </div>

        {/* Filter Bar */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '8px' }}>
          <div style={{ position: 'relative' }}>
            <Search size={14} color="var(--text-3)" style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)' }} />
            <input 
              type="text" 
              placeholder="Search provider or ID..." 
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              style={{ 
                width: '100%', 
                background: 'var(--bg-1)', 
                border: '1px solid var(--border)', 
                borderRadius: '8px', 
                padding: '8px 12px 8px 32px',
                color: 'var(--text-1)',
                fontSize: '11px',
                fontFamily: 'var(--font-mono)',
                outline: 'none'
              }}
            />
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '11px', color: 'var(--text-2)' }}>
            <input 
              type="checkbox" 
              checked={showPrivate} 
              onChange={(e) => setShowPrivate(e.target.checked)} 
              style={{ accentColor: 'var(--cyan)' }}
            />
            Show Private Plans
          </label>
        </div>

        {filteredPlans.map(plan => {
          const provInfo = providerNamesCache[plan.provAddress]
          const provName = provInfo?.name || plan.provAddress.slice(0, 12) + '...'
          const isSelected = selectedPlanId === plan.id
          
          return (
            <div 
              key={plan.id} 
              className={`card plan-card ${isSelected ? 'active' : ''}`}
              onClick={() => setSelectedPlanId(plan.id)}
              style={{ 
                flexShrink: 0,
                background: isSelected ? 'rgba(0,255,159,0.05)' : 'var(--bg-1)', 
                border: `1px solid ${isSelected ? 'var(--green)' : 'var(--border)'}`,
                borderRadius: '12px',
                padding: '20px',
                cursor: 'pointer',
                transition: 'all 0.2s',
                display: 'flex',
                flexDirection: 'column',
                gap: '12px',
                boxShadow: isSelected ? '0 0 15px rgba(0,255,159,0.15)' : 'none',
                position: 'relative',
                overflow: 'hidden'
              }}
            >
              {isSelected && <div style={{ position: 'absolute', top: 0, left: 0, width: '4px', height: '100%', background: 'var(--green)' }} />}
              
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '15px', fontWeight: 600, color: isSelected ? 'var(--green)' : 'var(--text-1)', display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <ShieldCheck size={16} /> {provName}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-3)', marginTop: '4px' }}>
                    Plan #{plan.id}
                  </div>
                </div>
                <div className="badge badge-green" style={{ fontSize: '10px' }}>{planNodesCache[plan.id]?.length || 0} NODES</div>
              </div>

              <div style={{ display: 'flex', gap: '20px', marginTop: '4px' }}>
                <div style={{ fontSize: '12px', color: 'var(--text-2)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Database size={14} style={{ opacity: 0.7 }} />
                  <strong>{formatDataQuota(plan.bytes)}</strong>
                </div>
                <div style={{ fontSize: '12px', color: 'var(--text-2)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Clock size={14} style={{ opacity: 0.7 }} />
                  <strong>{(plan.duration / 86400).toFixed(0)}</strong> {t('plans.days')}
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '8px' }}>
                <div style={{ fontSize: '14px', color: 'var(--yellow)', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <CreditCard size={14} />
                  {parseInt(plan.prices[0]?.amount || '0') / 1_000_000} {plan.prices[0]?.denom.replace('u', '').toUpperCase()}
                </div>
                {isSelected && (
                   <div className="badge badge-green" style={{ fontSize: '10px', fontWeight: 700 }}>SELECTED</div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Right Column: Header + Table */}
      <div className="plans-main" style={{ flex: 1, display: 'flex', flexDirection: 'column', background: 'var(--bg-0)', overflow: 'hidden' }}>
        {selectedPlan ? (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {/* Header Area */}
            <div style={{ padding: '24px 30px', borderBottom: '1px solid var(--border)', background: 'rgba(255,255,255,0.02)' }}>
               <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                  <div style={{ minWidth: 0, flex: 1, marginRight: 20 }}>
                    <h2 style={{ fontSize: '22px', fontWeight: 700, color: 'var(--text-1)', marginBottom: '4px', display: 'flex', alignItems: 'center', gap: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <Globe size={28} color="var(--green)" /> {selectedProv?.name || 'Plan Details'}
                    </h2>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                       <p style={{ fontSize: '12px', color: 'var(--text-3)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{selectedPlan.provAddress}</p>
                       {selectedProv?.website && (
                          <a href={selectedProv.website} target="_blank" rel="noreferrer" style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--cyan)', fontSize: '11px', textDecoration: 'none' }}>
                             <ExternalLink size={12} /> {selectedProv.website.replace('https://', '')}
                          </a>
                       )}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <button 
                      className="btn btn-primary" 
                      style={{ height: '42px', padding: '0 24px', fontSize: '13px', fontWeight: 700, boxShadow: '0 0 15px rgba(0,255,159,0.2)' }}
                      onClick={() => setConfirmingPlan(selectedPlan)}
                    >
                      <CreditCard size={16} style={{ marginRight: 8 }} />
                      SUBSCRIBE FOR {parseInt(selectedPlan.prices[0]?.amount || '0') / 1_000_000} {selectedPlan.prices[0]?.denom.replace('u', '').toUpperCase()}
                    </button>
                  </div>
               </div>

               {selectedProv?.description && (
                  <p style={{ fontSize: '13px', color: 'var(--text-2)', marginBottom: '20px', maxWidth: '800px', lineHeight: 1.6 }}>
                    {selectedProv.description}
                  </p>
               )}

               <div style={{ display: 'flex', gap: '40px' }}>
                  <div className="detail-item">
                    <div style={{ fontSize: '11px', color: 'var(--text-3)', textTransform: 'uppercase', marginBottom: '4px' }}>{t('subs.quota')}</div>
                    <div style={{ fontSize: '16px', fontWeight: 600, color: 'var(--cyan)' }}>{formatDataQuota(selectedPlan.bytes)}</div>
                  </div>
                  <div className="detail-item">
                    <div style={{ fontSize: '11px', color: 'var(--text-3)', textTransform: 'uppercase', marginBottom: '4px' }}>{t('node_modal.duration')}</div>
                    <div style={{ fontSize: '16px', fontWeight: 600, color: 'var(--cyan)' }}>{(selectedPlan.duration / 86400).toFixed(0)} {t('plans.days')}</div>
                  </div>
                  <div className="detail-item">
                    <div style={{ fontSize: '11px', color: 'var(--text-3)', textTransform: 'uppercase', marginBottom: '4px' }}>{t('subs.nodes_in_plan')}</div>
                    <div style={{ fontSize: '16px', fontWeight: 600, color: 'var(--cyan)' }}>{richNodes.length} {t('plans.available')}</div>
                  </div>
               </div>
            </div>

            {/* Table Area */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
               {richNodes.length > 0 ? (
                 <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                   <div style={{ padding: '16px 30px 8px', fontSize: '11px', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 8 }}>
                      <Server size={12} /> {t('subs.nodes_in_plan')}
                   </div>
                   <div style={{ flex: 1, overflowY: 'auto' }}>
                      <NodeTable 
                        nodes={richNodes} 
                        onSelect={() => {}} 
                        bookmarks={[]} 
                        onToggleBookmark={() => {}}
                        activeNodeAddress={activeNodeAddress}
                      />
                   </div>
                 </div>
               ) : (
                 <div className="empty-state">
                    <div className="empty-state-text">No nodes found for this plan.</div>
                 </div>
               )}
            </div>
          </div>
        ) : (
          <div className="empty-state">
            <Info size={48} color="var(--text-3)" style={{ marginBottom: 16, opacity: 0.5 }} />
            <div className="empty-state-text">Select a plan to view its characteristics and available nodes.</div>
          </div>
        )}
      </div>

      {confirmingPlan && (
        <ConfirmModal
          title={t('plans.confirm_sub_title')}
          message={t('plans.confirm_sub_msg', { id: confirmingPlan.id })}
          onConfirm={handleSubscribe}
          onCancel={() => {
             if (!subscribing) {
               setConfirmingPlan(null)
               setShowPolicyDropdown(false)
               setSelectedPolicy(0)
             }
          }}
          confirmLabel={subscribing ? t('common.starting') : t('plans.subscribe')}
          cancelLabel={subscribing ? "" : t('common.cancel')}
        >
          <div style={{ marginTop: '20px', position: 'relative' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-3)', textTransform: 'uppercase', marginBottom: '6px' }}>
              {t('renewal.title')}
            </div>
            <button 
              className="btn btn-secondary btn-full" 
              style={{ fontSize: '13px', padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              onClick={() => setShowPolicyDropdown(!showPolicyDropdown)}
              disabled={subscribing}
            >
              {t(POLICIES.find(p => p.value === selectedPolicy)?.labelKey || 'renewal.policy_0')}
              {showPolicyDropdown ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
            {showPolicyDropdown && (
              <div style={{
                position: 'absolute', top: '100%', left: 0, marginTop: '8px', width: '100%',
                background: 'var(--bg-1)', border: '1px solid var(--border)', borderRadius: '8px',
                boxShadow: '0 4px 20px rgba(0,0,0,0.5)', zIndex: 100, overflow: 'hidden',
                maxHeight: '200px', overflowY: 'auto'
              }}>
                {POLICIES.map(p => {
                  const isCurrent = p.value === selectedPolicy
                  return (
                    <div 
                      key={p.value}
                      onClick={() => {
                        setSelectedPolicy(p.value)
                        setShowPolicyDropdown(false)
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
        </ConfirmModal>
      )}
    </div>
  )
}
