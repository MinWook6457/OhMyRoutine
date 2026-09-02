'use strict'

// 서버의 task_description 은 [{ text, children? }] 형태의 중첩 트리다.
// 앱에서는 "들여쓰기 2칸(Tab) = 한 단계" 규칙의 평문으로 편집한다.
//
// 글머리 기호는 깊이를 눈으로 보기 위한 편집기 표시일 뿐이고,
// 서버로 보낼 때는 떼어낸다. (원본 웹페이지도 불릿은 CSS 로 그리고
// text 에는 순수 내용만 담는다.)
// 마커는 routine 사이트의 list-style-type 과 동일하게 맞춘다.
//   .list-box          -> "* "
//   .list-box>li>ul    -> "- "
//   .list-box>ul>li>ul -> "• "
const INDENT = '  '
const MARKERS = ['*', '-', '•']
const MARKER_RE = /^[*\-·•∙‧]\s*/

function markerFor (depth) {
  return MARKERS[Math.min(Math.max(depth, 0), MARKERS.length - 1)]
}

/** 줄 앞의 들여쓰기로 깊이를 센다. */
function depthOf (line) {
  const lead = String(line ?? '').match(/^[\t ]*/)[0].replace(/\t/g, INDENT)
  return Math.floor(lead.length / INDENT.length)
}

/** 줄에서 들여쓰기와 글머리 기호를 떼어낸 알맹이. */
function bodyOf (line) {
  return String(line ?? '').trim().replace(MARKER_RE, '').trim()
}

/** 줄의 깊이를 delta 만큼 옮기고 그 깊이에 맞는 글머리 기호를 다시 붙인다. */
function shiftLine (line, delta) {
  const depth = Math.max(0, depthOf(line) + delta)
  return prefixFor(depth) + bodyOf(line)
}

function prefixFor (depth) {
  const level = Math.max(0, depth)
  return INDENT.repeat(level) + markerFor(level) + ' '
}

function treeToText (nodes, depth = 0) {
  if (!Array.isArray(nodes)) return ''
  const lines = []
  for (const node of nodes) {
    if (!node) continue
    lines.push(prefixFor(depth) + String(node.text ?? '').trim())
    if (Array.isArray(node.children) && node.children.length) {
      const sub = treeToText(node.children, depth + 1)
      if (sub) lines.push(sub)
    }
  }
  return lines.join('\n')
}

function textToTree (text) {
  const root = []
  const stack = [{ depth: -1, children: root }]

  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const body = bodyOf(raw)
    if (!body) continue // 빈 줄과 내용 없는 글머리 기호만 있는 줄은 버린다

    const wanted = depthOf(raw)
    while (stack.length > 1 && stack[stack.length - 1].depth >= wanted) stack.pop()

    const parent = stack[stack.length - 1]
    const node = { text: body, children: [] }
    parent.children.push(node)
    // 단계를 건너뛴 들여쓰기는 부모 바로 아래로 보정한다.
    stack.push({ depth: parent.depth + 1, children: node.children })
  }

  return prune(root)
}

function prune (nodes) {
  for (const node of nodes) {
    if (node.children && node.children.length) prune(node.children)
    else delete node.children
  }
  return nodes
}

/** 저장 여부 판단용 키. 글머리 기호/여백 차이는 무시하고 내용만 비교한다. */
function treeKey (value) {
  const tree = typeof value === 'string' ? textToTree(value) : prune(deepCopy(value))
  return JSON.stringify(tree)
}

function deepCopy (nodes) {
  if (!Array.isArray(nodes)) return []
  return nodes.map((node) => {
    const copy = { text: String((node && node.text) ?? '').trim() }
    if (node && Array.isArray(node.children) && node.children.length) {
      copy.children = deepCopy(node.children)
    }
    return copy
  })
}

// ------------------------------------------------------------ 상태 칸 (우측 셀)
//
// 우측 셀(task_status)은 트리가 아니라 좌측 업무 내용의 각 줄에
// 1:1 로 대응하는 평면 목록이다. 원본 페이지도 EditorReport 를
// _taskType="task_status" 로 한 번 더 띄우고 저장은 따로 POST 한다.
// 빈 줄은 서버가 &nbsp; 로 저장한다.
const BLANK = '&nbsp;'
const BLANK_RE = /&nbsp;|\u00a0/g

/** 내용 없는 칸인지. (&nbsp; 만 있는 줄 포함) */
function isBlankCell (text) {
  return String(text ?? '').replace(BLANK_RE, ' ').trim() === ''
}

/** 혹시 children 이 섞여 와도 문서 순서대로 펼친다. */
function flattenStatus (nodes, out = []) {
  if (!Array.isArray(nodes)) return out
  for (const node of nodes) {
    if (!node) continue
    out.push(isBlankCell(node.text) ? '' : String(node.text).trim())
    if (Array.isArray(node.children)) flattenStatus(node.children, out)
  }
  return out
}

/** 뒤쪽 빈 줄은 서버 데이터에도 없으므로 떼어낸다. */
function trimTrailing (lines) {
  const copy = lines.slice()
  while (copy.length && copy[copy.length - 1] === '') copy.pop()
  return copy
}

function statusToText (nodes) {
  if (typeof nodes === 'string') return nodes
  return trimTrailing(flattenStatus(nodes)).join('\n')
}

function textToStatus (text) {
  const lines = String(text ?? '').split(/\r?\n/).map((line) => line.trim())
  return trimTrailing(lines).map((line) => ({ text: line === '' ? BLANK : line }))
}

/** 저장 여부 판단용 키. */
function statusKey (value) {
  return JSON.stringify(textToStatus(statusToText(value)))
}

module.exports = {
  INDENT,
  MARKERS,
  markerFor,
  prefixFor,
  depthOf,
  bodyOf,
  shiftLine,
  treeToText,
  textToTree,
  treeKey,
  BLANK,
  isBlankCell,
  statusToText,
  textToStatus,
  statusKey
}
