import React, { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiSubscription, ApiNode, ApiPlan } from '../types'
import { Loader2, CreditCard, Calendar, Database, Play, CheckCircle2, XCircle, Info, ChevronRight } from 'lucide-react'
import NodeTable from './NodeTable'

interface Props {
  subscriptions: ApiSubscription[]
  plans: ApiPlan[]
  loading: boolean
  bookmarks: string[]
  onToggleBookmark: (address: string) => void
  onConnect: (subId: number, nodeAddr: string) => void
  activeNodeAddress?: string | null
}

export default function SubscriptionsPanel({ 
  subscriptions, 
  plans, 
  loading, 
  bookmarks,
  onToggleBookmark,
  onConnect, 
  activeNodeAddress 
}: Props) {
  const { t } = useTranslation()
  const [selectedSubId, setSelectedSubId] = useState<number | null>(null)
  const [planNodes, setPlanNodes] = useState<Record<number, ApiNode[]>>({})
  const [loadingNodes, setLoadingNodes] = useState<Record<number, boolean>>({})
  const [providerNames, setProviderNames] = useState<Record<string, string>>({})

  useEffect(() => {
    // Fetch provider monikers for all active plans in subscriptions
    subscriptions.forEach(async (sub) => {
      const plan = plans.find(p => p.id === sub.planId)
      if (!plan || providerNames[plan.provAddress]) return
      try {
        const res = await window.api.fetchProviderInfo(plan.provAddress)
        if (res.success && res.provider) {
          setProviderNames(prev => ({ ...prev, [plan.provAddress]: res.provider.name }))
        }
      } catch (e) {
        console.error('Failed to fetch provider moniker', e)
      }
    })
  }, [subscriptions, plans])

  const filteredSubscriptions = useMemo(() => {
    return subscriptions.filter(sub => {
      const plan = plans.find(p => p.id === sub.planId)
      if (!plan) return true // Keep if plan not found (fallback)
      const name = (providerNames[plan.provAddress] || '').toLowerCase()
      if (name.includes('test') || name.includes('staging')) return false
      return true
    })
  }, [subscriptions, plans, providerNames])

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

  const selectedSub = filteredSubscriptions.find(s => s.id === selectedSubId)

  useEffect(() => {
    if (selectedSub) {
      fetchPlanNodes(selectedSub.planId)
    }
  }, [selectedSub])

  // Select first sub by default
  useEffect(() => {
    if (selectedSubId === null && filteredSubscriptions.length > 0) {
      setSelectedSubId(filteredSubscriptions[0].id)
    }
  }, [filteredSubscriptions, selectedSubId])

  if (loading && subscriptions.length === 0) {
    return (
      <div className="empty-state">
        <Loader2 className="spinner" size={32} />
        <div className="empty-state-text">{t('subs.fetching', { defaultValue: 'Fetching subscriptions...' })}</div>
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
    <div className="subs-panel-layout" style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* Left Column: Subscriptions List */}
      <div className="subs-sidebar" style={{ 
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
          {t('subs.title')}
        </div>
        {filteredSubscriptions.map(sub => {
          const plan = plans.find(p => p.id === sub.planId)
          const provName = plan ? (providerNames[plan.provAddress] || plan.provAddress.slice(0, 12) + '...') : `Plan #${sub.planId}`
          const isSelected = selectedSubId === sub.id
          
          return (
            <div 
              key={sub.id} 
              className={`sub-mini-card ${isSelected ? 'active' : ''}`}
              onClick={() => setSelectedSubId(sub.id)}
              style={{ 
                background: isSelected ? 'rgba(6, 182, 212, 0.05)' : 'var(--bg-1)', 
                border: `1px solid ${isSelected ? 'var(--cyan)' : 'var(--bg-2)'}`,
                borderRadius: '8px',
                padding: '12px',
                cursor: 'pointer',
                transition: 'all 0.2s',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
                boxShadow: isSelected ? '0 0 10px rgba(6, 182, 212, 0.1)' : 'none'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ fontSize: '13px', fontWeight: 600, color: isSelected ? 'var(--cyan)' : 'var(--text-1)' }}>
                  {provName}
                </div>
                <div style={{ fontSize: '10px', color: 'var(--text-3)' }}>#{sub.id}</div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <div style={{ fontSize: '10px', color: 'var(--text-2)' }}>
                    <Calendar size={10} style={{ marginRight: '4px', verticalAlign: 'middle', opacity: 0.7 }} />
                    {sub.inactiveAt ? new Date(sub.inactiveAt).toLocaleDateString() : 'N/A'}
                  </div>
                  <div style={{ fontSize: '10px', color: 'var(--text-2)' }}>
                    <Database size={10} style={{ marginRight: '4px', verticalAlign: 'middle', opacity: 0.7 }} />
                    {plan ? (plan.bytes === '0' ? '∞' : (parseInt(plan.bytes) / 1e9).toFixed(0) + ' GB') : '...'}
                  </div>
                </div>
                <span className="badge" style={{ 
                  background: sub.status === 1 ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)', 
                  color: sub.status === 1 ? 'var(--green)' : 'var(--red)',
                  fontSize: '9px', padding: '1px 6px', borderRadius: '4px'
                }}>
                  {sub.status === 1 ? t('subs.active') : 'Inactive'}
                </span>
              </div>
            </div>
          )
        })}
      </div>

      {/* Right Column: Node Table */}
      <div className="subs-main" style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
        {selectedSubId !== null && selectedSub ? (
          loadingNodes[selectedSub.planId] ? (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px' }}>
              <Loader2 className="spinner" size={24} />
              <div style={{ fontSize: '11px', color: 'var(--text-3)' }}>{t('common.loading_simple')}</div>
            </div>
          ) : planNodes[selectedSub.planId] ? (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
               <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--bg-2)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-2)' }}>
                    {t('subs.nodes_in_plan')} ({planNodes[selectedSub.planId].length})
                  </div>
                  <div style={{ fontSize: '10px', color: 'var(--text-3)' }}>
                    Click a node to connect using Sub #{selectedSub.id}
                  </div>
               </div>
               <NodeTable 
                 nodes={planNodes[selectedSub.planId]} 
                 onSelect={(node) => onConnect(selectedSub.id, node.address)}
                 bookmarks={bookmarks}
                 onToggleBookmark={onToggleBookmark}
                 activeNodeAddress={activeNodeAddress}
               />
            </div>
          ) : (
             <div className="empty-state">
                <div className="empty-state-text">Failed to load nodes for this subscription.</div>
             </div>
          )
        ) : (
          <div className="empty-state">
            <CreditCard size={32} color="var(--text-3)" />
            <div className="empty-state-text">Select a subscription from the list to view nodes.</div>
          </div>
        )}
      </div>
    </div>
  )
}
