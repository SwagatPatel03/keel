// Keel's interface inside Claude Code, on every surface it draws on (the
// terminal, the desktop app and the Claude Code panel in VS Code):
//
//   - a one-line strip above the prompt box: the verdict, the task's budget,
//     the last green checkpoint and what the guard stopped;
//   - a Keel pane (/keel, or the strip's Details button): the verdict and its
//     checks, the budget, the prompts so far, the files changed, the guard's
//     log, and actions (run the checks, preview and undo, the receipt);
//   - a status line entry, and a toast when a prompt's verdict changes.
//
// Everything is drawn from `keel ui --json` (src/ui-model.mjs), run in the
// background on a timer so no tool call waits for it.

import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { KeelModel, KeelView } from '../types'

const PANE = 'keel'
const model = atom({ plugin: 'keel', key: 'model' } as const, null as KeelModel | null)
const bandHidden = atom({ plugin: 'keel', key: 'bandHidden' } as const, false)
const view = atom({ plugin: 'keel', key: 'view' } as const, 'overview' as KeelView)
const output = atom({ plugin: 'keel', key: 'output' } as const, null as string | null)
const busy = atom({ plugin: 'keel', key: 'busy' } as const, null as string | null)

/** Tools whose results can change what Keel shows. */
const CHANGING_TOOLS = new Set(['Bash', 'PowerShell', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

// ---------------------------------------------------------------- formatting

/** "just now", "4m ago", "2h ago", "yesterday", "3d ago". */
export function ago(iso: string | null | undefined, now: number): string {
  if (!iso) return ''
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (!Number.isFinite(s)) return ''
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  return d === 1 ? 'yesterday' : `${d}d ago`
}

/** 1,234 → "1.2k", 3,400,000 → "3.4M". */
export function compact(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 1e6) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`
  return `${(n / 1e6).toFixed(1)}M`
}

/** A bar of `width` cells, full past 100%. */
export function bar(fraction: number, width: number): string {
  const filled = Math.max(0, Math.min(width, Math.round(Math.min(1, fraction) * width)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

/** How the verdict reads, with the theme color for it. */
export function verdictLook(value: string): { glyph: string; label: string; color: 'success' | 'error' | 'warning' } {
  if (value === 'verified') return { glyph: '✔', label: 'Verified', color: 'success' }
  if (value === 'failed') return { glyph: '✖', label: 'Checks failed', color: 'error' }
  return { glyph: '◌', label: 'Not verified', color: 'warning' }
}

/** The budget's color: quiet below 70%, a warning to 100%, an error past it. */
export function budgetColor(fraction: number): 'subtle' | 'warning' | 'error' {
  return fraction >= 1 ? 'error' : fraction >= 0.7 ? 'warning' : 'subtle'
}

/** The budget used, as people read it: "41%", "140%", and past twice the budget "63× budget". */
export function budgetLabel(fraction: number): string {
  if (fraction < 1.995) return `${Math.round(fraction * 100)}%`
  return `${fraction < 9.95 ? fraction.toFixed(1) : Math.round(fraction)}× budget`
}

/** The pieces of the strip above the prompt, the least important dropped first to fit. */
export function stripParts(m: KeelModel, columns: number, now: number): { text: string; color?: string; bold?: boolean }[] {
  const v = verdictLook(m.verdict.value)
  const parts: { text: string; color?: string; bold?: boolean; drop: number }[] = [
    { text: '⚓ Keel', color: 'claude', bold: true, drop: 99 },
    { text: `${v.glyph} ${v.label}`, color: v.color, bold: true, drop: 98 },
  ]
  if (m.task) {
    parts.push({ text: `${m.task.size} ${bar(m.task.fraction, 8)} ${budgetLabel(m.task.fraction)}`, color: budgetColor(m.task.fraction), drop: 3 })
  }
  parts.push(m.lastGreen
    ? { text: `★ green ${ago(m.lastGreen.at, now)}`, color: 'success', drop: 2 }
    : { text: 'no green checkpoint yet', color: 'subtle', drop: 1 })
  if (m.guard.refused || m.guard.asked) {
    const g = [m.guard.refused ? `${m.guard.refused} refused` : '', m.guard.asked ? `${m.guard.asked} asked` : ''].filter(Boolean).join(', ')
    parts.push({ text: `⛨ ${g}`, color: m.guard.refused ? 'error' : 'warning', drop: 0 })
  }
  // Room for the two buttons ("[ Details ] [ Hide ]") and the separators.
  const room = Math.max(20, columns - 22)
  const width = () => parts.reduce((n, p) => n + p.text.length, 0) + (parts.length - 1) * 3
  while (width() > room && parts.length > 2) {
    const lowest = parts.reduce((a, b) => (b.drop < a.drop ? b : a))
    parts.splice(parts.indexOf(lowest), 1)
  }
  return parts.map(({ text, color, bold }) => ({ text, color, bold }))
}

// ---------------------------------------------------------------- running keel

/** The command that runs this plugin's own Keel: node with the script, or the compiled program. */
async function keelArgv($: any): Promise<string[]> {
  const root: string = $.plugin.root
  const script = `${root}/bin/keel.mjs`
  try {
    await $.fs.stat(script)
    return ['node', script]
  } catch {
    try {
      await $.fs.stat(`${root}/bin/keel.exe`)
      return [`${root}/bin/keel.exe`]
    } catch {
      return [`${root}/bin/keel`]
    }
  }
}

/** Runs `keel <args>` in the project; resolves its output, or the error's words. */
async function runKeel($: any, args: string[], timeoutMs = 30000): Promise<{ ok: boolean; text: string }> {
  try {
    const cwd: string = await $.session.root()
    const r = await $.process.run([...(await keelArgv($)), ...args], { cwd, timeoutMs })
    return { ok: r.exitCode === 0, text: String(r.stdout || r.stderr || '').trim() }
  } catch (err) {
    return { ok: false, text: `Keel could not run: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** Fetches the summary and stores it; resolves the previous and new verdicts. */
async function refresh($: any): Promise<{ before: string | null; after: string | null }> {
  const before = (await read($, model))?.verdict.value ?? null
  const cwd: string = await $.session.root()
  const r = await runKeel($, ['ui', cwd])
  let next: KeelModel | null = null
  try {
    const parsed = JSON.parse(r.text.split('\n').pop() || 'null')
    if (parsed && parsed.v === 1 && !parsed.error) next = parsed
  } catch { next = null }
  if (next) {
    await update($, model, () => next)
    $.ui.status(statusText(next))
  }
  return { before, after: next?.verdict.value ?? before }
}

/** The status line entry: "⚓ ✔ verified · small 41%". */
export function statusText(m: KeelModel): string | undefined {
  if (!m.prompts) return undefined
  const v = verdictLook(m.verdict.value)
  const budget = m.task ? ` · ${m.task.size} ${budgetLabel(m.task.fraction)}` : ''
  return `⚓ ${v.glyph} ${v.label.toLowerCase()}${budget}`
}

// ---------------------------------------------------------------- the module

/** When the summary needs fetching again; a module reload starts these over. */
const flags = { dirty: true, afterTurn: false, running: false }

async function openPane($: any, page: KeelView = 'overview') {
  await update($, view, () => page)
  await $.ui.open({ id: PANE, title: 'Keel', focus: true, closeOnEscape: true })
}

/** Runs a Keel command for a pane page, showing a busy line while it runs. */
async function act($: any, label: string, args: string[], page: KeelView, timeoutMs?: number) {
  await update($, busy, () => label)
  await update($, view, () => page)
  const r = await runKeel($, args, timeoutMs)
  await update($, output, () => r.text || (r.ok ? 'Done.' : 'Keel printed nothing.'))
  await update($, busy, () => null)
  flags.dirty = true
}

/** The background refresh: fetches when something changed, and toasts a changed verdict after a prompt. */
async function tick($: any) {
  if (!flags.dirty || flags.running) return
  flags.dirty = false
  flags.running = true
  try {
    const { before, after } = await refresh($)
    if (flags.afterTurn && after && before && after !== before) {
      const v = verdictLook(after)
      $.ui.toast(`Keel: ${v.label.toLowerCase()}${after === 'verified' ? ', the checks passed' : after === 'failed' ? '. Open /keel for details' : ''}`)
    }
    flags.afterTurn = false
  } finally {
    flags.running = false
  }
}

async function refreshNow($: any) {
  flags.dirty = true
  await tick($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'keel', description: 'Open Keel: the verdict, budget, changes and guard for this session' })
    // Refresh in the background whenever something changed, never inside a tool call.
    $.clock.every(2000, () => { void tick($) })
    return next(e)
  })

  on('command.run', { command: 'keel' }, async $ => {
    // Open on current data.
    await refreshNow($)
    await openPane($)
    return { text: 'Keel pane opened.' }
  })

  // Only notes that something changed; a failure here must never stop a tool.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (CHANGING_TOOLS.has(String(e.tool))) flags.dirty = true
    return result
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    flags.dirty = true
    flags.afterTurn = true
    return next(e)
  })

  // ------------------------------------------------------------ the strip

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const m = await read($, model)
    if (!m || !m.prompts || e.props.hasSurvey || (await read($, bandHidden))) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const parts = stripParts(m, e.props.bodyColumns, Date.now())
    return (
      <Box flexDirection="row" justifyContent="space-between" width="100%">
        <Box flexDirection="row" flexShrink={1}>
          {parts.map((p, i) => (
            <Text key={`p${i}`} wrap="truncate-end">
              {i > 0 ? <Text color="subtle"> · </Text> : null}
              <Text color={p.color} weight={p.bold ? 'semibold' : undefined}>{p.text}</Text>
            </Text>
          ))}
        </Box>
        <Box flexDirection="row" gap={1} flexShrink={0}>
          <Button key="details" label="Details" onPress={() => openPane($)} />
          <Button key="hide" label="Hide" onPress={() => update($, bandHidden, () => true)} />
        </Box>
      </Box>
    )
  })

  // ------------------------------------------------------------ the pane

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const m = await read($, model)
    const page = await read($, view)
    const working = await read($, busy)
    const text = await read($, output)
    const hidden = await read($, bandHidden)
    const cols = Math.max(30, e.props.bodyColumns)
    const now = Date.now()

    const heading = (title: string, note?: string) => (
      <Box flexDirection="row" justifyContent="space-between" marginTop={1}>
        <Text weight="semibold">{title}</Text>
        {note ? <Text color="subtle">{note}</Text> : null}
      </Box>
    )
    const row = (key: string, left: any, right?: string, color?: string) => (
      <Box key={key} flexDirection="row" justifyContent="space-between" width="100%">
        <Box flexShrink={1}><Text color={color} wrap="truncate-end">{left}</Text></Box>
        {right ? <Box flexShrink={0} marginLeft={1}><Text color="subtle" tabular>{right}</Text></Box> : null}
      </Box>
    )

    const header = (
      <Box flexDirection="row" justifyContent="space-between" width="100%">
        <Text>
          <Text color="claude" weight="bold">⚓ Keel</Text>
          {m ? <Text color="subtle">{`  ${m.project.name}${m.prompts ? ` · ${m.prompts} ${m.prompts === 1 ? 'prompt' : 'prompts'}` : ''}`}</Text> : null}
        </Text>
        <Box flexDirection="row" gap={1}>
          <Button key="refresh" label="Refresh" onPress={() => refreshNow($)} />
          <Button key="close" label="Close" role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
        </Box>
      </Box>
    )

    if (working) {
      return (
        <Box flexDirection="column">
          {header}
          <Box marginTop={1}><Text color="claude">{`◐ ${working}…`}</Text></Box>
          <Text color="subtle">This can take a moment. You can keep working.</Text>
        </Box>
      )
    }

    // Pages that show a command's result.
    if (page !== 'overview' && text) {
      const lines = text.split('\n').slice(0, Math.max(6, (e.viewport?.rows ?? 30) - 8))
      const titles: Record<string, string> = {
        'undo-preview': 'Undo preview: nothing has changed yet',
        'undo-done': 'Undo result',
        receipt: 'Session receipt',
        checks: 'Checks',
      }
      const refused = /No files changed|ambiguous|requires manual review/i.test(text)
      return (
        <Box flexDirection="column">
          {header}
          {heading(titles[page] || 'Keel')}
          <Box flexDirection="column" marginTop={1}>
            {lines.map((l, i) => <Text key={`l${i}`} wrap="wrap">{l || ' '}</Text>)}
          </Box>
          <Box flexDirection="row" gap={1} marginTop={1}>
            {page === 'undo-preview' && !refused && m?.session ? (
              <Button key="apply" label="Undo these changes" variant="primary"
                onPress={() => act($, 'Undoing this session’s changes', ['revert', '--session', m.session as string], 'undo-done')} />
            ) : null}
            {page === 'undo-done' && !refused ? (
              <Button key="putback" label="Put the files back"
                onPress={() => act($, 'Putting the files back', ['revert', 'undo'], 'undo-done')} />
            ) : null}
            <Button key="back" label="Back" onPress={() => update($, view, () => 'overview')} />
          </Box>
        </Box>
      )
    }

    if (!m || !m.prompts) {
      return (
        <Box flexDirection="column">
          {header}
          <Box marginTop={1}><Text>Keel has nothing to show for this project yet.</Text></Box>
          <Text color="subtle" wrap="wrap">Send a prompt and Keel starts recording: a checkpoint for each prompt, the guard's decisions, and a verdict when Claude says it is done.</Text>
        </Box>
      )
    }

    const v = verdictLook(m.verdict.value)
    const when = m.verdict.at ? `${m.verdict.source === 'verify' ? 'checked' : 'after a prompt'} ${ago(m.verdict.at, now)}` : ''
    const barWidth = Math.max(10, Math.min(30, cols - 26))

    return (
      <Box flexDirection="column">
        {header}

        {heading('Verdict', when)}
        <Text color={v.color} weight="bold">{`${v.glyph} ${v.label}`}</Text>
        {m.verdict.checks.map(c => (
          row(`c-${c.id}`, `  ${c.verdict === 'verified' ? '✔' : c.verdict === 'failed' ? '✖' : '◌'} ${c.id}`,
            c.total != null ? `${c.passed ?? 0}/${c.total} passed${c.failed ? `, ${c.failed} failed` : ''}${c.skipped ? `, ${c.skipped} skipped` : ''}` : c.verdict.replace('_', ' '),
            c.verdict === 'failed' ? 'error' : undefined)
        ))}
        {m.verdict.value !== 'verified'
          ? m.verdict.reasons.slice(0, 3).map((r, i) => <Text key={`r${i}`} color="subtle" wrap="wrap">{`  · ${r}`}</Text>)
          : null}
        <Box flexDirection="row" marginTop={1}>
          <Button key="verify" label="Run the checks now"
            onPress={() => act($, 'Running the project’s checks', ['verify'], 'checks', 600000)} />
        </Box>

        {heading('Budget', m.task ? `prompt ${m.task.prompt} · ${m.task.size} task` : undefined)}
        {m.task ? (
          <Box flexDirection="column">
            <Text>
              <Text color={budgetColor(m.task.fraction)}>{bar(m.task.fraction, barWidth)}</Text>
              <Text weight="semibold" tabular>{`  ${budgetLabel(m.task.fraction)}`}</Text>
            </Text>
            <Text color="subtle">{`${compact(m.task.used)} of ${compact(m.task.budget)} ${m.task.unit === 'weighted' ? 'budget units' : 'new tokens'}${m.task.unit === 'weighted' && m.task.newTokens != null ? ` · ${compact(m.task.newTokens)} new tokens` : ''}`}</Text>
          </Box>
        ) : <Text color="subtle">No task is running.</Text>}

        {heading('Prompts', m.lastGreen ? `last green: prompt ${m.lastGreen.prompt ?? '?'}` : 'no green checkpoint yet')}
        {m.timeline.slice(0, 6).map((t, i) => {
          const look = t.kind === 'green' ? { g: '★', c: 'success' } : t.kind === 'failed' ? { g: '✖', c: 'error' } : t.kind === 'blocked' ? { g: '↺', c: 'warning' } : { g: '●', c: 'subtle' }
          return (
            <Box key={`t${i}`} flexDirection="row" justifyContent="space-between" width="100%">
              <Box flexShrink={1}>
                <Text wrap="truncate-end">
                  <Text color={look.c}>{`${look.g} `}</Text>
                  <Text tabular>{`Prompt ${t.prompt ?? '?'}`}</Text>
                  <Text color="subtle">{`  ${t.summary}`}</Text>
                </Text>
              </Box>
              <Box flexShrink={0} marginLeft={1}><Text color="subtle">{ago(t.at, now)}</Text></Box>
            </Box>
          )
        })}

        {heading('Changed this session', m.changes.length ? `${m.changes.length} ${m.changes.length === 1 ? 'file' : 'files'}` : undefined)}
        {m.changes.length === 0 ? <Text color="subtle">No files changed yet.</Text> : null}
        {m.changes.slice(0, 8).map(f => (
          <Box key={`f-${f.path}`} flexDirection="row" justifyContent="space-between" width="100%">
            <Box flexShrink={1}>
              <Text wrap="truncate-start">
                <Text color={f.status === 'A' ? 'diffAdded' : f.status === 'D' ? 'diffRemoved' : 'warning'} weight="semibold">{`${f.status} `}</Text>
                <Text>{f.path}</Text>
              </Text>
            </Box>
            <Box flexShrink={0} marginLeft={1}>
              <Text tabular>
                <Text color="diffAdded">{`+${f.added}`}</Text>
                <Text color="diffRemoved">{` −${f.removed}`}</Text>
              </Text>
            </Box>
          </Box>
        ))}
        {m.changes.length > 8 ? <Text color="subtle">{`  and ${m.changes.length - 8} more`}</Text> : null}
        {m.changes.length ? (
          <Box flexDirection="row" marginTop={1}>
            <Button key="preview" label="Preview undo"
              onPress={() => act($, 'Working out what an undo would change', ['revert', '--session', m.session as string, '--dry-run'], 'undo-preview')} />
          </Box>
        ) : null}

        {heading('Guard', `${m.guard.mode} mode`)}
        {!m.guard.refused && !m.guard.asked ? <Text color="subtle">Nothing refused or asked about this session.</Text> : (
          <Text color="subtle">{`${m.guard.refused} refused · ${m.guard.asked} asked about`}</Text>
        )}
        {m.guard.recent.slice(0, 4).map((g, i) => (
          <Box key={`g${i}`} flexDirection="row" width="100%">
            <Box flexShrink={0}><Text color={g.decision === 'refuse' ? 'error' : 'warning'}>{g.decision === 'refuse' ? '  ✖ refused ' : '  ? asked   '}</Text></Box>
            <Box flexShrink={1}><Text wrap="truncate-end" color="subtle">{`${g.rule}: ${g.what}`}</Text></Box>
          </Box>
        ))}

        <Box flexDirection="row" gap={1} marginTop={1}>
          <Button key="receipt" label="Session receipt" onPress={() => act($, 'Writing the receipt', ['receipt'], 'receipt')} />
          <Button key="strip" label={hidden ? 'Show the strip' : 'Hide the strip'} onPress={() => update($, bandHidden, h => !h)} />
        </Box>
      </Box>
    )
  })
}
