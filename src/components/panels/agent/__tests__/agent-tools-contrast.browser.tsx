import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import '../../../../index.css'
import '../../../../styles/agent-tools.css'

let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(() => container.remove())

describe('Agent tool information text contrast', () => {
  it.each([
    ['light', 'rgb(11, 98, 91)', 'rgb(180, 35, 24)', 'rgb(181, 71, 8)', 'rgb(26, 26, 26)', 'rgb(15, 118, 110)', 'rgb(217, 45, 32)', 'rgb(181, 71, 8)', 'rgb(255, 255, 255)'],
    ['dark', 'rgb(110, 231, 183)', 'rgb(255, 143, 133)', 'rgb(253, 176, 34)', 'rgb(247, 248, 248)', 'rgb(110, 231, 183)', 'rgb(255, 143, 133)', 'rgb(253, 176, 34)', 'rgb(8, 9, 10)'],
  ])('uses readable semantic copy while retaining decorative status icons in %s', (theme, successText, errorText, warningText, ordinaryText, successDecoration, errorDecoration, warningDecoration, successForeground) => {
    container.className = theme
    container.innerHTML = `
      <div class="tool-call-header">
        <span class="tool-call-source-badge builtin">Built-in</span>
        <span class="tool-call-source-badge mcp">MCP</span>
        <span class="tool-call-source-badge skill">Skill</span>
        <div class="tool-call-status"><svg class="tool-call-status completed"></svg><span>Completed</span></div>
        <div class="tool-call-status"><svg class="tool-call-status failed"></svg><span>Failed</span></div>
        <div class="tool-call-status"><svg class="tool-call-status waiting_confirm"></svg><span>Waiting</span></div>
        <button class="confirm-card-btn approve">Approve</button>
      </div>
    `

    const color = (selector: string) => getComputedStyle(container.querySelector(selector)!).color
    expect([
      color('.tool-call-source-badge.builtin'),
      color('.tool-call-source-badge.mcp'),
      color('.tool-call-source-badge.skill'),
      color('.tool-call-status:has(> .completed) > span'),
      color('.tool-call-status:has(> .failed) > span'),
      color('.tool-call-status:has(> .waiting_confirm) > span'),
      color('svg.completed'),
      color('svg.failed'),
      color('svg.waiting_confirm'),
      color('.confirm-card-btn.approve'),
    ]).toEqual([
      ordinaryText, ordinaryText, successText, successText, errorText, warningText,
      successDecoration, errorDecoration, warningDecoration, successForeground,
    ])
  })
})
