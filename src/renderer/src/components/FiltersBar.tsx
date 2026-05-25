import React from 'react'
import { useTranslation } from 'react-i18next'
import { NodeFilters, ApiNode } from '../types'
import { uniqueSorted } from '../utils'
import { 
  Search, 
  Circle, 
  Heart, 
  Check, 
  Home, 
  Copy, 
  Star 
} from 'lucide-react'

interface Props {
  filters: NodeFilters
  onChange: (f: NodeFilters) => void
  nodes: ApiNode[]
  filteredCount: number
}

export default function FiltersBar({ filters, onChange, nodes, filteredCount }: Props) {
  const { t } = useTranslation()
  const countries = uniqueSorted(nodes.map(n => n.country ?? '').filter(Boolean))
  const cities    = uniqueSorted(
    nodes.filter(n => !filters.country || n.country === filters.country).map(n => n.city ?? '').filter(Boolean)
  )
  const set = (patch: Partial<NodeFilters>) => onChange({ ...filters, ...patch })

  return (
    <div className="filters-bar">
      <div className="filter-search" style={{ position: 'relative' }}>
        <Search size={12} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', opacity: 0.5 }} />
        <input
          className="form-input"
          style={{ width: '100%', padding: '6px 10px 6px 30px', fontSize: 11 }}
          placeholder={t('filters.search_placeholder')}
          value={filters.search}
          onChange={e => set({ search: e.target.value })}
        />
      </div>

      <select className="filter-select" value={filters.country}
        onChange={e => set({ country: e.target.value, city: '' })}>
        <option value="">{t('filters.all_countries')}</option>
        {countries.map(c => <option key={c} value={c}>{c}</option>)}
      </select>

      <select className="filter-select" value={filters.city}
        onChange={e => set({ city: e.target.value })} disabled={!filters.country}>
        <option value="">{t('filters.all_cities')}</option>
        {cities.map(c => <option key={c} value={c}>{c}</option>)}
      </select>

      <select className="filter-select" value={filters.type}
        onChange={e => set({ type: e.target.value as NodeFilters['type'] })}>
        <option value="">{t('filters.all_types')}</option>
        <option value="1">{t('filters.wireguard')}</option>
        <option value="2">{t('filters.v2ray')}</option>
      </select>

      <button className={`filter-toggle ${filters.onlyActive      ? 'active' : ''}`} onClick={() => set({ onlyActive:      !filters.onlyActive      })}><Circle size={8} fill="currentColor" /> {t('filters.active')}</button>
      <button className={`filter-toggle ${filters.onlyHealthy     ? 'active' : ''}`} onClick={() => set({ onlyHealthy:     !filters.onlyHealthy     })}><Heart size={8} fill="currentColor" /> {t('filters.healthy_label')}</button>
      <button className={`filter-toggle ${filters.onlyWhitelisted ? 'active' : ''}`} onClick={() => set({ onlyWhitelisted: !filters.onlyWhitelisted })}><Check size={10} strokeWidth={3} /> {t('filters.listed')}</button>
      <button className={`filter-toggle ${filters.hideResidential ? 'active' : ''}`} onClick={() => set({ hideResidential: !filters.hideResidential })}><Home size={10} /> {t('filters.hide_res')}</button>
      <button className={`filter-toggle ${filters.hideDuplicate   ? 'active' : ''}`} onClick={() => set({ hideDuplicate:   !filters.hideDuplicate   })}><Copy size={10} /> {t('filters.hide_dupes')}</button>
      <button className={`filter-toggle ${filters.bookmarksOnly   ? 'active' : ''}`} onClick={() => set({ bookmarksOnly:   !filters.bookmarksOnly   })}><Star size={10} fill="currentColor" /> {t('common.bookmarks')}</button>

      <div className="filters-count">{filteredCount} / {nodes.length} {t('common.nodes')}</div>
    </div>
  )
}
