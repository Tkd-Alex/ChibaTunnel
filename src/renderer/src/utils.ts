/**
 * Convert a country name to its ISO 3166-1 alpha-2 code.
 * Falls back to 'un' (United Nations) for unknown countries.
 */
export function countryToIsoCode(country: string): string {
  const map: Record<string, string> = {
    'United States': 'us', 'United Kingdom': 'gb', 'Germany': 'de', 'France': 'fr',
    'Netherlands': 'nl', 'Sweden': 'se', 'Norway': 'no', 'Finland': 'fi',
    'Switzerland': 'ch', 'Austria': 'at', 'Belgium': 'be', 'Spain': 'es',
    'Italy': 'it', 'Portugal': 'pt', 'Poland': 'pl', 'Czech Republic': 'cz',
    'Romania': 'ro', 'Hungary': 'hu', 'Bulgaria': 'bg', 'Ukraine': 'ua',
    'Russia': 'ru', 'Turkey': 'tr', 'Canada': 'ca', 'Mexico': 'mx',
    'Brazil': 'br', 'Argentina': 'ar', 'Chile': 'cl', 'Colombia': 'co',
    'Japan': 'jp', 'South Korea': 'kr', 'China': 'cn', 'India': 'in',
    'Singapore': 'sg', 'Hong Kong': 'hk', 'Taiwan': 'tw', 'Thailand': 'th',
    'Vietnam': 'vn', 'Indonesia': 'id', 'Malaysia': 'my', 'Philippines': 'ph',
    'Australia': 'au', 'New Zealand': 'nz', 'South Africa': 'za',
    'Israel': 'il', 'United Arab Emirates': 'ae', 'Saudi Arabia': 'sa',
    'Egypt': 'eg', 'Nigeria': 'ng', 'Kenya': 'ke', 'Morocco': 'ma',
    'Denmark': 'dk', 'Croatia': 'hr', 'Serbia': 'rs', 'Slovakia': 'sk',
    'Lithuania': 'lt', 'Latvia': 'lv', 'Estonia': 'ee', 'Moldova': 'md',
    'Kazakhstan': 'kz', 'Georgia': 'ge', 'Armenia': 'am', 'Azerbaijan': 'az',
    'Belarus': 'by', 'Greece': 'gr', 'Iceland': 'is', 'Ireland': 'ie',
    'Luxembourg': 'lu', 'Malta': 'mt', 'Cyprus': 'cy', 'Slovenia': 'si',
    'Ecuador': 'ec', 'Peru': 'pe', 'Venezuela': 've', 'Paraguay': 'py',
    'Uruguay': 'uy', 'Bolivia': 'bo', 'Cuba': 'cu', 'Dominican Republic': 'do',
    'Costa Rica': 'cr', 'Guatemala': 'gt', 'Panama': 'pa', 'Puerto Rico': 'pr',
    'Pakistan': 'pk', 'Bangladesh': 'bd', 'Sri Lanka': 'lk', 'Nepal': 'np',
    'Myanmar': 'mm', 'Cambodia': 'kh', 'Laos': 'la', 'Mongolia': 'mn',
    'Iran': 'ir', 'Iraq': 'iq', 'Jordan': 'jo', 'Lebanon': 'lb',
    'Kuwait': 'kw', 'Qatar': 'qa', 'Bahrain': 'bh', 'Oman': 'om',
    'Algeria': 'dz', 'Tunisia': 'tn', 'Libya': 'ly', 'Sudan': 'sd',
    'Ethiopia': 'et', 'Ghana': 'gh', 'Tanzania': 'tz', 'Uganda': 'ug',
    'Zimbabwe': 'zw', 'Cameroon': 'cm', 'Senegal': 'sn', 'Ivory Coast': 'ci',
  }
  return map[country] ?? 'un'
}

export function vpnTypeLabel(type: number): string {
  return type === 1 ? 'WireGuard' : type === 2 ? 'V2Ray' : `Type ${type}`
}

export function formatBalance(amount: string, denom: string): string {
  if (denom === 'udvpn') {
    const dvpn = (parseInt(amount, 10) / 1_000_000).toFixed(6)
    return `${dvpn} DVPN`
  }
  if (denom.startsWith('ibc/')) {
    const shortDenom = denom.slice(4, 10) + '…'
    return `${(parseInt(amount, 10) / 1_000_000).toFixed(2)} IBC/${shortDenom}`
  }
  return `${amount} ${denom}`
}

export function formatUdvpnPrice(prices: Array<{ denom: string; value: string }>): string {
  const p = prices.find(x => x.denom === 'udvpn')
  if (!p) return '—'
  const dvpn = (parseInt(p.value, 10) / 1_000_000).toFixed(2)
  return `${dvpn} DVPN`
}

export function truncateAddress(addr: string, len = 12): string {
  if (addr.length <= len * 2 + 3) return addr
  return `${addr.slice(0, len)}…${addr.slice(-6)}`
}

export function uniqueSorted(arr: string[]): string[] {
  return [...new Set(arr.filter(Boolean))].sort()
}

export function formatDataQuota(bytesStr: string): string {
  const bytes = parseInt(bytesStr, 10)
  if (!bytes || isNaN(bytes)) return '∞'
  if (bytes === 0) return '∞'
  
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB']
  let l = 0, n = bytes
  while (n >= 1024 && l < units.length - 1) {
    n = n / 1024
    l++
  }
  return n.toFixed(n < 10 && l > 0 ? 1 : 0) + ' ' + units[l]
}
