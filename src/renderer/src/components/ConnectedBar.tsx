import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ConnectionState } from '../types'
import TrafficStatsWidget from './TrafficStats'
import { Hexagon, X } from 'lucide-react'
import ConfirmModal from './ConfirmModal'

interface Props {
  connection: ConnectionState
  reconnectMsg?: string | null
  onDisconnect: () => void
  onManage: () => void
}

export default function ConnectedBar({ connection, reconnectMsg, onDisconnect, onManage }: Props) {
  const { t } = useTranslation()
  const { node, vpnType, sessionId, inbounds } = connection
  const [showConfirm, setShowConfirm] = useState(false)

  return (
    <div className="connected-panel">
      {reconnectMsg ? (
        <div className="reconnect-banner">
          <div className="spinner" style={{ width: 12, height: 12, flexShrink: 0 }} />
          <span>{reconnectMsg}</span>
        </div>
      ) : (
        <div className="connected-indicator">
          <span className="dot" />
          <span>{t('vpn.connected').toUpperCase()}</span>
        </div>
      )}

      <div style={{ fontSize: 11, color: 'var(--text-2)', flexShrink: 0 }}>
        {node?.moniker ?? 'Unknown'} · {vpnType === 'wireguard' ? 'WireGuard' : 'V2Ray'}
        {sessionId && <span style={{ color: 'var(--text-3)', fontSize: 10, marginLeft: 8 }}>#{sessionId}</span>}
      </div>

      {vpnType === 'v2ray' && inbounds && inbounds.length > 0 && (
        <div className="proxy-chips">
          {inbounds.map((ib, i) => (
            <span key={i} className="proxy-chip">{ib.protocol.toUpperCase()} :{ib.port}</span>
          ))}
        </div>
      )}

      <TrafficStatsWidget />

      <div className="connected-actions">
        <button className="btn btn-secondary btn-sm" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={onManage}>
          <Hexagon size={12} /> {t('vpn.manage_btn')}
        </button>
        <button className="btn btn-danger btn-sm" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={() => setShowConfirm(true)}>
          <X size={12} /> {t('vpn.disconnect_btn')}
        </button>
      </div>

      {showConfirm && (
        <ConfirmModal
          title={t('vpn.disconnect_confirm_title')}
          message={t('vpn.disconnect_confirm_msg')}
          confirmLabel={t('vpn.disconnect_btn')}
          cancelLabel={t('common.cancel')}
          danger
          onConfirm={() => {
            setShowConfirm(false)
            onDisconnect()
          }}
          onCancel={() => setShowConfirm(false)}
        />
      )}
    </div>
  )
}
