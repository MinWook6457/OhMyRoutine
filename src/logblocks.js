'use strict'

/**
 * 평문 → Editor.js OutputData 변환.
 *
 * 아카이브 로그 본문은 Editor.js(2.28.2) 블록 JSON 이다. 앱에서는 평문으로 적고
 * 저장 직전에 블록으로 바꾼다. 웹 편집기가 인식하는 블록만 만든다.
 *
 *   빈 줄            블록 구분
 *   # 제목 / ## 제목  header (level 2 / 3)
 *   - 항목 / * 항목   list (unordered). 들여쓰기 2칸마다 하위 항목
 *   1. 항목          list (ordered)
 *   그 외             paragraph. 연속된 줄은 <br> 로 한 블록에 묶는다
 *
 * 텍스트는 HTML 로 해석되므로 < > & 를 이스케이프한다.
 */

const VERSION = '2.28.2'
const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

function blockId () {
  let id = ''
  for (let i = 0; i < 10; i += 1) id += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)]
  return id
}

function escapeHtml (text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const UNORDERED = /^(\s*)([-*•])\s+(.*)$/
const ORDERED = /^(\s*)\d+[.)]\s+(.*)$/
const HEADER = /^(#{1,3})\s+(.*)$/

function classify (line) {
  let m = HEADER.exec(line)
  if (m) return { kind: 'header', level: Math.min(m[1].length + 1, 4), text: m[2].trim() }
  m = UNORDERED.exec(line)
  if (m) return { kind: 'list', style: 'unordered', depth: Math.floor(m[1].length / 2), text: m[3].trim() }
  m = ORDERED.exec(line)
  if (m) return { kind: 'list', style: 'ordered', depth: Math.floor(m[1].length / 2), text: m[2].trim() }
  return { kind: 'paragraph', text: line.trim() }
}

/** 깊이 표시가 있는 항목 배열을 nested-list 형태 { content, items } 트리로 만든다. */
function nestItems (entries) {
  const root = []
  const stack = [{ depth: -1, items: root }]
  for (const entry of entries) {
    const node = { content: escapeHtml(entry.text), items: [] }
    while (stack.length > 1 && stack[stack.length - 1].depth >= entry.depth) stack.pop()
    stack[stack.length - 1].items.push(node)
    stack.push({ depth: entry.depth, items: node.items })
  }
  return root
}

function textToBlocks (text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n')
  const blocks = []

  let paragraph = []
  let list = null // { style, entries: [] }

  const flushParagraph = () => {
    if (!paragraph.length) return
    blocks.push({
      id: blockId(),
      type: 'paragraph',
      data: { text: paragraph.map(escapeHtml).join('<br>') }
    })
    paragraph = []
  }
  const flushList = () => {
    if (!list) return
    blocks.push({
      id: blockId(),
      type: 'list',
      data: { style: list.style, items: nestItems(list.entries) }
    })
    list = null
  }

  for (const raw of lines) {
    if (raw.trim() === '') {
      flushParagraph()
      flushList()
      continue
    }
    const item = classify(raw)

    if (item.kind === 'header') {
      flushParagraph()
      flushList()
      blocks.push({ id: blockId(), type: 'header', data: { text: escapeHtml(item.text), level: item.level } })
    } else if (item.kind === 'list') {
      flushParagraph()
      if (list && list.style !== item.style) flushList()
      if (!list) list = { style: item.style, entries: [] }
      list.entries.push({ depth: item.depth, text: item.text })
    } else {
      flushList()
      paragraph.push(item.text)
    }
  }
  flushParagraph()
  flushList()

  return { time: Date.now(), blocks, version: VERSION }
}

/** 실제로 내용이 있는지 (공백만 있는 본문은 저장하지 않게) */
function hasContent (text) {
  return String(text || '').trim() !== ''
}

module.exports = { textToBlocks, hasContent, VERSION }
