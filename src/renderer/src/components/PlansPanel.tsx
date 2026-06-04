import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiPlan, ApiNode } from '../types'
import { Globe, Users, Clock, CreditCard, ChevronRight, CheckCircle2, Loader2, Info } from 'lucide-react'

interface Props {
  plans: ApiPlan[]
  loading: boolean
  onSubscribe: () => void
}

export default function PlansPanel({ plans, loading, onSubscribe }: Props) {
  const { t } = useTranslation()
  const [nodesPreview, setNodesPreview] = useState<Record<number, ApiNode[]>>({})
  const [loadingNodes, setLoadingNodes] = useState<Record<number, boolean>>({})

  const fetchPlanNodes = async (planId: number) => {
    if (nodesPreview[planId]) return
    setLoadingNodes(prev => ({ ...prev, [planId]: true }))
    try {
      const res = await window.api.fetchPlanNodes(planId)
      if (res.success) {
        setNodesPreview(prev => ({ ...prev, [planId]: res.nodes }))
      }
    } catch (e) {
      console.error(e)
    } finally {
      setLoadingNodes(prev => ({ ...prev, [planId]: false }))
    }
  }

  const handleSubscribe = async (planId: number, denom: string) => {
    if (!confirm(t('plans.subscribe_confirm', { defaultValue: `Are you sure you want to subscribe to this plan?` }))) return
    try {
      const res = await window.api.subscribeToPlan(planId, denom)
      if (res.success) {
        alert(t('plans.subscribe_success', { defaultValue: 'Subscription transaction sent successfully!' }))
        onSubscribe()
      } else {
        alert(t('common.error') + ': ' + res.error)
      }
    } catch (e) {
      alert(t('common.error') + ': ' + String(e))
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

  if (plans.length === 0) {
    return (
      <div className="empty-state">
        <Info size={32} color="var(--text-3)" />
        <div className="empty-state-text">{t('plans.no_plans')}</div>
      </div>
    )
  }

  return (
    <div className="plans-grid" style={{ 
      display: 'grid', 
      gridTemplateColumns: 'repeat(auto-fill, minmax(350px, 1fr))', 
      gap: '16px', 
      padding: '16px',
      overflowY: 'auto',
      height: '100%'
    }}>
      {plans.map(plan => (
        <div key={plan.id} className="card plan-card" style={{ 
          background: 'var(--bg-1)', 
          border: '1px solid var(--bg-2)',
          borderRadius: '12px',
          padding: '20px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          transition: 'border-color 0.2s',
          cursor: 'default'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <div style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-1)' }}>
                🌍 Plan #{plan.id}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-3)', marginTop: '2px' }}>
                {t('plans.by')} <span style={{ color: 'var(--cyan)' }}>{plan.provAddress.slice(0, 12)}...{plan.provAddress.slice(-4)}</span>
              </div>
            </div>
            <div className="badge" style={{ 
              background: 'rgba(16, 185, 129, 0.1)', 
              color: 'var(--green)',
              border: '1px solid rgba(16, 185, 129, 0.2)',
              fontSize: '10px',
              padding: '2px 8px',
              borderRadius: '20px',
              display: 'flex',
              alignItems: 'center',
              gap: '4px'
            }}>
              <CheckCircle2 size={10} /> {t('common.active')}
            </div>
          </div>

          <div style={{ display: 'flex', gap: '16px', marginTop: '4px' }}>
            <div style={{ fontSize: '12px', color: 'var(--text-2)' }}>
              <Users size={12} style={{ marginRight: '4px', verticalAlign: 'middle', opacity: 0.7 }} />
              <strong>{plan.bytes === '0' ? '∞' : (parseInt(plan.bytes) / 1e9).toFixed(0)}</strong> GB
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-2)' }}>
              <Clock size={12} style={{ marginRight: '4px', verticalAlign: 'middle', opacity: 0.7 }} />
              <strong>{(plan.duration / 86400).toFixed(0)}</strong> {t('plans.days')}
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-1)', fontWeight: 600 }}>
              <CreditCard size={12} style={{ marginRight: '4px', verticalAlign: 'middle', opacity: 0.7 }} />
              {parseInt(plan.prices[0]?.amount || '0') / 1e6} {plan.prices[0]?.denom.replace('u', '').toUpperCase()}
            </div>
          </div>

          <hr style={{ border: 'none', borderTop: '1px solid var(--bg-2)', margin: '4px 0' }} />

          <div style={{ flex: 1 }}>
            <div style={{ 
              display: 'flex', 
              justifyContent: 'space-between', 
              alignItems: 'center', 
              marginBottom: '8px',
              cursor: 'pointer'
            }} onClick={() => fetchPlanNodes(plan.id)}>
              <span style={{ fontSize: '11px', fontWeight: 500, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                {t('subs.nodes_in_plan')}
              </span>
              {!nodesPreview[plan.id] && !loadingNodes[plan.id] && (
                <span style={{ fontSize: '10px', color: 'var(--cyan)', display: 'flex', alignItems: 'center' }}>
                  {t('plans.details')} <ChevronRight size={12} />
                </span>
              )}
            </div>

            {loadingNodes[plan.id] && (
              <div style={{ display: 'flex', justifyContent: 'center', padding: '10px' }}>
                <Loader2 className="spinner" size={16} color="var(--text-3)" />
              </div>
            )}

            {nodesPreview[plan.id] && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
                {nodesPreview[plan.id].slice(0, 4).map((node, idx) => (
                  <div key={idx} style={{ 
                    background: 'var(--bg-0)', 
                    border: '1px solid var(--bg-2)',
                    borderRadius: '6px',
                    padding: '6px 8px',
                    fontSize: '11px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden'
                  }}>
                    <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--green)' }} />
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{node.moniker || node.address.slice(0, 8)}</span>
                    <span style={{ fontSize: '9px', color: 'var(--text-3)' }}>{node.type === 1 ? 'WG' : 'V2R'}</span>
                  </div>
                ))}
                {nodesPreview[plan.id].length > 4 && (
                  <div style={{ 
                    padding: '4px 8px', 
                    fontSize: '10px', 
                    color: 'var(--text-3)', 
                    fontStyle: 'italic',
                    gridColumn: 'span 2'
                  }}>
                    + {nodesPreview[plan.id].length - 4} {t('plans.nodes')}
                  </div>
                )}
              </div>
            )}
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '8px' }}>
            <button 
              className="btn btn-primary" 
              style={{ width: '100%', justifyContent: 'center', gap: '8px' }}
              onClick={() => handleSubscribe(plan.id, plan.prices[0]?.denom || 'udvpn')}
            >
              <CreditCard size={14} /> 
              {t('plans.subscribe')} — {parseInt(plan.prices[0]?.amount || '0') / 1e6} {plan.prices[0]?.denom.replace('u', '').toUpperCase()}
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
