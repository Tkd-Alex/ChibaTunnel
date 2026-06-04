import React, { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiPlan, ApiNode } from '../types'
import { Globe, Users, Clock, CreditCard, ChevronRight, CheckCircle2, Loader2, Info, Search } from 'lucide-react'
import ConfirmModal from './ConfirmModal'
import NodeTable from './NodeTable'

interface Props {
  plans: ApiPlan[]
  loading: boolean
  bookmarks: string[]
  onToggleBookmark: (address: string) => void
  activeNodeAddress?: string | null
  onSelectNode: (node: ApiNode) => void
  onSubscribe: () => void
}

export default function PlansPanel({ 
  plans, 
  loading, 
  bookmarks, 
  onToggleBookmark, 
  activeNodeAddress, 
  onSelectNode, 
  onSubscribe 
}: Props) {
  const { t } = useTranslation()
  const [selectedPlanId, setSelectedPlanId] = useState<number | null>(null)
  const [planNodes, setPlanNodes] = useState<Record<number, ApiNode[]>>({})
  const [loadingNodes, setLoadingNodes] = useState<Record<number, boolean>>({})
  const [providerNames, setProviderNames] = useState<Record<string, string>>({})
  const [confirmingPlan, setConfirmingPlan] = useState<ApiPlan | null>(null)
  const [subscribing, setSubscribing] = useState(false)

  useEffect(() => {
    // Fetch provider monikers for all plans
    plans.forEach(async (plan) => {
      if (providerNames[plan.provAddress]) return
      try {
        const res = await window.api.fetchProviderInfo(plan.provAddress)
        if (res.success && res.provider) {
          setProviderNames(prev => ({ ...prev, [plan.provAddress]: res.provider.name }))
        }
      } catch (e) {
        console.error('Failed to fetch provider moniker', e)
      }
    })
  }, [plans])

  const filteredPlans = useMemo(() => {
    return plans.filter(plan => {
      const name = (providerNames[plan.provAddress] || '').toLowerCase()
      // Skip staging/test providers
      if (name.includes('test') || name.includes('staging')) return false
      return true
    })
  }, [plans, providerNames])

  const fetchPlanNodes = async (planId: number) => {
    if (planNodes[planId]) return
    setLoadingNodes(prev => ({ ...prev, [planId]: true }))
    try {
      const res = await window.api.fetchPlanNodes(planId)
      if (res.success) {
        setPlanNodes(prev => ({ ...prev, [planId]: res.nodes }))
      }
    } catch (e) {
      console.error(e)
    } finally {
      setLoadingNodes(prev => ({ ...prev, [planId]: false }))
    }
  }

  useEffect(() => {
    if (selectedPlanId !== null) {
      fetchPlanNodes(selectedPlanId)
    }
  }, [selectedPlanId])

  // Select first plan by default if none selected
  useEffect(() => {
    if (selectedPlanId === null && filteredPlans.length > 0) {
      setSelectedPlanId(filteredPlans[0].id)
    }
  }, [filteredPlans, selectedPlanId])

  const handleSubscribe = async () => {
    if (!confirmingPlan) return
    setSubscribing(true)
    const planId = confirmingPlan.id
    const denom = confirmingPlan.prices[0]?.denom || 'udvpn'
    
    try {
      const res = await window.api.subscribeToPlan(planId, denom)
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

  if (filteredPlans.length === 0) {
    return (
      <div className="empty-state">
        <Info size={32} color="var(--text-3)" />
        <div className="empty-state-text">{t('plans.no_plans')}</div>
      </div>
    )
  }

  return (
    <div className="plans-panel-layout" style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* Left Column: Plan Cards */}
      <div className="plans-sidebar" style={{ 
        width: '320px', 
        flexShrink: 0, 
        borderRight: '1px solid var(--bg-2)', 
        overflowY: 'auto', 
        padding: '16px', 
        display: 'flex', 
        flexDirection: 'column', 
        gap: '12px',
        background: 'rgba(0,0,0,0.2)'
      }}>
        <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '4px' }}>
          {t('plans.title')}
        </div>
        {filteredPlans.map(plan => {
          const provName = providerNames[plan.provAddress] || plan.provAddress.slice(0, 12) + '...'
          const isSelected = selectedPlanId === plan.id
          
          return (
            <div 
              key={plan.id} 
              className={`plan-mini-card ${isSelected ? 'active' : ''}`}
              onClick={() => setSelectedPlanId(plan.id)}
              style={{ 
                background: isSelected ? 'rgba(0,255,159,0.05)' : 'var(--bg-1)', 
                border: `1px solid ${isSelected ? 'var(--green)' : 'var(--bg-2)'}`,
                borderRadius: '8px',
                padding: '12px',
                cursor: 'pointer',
                transition: 'all 0.2s',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
                boxShadow: isSelected ? '0 0 10px rgba(0,255,159,0.1)' : 'none'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ fontSize: '13px', fontWeight: 600, color: isSelected ? 'var(--green)' : 'var(--text-1)' }}>
                  {provName}
                </div>
                <div style={{ fontSize: '10px', color: 'var(--text-3)' }}>#{plan.id}</div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', gap: '8px' }}>
                   <div style={{ fontSize: '10px', color: 'var(--text-2)' }}>
                     <strong>{plan.bytes === '0' ? '∞' : (parseInt(plan.bytes) / 1e9).toFixed(0)}</strong> GB
                   </div>
                   <div style={{ fontSize: '10px', color: 'var(--text-2)' }}>
                     <strong>{(plan.duration / 86400).toFixed(0)}</strong> {t('plans.days')}
                   </div>
                </div>
                <div style={{ fontSize: '11px', color: 'var(--yellow)', fontWeight: 600 }}>
                  {parseInt(plan.prices[0]?.amount || '0') / 1e6} {plan.prices[0]?.denom.replace('u', '').toUpperCase()}
                </div>
              </div>

              {isSelected && (
                <button 
                  className="btn btn-primary btn-sm" 
                  style={{ marginTop: '4px', width: '100%', justifyContent: 'center', height: '28px', fontSize: '10px' }}
                  onClick={(e) => { e.stopPropagation(); setConfirmingPlan(plan) }}
                >
                  <CreditCard size={12} style={{ marginRight: '6px' }} /> {t('plans.subscribe')}
                </button>
              )}
            </div>
          )
        })}
      </div>

      {/* Right Column: Node Table */}
      <div className="plans-main" style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
        {selectedPlanId !== null ? (
          loadingNodes[selectedPlanId] ? (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px' }}>
              <Loader2 className="spinner" size={24} />
              <div style={{ fontSize: '11px', color: 'var(--text-3)' }}>{t('common.loading_simple')}</div>
            </div>
          ) : planNodes[selectedPlanId] ? (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
               <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--bg-2)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-2)' }}>
                    {t('subs.nodes_in_plan')} ({planNodes[selectedPlanId].length})
                  </div>
               </div>
               <NodeTable 
                 nodes={planNodes[selectedPlanId]} 
                 onSelect={onSelectNode}
                 bookmarks={bookmarks}
                 onToggleBookmark={onToggleBookmark}
                 activeNodeAddress={activeNodeAddress}
               />
            </div>
          ) : (
             <div className="empty-state">
                <div className="empty-state-text">Failed to load nodes for this plan.</div>
             </div>
          )
        ) : (
          <div className="empty-state">
            <Info size={32} color="var(--text-3)" />
            <div className="empty-state-text">Select a plan from the list to view its nodes.</div>
          </div>
        )}
      </div>

      {confirmingPlan && (
        <ConfirmModal
          title={t('plans.confirm_sub_title')}
          message={t('plans.confirm_sub_msg', { id: confirmingPlan.id })}
          onConfirm={handleSubscribe}
          onCancel={() => !subscribing && setConfirmingPlan(null)}
          confirmLabel={subscribing ? t('common.starting') : t('plans.subscribe')}
          cancelLabel={subscribing ? "" : t('common.cancel')}
        />
      )}
    </div>
  )
}
