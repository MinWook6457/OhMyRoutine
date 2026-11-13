'use strict'

const DAY_NAMES = ['월', '화', '수', '목', '금']
const AUTOSAVE_DELAY = 800

// 우측 상태 칸에 Ctrl+1..4 로 바로 찍는 값. 부서에서 실제로 쓰는 표현이다.
const STATUS_PRESETS = ['진행중', '진행대기', '완료', '작업대기']

const state = {
  monday: mondayOf(new Date()),
  department: 'bs',
  widget: false,
  view: 'week',      // 'week' = 월~금 전체, 'today' = 오늘 하루만, 'log' = 아카이브 로그 작성, 'team' = 팀 보기, 'car' = 차량 예약 달력
  logProject: '',    // 로그 패널에서 마지막으로 고른 프로젝트
  logMode: 'write',  // 로그 패널 'write' = 새 로그 작성, 'browse' = 프로젝트 로그 검색
  days: [],          // 아래 makeDay() 가 만드는 모양
  loading: false,
  notice: [],        // 이번 주 공지 (문자열 배열)
  team: { rows: [], myPk: null, selected: null }   // 부서 응답의 구성원 행 전체와 팀 보기에서 고른 user_pk
}

// 단축키 표기. macOS 는 Cmd(⌘), 그 외는 Ctrl. 실제 판정은 ctrlKey || metaKey 로 둘 다 받는다.
const MOD = window.api.isMac ? '⌘' : 'Ctrl'

const el = {
  days: document.getElementById('days'),
  weekTitle: document.getElementById('weekTitle'),
  weekRange: document.getElementById('weekRange'),
  status: document.getElementById('status'),
  department: document.getElementById('department'),
  overlay: document.getElementById('overlay'),
  overlayText: document.getElementById('overlayText'),
  overlayAction: document.getElementById('overlayAction'),
  notice: document.getElementById('notice'),
  noticeText: document.getElementById('noticeText'),
  teamPanel: document.getElementById('teamPanel'),
  teamList: document.getElementById('teamList'),
  teamDays: document.getElementById('teamDays'),
  updateToast: document.getElementById('updateToast'),
  updateTitle: document.getElementById('updateTitle'),
  updateText: document.getElementById('updateText'),
  updateAction: document.getElementById('updateAction'),
  updateDismiss: document.getElementById('updateDismiss')
}

// ------------------------------------------------------------ 날짜 유틸

function mondayOf (date) {
  const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const day = copy.getDay()            // 0=일요일
  copy.setDate(copy.getDate() + (day === 0 ? -6 : 1 - day))
  return toISO(copy)
}

function toISO (date) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function addDays (iso, days) {
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  date.setDate(date.getDate() + days)
  return toISO(date)
}

function fromISO (iso) {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/**
 * '오늘' 모드에서 보여줄 날짜.
 * 주말에는 해당 주의 금요일을 보여준다 (월~금만 편집 대상이므로).
 */
function focusDate () {
  const now = new Date()
  const dow = now.getDay()
  if (dow >= 1 && dow <= 5) return toISO(now)
  return addDays(mondayOf(now), 4)
}

function weekOfMonth (iso) {
  const [y, m, d] = iso.split('-').map(Number)
  const first = new Date(y, m - 1, 1)
  while (first.getDay() !== 1) first.setDate(first.getDate() + 1)
  return { month: m, week: Math.ceil((d - first.getDate() + 1) / 7) }
}

// ------------------------------------------------------------ 편집기 동작

/** 선택된 줄들의 깊이를 옮기고 글머리 기호를 다시 붙인다. */
function shiftSelection (editor, delta) {
  const start = editor.selectionStart
  const end = editor.selectionEnd
  const value = editor.value

  const lineStart = value.lastIndexOf('\n', start - 1) + 1
  let lineEnd = value.indexOf('\n', end)
  if (lineEnd === -1) lineEnd = value.length

  const before = value.slice(lineStart, lineEnd)
  const changed = before
    .split('\n')
    .map((line) => window.api.shiftLine(line, delta))
    .join('\n')

  if (changed === before) return

  editor.setRangeText(changed, lineStart, lineEnd, 'end')

  // 커서만 있던 경우 원래 타이핑하던 위치를 유지한다.
  if (start === end) {
    const diff = changed.length - before.length
    const position = Math.min(Math.max(lineStart, start + diff), editor.value.length)
    editor.selectionStart = editor.selectionEnd = position
  }
}

/** 줄바꿈 시 같은 깊이의 글머리 기호를 자동으로 붙인다. */
function insertNewLine (editor) {
  const start = editor.selectionStart
  const end = editor.selectionEnd
  const lineStart = editor.value.lastIndexOf('\n', start - 1) + 1
  const depth = window.api.depthOf(editor.value.slice(lineStart, start))
  editor.setRangeText('\n' + window.api.prefixFor(depth), start, end, 'end')
}

/**
 * 커서가 놓인 줄 하나를 통째로 바꾼다.
 * 상태 칸은 줄마다 값이 하나뿐이라 프리셋을 이렇게 덮어쓴다.
 */
function replaceCurrentLine (editor, text) {
  const value = editor.value
  const lineStart = value.lastIndexOf('\n', editor.selectionStart - 1) + 1
  let lineEnd = value.indexOf('\n', editor.selectionStart)
  if (lineEnd === -1) lineEnd = value.length
  editor.setRangeText(text, lineStart, lineEnd, 'end')
}

/**
 * 좌우 칸의 줄이 어긋나 보이지 않게 세로 스크롤을 붙여둔다.
 * 두 칸 모두 white-space: pre 라 한 줄이 한 줄로 그려진다.
 */
function linkScroll (a, b) {
  let syncing = false
  const bind = (from, to) => from.addEventListener('scroll', () => {
    if (syncing) return
    syncing = true
    to.scrollTop = from.scrollTop
    syncing = false
  })
  bind(a, b)
  bind(b, a)
}

// ------------------------------------------------------------ 렌더링

function renderHeader () {
  const { month, week } = weekOfMonth(state.monday)
  el.weekTitle.textContent = `${month}월 ${week}주`
  el.weekRange.textContent = `${state.monday} ~ ${addDays(state.monday, 4)}`
}

/** 현재 보기 모드에서 화면에 그릴 날짜들. */
function visibleDays () {
  const all = state.days.map((day, index) => ({ day, index }))
  if (state.view !== 'today') return all
  const target = focusDate()
  return all.filter((entry) => entry.day.date === target)
}

function renderDays () {
  el.days.replaceChildren()
  el.days.classList.toggle('today-only', state.view === 'today')
  const today = toISO(new Date())

  const entries = visibleDays()

  if (entries.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'muted empty'
    empty.textContent = '이번 주가 아닙니다. ‘이번 주’ 를 누르거나 주간 보기로 전환하세요.'
    el.days.append(empty)
    return
  }

  entries.forEach(({ day, index }) => {
    const card = document.createElement('section')
    card.className = 'day' + (day.date === today ? ' today' : '')

    const head = document.createElement('div')
    head.className = 'day-head'
    head.append(
      spanWith('name', day.name),
      spanWith('date', day.date.slice(5)),
      spanWith('state', '')
    )

    // 출장/휴가는 결재 문서에서 자동으로 들어오는 값이라 여기서는 표시만 한다.
    const meta = buildMeta(day)

    // 좌: 업무 내용(task_description) · 우: 상태(task_status)
    const body = document.createElement('div')
    body.className = 'day-body'

    const editor = document.createElement('textarea')
    editor.className = 'editor'
    editor.value = day.text
    editor.spellcheck = false
    editor.placeholder = '금주에 진행할 업무'

    const statusEditor = document.createElement('textarea')
    statusEditor.className = 'status-editor'
    statusEditor.value = day.statusText
    statusEditor.spellcheck = false
    statusEditor.placeholder = '진행 상태'
    statusEditor.title = `왼쪽 업무 줄과 같은 순서로 한 줄에 하나씩 적는다.\n${MOD}+1 진행중 · ${MOD}+2 진행대기 · ${MOD}+3 완료 · ${MOD}+4 작업대기`

    const sync = () => {
      day.text = editor.value
      day.statusText = statusEditor.value
      const dirty = isDirty(day)
      setSaveState(index, dirty ? 'dirty' : 'clean')
      return dirty
    }

    const autosave = () => {
      clearTimeout(day.timer)
      if (sync()) day.timer = setTimeout(() => saveDay(index), AUTOSAVE_DELAY)
    }

    const flush = () => {
      clearTimeout(day.timer)
      day.text = editor.value
      day.statusText = statusEditor.value
      if (isDirty(day)) saveDay(index)
    }

    editor.addEventListener('input', autosave)
    statusEditor.addEventListener('input', autosave)
    editor.addEventListener('blur', flush)
    statusEditor.addEventListener('blur', flush)

    // 빈 칸에 처음 들어가면 1단계 글머리 기호를 미리 놓아준다.
    editor.addEventListener('focus', () => {
      if (editor.value !== '') return
      editor.value = window.api.prefixFor(0)
      editor.selectionStart = editor.selectionEnd = editor.value.length
      day.text = editor.value
    })

    editor.addEventListener('keydown', (event) => {
      if (event.key === 'Tab') {
        // Tab 은 포커스 이동 대신 깊이 조절로 쓴다.
        event.preventDefault()
        shiftSelection(editor, event.shiftKey ? -1 : 1)
        sync()
      } else if (event.key === 'Enter') {
        event.preventDefault()
        insertNewLine(editor)
        sync()
      }
    })

    // 상태 칸은 글머리 기호가 없는 평범한 줄 목록이다. 프리셋만 얹는다.
    statusEditor.addEventListener('keydown', (event) => {
      if (!event.ctrlKey && !event.metaKey) return
      const preset = STATUS_PRESETS[Number(event.key) - 1]
      if (!preset) return
      event.preventDefault()
      replaceCurrentLine(statusEditor, preset)
      autosave()
    })

    linkScroll(editor, statusEditor)

    body.append(editor, statusEditor)
    card.append(head)
    if (meta) card.append(meta)
    card.append(body)
    el.days.append(card)
    day.el = { card, state: head.querySelector('.state'), editor, statusEditor }
    setSaveState(index, day.saveState)
  })
}

/** 출장(좌)·휴가(우) 등 결재에서 자동 반영되는 읽기 전용 줄. */
function buildMeta (day) {
  if (!day.trips.length && !day.holidays.length) return null

  const meta = document.createElement('div')
  meta.className = 'day-meta'
  meta.title = '출장·휴가 결재에서 자동 반영되는 항목입니다. 여기서는 수정할 수 없습니다.'

  for (const text of day.trips) meta.append(spanWith('chip trip', text))
  for (const text of day.holidays) meta.append(spanWith('chip holiday', text))
  return meta
}

function spanWith (className, text) {
  const node = document.createElement('span')
  node.className = className
  node.textContent = text
  return node
}

/** 글머리 기호나 여백 차이는 무시하고 내용이 실제로 달라졌을 때만 저장 대상으로 본다. */
function isDescDirty (day) {
  return window.api.treeKey(day.text) !== day.serverKey
}

function isStatusDirty (day) {
  return window.api.statusKey(day.statusText) !== day.serverStatusKey
}

function isDirty (day) {
  return isDescDirty(day) || isStatusDirty(day)
}

function setSaveState (index, status, message) {
  const day = state.days[index]
  if (!day) return
  day.saveState = status
  if (!day.el) return

  const labels = {
    clean: '',
    dirty: '수정됨',
    saving: '저장 중…',
    saved: '저장됨',
    error: message || '저장 실패',
    conflict: '웹에서 변경됨'
  }
  day.el.state.textContent = labels[status] || ''

  let tone = ''
  if (status === 'dirty' || status === 'conflict') tone = ' dirty'
  else if (status === 'saved') tone = ' saved'
  else if (status === 'error') tone = ' error'
  day.el.state.className = 'state' + tone

  day.el.card.classList.toggle('conflict', status === 'conflict')
}

function setStatus (text, kind) {
  el.status.textContent = text
  el.status.className = 'muted'
  el.status.style.color = kind === 'error' ? 'var(--danger)' : ''
}

function showOverlay (text, actionLabel, action) {
  el.overlayText.textContent = text
  el.overlay.classList.remove('hidden')
  if (actionLabel) {
    el.overlayAction.textContent = actionLabel
    el.overlayAction.classList.remove('hidden')
    el.overlayAction.onclick = action
  } else {
    el.overlayAction.classList.add('hidden')
    el.overlayAction.onclick = null
  }
}

function hideOverlay () {
  el.overlay.classList.add('hidden')
}

// ------------------------------------------------------------ 데이터

/**
 * 출장(task_default_business_trip)·휴가(task_default_holiday)를
 * 표시용 문자열 배열로 만든다.
 * 원본 페이지는 각 항목을 그대로 문자열 보간해서 그린다.
 */
function normalizeLines (value) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      if (item === null || item === undefined) return ''
      if (typeof item === 'string') return item
      if (typeof item === 'object') {
        return String(item.text ?? item.title ?? item.name ?? JSON.stringify(item))
      }
      return String(item)
    })
    .filter((text) => text.trim() !== '')
}

function makeDay (date, name, log, kept) {
  const serverTree = (log && log.task_description) || []
  const serverStatus = (log && log.task_status) || []
  const day = {
    date,
    name,
    text: window.api.treeToText(serverTree),
    serverText: window.api.treeToText(serverTree),
    serverKey: window.api.treeKey(serverTree),
    statusText: window.api.statusToText(serverStatus),
    serverStatusText: window.api.statusToText(serverStatus),
    serverStatusKey: window.api.statusKey(serverStatus),
    trips: normalizeLines(log && log.task_default_business_trip),
    holidays: normalizeLines(log && log.task_default_holiday),
    saveState: 'clean'
  }

  // 저장 못 한 로컬 수정본이 있고 그 사이 웹에서도 값이 바뀌었으면 그대로 들고 있는다.
  if (kept) {
    if (kept.text !== undefined && window.api.treeKey(kept.text) !== day.serverKey) {
      day.text = kept.text
      day.saveState = 'conflict'
    }
    if (kept.statusText !== undefined && window.api.statusKey(kept.statusText) !== day.serverStatusKey) {
      day.statusText = kept.statusText
      day.saveState = 'conflict'
    }
  }

  return day
}

/** 응답에서 로그인 사용자의 이번 주 업무 로그를 뽑아낸다. */
function extractMyWeek (result) {
  if (!result || !Array.isArray(result.weekly_task_logs_list)) return null
  const myPk = result.user_data && result.user_data.pk
  const mine = result.weekly_task_logs_list.find((row) => row && row.user_pk === myPk) ||
    result.weekly_task_logs_list[0]
  if (!mine) return null

  const byDate = new Map()
  for (const log of mine.current_week_task_log || []) {
    if (log && log.date) byDate.set(log.date, log)
  }
  return { row: mine, byDate }
}

async function loadWeek (options) {
  const { silent = false, preserveDirty = false } = options || {}
  if (state.loading) return
  state.loading = true
  if (!silent) showOverlay('불러오는 중…')
  setStatus('조회 중…')

  const response = await window.api.getWeek(state.monday, state.department)

  if (!response.ok) {
    state.loading = false
    if (response.code === 'AUTH_REQUIRED') {
      showOverlay('로그인이 필요합니다.', '로그인', doLogin)
      setStatus('로그인 필요', 'error')
    } else {
      showOverlay(response.message || '불러오지 못했습니다.', '다시 시도', () => loadWeek())
      setStatus(response.message || '조회 실패', 'error')
    }
    return
  }

  // 저장되지 않은 로컬 수정본은 새로고침 시에도 보존한다.
  const dirtyBefore = new Map()
  if (preserveDirty) {
    for (const day of state.days) {
      if (!isDirty(day)) continue
      dirtyBefore.set(day.date, {
        text: isDescDirty(day) ? day.text : undefined,
        statusText: isStatusDirty(day) ? day.statusText : undefined
      })
    }
  }

  const mine = extractMyWeek(response.result)
  storeTeam(response.result)
  renderNotice(response.result)

  state.days = DAY_NAMES.map((name, index) => {
    const date = addDays(state.monday, index)
    const log = mine ? mine.byDate.get(date) : null
    return makeDay(date, name, log, dirtyBefore.get(date))
  })

  renderHeader()
  renderDays()
  if (state.view === 'team') renderTeam()
  hideOverlay()
  state.loading = false

  if (!mine) {
    setStatus(`'${state.department}' 부서 응답에서 내 업무 행을 찾지 못했습니다. 부서 코드를 확인하세요.`, 'error')
  } else {
    const who = mine.row.name ? ` · ${mine.row.name}` : ''
    setStatus(`불러옴${who} · ${new Date().toLocaleTimeString('ko-KR')}`)
  }
}

async function saveDay (index) {
  const day = state.days[index]
  if (!day || !isDirty(day)) return

  setSaveState(index, 'saving')

  const patch = {}
  // 글머리 기호는 textToTree 에서 떨어져 나간다.
  const tree = isDescDirty(day) ? window.api.textToTree(day.text) : null
  const status = isStatusDirty(day) ? window.api.textToStatus(day.statusText) : null
  if (tree) patch.task_description = tree
  if (status) patch.task_status = status

  const response = await window.api.saveDay(day.date, patch)

  if (!response.ok) {
    if (response.code === 'AUTH_REQUIRED') {
      setSaveState(index, 'error', '로그인 필요')
      showOverlay('로그인이 필요합니다.', '로그인', doLogin)
      return
    }
    setSaveState(index, 'error', response.message)
    setStatus(`${day.date} 저장 실패: ${response.message}`, 'error')
    return
  }

  if (tree) {
    day.serverText = day.text
    day.serverKey = window.api.treeKey(tree)
  }
  if (status) {
    day.serverStatusText = day.statusText
    day.serverStatusKey = window.api.statusKey(status)
  }
  setSaveState(index, 'saved')
  setStatus(`${day.date} 저장됨 · ${new Date().toLocaleTimeString('ko-KR')}`)
  setTimeout(() => {
    if (day.saveState === 'saved') setSaveState(index, 'clean')
  }, 2500)
}

async function saveAll () {
  for (let index = 0; index < state.days.length; index += 1) {
    clearTimeout(state.days[index].timer)
    await saveDay(index)
  }
}

async function doLogin () {
  showOverlay('로그인 창에서 로그인해 주세요…')
  const ok = await window.api.login()
  if (ok) {
    setStatus('로그인 완료')
    await loadWeek()
  } else {
    showOverlay('로그인이 취소되었습니다.', '다시 로그인', doLogin)
  }
}

// ------------------------------------------------------------ 이벤트

document.getElementById('prevWeek').addEventListener('click', () => {
  state.monday = addDays(state.monday, -7)
  loadWeek()
})

document.getElementById('nextWeek').addEventListener('click', () => {
  state.monday = addDays(state.monday, 7)
  loadWeek()
})

document.getElementById('thisWeek').addEventListener('click', () => {
  state.monday = mondayOf(new Date())
  loadWeek()
})

document.getElementById('refresh').addEventListener('click', () => {
  loadWeek({ preserveDirty: true })
})

document.getElementById('saveAll').addEventListener('click', saveAll)

document.getElementById('openWeb').addEventListener('click', () => window.api.openWeb())

const WEEK_HINT = document.getElementById('hint').textContent
const LOG_HINT = `빈 줄 = 단락 / - 항목 = 목록 (Tab 하위 단계) / 1. 항목 = 번호 목록 / # 제목 / ${MOD}+Enter 로 생성`
const BROWSE_HINT = '읽기 전용 · ↑↓ = 이전/다음 로그 · Enter / Shift+Enter = 본문의 다음/이전 일치 · PageUp/PageDown = 본문 넘기기 · 새 로그는 새로고침 · 제목을 누르면 웹에서 연다'
const TEAM_HINT = '읽기 전용 · 왼쪽에서 구성원을 고르면 그 사람의 주간 업무가 보인다 · 부서 코드를 바꾸면 다른 부서도 볼 수 있다'
const CAR_HINT = '읽기 전용 · 아카이브 차량예약신청 위키의 신청 현황 표 · 날짜를 누르면 오른쪽에 상세 · 예약은 "웹에서 예약" 으로 위키에 직접 적는다'

/** 보기 모드에 맞춰 헤더 구성과 카드 배치를 바꾼다. */
function applyView () {
  const isLog = state.view === 'log'
  const isTeam = state.view === 'team'
  const isCar = state.view === 'car'
  for (const button of document.querySelectorAll('.seg')) {
    button.classList.toggle('active', button.dataset.view === state.view)
  }
  // '오늘' 모드에서는 주 이동이 의미가 없으므로 감춘다. 로그 패널에서는 주간 도구를 모두 감춘다.
  // 팀 보기는 주 이동·부서·새로고침은 쓰되 저장 버튼만 감춘다 (읽기 전용).
  document.querySelector('.week-nav').classList.toggle('hidden', !(state.view === 'week' || isTeam))
  // 차량 달력은 자기 툴바(달 이동·새로고침)를 따로 가지므로 주간 도구를 모두 감춘다.
  for (const node of document.querySelectorAll('.week-only')) node.classList.toggle('hidden', isLog || isCar)
  for (const node of document.querySelectorAll('.edit-only')) node.classList.toggle('hidden', isLog || isTeam || isCar)
  for (const node of document.querySelectorAll('.team-only')) node.classList.toggle('hidden', !isTeam)
  el.days.classList.toggle('hidden', isLog || isTeam || isCar)
  el.teamPanel.classList.toggle('hidden', !isTeam)
  el.notice.classList.toggle('hidden', isLog || isCar || !state.notice.length)
  logEl.panel.classList.toggle('hidden', !isLog)
  carEl.panel.classList.toggle('hidden', !isCar)
  document.getElementById('hint').textContent = isLog ? (state.logMode === 'browse' ? BROWSE_HINT : LOG_HINT) : isTeam ? TEAM_HINT : isCar ? CAR_HINT : WEEK_HINT
}

async function setView (view) {
  if (state.view === view) return
  state.view = view
  await window.api.setSettings({ view })
  applyView()

  if (view === 'log') {
    enterLogPanel()
    return
  }

  if (view === 'team') {
    renderTeam()
    return
  }

  if (view === 'car') {
    enterCarPanel()
    return
  }

  // '오늘' 모드로 올 때 다른 주를 보고 있었다면 이번 주로 되돌린다.
  const wanted = mondayOf(fromISO(focusDate()))
  if (view === 'today' && state.monday !== wanted) {
    state.monday = wanted
    await loadWeek({ preserveDirty: true })
    return
  }
  renderDays()
}

for (const button of document.querySelectorAll('.seg')) {
  button.addEventListener('click', () => setView(button.dataset.view))
}

document.getElementById('toggleWidget').addEventListener('click', () => {
  window.api.setWidget(!state.widget)   // 창이 다시 만들어지며 start() 가 재실행된다
})

document.getElementById('hideWindow').addEventListener('click', () => window.api.hideWindow())

el.department.addEventListener('change', async () => {
  state.department = el.department.value.trim() || 'bs'
  el.department.value = state.department
  await window.api.setSettings({ department: state.department })
  loadWeek()
})

document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault()
    saveAll()
  }
})

// 트레이 메뉴 '새 로그 작성' 등에서 보기 모드를 바꾼다.
window.api.onSetView((view) => {
  if (state.view === view) {
    if (view === 'log') setLogMode('write')
    return
  }
  // 트레이 '새 로그 작성' 은 작성 화면으로 연다.
  if (view === 'log') state.logMode = 'write'
  setView(view)
})

// 창을 다시 활성화하면 웹에서 바뀐 내용을 반영한다 (로컬 수정본은 보존).
window.api.onWindowFocus(() => {
  if (!state.loading) loadWeek({ silent: true, preserveDirty: true })
  if (state.view === 'car') loadCars({ silent: true, maxAge: CAR_REFRESH_AGE })
})

// ------------------------------------------------------------ 아카이브 로그 패널

const logEl = {
  panel: document.getElementById('logPanel'),
  form: document.getElementById('logForm'),
  auth: document.getElementById('logAuth'),
  login: document.getElementById('logLogin'),
  project: document.getElementById('logProject'),
  projectPick: document.getElementById('logProjectPick'),
  date: document.getElementById('logDate'),
  start: document.getElementById('logStart'),
  end: document.getElementById('logEnd'),
  manager: document.getElementById('logManager'),
  managerPick: document.getElementById('logManagerPick'),
  memberBox: document.getElementById('logMembers'),
  memberInput: document.getElementById('logMemberInput'),
  memberPick: document.getElementById('logMemberPick'),
  tags: document.getElementById('logTags'),
  tagList: document.getElementById('logTagList'),
  presentation: document.getElementById('logPresentation'),
  meta: document.getElementById('logMeta'),
  text: document.getElementById('logText'),
  state: document.getElementById('logState'),
  submit: document.getElementById('logSubmit'),
  openProject: document.getElementById('logOpenProject')
}

const logState = {
  authed: null,
  bookmarks: [],        // 즐겨찾기 프로젝트 { name, isPublic, manager }
  allProjects: [],      // 즐겨찾기가 없을 때 대신 보여줄 첫 페이지
  found: new Map(),     // 검색으로 알게 된 프로젝트 name -> project
  input: null,          // logInput 응답 (담당자 후보, 그룹, 기본값)
  inputFor: '',         // input 이 어느 프로젝트 것인지
  managerId: null,
  members: { group: [], user: [] },
  busy: false,
  tagTimer: null
}

function setLogState (text, kind) {
  logEl.state.textContent = text || ''
  logEl.state.className = 'muted' + (kind === 'error' ? ' error' : kind === 'ok' ? ' ok' : '')
}

function setLogAuthed (authed) {
  logState.authed = authed
  logEl.auth.classList.toggle('hidden', authed)
  logEl.form.classList.toggle('hidden', !authed || state.logMode !== 'write')
  browseEl.panel.classList.toggle('hidden', !authed || state.logMode !== 'browse')
}

/** 일자 = 오늘, 시작 = 현재 시각을 30분 단위로 내림, 종료 = +30분 (웹 기본값과 동일). */
function setLogDefaults () {
  const now = new Date()
  if (!logEl.date.value) logEl.date.value = toISO(now)
  if (!logEl.start.value || !logEl.end.value) {
    const start = new Date(now)
    start.setMinutes(now.getMinutes() < 30 ? 0 : 30, 0, 0)
    const end = new Date(start.getTime() + 30 * 60 * 1000)
    const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    if (!logEl.start.value) logEl.start.value = hhmm(start)
    if (!logEl.end.value) logEl.end.value = hhmm(end)
  }
}

// ---- 검색 가능한 선택 목록 (프로젝트 / 담당자 / 참여인원 공용)

/**
 * input 아래에 목록을 띄우는 작은 콤보박스.
 * source(query) 는 [{ kind: 'item'|'group'|'empty', label, sub, value }] 를 (비동기로) 돌려준다.
 */
function makePicker ({ input, list, source, onPick, debounce = 250 }) {
  let items = []
  let active = -1
  let timer = null
  let seq = 0

  const close = () => {
    list.classList.add('hidden')
    list.replaceChildren()
    items = []
    active = -1
  }

  const render = () => {
    list.replaceChildren()
    items.forEach((item, index) => {
      const li = document.createElement('li')
      if (item.kind === 'group') {
        li.className = 'group'
        li.textContent = item.label
      } else if (item.kind === 'empty') {
        li.className = 'empty'
        li.textContent = item.label
      } else {
        li.textContent = item.label
        if (item.sub) li.append(spanWith('sub', item.sub))
        if (index === active) li.classList.add('active')
        // blur 보다 먼저 처리되도록 mousedown 에서 고른다.
        li.addEventListener('mousedown', (event) => {
          event.preventDefault()
          pick(index)
        })
      }
      list.append(li)
    })
    list.classList.toggle('hidden', items.length === 0)
  }

  const pick = (index) => {
    const item = items[index]
    if (!item || item.kind !== 'item') return
    close()
    onPick(item.value, item)
  }

  const open = async () => {
    const mine = ++seq
    const result = await source(input.value.trim())
    if (mine !== seq) return // 더 최근 요청이 있다
    items = result || []
    active = items.findIndex((item) => item.kind === 'item')
    render()
  }

  const move = (delta) => {
    if (!items.length) return
    let next = active
    for (let i = 0; i < items.length; i += 1) {
      next = (next + delta + items.length) % items.length
      if (items[next].kind === 'item') break
    }
    active = next
    render()
    const node = list.children[active]
    if (node) node.scrollIntoView({ block: 'nearest' })
  }

  input.addEventListener('focus', open)
  input.addEventListener('click', () => { if (list.classList.contains('hidden')) open() })
  input.addEventListener('input', () => {
    clearTimeout(timer)
    timer = setTimeout(open, debounce)
  })
  input.addEventListener('blur', () => setTimeout(close, 120))
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); if (items.length) move(1); else open() }
    else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1) }
    else if (event.key === 'Enter') {
      if (items.length && active >= 0) { event.preventDefault(); pick(active) }
    } else if (event.key === 'Escape') close()
  })

  return { open, close }
}

function matches (text, query) {
  return !query || String(text || '').toLowerCase().includes(query.toLowerCase())
}

// ---- 프로젝트

async function projectSource (query) {
  const out = []
  const seen = new Set()
  const push = (project, sub) => {
    if (!project || seen.has(project.name)) return
    seen.add(project.name)
    out.push({ kind: 'item', label: project.name, sub, value: project })
  }

  if (!query) {
    if (logState.bookmarks.length) {
      out.push({ kind: 'group', label: '즐겨찾기' })
      for (const p of logState.bookmarks) push(p, p.manager)
    } else {
      out.push({ kind: 'empty', label: '즐겨찾기한 프로젝트가 없습니다. 웹에서 별표를 누르면 여기 나옵니다.' })
      if (logState.allProjects.length) {
        out.push({ kind: 'group', label: '최근 프로젝트' })
        for (const p of logState.allProjects) push(p, p.manager)
      }
    }
    return out
  }

  // 로컬에 아는 것 먼저, 서버 검색 결과를 뒤에 붙인다.
  for (const p of [...logState.bookmarks, ...logState.allProjects, ...logState.found.values()]) {
    if (matches(p.name, query)) push(p, p.isBookmark ? '즐겨찾기' : p.manager)
  }
  const res = await window.api.archive.searchProjects(query)
  if (res.code === 'AUTH_REQUIRED') { setLogAuthed(false); return [] }
  if (res.ok) {
    for (const p of res.projects) {
      logState.found.set(p.name, p)
      push(p, p.manager)
    }
  }
  if (!out.length) out.push({ kind: 'empty', label: `'${query}' 에 맞는 프로젝트가 없습니다.` })
  return out
}

function knownProject (name) {
  return logState.bookmarks.find((p) => p.name === name) ||
    logState.allProjects.find((p) => p.name === name) ||
    logState.found.get(name) || null
}

async function loadBookmarks () {
  const res = await window.api.archive.bookmarks()
  if (res.code === 'AUTH_REQUIRED') { setLogAuthed(false); return }
  logState.bookmarks = res.bookmarks || []
  if (!res.ok) setLogState(res.message || '즐겨찾기를 불러오지 못했습니다.', 'error')

  // 즐겨찾기가 없으면 첫 페이지라도 보여준다.
  if (!logState.bookmarks.length) {
    const all = await window.api.archive.searchProjects('')
    if (all.ok) logState.allProjects = all.projects
  }
}

/** 프로젝트가 정해지면 담당자 후보와 기본 참여인원을 받아온다. */
async function loadLogInput (project) {
  logState.input = null
  logState.inputFor = ''
  logState.managerId = null
  logState.members = { group: [], user: [] }
  logEl.manager.value = ''
  logEl.manager.placeholder = '불러오는 중…'
  logEl.manager.disabled = true
  logEl.memberInput.disabled = true
  renderMemberChips()
  logEl.meta.textContent = ''

  const res = await window.api.archive.logInput(project)
  if (res.code === 'AUTH_REQUIRED') { setLogAuthed(false); return }
  if (!res.ok) {
    logEl.manager.placeholder = '프로젝트를 확인하세요'
    setLogState(`'${project}' 정보를 불러오지 못했습니다: ${res.message}`, 'error')
    return
  }

  logState.input = res.input
  logState.inputFor = project
  state.logProject = project
  window.api.setSettings({ logProject: project })

  logState.managerId = res.input.defaultManager
  const manager = res.input.managers.find((m) => m.userId === res.input.defaultManager)
  logEl.manager.value = manager ? manager.name : ''
  logEl.manager.placeholder = '이름 또는 부서로 검색'
  logEl.manager.disabled = false

  logState.members = {
    group: [...(res.input.defaultMember.group || [])],
    user: [...(res.input.defaultMember.user || [])]
  }
  logEl.memberInput.disabled = false
  renderMemberChips()

  const known = knownProject(project)
  logEl.meta.textContent = (known ? `${known.isPublic ? '공개' : '비공개'} 프로젝트 / ` : '') +
    `담당자 후보 ${res.input.managers.length}명, 그룹 ${res.input.groups.length}개. 참여인원 기본값은 웹과 같이 미리 들어 있습니다.`
  setLogState('')
}

// ---- 담당자

function managerSource (query) {
  if (!logState.input) return [{ kind: 'empty', label: '프로젝트를 먼저 선택하세요.' }]
  const out = logState.input.managers
    .filter((m) => matches(m.name, query) || matches(m.department, query))
    .slice(0, 50)
    .map((m) => ({ kind: 'item', label: m.name, sub: [m.department, m.position].filter(Boolean).join(' '), value: m }))
  return out.length ? out : [{ kind: 'empty', label: '일치하는 사용자가 없습니다.' }]
}

// ---- 참여인원

function memberSource (query) {
  if (!logState.input) return [{ kind: 'empty', label: '프로젝트를 먼저 선택하세요.' }]
  const out = []
  const groups = logState.input.groups
    .filter((g) => !logState.members.group.includes(g.id) && matches(g.name, query))
  if (groups.length) {
    out.push({ kind: 'group', label: '그룹' })
    for (const g of groups.slice(0, 20)) {
      out.push({ kind: 'item', label: g.name, sub: g.count ? `${g.count}명` : '', value: { type: 'group', id: g.id } })
    }
  }
  const users = logState.input.managers
    .filter((m) => !logState.members.user.includes(m.userId) && (matches(m.name, query) || matches(m.department, query)))
  if (users.length) {
    out.push({ kind: 'group', label: '사용자' })
    for (const m of users.slice(0, 50)) {
      out.push({ kind: 'item', label: m.name, sub: [m.department, m.position].filter(Boolean).join(' '), value: { type: 'user', id: m.userId } })
    }
  }
  return out.length ? out : [{ kind: 'empty', label: '일치하는 사용자/그룹이 없습니다.' }]
}

function renderMemberChips () {
  for (const chip of logEl.memberBox.querySelectorAll('.chip')) chip.remove()
  const input = logState.input
  const nameOfGroup = (id) => (input && input.groups.find((g) => g.id === id)) ? input.groups.find((g) => g.id === id).name : `그룹 #${id}`
  const nameOfUser = (id) => (input && input.managers.find((m) => m.userId === id)) ? input.managers.find((m) => m.userId === id).name : `사용자 #${id}`

  const add = (type, id, label) => {
    const chip = document.createElement('span')
    chip.className = 'chip' + (type === 'group' ? ' group' : '')
    chip.append(document.createTextNode(label))
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.title = '제외'
    remove.textContent = '×'
    remove.addEventListener('click', () => {
      logState.members[type] = logState.members[type].filter((v) => v !== id)
      renderMemberChips()
    })
    chip.append(remove)
    logEl.memberBox.insertBefore(chip, logEl.memberInput)
  }
  for (const id of logState.members.group) add('group', id, nameOfGroup(id))
  for (const id of logState.members.user) add('user', id, nameOfUser(id))
}

// ---- 태그

function parseTags () {
  const tags = logEl.tags.value.split(',').map((t) => t.trim()).filter(Boolean)
  return [...new Set(tags)]
}

/** 마지막 쉼표 뒤 토큰으로 태그를 검색해 자동완성에 넣는다. */
function scheduleTagSearch () {
  clearTimeout(logState.tagTimer)
  const raw = logEl.tags.value
  const cut = raw.lastIndexOf(',')
  const prefix = cut === -1 ? '' : raw.slice(0, cut + 1) + ' '
  const keyword = raw.slice(cut + 1).trim()
  if (!keyword) { logEl.tagList.replaceChildren(); return }
  logState.tagTimer = setTimeout(async () => {
    const res = await window.api.archive.searchTags(keyword)
    if (!res.ok) return
    logEl.tagList.replaceChildren(...res.tags.slice(0, 10).map((tag) => new Option(prefix + tag)))
  }, 300)
}

// ---- 진입 / 제출

/** 로그 탭에 들어올 때: 로그인 확인 → 즐겨찾기 → 마지막 프로젝트 복원. */
async function enterLogPanel () {
  setLogDefaults()
  const check = await window.api.archive.check()
  if (!check.ok) {
    setLogAuthed(true)
    setLogState(check.message || '아카이브에 연결하지 못했습니다.', 'error')
    return
  }
  setLogAuthed(check.authed)
  if (!check.authed) return

  await loadBookmarks()
  if (!logEl.project.value && state.logProject) logEl.project.value = state.logProject
  if (state.logMode === 'browse') {
    enterBrowse()
    return
  }
  if (logEl.project.value && logState.inputFor !== logEl.project.value) await loadLogInput(logEl.project.value)
  ;(logEl.project.value ? logEl.text : logEl.project).focus()
}

function validateLogForm () {
  const project = logEl.project.value.trim()
  if (!project) return { error: '프로젝트를 선택하세요.', focus: logEl.project }
  if (logState.inputFor !== project) return { error: '목록에서 프로젝트를 선택해 주세요.', focus: logEl.project }
  if (!logEl.date.value) return { error: '일자를 입력하세요.', focus: logEl.date }
  if (!logEl.start.value || !logEl.end.value) return { error: '시작/종료 시간을 입력하세요.', focus: logEl.start }
  if (logEl.start.value >= logEl.end.value) return { error: '종료 시각이 시작 시각보다 늦어야 합니다.', focus: logEl.end }
  if (logEl.text.value.trim() === '') return { error: '본문을 입력하세요.', focus: logEl.text }
  const tags = parseTags()
  if (tags.length > 10) return { error: '태그는 최대 10개입니다.', focus: logEl.tags }
  if (tags.some((t) => t.length > 50)) return { error: '태그는 50글자 이내여야 합니다.', focus: logEl.tags }
  return { project, tags }
}

async function submitLog () {
  if (logState.busy) return
  const checked = validateLogForm()
  if (checked.error) {
    setLogState(checked.error, 'error')
    checked.focus.focus()
    return
  }

  logState.busy = true
  logEl.submit.disabled = true
  setLogState('생성 중…')

  const res = await window.api.archive.createLog({
    project: checked.project,
    date: logEl.date.value,
    startTime: logEl.start.value,
    endTime: logEl.end.value,
    presentation: logEl.presentation.checked,
    manager: logState.managerId || null,
    member: logState.members,
    tags: checked.tags,
    text: logEl.text.value
  })

  logState.busy = false
  logEl.submit.disabled = false

  if (!res.ok) {
    if (res.code === 'AUTH_REQUIRED') { setLogAuthed(false); return }
    setLogState(res.message || '로그 생성에 실패했습니다.', 'error')
    return
  }

  // 같은 프로젝트에 이어서 쓸 수 있게 본문과 태그만 비운다.
  logEl.text.value = ''
  logEl.tags.value = ''
  logEl.presentation.checked = false
  setLogState(`${res.message} / ${new Date().toLocaleTimeString('ko-KR')}`, 'ok')
  setStatus(`아카이브 로그 생성됨: ${checked.project}`)
  window.api.archive.bookmarks() // 트레이 목록도 최신으로
}

/** 목록 줄에서 Enter 를 치면 같은 깊이의 글머리를 이어 붙이고, 빈 항목에서 Enter 면 목록을 끝낸다. */
function logEditorKeydown (event) {
  const editor = logEl.text
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault()
    submitLog()
    return
  }
  if (event.key === 'Tab') {
    event.preventDefault()
    const start = editor.selectionStart
    const lineStart = editor.value.lastIndexOf('\n', start - 1) + 1
    if (event.shiftKey) {
      if (editor.value.slice(lineStart, lineStart + 2) === '  ') editor.setRangeText('', lineStart, lineStart + 2, 'end')
    } else {
      editor.setRangeText('  ', lineStart, lineStart, 'preserve')
      editor.selectionStart = editor.selectionEnd = start + 2
    }
    return
  }
  if (event.key === 'Enter') {
    const start = editor.selectionStart
    const lineStart = editor.value.lastIndexOf('\n', start - 1) + 1
    const line = editor.value.slice(lineStart, start)
    const m = /^(\s*)(?:([-*•])|(\d+)[.)])\s+(.*)$/.exec(line)
    if (!m) return
    event.preventDefault()
    if (m[4].trim() === '') {
      // 빈 항목: 글머리를 지우고 목록을 끝낸다.
      editor.setRangeText('', lineStart, start, 'end')
      return
    }
    const marker = m[2] ? `${m[2]} ` : `${Number(m[3]) + 1}. `
    editor.setRangeText('\n' + m[1] + marker, start, editor.selectionEnd, 'end')
  }
}

// ---- 이벤트 연결

makePicker({
  input: logEl.project,
  list: logEl.projectPick,
  source: projectSource,
  onPick: (project) => {
    logEl.project.value = project.name
    loadLogInput(project.name)
  }
})

makePicker({
  input: logEl.manager,
  list: logEl.managerPick,
  source: managerSource,
  debounce: 80,
  onPick: (m) => {
    logState.managerId = m.userId
    logEl.manager.value = m.name
  }
})

makePicker({
  input: logEl.memberInput,
  list: logEl.memberPick,
  source: memberSource,
  debounce: 80,
  onPick: (picked) => {
    if (!logState.members[picked.type].includes(picked.id)) logState.members[picked.type].push(picked.id)
    logEl.memberInput.value = ''
    renderMemberChips()
    logEl.memberInput.focus()
  }
})

// 목록에서 고르지 않고 이름만 정확히 쳤을 때도 인식한다.
logEl.project.addEventListener('blur', () => {
  const name = logEl.project.value.trim()
  if (name && name !== logState.inputFor && knownProject(name)) loadLogInput(name)
})
// 담당자 칸을 비우면 담당자 없음. 다른 글자를 남겨두면 마지막 선택을 유지한다.
logEl.manager.addEventListener('blur', () => {
  if (logEl.manager.value.trim() === '') { logState.managerId = null; return }
  const m = logState.input && logState.input.managers.find((x) => x.userId === logState.managerId)
  if (m && logEl.manager.value.trim() !== m.name) logEl.manager.value = m.name
})
logEl.memberBox.addEventListener('click', (event) => {
  if (event.target === logEl.memberBox) logEl.memberInput.focus()
})
logEl.tags.addEventListener('input', scheduleTagSearch)
logEl.text.addEventListener('keydown', logEditorKeydown)
logEl.submit.addEventListener('click', submitLog)
logEl.openProject.addEventListener('click', () => window.api.archive.openProject(logEl.project.value.trim()))
logEl.login.addEventListener('click', async () => {
  setLogState('로그인 창에서 로그인해 주세요…')
  const ok = await window.api.archive.login()
  setLogState(ok ? '' : '로그인이 취소되었습니다.', ok ? '' : 'error')
  if (ok) enterLogPanel()
})

// ------------------------------------------------------------ 아카이브 로그 검색

// 프로젝트를 고르면 로그를 모두 받아 두고, 검색은 받은 내용(화면에 보이는 평문) 안에서 바로 거른다.
// 서버는 size 를 무시하고 10건씩 주므로 첫 페이지로 페이지 수를 알아낸 뒤 나머지를 몇 개씩 나눠 받는다.
const BROWSE_FETCH_PARALLEL = 4
const BROWSE_SHOW_STEP = 50    // 왼쪽 목록에 한 번에 그리는 건수. 나머지는 '더 보기'
const BROWSE_FILTER_DELAY = 150

const browseEl = {
  modes: document.getElementById('logModes'),
  panel: document.getElementById('logBrowse'),
  project: document.getElementById('browseProject'),
  projectPick: document.getElementById('browseProjectPick'),
  search: document.getElementById('browseSearch'),
  reload: document.getElementById('browseReload'),
  state: document.getElementById('browseState'),
  openProject: document.getElementById('browseOpenProject'),
  list: document.getElementById('browseList'),
  detail: document.getElementById('browseDetail')
}

const browseState = {
  project: '',    // 받아 둔 로그가 어느 프로젝트 것인지
  logs: [],       // 받아 둔 로그 전체 (최신순). 각 항목에 검색용 haystack 을 붙인다
  count: 0,       // 서버가 알려준 전체 건수
  loading: false,
  terms: [],      // 지금 검색어 (공백으로 나눈 낱말, 소문자)
  matches: [],    // terms 에 맞는 로그
  shown: BROWSE_SHOW_STEP,
  selected: null, // 오른쪽에 펼친 로그 id
  markIndex: -1,  // 오른쪽 본문에서 지금 가리키는 일치 순번
  seq: 0,        // 늦게 온 이전 프로젝트 응답을 버리기 위한 요청 번호
  filterTimer: null
}

function setBrowseState (text, kind) {
  browseEl.state.textContent = text || ''
  browseEl.state.className = 'muted' + (kind === 'error' ? ' error' : kind === 'ok' ? ' ok' : '')
}

function syncLogModeButtons () {
  for (const button of browseEl.modes.querySelectorAll('.scope')) {
    button.classList.toggle('active', button.dataset.mode === state.logMode)
  }
}

function setLogMode (mode) {
  state.logMode = mode
  window.api.setSettings({ logMode: mode })
  syncLogModeButtons()
  applyView()
  if (logState.authed === null) return // 아직 enterLogPanel 이 로그인 확인 중
  setLogAuthed(logState.authed)
  if (!logState.authed) return
  if (mode === 'browse') enterBrowse()
  else (logEl.project.value ? logEl.text : logEl.project).focus()
}

/** 검색 화면에 들어올 때: 프로젝트가 비어 있으면 작성 화면의 프로젝트를 가져온다. 이미 받아 둔 프로젝트면 다시 받지 않는다. */
function enterBrowse () {
  if (!browseEl.project.value) browseEl.project.value = logEl.project.value.trim() || state.logProject
  const project = browseEl.project.value.trim()
  if (project && project !== browseState.project) loadBrowse()
  ;(project ? browseEl.search : browseEl.project).focus()
}

/** 로그 이름은 보통 '<프로젝트>_YYYYMMDD' 라 프로젝트 부분은 떼고 보여준다 (검색 대상에서도 뺀다). */
function shortLogName (log) {
  const prefix = browseState.project + '_'
  return log.name.startsWith(prefix) && log.name.length > prefix.length ? log.name.slice(prefix.length) : log.name
}

/** 검색 대상: 제목, 본문, 태그, 담당자·참여자, 일자. 화면에 보이는 글과 같다. */
function haystackOf (log) {
  return [shortLogName(log), log.date, log.text, log.tags.map((t) => '#' + t).join(' '), log.managers.join(' '), log.participants.join(' ')]
    .join('\n').toLowerCase()
}

/** 프로젝트 로그를 모두 받아 둔다. 받는 동안에도 받은 만큼 걸러서 보여준다. */
async function loadBrowse () {
  const project = browseEl.project.value.trim()
  if (!project) {
    setBrowseState('프로젝트를 선택하세요.', 'error')
    browseEl.project.focus()
    return
  }

  const mine = ++browseState.seq
  const stale = () => mine !== browseState.seq
  browseState.project = project
  browseState.logs = []
  browseState.count = 0
  browseState.loading = true
  browseEl.reload.disabled = true
  setBrowseState('불러오는 중…')
  filterBrowse()

  const fail = (res) => {
    if (stale()) return true
    if (res.ok) return false
    browseState.loading = false
    browseEl.reload.disabled = false
    if (res.code === 'AUTH_REQUIRED') setLogAuthed(false)
    else setBrowseState(`로그를 불러오지 못했습니다: ${res.message}`, 'error')
    filterBrowse()
    return true
  }

  const first = await window.api.archive.projectLogs({ project, page: 1 })
  if (fail(first)) return

  const perPage = first.logs.length || 1
  const pageCount = Math.max(1, Math.ceil(first.count / perPage))
  const pages = [first.logs]
  browseState.count = first.count

  // 페이지 순서를 지키며 앞에서부터 이어 붙인다 (받는 순서는 뒤섞일 수 있다).
  const publish = () => {
    const seen = new Set()
    const logs = []
    for (const page of pages) {
      if (!page) break
      for (const log of page) {
        if (seen.has(log.id)) continue // 받는 사이 새 로그가 생겨 페이지가 밀린 경우
        seen.add(log.id)
        logs.push(log)
      }
    }
    browseState.logs = logs
    setBrowseState(`불러오는 중… ${logs.length} / ${browseState.count}`)
    filterBrowse({ keepShown: true })
  }
  for (const log of first.logs) log.haystack = haystackOf(log)
  publish()

  let next = 2
  const worker = async () => {
    while (next <= pageCount) {
      const page = next++
      const res = await window.api.archive.projectLogs({ project, page })
      if (fail(res)) throw new Error('stop')
      for (const log of res.logs) log.haystack = haystackOf(log)
      pages[page - 1] = res.logs
      publish()
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(BROWSE_FETCH_PARALLEL, pageCount - 1) }, worker))
  } catch {
    return
  }
  if (stale()) return

  browseState.loading = false
  browseEl.reload.disabled = false
  filterBrowse({ keepShown: true })
}

/** 검색어로 받아 둔 로그를 거른다. 공백으로 나눈 낱말이 모두 들어 있어야 맞는다 (대소문자 무시). */
function filterBrowse ({ keepShown = false } = {}) {
  browseState.terms = [...new Set(browseEl.search.value.toLowerCase().split(/\s+/).filter(Boolean))]
  const terms = browseState.terms
  browseState.matches = terms.length
    ? browseState.logs.filter((log) => terms.every((term) => log.haystack.includes(term)))
    : browseState.logs
  if (!keepShown) {
    browseState.shown = BROWSE_SHOW_STEP
    browseEl.list.scrollTop = 0
    browseState.selected = null // 검색어가 바뀌면 첫 결과를 편다
  }

  if (!browseState.loading && browseState.project && browseEl.state.className.indexOf('error') === -1) {
    setBrowseState(terms.length
      ? `${browseState.matches.length}건 일치 / 전체 ${browseState.logs.length}건`
      : `로그 ${browseState.logs.length}건`)
  } else if (browseState.loading && terms.length) {
    setBrowseState(`불러오는 중… ${browseState.logs.length} / ${browseState.count} · 지금까지 ${browseState.matches.length}건 일치`)
  }
  renderBrowse()
}

/** text 에서 terms 중 하나와 같은 부분(대소문자 무시)을 <mark> 로 감싼 노드 목록. */
function highlighted (text, terms) {
  if (!terms.length) return [document.createTextNode(text)]
  const nodes = []
  const lower = text.toLowerCase()
  let from = 0
  for (;;) {
    let at = -1
    let length = 0
    for (const term of terms) {
      const i = lower.indexOf(term, from)
      if (i !== -1 && (at === -1 || i < at || (i === at && term.length > length))) {
        at = i
        length = term.length
      }
    }
    if (at === -1) break
    if (at > from) nodes.push(document.createTextNode(text.slice(from, at)))
    const mark = document.createElement('mark')
    mark.textContent = text.slice(at, at + length)
    nodes.push(mark)
    from = at + length
  }
  if (from < text.length) nodes.push(document.createTextNode(text.slice(from)))
  return nodes
}

/** → "2026-11-12 (목) 17:00 ~ 18:15" */
function logWhen (log) {
  const day = log.date ? `${log.date} (${'일월화수목금토'[fromISO(log.date).getDay()]})` : ''
  const time = log.startTime ? (log.endTime ? `${log.startTime} ~ ${log.endTime}` : log.startTime) : ''
  return [day, time].filter(Boolean).join(' ')
}

/** "2026-11-12" → "11-12 (목)" */
function shortDay (iso) {
  return iso ? `${iso.slice(5)} (${'일월화수목금토'[fromISO(iso).getDay()]})` : ''
}

/** 본문에서 검색어가 든 줄을 최대 limit 개. 검색어가 없으면 첫 줄. 긴 줄은 첫 일치 주변만 자른다. */
function snippetLines (log, terms, limit = 2) {
  const lines = (log.text || '').split('\n').map((line) => line.replace(/^\s*(?:[-*]|\d+\.|#+|>)\s*/, '').trim()).filter(Boolean)
  if (!terms.length) return lines.slice(0, 1)
  const out = []
  for (const line of lines) {
    const lower = line.toLowerCase()
    const at = Math.min(...terms.map((term) => { const i = lower.indexOf(term); return i === -1 ? Infinity : i }))
    if (at === Infinity) continue
    out.push(at > 24 ? '…' + line.slice(at - 16) : line)
    if (out.length >= limit) break
  }
  return out
}

/** 왼쪽 목록 한 줄: 일자 · 제목 · 일치한 본문 줄 */
function browseRow (log, terms) {
  const row = document.createElement('button')
  row.type = 'button'
  row.className = 'browse-row' + (log.id === browseState.selected ? ' active' : '')
  row.dataset.id = log.id

  const head = document.createElement('span')
  head.className = 'browse-row-head'
  head.append(spanWith('browse-row-day', shortDay(log.date)))
  const name = document.createElement('span')
  name.className = 'browse-row-name'
  name.append(...highlighted(shortLogName(log) || '(제목 없음)', terms))
  head.append(name)
  if (log.presentation) head.append(spanWith('chip browse-badge', '발표'))
  row.append(head)

  for (const line of snippetLines(log, terms)) {
    const snippet = document.createElement('span')
    snippet.className = 'browse-row-snippet'
    snippet.append(...highlighted(line, terms))
    row.append(snippet)
  }

  row.addEventListener('click', () => selectBrowse(log.id))
  return row
}

/** 오른쪽: 고른 로그 전체. 첫 일치 위치로 스크롤한다. */
function renderBrowseDetail () {
  const terms = browseState.terms
  const log = browseState.matches.find((l) => l.id === browseState.selected)
  browseState.markIndex = -1
  browseEl.detail.dataset.id = String(browseState.selected)
  browseEl.detail.dataset.terms = terms.join(' ')

  if (!log) {
    const empty = document.createElement('p')
    empty.className = 'empty muted'
    empty.textContent = browseState.project ? '왼쪽에서 로그를 고르세요.' : '프로젝트를 고르면 로그가 여기 나옵니다.'
    browseEl.detail.replaceChildren(empty)
    return
  }

  const head = document.createElement('div')
  head.className = 'browse-head'
  const title = document.createElement('button')
  title.type = 'button'
  title.className = 'browse-title'
  title.title = `${log.name}\n웹에서 이 로그 열기`
  title.append(...highlighted(shortLogName(log) || '(제목 없음)', terms))
  title.addEventListener('click', () => window.api.archive.openLog(log.id))
  head.append(title)
  if (log.presentation) head.append(spanWith('chip browse-badge', '발표'))
  head.append(Object.assign(document.createElement('span'), { className: 'spacer' }))

  // 일치 위치 이동 (검색 중일 때만)
  const nav = document.createElement('span')
  nav.className = 'browse-nav'
  if (terms.length) {
    const prev = document.createElement('button')
    prev.className = 'icon'
    prev.title = '이전 일치 (Shift+Enter)'
    prev.textContent = '‹'
    prev.addEventListener('click', () => moveMark(-1))
    const next = document.createElement('button')
    next.className = 'icon'
    next.title = '다음 일치 (Enter)'
    next.textContent = '›'
    next.addEventListener('click', () => moveMark(1))
    const count = spanWith('browse-nav-count muted', '')
    nav.append(prev, count, next)
  }
  head.append(nav)

  const people = [...new Set([...log.managers, ...log.participants])]
  const meta = document.createElement('div')
  meta.className = 'browse-meta'
  meta.append(...highlighted([logWhen(log), people.join(', ')].filter(Boolean).join(' · '), terms))

  const nodes = [head, meta]
  if (log.tags.length) {
    const tags = document.createElement('div')
    tags.className = 'browse-tags'
    for (const tag of log.tags) {
      const chip = document.createElement('span')
      chip.className = 'chip'
      chip.append(...highlighted('#' + tag, terms))
      tags.append(chip)
    }
    nodes.push(tags)
  }

  const body = document.createElement('div')
  body.className = 'browse-text'
  body.append(...highlighted(log.text || '(본문 없음)', terms))
  nodes.push(body)

  browseEl.detail.replaceChildren(...nodes)
  browseEl.detail.scrollTop = 0
  if (terms.length) moveMark(1)
}

/** 오른쪽 본문에서 다음(+1)/이전(-1) 일치로 이동한다. 본문 안의 일치를 먼저 보여주려고 제목·메타 일치는 건너뛴다. */
function moveMark (delta) {
  const marks = [...browseEl.detail.querySelectorAll('.browse-text mark, .browse-tags mark')]
  const all = marks.length ? marks : [...browseEl.detail.querySelectorAll('mark')]
  const count = browseEl.detail.querySelector('.browse-nav-count')
  if (!all.length) {
    if (count) count.textContent = '본문 일치 없음'
    return
  }
  const index = browseState.markIndex === -1 && delta > 0
    ? 0
    : (browseState.markIndex + delta + all.length) % all.length
  browseState.markIndex = index
  for (const mark of all) mark.classList.remove('current')
  all[index].classList.add('current')
  all[index].scrollIntoView({ block: 'center' })
  if (count) count.textContent = `${index + 1} / ${all.length}`
}

function selectBrowse (id) {
  browseState.selected = id
  for (const row of browseEl.list.querySelectorAll('.browse-row')) {
    const active = String(row.dataset.id) === String(id)
    row.classList.toggle('active', active)
    if (active) row.scrollIntoView({ block: 'nearest' })
  }
  renderBrowseDetail()
}

/** 목록에서 위(-1)/아래(+1) 로그로. 아직 그리지 않은 곳이면 더 그린다. */
function stepBrowse (delta) {
  const { matches } = browseState
  if (!matches.length) return
  const at = matches.findIndex((l) => l.id === browseState.selected)
  const next = Math.max(0, Math.min(matches.length - 1, at + delta))
  if (next >= browseState.shown) {
    browseState.shown += BROWSE_SHOW_STEP
    browseState.selected = matches[next].id
    renderBrowse()
    return
  }
  selectBrowse(matches[next].id)
}

function renderBrowse () {
  const { matches, shown, terms } = browseState

  // 고른 로그가 결과에서 빠졌으면 첫 결과를 고른다.
  if (!matches.some((l) => l.id === browseState.selected)) {
    browseState.selected = matches.length ? matches[0].id : null
  }

  const nodes = matches.slice(0, shown).map((log) => browseRow(log, terms))

  if (!nodes.length && browseState.project && !browseState.loading) {
    const empty = document.createElement('p')
    empty.className = 'empty muted'
    empty.textContent = terms.length ? '검색 결과가 없습니다.' : '이 프로젝트에는 로그가 없습니다.'
    nodes.push(empty)
  }

  if (matches.length > shown) {
    const more = document.createElement('button')
    more.className = 'ghost browse-more'
    more.textContent = `더 보기 (${shown} / ${matches.length})`
    more.addEventListener('click', () => {
      browseState.shown += BROWSE_SHOW_STEP
      renderBrowse()
    })
    nodes.push(more)
  }

  browseEl.list.replaceChildren(...nodes)

  // 받는 중에 목록만 늘어난 경우 오른쪽은 다시 그리지 않는다 (읽던 위치 유지).
  if (browseEl.detail.dataset.id !== String(browseState.selected) || browseEl.detail.dataset.terms !== terms.join(' ')) {
    renderBrowseDetail()
  }
}

makePicker({
  input: browseEl.project,
  list: browseEl.projectPick,
  source: projectSource,
  onPick: (project) => {
    browseEl.project.value = project.name
    loadBrowse()
    browseEl.search.focus()
  }
})

for (const button of browseEl.modes.querySelectorAll('.scope')) {
  button.addEventListener('click', () => {
    if (state.logMode !== button.dataset.mode) setLogMode(button.dataset.mode)
  })
}
// 입력하는 대로 거른다 (서버 호출 없음).
browseEl.search.addEventListener('input', () => {
  clearTimeout(browseState.filterTimer)
  browseState.filterTimer = setTimeout(() => filterBrowse(), BROWSE_FILTER_DELAY)
})
// 검색 칸: Enter / Shift+Enter = 오른쪽 본문의 다음/이전 일치
browseEl.search.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return
  event.preventDefault()
  const pending = browseEl.search.value.toLowerCase().split(/\s+/).filter(Boolean).join(' ') !== browseState.terms.join(' ')
  clearTimeout(browseState.filterTimer)
  if (pending) filterBrowse()
  else moveMark(event.shiftKey ? -1 : 1)
})

// 검색 화면 어디서든: ↑↓ = 이전/다음 로그, PageUp/PageDown = 오른쪽 본문 넘기기.
// 프로젝트 칸은 고르기 목록이 ↑↓ 를 쓰므로 뺀다.
document.addEventListener('keydown', (event) => {
  if (state.view !== 'log' || state.logMode !== 'browse' || browseEl.panel.classList.contains('hidden')) return
  if (event.ctrlKey || event.metaKey || event.altKey) return
  if (event.target === browseEl.project) return

  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const fromList = browseEl.list.contains(document.activeElement)
    stepBrowse(event.key === 'ArrowDown' ? 1 : -1)
    // 목록에 포커스가 있었으면 따라가게 한다 (Tab 으로 들어온 경우).
    const active = fromList && browseEl.list.querySelector('.browse-row.active')
    if (active) active.focus()
  } else if (event.key === 'PageDown' || event.key === 'PageUp') {
    event.preventDefault()
    const step = browseEl.detail.clientHeight * 0.85
    browseEl.detail.scrollBy({ top: event.key === 'PageDown' ? step : -step })
  }
})
browseEl.reload.addEventListener('click', () => loadBrowse())
browseEl.openProject.addEventListener('click', () => window.api.archive.openProject(browseEl.project.value.trim()))

// ------------------------------------------------------------ 공지

/** 서버 notice.current_week_notice 를 헤더 아래 한 줄로. 비어 있으면 숨긴다. */
function renderNotice (result) {
  state.notice = normalizeLines(result && result.notice && result.notice.current_week_notice)
  el.noticeText.textContent = state.notice.join('\n')
  el.notice.classList.toggle('hidden', state.view === 'log' || state.view === 'car' || !state.notice.length)
}

// ------------------------------------------------------------ 팀 보기 (읽기 전용)

/** 부서 응답의 구성원 행을 전부 들고 있는다. 고른 사람이 응답에 없으면 첫 사람으로. */
function storeTeam (result) {
  const rows = (result && Array.isArray(result.weekly_task_logs_list) ? result.weekly_task_logs_list : [])
    .filter((row) => row && row.user_pk !== undefined)
  state.team.rows = rows
  state.team.myPk = result && result.user_data ? result.user_data.pk : null
  if (!rows.some((row) => row.user_pk === state.team.selected)) {
    state.team.selected = rows.length ? rows[0].user_pk : null
  }
}

function selectTeamMember (pk) {
  state.team.selected = pk
  window.api.setSettings({ teamMember: pk })
  renderTeam()
}

function renderTeam () {
  const { rows, myPk, selected } = state.team
  el.teamList.replaceChildren()
  el.teamDays.replaceChildren()

  if (!rows.length) {
    const empty = document.createElement('p')
    empty.className = 'muted empty'
    empty.textContent = '이 부서에 구성원 업무가 없습니다. 부서 코드를 확인하세요.'
    el.teamDays.append(empty)
    return
  }

  // 파트(part)별로 묶어 서버 순서대로 나열한다.
  let lastPart = null
  for (const row of rows) {
    const part = row.part || '기타'
    if (part !== lastPart) {
      el.teamList.append(spanWith('part', part))
      lastPart = part
    }
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'member' + (row.user_pk === selected ? ' active' : '')
    button.append(spanWith('member-name', row.name || String(row.user_pk)))
    if (row.user_pk === myPk) button.append(spanWith('me', '나'))
    button.addEventListener('click', () => selectTeamMember(row.user_pk))
    el.teamList.append(button)
  }

  const row = rows.find((item) => item.user_pk === selected) || rows[0]
  const byDate = new Map()
  for (const log of row.current_week_task_log || []) {
    if (log && log.date) byDate.set(log.date, log)
  }

  const today = toISO(new Date())
  DAY_NAMES.forEach((name, index) => {
    const date = addDays(state.monday, index)
    const log = byDate.get(date)
    const day = makeDay(date, name, log)

    const card = document.createElement('section')
    card.className = 'day' + (date === today ? ' today' : '')

    const head = document.createElement('div')
    head.className = 'day-head'
    head.append(spanWith('name', name), spanWith('date', date.slice(5)), spanWith('state', row.name || ''))

    const body = document.createElement('div')
    body.className = 'day-body'
    body.append(readOnlyBlock('ro-editor', day.text), readOnlyBlock('ro-status', day.statusText))

    const meta = buildMeta(day)
    card.append(head)
    if (meta) card.append(meta)
    card.append(body)
    el.teamDays.append(card)
  })
}

/** 편집 칸과 같은 타이포로 그리는 읽기 전용 블록. */
function readOnlyBlock (className, text) {
  const pre = document.createElement('pre')
  pre.className = className
  if (text.trim()) {
    pre.textContent = text
  } else {
    pre.append(spanWith('placeholder', className === 'ro-status' ? '' : '(비어 있음)'))
  }
  return pre
}

// ------------------------------------------------------------ 차량 예약 달력 (읽기 전용)

const CAR_WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토']
const CAR_NAMES = ['아반떼', '투싼']
const CAR_REFRESH_AGE = 60 * 1000   // 창 포커스 때 이보다 오래된 목록만 다시 받는다

const carEl = {
  panel: document.getElementById('carPanel'),
  view: document.getElementById('carView'),
  auth: document.getElementById('carAuth'),
  login: document.getElementById('carLogin'),
  month: document.getElementById('carMonth'),
  meta: document.getElementById('carMeta'),
  grid: document.getElementById('carGrid'),
  detail: document.getElementById('carDetail')
}

const carState = {
  month: toISO(new Date()).slice(0, 7),   // 'YYYY-MM'
  selected: toISO(new Date()),
  list: [],            // main 의 vehicles.parseReservations() 결과
  byDate: new Map(),   // 'YYYY-MM-DD' -> 그날 걸친 예약[]
  loadedAt: 0,
  loading: false,
  meta: ''
}

function carClass (car) {
  return car === '아반떼' ? 'avante' : car === '투싼' ? 'tucson' : 'other'
}

/** 여러 날 걸친 예약은 걸친 날마다 넣는다. */
function indexCars (list) {
  const byDate = new Map()
  for (const item of list) {
    for (let date = item.start; date <= item.end; date = addDays(date, 1)) {
      if (!byDate.has(date)) byDate.set(date, [])
      byDate.get(date).push(item)
    }
  }
  return byDate
}

async function enterCarPanel () {
  renderCars()
  await loadCars({ maxAge: CAR_REFRESH_AGE })
}

async function loadCars ({ silent = false, maxAge = 0 } = {}) {
  if (carState.loading) return
  if (maxAge && carState.loadedAt && Date.now() - carState.loadedAt < maxAge) return
  carState.loading = true
  if (!silent) setStatus('차량 예약 현황 불러오는 중…')
  try {
    const res = await window.api.archive.vehicles()
    if (!res.ok) {
      const needLogin = res.code === 'AUTH_REQUIRED'
      carEl.auth.classList.toggle('hidden', !needLogin)
      carEl.view.classList.toggle('hidden', needLogin)
      if (!silent || needLogin) setStatus(needLogin ? '아카이브 로그인 필요' : res.message, needLogin ? undefined : 'error')
      return
    }
    carEl.auth.classList.add('hidden')
    carEl.view.classList.remove('hidden')
    carState.list = res.reservations || []
    carState.byDate = indexCars(carState.list)
    carState.loadedAt = Date.now()
    carState.meta = res.modifiedBy ? `위키 수정 ${res.modifiedBy} · ${res.modifiedAt}` : ''
    renderCars()
    if (!silent) setStatus(`차량 예약 ${carState.list.length}건`, 'ok')
  } finally {
    carState.loading = false
  }
}

function shiftCarMonth (delta) {
  const [y, m] = carState.month.split('-').map(Number)
  carState.month = toISO(new Date(y, m - 1 + delta, 1)).slice(0, 7)
  renderCars()
}

function selectCarDate (date) {
  carState.selected = date
  carState.month = date.slice(0, 7)
  renderCars()
}

/** 예약 한 건의 시각 범위. 여러 날이면 날짜도 붙인다. */
function carTimeRange (item) {
  const at = (date, time) => ((item.start === item.end ? '' : date.slice(5).replace('-', '/') + ' ') + (time || '')).trim()
  const from = at(item.start, item.startTime)
  const to = at(item.end, item.endTime)
  return from || to ? `${from || '?'} – ${to || '?'}` : '시각 미기재'
}

function renderCars () {
  const [y, m] = carState.month.split('-').map(Number)
  carEl.month.textContent = `${y}년 ${m}월`
  carEl.meta.textContent = carState.meta

  // 달 첫날이 든 주의 일요일부터 6주를 그린다.
  const first = new Date(y, m - 1, 1)
  const gridStart = addDays(toISO(first), -first.getDay())
  const today = toISO(new Date())

  carEl.grid.replaceChildren()
  CAR_WEEKDAYS.forEach((name, index) => {
    carEl.grid.append(spanWith('car-weekday' + (index === 0 ? ' sun' : index === 6 ? ' sat' : ''), name))
  })

  for (let i = 0; i < 42; i++) {
    const date = addDays(gridStart, i)
    const cell = document.createElement('button')
    cell.type = 'button'
    cell.className = 'car-cell' +
      (date.slice(0, 7) !== carState.month ? ' outside' : '') +
      (date === today ? ' today' : '') +
      (date === carState.selected ? ' selected' : '') +
      (i % 7 === 0 ? ' sun' : i % 7 === 6 ? ' sat' : '')
    cell.append(spanWith('car-day', String(Number(date.slice(8)))))

    for (const item of carState.byDate.get(date) || []) {
      const lead = item.start !== date ? '↳' : item.startTime || ''
      const chip = spanWith('car-chip ' + carClass(item.car), `${lead} ${item.car || '미지정'} ${item.driver}`.trim())
      chip.title = `${item.car || '차량 미지정'} · ${item.driver}\n${carTimeRange(item)}\n${item.place}\n${item.purpose}`
      cell.append(chip)
    }

    cell.addEventListener('click', () => selectCarDate(date))
    carEl.grid.append(cell)
  }

  renderCarDetail()
}

function renderCarDetail () {
  const date = carState.selected
  const items = carState.byDate.get(date) || []
  carEl.detail.replaceChildren()

  const [y, m, d] = date.split('-').map(Number)
  carEl.detail.append(spanWith('car-detail-date', `${m}월 ${d}일 (${CAR_WEEKDAYS[new Date(y, m - 1, d).getDay()]})`))

  // 차량별로 비었는지 한 줄로. 미지정(차량 열이 없던 지난 표) 예약은 어느 차인지 몰라 따지지 않는다.
  const free = document.createElement('div')
  free.className = 'car-free'
  for (const car of CAR_NAMES) {
    const count = items.filter((item) => item.car === car).length
    free.append(spanWith('car-chip ' + (count ? carClass(car) : 'free'), count ? `${car} 예약 ${count}건` : `${car} 비어 있음`))
  }
  carEl.detail.append(free)

  if (!items.length) {
    carEl.detail.append(spanWith('muted empty', '이 날 예약이 없습니다.'))
    return
  }

  for (const item of items) {
    const card = document.createElement('div')
    card.className = 'car-item ' + carClass(item.car)

    const title = document.createElement('div')
    title.className = 'car-item-title'
    title.append(spanWith('car-badge ' + carClass(item.car), item.car || '미지정'), spanWith('car-time', carTimeRange(item)))
    card.append(title)

    const rows = [
      ['운전자', item.driver],
      ['출장지', item.place],
      ['목적', item.purpose],
      ['주차', item.parking],
      ['차키 인수', item.keeper],
      ['신청일', item.requested]
    ]
    const list = document.createElement('dl')
    for (const [label, value] of rows) {
      if (!value || value === '-') continue
      const dt = document.createElement('dt')
      dt.textContent = label
      const dd = document.createElement('dd')
      dd.textContent = value
      list.append(dt, dd)
    }
    card.append(list)
    carEl.detail.append(card)
  }
}

document.getElementById('carPrev').addEventListener('click', () => shiftCarMonth(-1))
document.getElementById('carNext').addEventListener('click', () => shiftCarMonth(1))
document.getElementById('carThisMonth').addEventListener('click', () => selectCarDate(toISO(new Date())))
document.getElementById('carRefresh').addEventListener('click', () => loadCars())
document.getElementById('carOpenWeb').addEventListener('click', () => window.api.archive.openVehicles())
carEl.login.addEventListener('click', async () => {
  if (await window.api.archive.login()) loadCars()
})

// ------------------------------------------------------------ 전역 단축키

/** 트레이/전역 단축키로 창을 띄운 뒤 오늘 칸에 커서를 둔다. 다른 주를 보고 있었으면 이번 주로 돌아온다. */
window.api.onFocusToday(async () => {
  if (state.view === 'log') {
    logEl.text.focus()
    return
  }
  if (state.view === 'team' || state.view === 'car') await setView('week')

  const wanted = mondayOf(fromISO(focusDate()))
  if (state.monday !== wanted) {
    state.monday = wanted
    await loadWeek({ preserveDirty: true })
  }

  const target = focusDate()
  const day = state.days.find((item) => item.date === target) || state.days.find((item) => item.el)
  if (!day || !day.el) return
  const editor = day.el.editor
  editor.focus()
  editor.setSelectionRange(editor.value.length, editor.value.length)
})

// ------------------------------------------------------------ 자동 업데이트 토스트

let dismissedUpdate = null   // "나중에" 를 누른 버전. 이번 실행 동안만 숨긴다

/** 메인 프로세스가 보내는 업데이트 상태로 창 우측 하단 토스트를 그린다. */
function renderUpdate (update) {
  if (!update) return
  const show = (update.status === 'downloaded' || update.status === 'available') &&
    update.version !== dismissedUpdate
  el.updateToast.classList.toggle('hidden', !show)
  if (!show) return

  if (update.status === 'downloaded') {
    el.updateTitle.textContent = `v${update.version} 설치 준비 완료`
    el.updateText.textContent = '지금 재시작하면 바로 적용됩니다. 그냥 두면 다음 종료 때 설치됩니다.'
    el.updateAction.textContent = '지금 재시작'
    el.updateAction.onclick = () => window.api.update.install()
  } else {
    el.updateTitle.textContent = `새 버전 v${update.version}`
    el.updateText.textContent = update.canInstall
      ? '새 버전이 나왔습니다.'
      : '이 환경은 자동 설치가 되지 않습니다. 직접 내려받아 바꿔 주세요.'
    el.updateAction.textContent = '다운로드 페이지 열기'
    el.updateAction.onclick = () => window.api.update.openReleases()
  }

  el.updateDismiss.onclick = () => {
    dismissedUpdate = update.version
    el.updateToast.classList.add('hidden')
  }
}

window.api.update.onState(renderUpdate)

// ------------------------------------------------------------ 시작

async function start () {
  // 화면에 박힌 단축키 표기를 플랫폼에 맞춘다.
  if (MOD !== 'Ctrl') {
    for (const node of document.querySelectorAll('kbd, .hint')) {
      node.textContent = node.textContent.replace(/Ctrl/g, MOD)
    }
  }

  const config = await window.api.getSettings()
  state.department = config.department || 'bs'
  state.widget = Boolean(config.widget)
  state.view = ['today', 'log', 'team', 'car'].includes(config.view) ? config.view : 'week'
  state.logProject = config.logProject || ''
  state.logMode = config.logMode === 'browse' ? 'browse' : 'write'
  syncLogModeButtons()
  state.team.selected = config.teamMember ?? null
  el.department.value = state.department

  if (state.view === 'today') state.monday = mondayOf(fromISO(focusDate()))
  applyView()

  // 위젯 모드에서는 프레임이 없으므로 헤더를 드래그 영역으로 쓰고 닫기 버튼을 노출한다.
  document.body.classList.toggle('widget', state.widget)
  document.getElementById('toggleWidget').textContent = state.widget ? '창 모드' : '위젯'
  document.getElementById('hideWindow').classList.toggle('hidden', !state.widget)

  renderHeader()
  window.api.update.getState().then(renderUpdate)

  if (state.view === 'log') enterLogPanel()
  if (state.view === 'car') enterCarPanel()

  if (await window.api.checkAuth()) {
    await loadWeek({ silent: state.view === 'log' })
  } else {
    showOverlay('로그인이 필요합니다.', '로그인', doLogin)
    setStatus('로그인 필요')
  }
}

// ------------------------------------------------------------ 연락처 QR

const contactsEl = {
  modal: document.getElementById('contactsModal'),
  scope: document.querySelector('#contactsModal .contacts-scope'),
  qr: document.getElementById('contactsQrImage'),
  text: document.getElementById('contactsText'),
  url: document.getElementById('contactsUrl'),
  retry: document.getElementById('contactsRetry'),
  close: document.getElementById('contactsClose')
}
const contactsState = { scope: 'team', open: false, timer: null, expiresAt: 0 }

function contactsScopeLabel () {
  return contactsState.scope === 'team' ? `${state.department.toUpperCase()} 부서` : '전 직원'
}

function renderContactsScope () {
  for (const button of contactsEl.scope.querySelectorAll('.scope')) {
    button.classList.toggle('active', button.dataset.scope === contactsState.scope)
  }
}

function setContactsMessage (text, isError) {
  contactsEl.text.textContent = text
  contactsEl.text.classList.toggle('error', Boolean(isError))
  contactsEl.retry.classList.toggle('hidden', !isError)
}

function stopContactsTimer () {
  if (contactsState.timer) clearInterval(contactsState.timer)
  contactsState.timer = null
}

/** 남은 시간을 1초마다 갱신하고, 만료되면 서버가 이미 내려갔으니 안내만 바꾼다. */
function startContactsTimer (count, skipped) {
  stopContactsTimer()
  const tick = () => {
    const left = Math.max(0, contactsState.expiresAt - Date.now())
    if (!left) {
      stopContactsTimer()
      contactsEl.qr.classList.add('hidden')
      contactsEl.url.classList.add('hidden')
      setContactsMessage('공유 시간이 끝났습니다. 다시 시도를 누르면 새 QR 을 만듭니다.', true)
      return
    }
    const m = Math.floor(left / 60000)
    const s = String(Math.floor((left % 60000) / 1000)).padStart(2, '0')
    const skippedText = skipped ? `\n연락처가 없는 ${skipped}명은 빠졌습니다.` : ''
    setContactsMessage(`${contactsScopeLabel()} ${count}명 · ${m}:${s} 뒤 만료${skippedText}`, false)
  }
  tick()
  contactsState.timer = setInterval(tick, 1000)
}

async function loadContacts () {
  stopContactsTimer()
  contactsEl.qr.classList.add('hidden')
  contactsEl.url.classList.add('hidden')
  setContactsMessage('조직 현황을 불러오는 중…', false)

  const response = await window.api.contacts.start(contactsState.scope, state.department, contactsScopeLabel(), state.team.myPk)
  if (!contactsState.open) { window.api.contacts.stop(); return }   // 기다리는 동안 닫았으면 바로 내린다

  if (!response.ok) {
    if (response.code === 'AUTH_REQUIRED') {
      closeContacts()
      showOverlay('로그인이 필요합니다.', '로그인', doLogin)
      return
    }
    setContactsMessage(response.message || '연락처를 만들지 못했습니다.', true)
    return
  }

  contactsEl.qr.src = response.qr
  contactsEl.qr.classList.remove('hidden')
  contactsEl.url.textContent = response.url
  contactsEl.url.classList.remove('hidden')
  contactsState.expiresAt = response.expiresAt
  startContactsTimer(response.count, response.skipped)
}

function openContacts () {
  contactsState.open = true
  renderContactsScope()
  contactsEl.modal.classList.remove('hidden')
  loadContacts()
}

function closeContacts () {
  contactsState.open = false
  stopContactsTimer()
  contactsEl.modal.classList.add('hidden')
  contactsEl.qr.removeAttribute('src')
  window.api.contacts.stop()
}

document.getElementById('contactsQr').addEventListener('click', openContacts)
contactsEl.close.addEventListener('click', closeContacts)
contactsEl.retry.addEventListener('click', loadContacts)
contactsEl.scope.addEventListener('click', (event) => {
  const button = event.target.closest('.scope')
  if (!button || button.dataset.scope === contactsState.scope) return
  contactsState.scope = button.dataset.scope
  renderContactsScope()
  loadContacts()
})
contactsEl.modal.addEventListener('click', (event) => {
  if (event.target === contactsEl.modal) closeContacts()
})
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && contactsState.open) closeContacts()
})

start()
