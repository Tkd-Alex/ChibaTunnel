import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiSubscription, ApiNode, ApiPlan } from '../types'
import { Loader2, CreditCard, Calendar, Database, Play, CheckCircle2, XCircle, Info, ChevronDown, ChevronUp } from 'lucide-react'

interface Props {
  subscriptions: ApiSubscription[]
  plans: ApiPlan[]
  loading: boolean
  onConnect: (subId: number, nodeAddr: string) => void
  activeNodeAddress?: string
}

export default function SubscriptionsPanel({ subscriptions, plans, loading, onConnect, activeNodeAddress }: Props) {
  const { t } = useTranslation()
  const [expandedSub, setExpandedSub] = useState<number | null>(null)
  const [planNodes, setPlanNodes] = useState<Record<number, ApiNode[]>>({})
  const [loadingNodes, setLoadingNodes] = useState<Record<number, boolean>>({})

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

  const toggleExpand = (subId: number, planId: number) => {
    if (expandedSub === subId) {
      setExpandedSub(null)
    } else {
      setExpandedSub(subId)
      fetchPlanNodes(planId)
    }
  }

  if (loading && subscriptions.length === 0) {
    return (
      <div className="empty-state">
        <Loader2 className="spinner" size={32} />
        <div className="empty-state-text">{t('subs.fetching', { defaultValue: 'Fetching subscriptions...' })}</div>
      </div>
    )
  }

  if (subscriptions.length === 0) {
    return (
      <div className="empty-state">
        <CreditCard size={32} color="var(--text-3)" />
        <div className="empty-state-text">{t('subs.no_subs')}</div>
      </div>
    )
  }

  return (
    <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px', height: '100%', overflowY: 'auto' }}>
      {subscriptions.map(sub => {
        const plan = plans.find(p => p.id === sub.planId)
        const isExpanded = expandedSub === sub.id
        
        return (
          <div key={sub.id} className="card" style={{ 
            background: 'var(--bg-1)', 
            border: '1px solid var(--bg-2)',
            borderRadius: '12px',
            padding: '16px',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div style={{ cursor: 'pointer', flex: 1 }} onClick={() => toggleExpand(sub.id, sub.planId)}>
                <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-1)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  Plan #{sub.planId} 
                  <span style={{ fontSize: '11px', color: 'var(--text-3)', fontWeight: 400 }}>{t('subs.sub_id', { id: sub.id })}</span>
                </div>
                <div style={{ display: 'flex', gap: '12px', marginTop: '6px' }}>
                  <span className="badge" style={{ 
                    background: sub.status === 1 ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)', 
                    color: sub.status === 1 ? 'var(--green)' : 'var(--red)',
                    fontSize: '10px', padding: '2px 8px', borderRadius: '4px'
                  }}>
                    {sub.status === 1 ? t('subs.active') : 'Inactive'}
                  </span>
                </div>
              </div>
              
              <button 
                className="btn btn-secondary btn-sm"
                onClick={() => toggleExpand(sub.id, sub.planId)}
                style={{ padding: '4px' }}
              >
                {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </button>
            </div>

            <div style={{ display: 'flex', gap: '20px' }}>
              <div className="meta" style={{ fontSize: '12px', color: 'var(--text-2)' }}>
                <Calendar size={12} style={{ marginRight: '6px', verticalAlign: 'middle', opacity: 0.7 }} />
                {t('subs.expires')}: <strong>{sub.inactiveAt ? new Date(sub.inactiveAt).toLocaleDateString() : 'N/A'}</strong>
              </div>
              <div className="meta" style={{ fontSize: '12px', color: 'var(--text-2)' }}>
                <Database size={12} style={{ marginRight: '6px', verticalAlign: 'middle', opacity: 0.7 }} />
                {t('subs.quota')}: <strong>{plan ? (plan.bytes === '0' ? '∞' : (parseInt(plan.bytes) / 1e9).toFixed(0) + ' GB') : '...'}</strong>
              </div>
            </div>

            {isExpanded && (
              <>
                <hr style={{ border: 'none', borderTop: '1px solid var(--bg-2)', margin: '4px 0' }} />
                <div>
                  <div style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-2)', marginBottom: '8px' }}>
                    {t('subs.nodes_in_plan')}
                  </div>
                  
                  {loadingNodes[sub.planId] ? (
                    <div style={{ display: 'flex', justifyContent: 'center', padding: '20px' }}>
                      <Loader2 className="spinner" size={24} color="var(--text-3)" />
                    </div>
                  ) : planNodes[sub.planId] ? (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '8px' }}>
                      {planNodes[sub.planId].map(node => {
                        const isConnected = activeNodeAddress === node.address
                        return (
                          <div key={node.address} className="node-item" style={{ 
                            padding: '8px 12px',
                            background: isConnected ? 'rgba(6, 182, 212, 0.1)' : 'var(--bg-0)',
                            border: `1px solid ${isConnected ? 'var(--cyan)' : 'var(--bg-2)'}`,
                            borderRadius: '8px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '10px',
                            cursor: 'pointer'
                          }} onClick={() => onConnect(sub.id, node.address)}>
                            <div style={{ 
                              width: '8px', height: '8px', borderRadius: '50%', 
                              background: node.isHealthy ? 'var(--green)' : 'var(--red)' 
                            }} />
                            <span style={{ flex: 1, fontSize: '12px', color: isConnected ? 'var(--cyan)' : 'var(--text-1)' }}>
                              {node.moniker || node.address.slice(0, 12)}
                            </span>
                            {isConnected ? (
                              <span style={{ fontSize: '9px', fontWeight: 600, color: 'var(--cyan)', textTransform: 'uppercase' }}>
                                {t('subs.connected')}
                              </span>
                            ) : (
                              <Play size={12} color="var(--text-3)" />
                            )}
                          </div>
                        )
                      })}
                    </div>
                  ) : (
                    <div style={{ fontSize: '11px', color: 'var(--text-3)', textAlign: 'center', padding: '10px' }}>
                      Failed to load nodes.
                    </div>
                  )}
                </div>
                
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '8px' }}>
                  <button className="btn btn-secondary btn-sm" disabled>{t('subs.renew')}</button>
                  <button className="btn btn-danger btn-sm" disabled>{t('subs.cancel')}</button>
                </div>
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}
