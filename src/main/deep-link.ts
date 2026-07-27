export interface DeepLinkArgs {
  nodeAddress: string
  subscriptionType: 'gigabytes' | 'hours'
  amount: number
}

const NODE_ADDRESS_PATTERN = /^sentnode1[02-9ac-hj-np-z]{38}$/
const MAX_AMOUNT = 1_000_000

export function isValidNodeAddress(address: string): boolean {
  return NODE_ADDRESS_PATTERN.test(address)
}

export function parseDeepLink(url: string): DeepLinkArgs | null {
  try {
    const parsed = new URL(url)
    if (
      parsed.protocol !== 'chibatun:' ||
      parsed.hostname !== 'connect' ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      (parsed.pathname !== '' && parsed.pathname !== '/')
    ) return null

    const nodeAddress = parsed.searchParams.get('node')
    if (!nodeAddress || !isValidNodeAddress(nodeAddress)) return null

    const type = parsed.searchParams.get('type')
    if (type !== null && type !== 'gigabytes' && type !== 'hours') return null
    const subscriptionType: 'gigabytes' | 'hours' = type === 'hours' ? 'hours' : 'gigabytes'

    const amountParam = parsed.searchParams.get('amount')
    if (amountParam !== null && !/^[1-9]\d*$/.test(amountParam)) return null
    const amount = amountParam === null ? 1 : Number(amountParam)
    if (!Number.isSafeInteger(amount) || amount > MAX_AMOUNT) return null

    return { nodeAddress, subscriptionType, amount }
  } catch {
    return null
  }
}
