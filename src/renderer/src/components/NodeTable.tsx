import React, { useState, useMemo, memo } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiNode } from '../types'
import { countryToIsoCode, vpnTypeLabel, formatUdvpnPrice } from '../utils'
import { Star, Play, Circle, Heart, X, Check, Home, Copy, AlertTriangle } from 'lucide-react'

type SortKey = 'moniker' | 'country' | 'city' | 'type' | 'sessions' | 'peers' | 'gigaPrice' | 'hourPrice'
type SortDir = 'asc' | 'desc'

interface Props {
  nodes: ApiNode[]
  onSelect: (node: ApiNode) => void
  activeNodeAddress?: string | null
  bookmarks: string[]
  onToggleBookmark: (address: string) => void
}

const NodeRow = memo(({ 
  node, 
  isActive, 
  isBookmark, 
  onSelect, 
  onToggleBookmark, 
  t 
}: { 
  node: ApiNode, 
  isActive: boolean, 
  isBookmark: boolean, 
  onSelect: (node: ApiNode) => void, 
  onToggleBookmark: (address: string) => void,
  t: any
}) => {
  return (
    <tr onClick={() => onSelect(node)}
      style={isActive ? { background: 'rgba(0,255,159,0.04)', outline: '1px solid rgba(0,255,159,0.2)' } : {}}>

      <td onClick={e => { e.stopPropagation(); onToggleBookmark(node.address) }}
        style={{ textAlign: 'center', cursor: 'pointer', color: isBookmark ? 'var(--yellow)' : 'var(--text-3)' }}
        title={isBookmark ? t('table.remove_bookmark') : t('table.bookmark')}>
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          {isBookmark ? <Star size={14} fill="currentColor" /> : <Star size={14} />}
        </div>
      </td>

      <td className="td-moniker" title={`${node.address}\n${node.api}`}>
        {isActive && <Play size={10} fill="currentColor" style={{ color: 'var(--green)', marginRight: 6 }} />}
        {node.moniker}
        <div style={{ fontSize: 9, color: 'var(--text-3)', marginTop: 2 }}>v{node.version}</div>
      </td>

      <td><div className="td-country">
        <span className={`fi fi-${countryToIsoCode(node.country ?? '')}`} style={{ marginRight: 8, borderRadius: 1 }} />
        <span className="td-country-name" title={node.country}>{node.country}</span>
      </div></td>

      <td style={{ color: 'var(--text-3)' }}>{node.city || '—'}</td>

      <td><span className={`td-type ${node.type === 1 ? 'wireguard' : 'v2ray'}`}>{vpnTypeLabel(node.type)}</span></td>

      <td>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span className={`status-dot ${node.isActive ? 'active' : 'bad'}`} title={node.isActive ? t('table.active_status') : t('table.inactive_status')} />
          <span style={{ 
            fontSize: 12, 
            color: node.isHealthy ? 'var(--cyan)' : 'var(--red)', 
            filter: `drop-shadow(0 0 3px ${node.isHealthy ? 'var(--cyan)' : 'var(--red)'})`,
            display: 'inline-flex'
          }} title={node.isHealthy ? t('table.healthy_status') : t('table.unhealthy_status')}>
            {node.isHealthy ? <Heart size={10} fill="currentColor" /> : <X size={10} />}
          </span>
        </div>
      </td>

      <td style={{ color: node.sessions > 0 ? 'var(--cyan)' : 'var(--text-3)' }}>{node.sessions}</td>
      <td style={{ color: node.peers > 0 ? 'var(--text-2)' : 'var(--text-3)' }}>{node.peers}</td>
      <td style={{ color: 'var(--yellow)' }}>{formatUdvpnPrice(node.gigabytePrices)}</td>
      <td style={{ color: 'var(--orange)' }}>{formatUdvpnPrice(node.hourlyPrices)}</td>

      <td><div style={{ display: 'flex', gap: 4 }}>
        {node.isWhitelisted && <span className="tag tag-green" style={{ padding: '2px 4px' }}><Check size={10} strokeWidth={3} /></span>}
        {node.isResidential && <span className="tag tag-cyan" title={t('common.residential')} style={{ padding: '2px 4px' }}><Home size={10} /></span>}
        {node.isDuplicate   && <span className="tag tag-yellow" title={t('common.duplicate')} style={{ padding: '2px 4px' }}><Copy size={10} /></span>}
        {node.errorMessage  && <span className="tag tag-red" title={node.errorMessage ?? ''} style={{ padding: '2px 4px' }}><AlertTriangle size={10} /></span>}
      </div></td>
    </tr>
  )
})

export default function NodeTable({ nodes, onSelect, activeNodeAddress, bookmarks, onToggleBookmark }: Props) {
  const { t } = useTranslation()
  const [sortKey, setSortKey] = useState<SortKey>('sessions')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  function handleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
  }

  function thCls(key: SortKey) {
    if (sortKey !== key) return ''
    return sortDir === 'asc' ? 'sort-asc' : 'sort-desc'
  }

  function udvpn(prices: Array<{ denom: string; value: string }>): number {
    const p = prices.find(x => x.denom === 'udvpn')
    return p ? parseInt(p.value, 10) : Infinity
  }

  const sorted = useMemo(() => [...nodes].sort((a, b) => {
    let av: string | number = 0, bv: string | number = 0
    switch (sortKey) {
      case 'moniker':   av = (a.moniker ?? '').toLowerCase(); bv = (b.moniker ?? '').toLowerCase(); break
      case 'country':   av = (a.country ?? '').toLowerCase(); bv = (b.country ?? '').toLowerCase(); break
      case 'city':      av = (a.city ?? '').toLowerCase();    bv = (b.city ?? '').toLowerCase();    break
      case 'type':      av = a.type;    bv = b.type;    break
      case 'sessions':  av = a.sessions; bv = b.sessions; break
      case 'peers':     av = a.peers;    bv = b.peers;    break
      case 'gigaPrice': av = udvpn(a.gigabytePrices); bv = udvpn(b.gigabytePrices); break
      case 'hourPrice': av = udvpn(a.hourlyPrices);   bv = udvpn(b.hourlyPrices);   break
    }
    if (av < bv) return sortDir === 'asc' ? -1 : 1
    if (av > bv) return sortDir === 'asc' ? 1 : -1
    return 0
  }), [nodes, sortKey, sortDir])

  const [visibleCount, setVisibleCount] = useState(50)

  // Reset visible count when sort or filter changes
  React.useEffect(() => {
    setVisibleCount(50)
  }, [sorted])

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const { scrollTop, clientHeight, scrollHeight } = e.currentTarget
    if (scrollHeight - scrollTop <= clientHeight * 1.5) {
      if (visibleCount < sorted.length) {
        setVisibleCount(prev => Math.min(prev + 50, sorted.length))
      }
    }
  }

  if (!nodes.length) return (
    <div className="empty-state">
      <div className="empty-state-icon">◎</div>
      <div className="empty-state-text">{t('table.no_nodes')}</div>
    </div>
  )

  const visibleNodes = sorted.slice(0, visibleCount)

  return (
    <div className="nodes-table-wrapper" onScroll={handleScroll}>
      <table className="nodes-table">
        <thead>
          <tr>
            <th style={{ width: 32, textAlign: 'center' }} title={t('table.bookmark')}><Star size={14} style={{ margin: '0 auto' }} /></th>
            <th className={thCls('moniker')} onClick={() => handleSort('moniker')}>{t('table.node')}</th>
            <th className={thCls('country')} onClick={() => handleSort('country')}>{t('table.location')}</th>
            <th className={thCls('city')} onClick={() => handleSort('city')}>{t('table.city')}</th>
            <th className={thCls('type')} onClick={() => handleSort('type')}>{t('table.type')}</th>
            <th>{t('table.status')}</th>
            <th className={thCls('sessions')} onClick={() => handleSort('sessions')}>{t('table.sessions')}</th>
            <th className={thCls('peers')} onClick={() => handleSort('peers')}>{t('table.peers')}</th>
            <th className={thCls('gigaPrice')} onClick={() => handleSort('gigaPrice')}>{t('table.gb_price')}</th>
            <th className={thCls('hourPrice')} onClick={() => handleSort('hourPrice')}>{t('table.hr_price')}</th>
            <th>{t('table.flags')}</th>
          </tr>
        </thead>
        <tbody>
          {visibleNodes.map(node => (
            <NodeRow 
              key={node.address}
              node={node}
              isActive={node.address === activeNodeAddress}
              isBookmark={bookmarks.includes(node.address)}
              onSelect={onSelect}
              onToggleBookmark={onToggleBookmark}
              t={t}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}
