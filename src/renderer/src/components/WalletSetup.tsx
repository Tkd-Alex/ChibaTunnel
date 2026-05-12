import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'

interface Props {
  onSuccess: (address: string, rpc: string) => void
}

export default function WalletSetup({ onSuccess }: Props) {
  const { t } = useTranslation()
  const [mnemonic, setMnemonic] = useState('')
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState('')
  const [understood, setUnderstood] = useState(false)

  async function handleGenerate() {
    setError('')
    setLoading(true)
    try {
      const res = await window.api.generateMnemonic()
      if (res.success) {
        setMnemonic(res.mnemonic!)
      } else {
        setError(res.error || 'Failed to generate')
      }
    } finally {
      setLoading(false)
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!understood) return
    setError('')
    if (mnemonic.trim().split(/\s+/).length < 12) {
      setError(t('wallet.mnemonic_error'))
      return
    }
    setLoading(true)
    try {
      const res = await window.api.setupWallet(mnemonic.trim())
      if (res.success) {
        onSuccess(res.address!, (res as { rpc?: string }).rpc ?? '')
      } else {
        setError(res.error ?? 'Unknown error')
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="wallet-setup-screen">
      <div className="setup-card">
        <div className="setup-header">
          <div className="icon">🔐</div>
          <h1>{t('wallet.setup_title')}</h1>
          <p>{t('wallet.setup_sub')}</p>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <label className="form-label" style={{ marginBottom: 0 }}>{t('wallet.mnemonic_label')}</label>
              <button type="button" className="btn btn-secondary btn-sm" onClick={handleGenerate} disabled={loading}>
                {loading ? '...' : `✨ ${t('wallet.generate_btn')}`}
              </button>
            </div>
            <textarea
              className="form-input textarea"
              placeholder={t('wallet.mnemonic_placeholder')}
              value={mnemonic}
              onChange={e => setMnemonic(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              data-gramm="false"
            />
            <div className="form-hint">
              <span className="dot" />
              <span>{t('wallet.mnemonic_hint')}</span>
            </div>
          </div>

          <div className="form-group" style={{ marginTop: 16 }}>
            <label className="checkbox-container" style={{ fontSize: 11, color: 'var(--text-2)', display: 'flex', gap: 10, cursor: 'pointer', alignItems: 'flex-start' }}>
              <input 
                type="checkbox" 
                checked={understood} 
                onChange={e => setUnderstood(e.target.checked)} 
                style={{ marginTop: 2 }}
              />
              <span>{t('wallet.mnemonic_loss_warning')}</span>
            </label>
          </div>

          {error && (
            <div className="error-box">
              <div className="error-label">{t('common.error')}</div>
              {error}
            </div>
          )}

          <button
            type="submit"
            className="btn btn-primary btn-full"
            disabled={loading || !mnemonic.trim() || !understood}
          >
            {loading
              ? <><div className="spinner" style={{ width: 16, height: 16 }} /> {t('common.loading')}</>
              : `⚡ ${t('wallet.connect_btn')}`}
          </button>
        </form>

        <div className="divider">or</div>

        <p style={{ textAlign: 'center', fontSize: 10, color: 'var(--text-3)' }}>
          {t('wallet.setup_footer')}
        </p>
      </div>
    </div>
  )
}
