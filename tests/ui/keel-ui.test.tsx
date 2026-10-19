import { describe, expect, test } from 'claude-code/testing'

import type { KeelModel } from '../../types'
import { ago, bar, budgetColor, budgetLabel, compact, statusText, stripParts, verdictLook } from '../../hooks/keel-ui'

const NOW = Date.parse('2026-10-20T12:00:00Z')

const SAMPLE: KeelModel = {
  v: 1,
  project: { name: 'shop', root: '/work/shop' },
  session: 's1',
  prompts: 3,
  verdict: {
    value: 'verified',
    reasons: [],
    checks: [{ id: 'unit', verdict: 'verified', passed: 12, total: 12, failed: 0, skipped: 0 }],
    at: '2026-10-20T11:57:00Z',
    source: 'turn',
  },
  task: { prompt: 3, size: 'small', fraction: 0.41, used: 36900, budget: 90000, unit: 'weighted', newTokens: 12000 },
  lastGreen: { prompt: 3, at: '2026-10-20T11:57:00Z' },
  timeline: [
    { prompt: 3, at: '2026-10-20T11:57:00Z', kind: 'green', files: 2, summary: 'Checks passed' },
    { prompt: 2, at: '2026-10-20T11:40:00Z', kind: 'blocked', files: 1, summary: 'Sent back: a claim had no evidence' },
  ],
  changes: [
    { path: 'src/cart.mjs', status: 'M', added: 4, removed: 1 },
    { path: 'test/cart.test.mjs', status: 'A', added: 18, removed: 0 },
  ],
  guard: { mode: 'beginner', refused: 1, asked: 1, recent: [{ decision: 'refuse', rule: 'delete-home', what: 'rm -rf ~', at: '2026-10-20T11:30:00Z' }] },
  catches: { claims: 1, loops: 0 },
  learn: 'on',
}

const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 120 } as any
const PANE_PROPS = { title: 'Keel', isFocused: true, bodyColumns: 80, placement: 'dock' } as any
const SURFACES = ['terminal', 'desktop', 'vscode'] as const

describe('formatting', () => {
  test('ages, token counts and bars read plainly', () => {
    expect(ago('2026-10-20T11:59:50Z', NOW)).toBe('just now')
    expect(ago('2026-10-20T11:57:00Z', NOW)).toBe('3m ago')
    expect(ago('2026-10-20T09:00:00Z', NOW)).toBe('3h ago')
    expect(ago('2026-10-19T09:00:00Z', NOW)).toBe('yesterday')
    expect(compact(950)).toBe('950')
    expect(compact(36900)).toBe('37k')
    expect(compact(1263631)).toBe('1.3M')
    expect(bar(0.5, 10)).toBe('█████░░░░░')
    expect(bar(3, 4)).toBe('████')
  })

  test('each verdict and budget level has its own look', () => {
    expect(verdictLook('verified')).toEqual({ glyph: '✔', label: 'Verified', color: 'success' })
    expect(verdictLook('failed').color).toBe('error')
    expect(verdictLook('not_verified').label).toBe('Not verified')
    expect([budgetColor(0.4), budgetColor(0.8), budgetColor(1.2)]).toEqual(['subtle', 'warning', 'error'])
    expect(statusText(SAMPLE)).toBe('⚓ ✔ verified · small 41%')
    expect(statusText({ ...SAMPLE, prompts: 0 })).toBe(undefined)
    expect([0.41, 1.4, 62.73].map(budgetLabel)).toEqual(['41%', '140%', '63× budget'])
  })

  test('the strip drops its least important parts first when the window is narrow', () => {
    const wide = stripParts(SAMPLE, 140, NOW).map(p => p.text)
    expect(wide.length).toBe(5)
    expect(wide[1]).toBe('✔ Verified')
    const narrow = stripParts(SAMPLE, 50, NOW).map(p => p.text)
    expect(narrow[0]).toBe('⚓ Keel')
    expect(narrow[1]).toBe('✔ Verified')
    expect(narrow.length).toBeLessThan(wide.length)
    expect(narrow.some(t => t.startsWith('⛨'))).toBe(false)
  })
})

/**
 * Stands in for the host beneath the plugin: `keel ui --json` answers the
 * sample, so the module fills its state through its real refresh path.
 * @returns the commands the module ran
 */
function host(on: any, model: KeelModel | null = SAMPLE): string[][] {
  const ran: string[][] = []
  on('session.root', () => ({ value: '/work/shop' }))
  on('fs.stat', (_$: any, e: any) => (String(e.path).endsWith('keel.mjs') ? { value: { kind: 'file', size: 1 } } : { deny: 'missing' }))
  on('process.run', (_$: any, e: any) => {
    ran.push([...e.argv])
    const isUi = e.argv.includes('ui')
    return { value: { exitCode: 0, stdout: isUi ? JSON.stringify(model) : 'preview: 2 files would change', stderr: '' } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('command.register', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  // Claude Code's own drawing above the prompt, where Keel's strip steps aside.
  on('ui.render', { component: 'AbovePrompt' }, (_$: any, e: any) => {
    const { Text } = _$.ui.resolve(e)
    return <Text key="engine">engine</Text>
  })
  return ran
}

describe('drawing', () => {
  for (const surface of SURFACES) {
    test(`the strip and the pane draw on ${surface}`, async ($, on) => {
      const ran = host(on)
      await $.command.run({ command: 'keel', args: '' } as any)
      expect(ran[0]?.slice(0, 1)).toEqual(['node'])
      expect(ran[0]).toContain('ui')

      const band = await $.ui.mount({ plugin: 'keel', surface, component: 'AbovePrompt', props: BAND_PROPS })
      expect(await band.find({ text: /Verified/ })).toBeTruthy()
      expect(await band.find({ type: 'Button', key: 'details' })).toBeTruthy()

      const pane = await $.ui.mount({ plugin: 'keel', surface, component: 'Pane', requestId: 'keel', props: PANE_PROPS })
      for (const text of [/Verdict/, /12\/12 passed/, /Budget/, /src\/cart\.mjs/, /\+18/, /Prompt 3/, /delete-home/]) {
        expect(await pane.find({ text })).toBeTruthy()
      }
      expect(await pane.find({ type: 'Button', key: 'preview' })).toBeTruthy()
      expect(await pane.find({ type: 'Button', key: 'apply' })).toBe(undefined)
    })
  }

  test('hiding the strip leaves the space above the prompt to Claude Code', async ($, on) => {
    host(on)
    await $.command.run({ command: 'keel', args: '' } as any)
    const band = await $.ui.mount({ plugin: 'keel', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    await band.press({ key: 'hide' })
    expect(await band.find({ type: 'Button', key: 'details' })).toBe(undefined)
    expect(await band.find({ text: 'engine' })).toBeTruthy()
  })

  test('undo is a preview first: nothing changes until the person presses Undo these changes', async ($, on) => {
    const ran = host(on)
    await $.command.run({ command: 'keel', args: '' } as any)
    const pane = await $.ui.mount({ plugin: 'keel', surface: 'desktop', component: 'Pane', requestId: 'keel', props: PANE_PROPS })
    await pane.press({ key: 'preview' })
    expect(ran.at(-1)?.slice(2)).toEqual(['revert', '--session', 's1', '--dry-run'])
    expect(await pane.find({ text: /Undo preview: nothing has changed yet/ })).toBeTruthy()
    expect(await pane.find({ text: /2 files would change/ })).toBeTruthy()
    expect(ran.some(a => a.includes('revert') && !a.includes('--dry-run'))).toBe(false)
    await pane.press({ key: 'apply' })
    expect(ran.at(-1)?.slice(2)).toEqual(['revert', '--session', 's1'])
  })

  test('with no records yet, the pane says how Keel starts', async ($, on) => {
    host(on, { ...SAMPLE, prompts: 0 })
    const pane = await $.ui.mount({ plugin: 'keel', surface: 'desktop', component: 'Pane', requestId: 'keel', props: PANE_PROPS })
    expect(await pane.find({ text: /nothing to show for this project yet/ })).toBeTruthy()
  })
})
