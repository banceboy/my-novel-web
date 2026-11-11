import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import postcss, { type Declaration, type Rule } from 'postcss'
import { describe, expect, it } from 'vitest'

const cssPath = resolve(process.cwd(), 'src/index.css')
const css = readFileSync(cssPath, 'utf8')
const root = postcss.parse(css, { from: cssPath })

const approvedPalette = {
  '--color-bg': '#F9F9F8',
  '--color-sidebar': '#F1F1F0',
  '--color-panel': '#F1F1F0',
  '--color-hover': '#E9E9E7',
  '--color-active': '#E0E0DE',
  '--color-text': '#1A1A1A',
  '--color-text-secondary': '#454545',
  '--color-text-muted': '#5F5F5F',
  '--color-border': '#E4E4E2',
  '--color-accent': '#5E6AD2',
  '--color-editor-bg': '#FFFFFF',
}

function declarationsFor(selector: string) {
  const declarations: Record<string, string> = {}
  root.walkRules((rule: Rule) => {
    if (!rule.selectors.includes(selector)) return
    rule.walkDecls((declaration: Declaration) => {
      if (declaration.prop.startsWith('--')) declarations[declaration.prop] = declaration.value
    })
  })
  return declarations
}

describe('runtime CSS token authority', () => {
  it('does not expose a second hand-copied TypeScript color-token source', () => {
    expect(existsSync(resolve(process.cwd(), 'src/tokens/index.ts'))).toBe(false)
  })

  it('defines the light palette once on :root', () => {
    const paperPaletteRules: Array<{ selectors: string[]; declarations: Record<string, string> }> = []
    root.walkRules((rule: Rule) => {
      if (!rule.selectors.includes(':root')) return

      const declarations = Object.fromEntries(
        rule.nodes
          .filter((node): node is Declaration => node.type === 'decl' && node.prop in approvedPalette)
          .map(declaration => [declaration.prop, declaration.value]),
      )
      if (Object.keys(declarations).length > 0) paperPaletteRules.push({ selectors: rule.selectors, declarations })
    })

    expect(paperPaletteRules).toEqual([
      {
        selectors: [':root'],
        declarations: approvedPalette,
      },
    ])
  })

  it.each([
    [':root', approvedPalette],
    ['.dark', {
      '--color-bg': '#08090A',
      '--color-sidebar': '#0F1011',
      '--color-panel': '#0F1011',
      '--color-hover': '#17181A',
      '--color-active': '#1C1D1F',
      '--color-text': '#F7F8F8',
      '--color-text-secondary': '#C7CBD1',
      '--color-text-muted': '#8A8F98',
      '--color-border': '#26272A',
      '--color-accent': '#5E6AD2',
      '--color-editor-bg': '#0F1011',
    }],
  ])('locks the approved %s runtime palette', (selector, expected) => {
    expect(declarationsFor(selector)).toMatchObject(expected)
  })
})

describe('retired themes and image skins', () => {
  it('keeps only the light and dark palettes, with no writer aliases or skin overrides', () => {
    const selectors: string[] = []
    const writerAliases: string[] = []
    root.walkRules((rule: Rule) => {
      selectors.push(...rule.selectors)
      rule.walkDecls((declaration: Declaration) => {
        if (declaration.prop.startsWith('--writer-') || declaration.prop.startsWith('--skin-')) writerAliases.push(declaration.prop)
      })
    })
    expect(selectors.filter(selector => /\.galaxy|\.paper\b|\.light\b|app-skin|data-skin/.test(selector))).toEqual([])
    expect(writerAliases).toEqual([])
  })
})

describe('relationship role semantics', () => {
  it('defines the approved role identity colors once for both themes', () => {
    const roleRules: Array<{ selectors: string[]; declarations: Record<string, string> }> = []
    root.walkRules((rule: Rule) => {
      const declarations = Object.fromEntries(
        rule.nodes
          .filter((node): node is Declaration => node.type === 'decl' && node.prop.startsWith('--color-role-'))
          .map(declaration => [declaration.prop, declaration.value]),
      )
      if (Object.keys(declarations).length > 0) roleRules.push({ selectors: rule.selectors, declarations })
    })

    expect(roleRules).toEqual([{
      selectors: [':root'],
      declarations: {
        '--color-role-protagonist': '#5E6AD2',
        '--color-role-antagonist': '#D92D20',
        '--color-role-supporting': '#0F766E',
        '--color-role-minor': '#64748B',
      },
    }])
  })
})

describe('Storybook token documentation', () => {
  it('renders every theme from runtime CSS variables without a hand-copied palette', () => {
    const story = readFileSync(resolve(process.cwd(), 'src/stories/Introduction.mdx'), 'utf8')

    expect(story).not.toMatch(/#[0-9a-f]{6}/i)
    expect(story).toContain("['light', 'dark'].map")
    expect(story).toContain('className={theme}')
    for (const token of [
      '--color-bg',
      '--color-text',
      '--color-accent',
      '--color-success',
      '--color-warning',
      '--color-error',
      '--color-info',
    ]) {
      expect(story).toContain(`var(${token})`)
    }
  })

  it('documents typography and radius through runtime semantic variables only', () => {
    const story = readFileSync(resolve(process.cwd(), 'src/stories/Introduction.mdx'), 'utf8')
    const fontSection = story.match(/### Font Families([\s\S]*?)### Type Scale/)?.[1]
    const radiusSection = story.match(/## Border Radius([\s\S]*?)## Components/)?.[1]

    expect(fontSection).toBeDefined()
    expect(radiusSection).toBeDefined()

    const documentedFontValues = [...(fontSection?.matchAll(/value:\s*'([^']+)'/g) ?? [])]
      .map(match => match[1])
    expect(documentedFontValues).toEqual([
      'var(--font-sans)',
      'var(--font-writing)',
      'var(--font-mono)',
    ])
    for (const token of ['--font-sans', '--font-writing', '--font-mono']) {
      expect(declarationsFor(':root')[token]).toBeDefined()
      expect(fontSection).toContain(`var(${token})`)
    }
    expect(fontSection).not.toMatch(/\b(?:Inter|Noto|LXGW|Fira Code|Consolas|system-ui|ui-monospace)\b/)
    expect(fontSection).not.toMatch(/fontFamily:\s*['"](?!var\(--font-)/)

    const documentedRadiusValues = [...(radiusSection?.matchAll(/value:\s*'([^']+)'/g) ?? [])]
      .map(match => match[1])
    expect(documentedRadiusValues).toEqual([
      'var(--radius-sm)',
      'var(--radius-md)',
      'var(--radius-lg)',
      'var(--radius-xl)',
      'var(--radius-2xl)',
    ])
    for (const token of ['--radius-sm', '--radius-md', '--radius-lg', '--radius-xl', '--radius-2xl']) {
      expect(declarationsFor(':root')[token]).toBeDefined()
      expect(radiusSection).toContain(`var(${token})`)
    }
    expect(radiusSection).not.toMatch(/\|\s*\d+(?:\.\d+)?(?:px|rem)\s*\|/)
    expect(radiusSection).not.toMatch(/border-?radius\s*[:=]\s*['"]?\d/i)
    expect(story).not.toMatch(/borderRadius:\s*['"]?\d/)
  })
})
