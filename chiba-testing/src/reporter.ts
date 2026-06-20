// ─── reporter.ts ───
//
// Durable, reviewable output. Every run writes a JSON report and a human-readable
// Markdown summary to reports/, plus a live console line per channel. Findings are
// first-class: not just pass/fail, but slow calls, empty result sets, malformed
// envelopes, and leaked internals are recorded for later review.

import * as fs from 'fs'
import * as path from 'path'

export type Outcome = 'pass' | 'fail' | 'skip' | 'error'

export interface Finding {
  severity: 'info' | 'warn' | 'error'
  message: string
}

export interface ChannelResult {
  channel: string
  api: string
  tier: string
  outcome: Outcome
  ms: number
  detail?: string
  findings: Finding[]
}

export interface RunReport {
  mode: string
  tier: string
  startedAt: string
  finishedAt?: string
  rpc?: string
  totals: Record<Outcome, number>
  channelCount: number
  capturedCount: number
  results: ChannelResult[]
}

const C = {
  reset: '\x1b[0m', gray: '\x1b[90m', red: '\x1b[31m', green: '\x1b[32m',
  yellow: '\x1b[33m', cyan: '\x1b[36m', bold: '\x1b[1m',
}

function icon(o: Outcome): string {
  switch (o) {
    case 'pass': return `${C.green}PASS${C.reset}`
    case 'fail': return `${C.red}FAIL${C.reset}`
    case 'error': return `${C.red}ERR ${C.reset}`
    case 'skip': return `${C.gray}SKIP${C.reset}`
  }
}

export class Reporter {
  private report: RunReport

  constructor(mode: string, tier: string, startedAt: string) {
    this.report = {
      mode, tier, startedAt,
      totals: { pass: 0, fail: 0, skip: 0, error: 0 },
      channelCount: 0,
      capturedCount: 0,
      results: [],
    }
  }

  setMeta(channelCount: number, capturedCount: number, rpc?: string): void {
    this.report.channelCount = channelCount
    this.report.capturedCount = capturedCount
    this.report.rpc = rpc
  }

  record(result: ChannelResult): void {
    this.report.results.push(result)
    this.report.totals[result.outcome]++
    const findingTag = result.findings.length
      ? ` ${C.yellow}(${result.findings.length} finding${result.findings.length > 1 ? 's' : ''})${C.reset}`
      : ''
    const detail = result.detail ? ` ${C.gray}— ${result.detail}${C.reset}` : ''
    // eslint-disable-next-line no-console
    console.log(
      `  ${icon(result.outcome)} ${C.cyan}${result.channel}${C.reset} ` +
      `${C.gray}[${result.tier}] ${result.ms}ms${C.reset}${findingTag}${detail}`,
    )
    for (const f of result.findings) {
      const col = f.severity === 'error' ? C.red : f.severity === 'warn' ? C.yellow : C.gray
      // eslint-disable-next-line no-console
      console.log(`       ${col}• ${f.message}${C.reset}`)
    }
  }

  finish(finishedAt: string, outDir: string): { json: string; md: string } {
    this.report.finishedAt = finishedAt
    fs.mkdirSync(outDir, { recursive: true })
    const stamp = finishedAt.replace(/[:.]/g, '-')
    const jsonPath = path.join(outDir, `run-${stamp}.json`)
    const mdPath = path.join(outDir, `run-${stamp}.md`)
    fs.writeFileSync(jsonPath, JSON.stringify(this.report, null, 2), 'utf8')
    fs.writeFileSync(mdPath, this.toMarkdown(), 'utf8')
    // Also keep a stable "latest" pair for easy diffing.
    fs.writeFileSync(path.join(outDir, 'latest.json'), JSON.stringify(this.report, null, 2), 'utf8')
    fs.writeFileSync(path.join(outDir, 'latest.md'), this.toMarkdown(), 'utf8')
    return { json: jsonPath, md: mdPath }
  }

  get totals(): Record<Outcome, number> {
    return this.report.totals
  }

  private toMarkdown(): string {
    const r = this.report
    const lines: string[] = []
    lines.push(`# Chiba Testing — run report`)
    lines.push('')
    lines.push(`- **Mode:** ${r.mode}`)
    lines.push(`- **Max tier:** ${r.tier}`)
    lines.push(`- **RPC:** ${r.rpc ?? '(n/a)'}`)
    lines.push(`- **Started:** ${r.startedAt}`)
    lines.push(`- **Finished:** ${r.finishedAt ?? '(running)'}`)
    lines.push(`- **Channels in map:** ${r.channelCount}  •  **Captured from app:** ${r.capturedCount}`)
    lines.push('')
    lines.push(`## Totals`)
    lines.push('')
    lines.push(`| pass | fail | error | skip |`)
    lines.push(`|-----:|-----:|------:|-----:|`)
    lines.push(`| ${r.totals.pass} | ${r.totals.fail} | ${r.totals.error} | ${r.totals.skip} |`)
    lines.push('')
    lines.push(`## Channels`)
    lines.push('')
    lines.push(`| Channel | Tier | Outcome | ms | Detail |`)
    lines.push(`|---------|------|---------|---:|--------|`)
    for (const c of r.results) {
      lines.push(`| \`${c.channel}\` | ${c.tier} | ${c.outcome.toUpperCase()} | ${c.ms} | ${(c.detail ?? '').replace(/\|/g, '\\|')} |`)
    }
    const withFindings = r.results.filter((c) => c.findings.length)
    if (withFindings.length) {
      lines.push('')
      lines.push(`## Findings`)
      lines.push('')
      for (const c of withFindings) {
        lines.push(`### \`${c.channel}\``)
        for (const f of c.findings) {
          lines.push(`- **${f.severity}** — ${f.message}`)
        }
        lines.push('')
      }
    }
    return lines.join('\n') + '\n'
  }
}
