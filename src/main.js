'use strict'

const fs = require('fs')
const path = require('path')
const { app, BrowserWindow, Menu, Tray, ipcMain, shell, nativeImage, dialog, globalShortcut, nativeTheme } = require('electron')

const api = require('./api')
const archive = require('./archive')
const contacts = require('./contacts')
const logblocks = require('./logblocks')
const settings = require('./settings')
const updater = require('./updater')

const isMac = process.platform === 'darwin'

/** 어느 창에서든 앱을 띄우고 오늘 칸에 커서를 두는 전역 단축키. 이미 떠 있고 포커스가 있으면 숨긴다. */
const GLOBAL_SHORTCUT = 'CommandOrControl+Alt+R'

const THEMES = [
  ['system', '시스템 설정 따름'],
  ['light', '라이트'],
  ['dark', '다크']
]

let mainWindow = null
let loginWindow = null
let tray = null
let quitting = false
let swapping = false   // 모드 전환으로 창을 다시 만드는 중

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showMainWindow)
}

// ---------------------------------------------------------------- 창

function windowOptions (config) {
  const saved = config.widget ? config.widgetBounds : config.bounds
  const fallback = config.widget
    ? { width: 380, height: 620 }
    : { width: 1080, height: 820 }

  const options = {
    ...fallback,
    ...(saved || {}),
    minWidth: 320,
    minHeight: 260,
    title: '주간 업무 일지',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  }

  if (config.widget) {
    // 바탕화면 위젯: 테두리 없는 반투명 창
    return {
      ...options,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      skipTaskbar: true,
      alwaysOnTop: config.alwaysOnTop
    }
  }

  return { ...options, backgroundColor: windowBackground(), alwaysOnTop: config.alwaysOnTop }
}

// ---------------------------------------------------------------- 테마

/**
 * nativeTheme.themeSource 를 바꾸면 렌더러의 prefers-color-scheme 와 네이티브 대화상자 색이 함께 바뀐다.
 * 렌더러 CSS 는 미디어 쿼리로 토큰만 갈아끼우므로 별도 IPC 가 필요 없다.
 */
function applyTheme (theme) {
  nativeTheme.themeSource = THEMES.some(([value]) => value === theme) ? theme : 'system'
}

/** 창이 그려지기 전 잠깐 보이는 배경색. CSS 의 --bg 와 같은 값. */
function windowBackground () {
  return nativeTheme.shouldUseDarkColors ? '#1b1d22' : '#ffffff'
}

nativeTheme.on('updated', () => {
  if (!mainWindow || mainWindow.isDestroyed() || settings.load().widget) return
  mainWindow.setBackgroundColor(windowBackground())
})

function createMainWindow () {
  const config = settings.load()
  mainWindow = new BrowserWindow(windowOptions(config))

  mainWindow.setMenuBarVisibility(false)
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  mainWindow.once('ready-to-show', () => mainWindow.show())

  if (config.alwaysOnTop) mainWindow.setAlwaysOnTop(true, 'floating')

  // 닫기는 트레이로 숨김 (종료는 트레이 메뉴)
  mainWindow.on('close', (event) => {
    if (quitting || swapping) return
    event.preventDefault()
    rememberBounds()
    mainWindow.hide()
  })

  mainWindow.on('moved', rememberBounds)
  mainWindow.on('resized', rememberBounds)
  mainWindow.on('focus', () => mainWindow.webContents.send('window:focused'))

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

function rememberBounds () {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return
  const config = settings.load()
  const bounds = mainWindow.getBounds()
  settings.save(config.widget ? { widgetBounds: bounds } : { bounds })
}

function showMainWindow () {
  if (!mainWindow || mainWindow.isDestroyed()) return createMainWindow()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/** frame/transparent 는 런타임에 못 바꾸므로 창을 새로 만든다. */
function applyWindowMode () {
  const previous = mainWindow
  swapping = true
  createMainWindow()
  if (previous && !previous.isDestroyed()) previous.destroy()
  swapping = false
  refreshTrayMenu()
}

/**
 * 실제 로그인 페이지를 같은 세션 파티션으로 띄운다. 성공하면 쿠키가 디스크에 남는다.
 * target 은 { BASE, checkAuth } 를 가진 api 또는 archive 모듈.
 */
function openLoginWindow (target = api) {
  return new Promise((resolve) => {
    if (loginWindow && !loginWindow.isDestroyed()) {
      loginWindow.focus()
      return resolve(false)
    }

    // routine 로그인 페이지는 좁은 창에서도 가운데 정렬되지만, archive 로그인 페이지는 1024px 고정 폭 레이아웃이라
    // 520px 창에서는 폼 오른쪽이 잘린다. 콘텐츠 폭을 1024 로 맞춰 준다.
    const size = target === archive
      ? { width: 1024, height: 700, useContentSize: true }
      : { width: 520, height: 720 }

    loginWindow = new BrowserWindow({
      ...size,
      center: true,
      title: target === archive ? 'inpleARCHIVE 로그인' : 'inpleROUTINE 로그인',
      autoHideMenuBar: true,
      webPreferences: {
        partition: api.PARTITION,
        contextIsolation: true,
        nodeIntegration: false
      }
    })

    loginWindow.webContents.setUserAgent(api.USER_AGENT)
    loginWindow.loadURL(`${target.BASE}/login`)

    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      clearInterval(poll)
      if (loginWindow && !loginWindow.isDestroyed()) loginWindow.destroy()
      loginWindow = null
      resolve(ok)
    }

    // SPA 라 URL 변화만으로는 확실하지 않아 프로필 API 로 성공을 판정한다.
    const poll = setInterval(async () => {
      try {
        if (await target.checkAuth()) finish(true)
      } catch { /* 네트워크 일시 오류는 무시하고 계속 폴링 */ }
    }, 1500)

    loginWindow.on('closed', () => finish(false))
  })
}

// ---------------------------------------------------------------- 트레이

function trayIcon () {
  if (isMac) {
    // 메뉴바용 템플릿 이미지(16px, @2x 자동 로드). 색은 시스템이 라이트/다크에 맞춰 칠한다.
    const icon = nativeImage.createFromPath(path.join(__dirname, 'renderer', 'trayTemplate.png'))
    icon.setTemplateImage(true)
    return icon
  }
  const icon = nativeImage.createFromPath(path.join(__dirname, 'renderer', 'icon.png'))
  return icon.isEmpty() ? nativeImage.createEmpty() : icon
}

function buildTray () {
  tray = new Tray(trayIcon())
  tray.setToolTip('주간 업무 일지')
  refreshTrayMenu()
  tray.on('click', showMainWindow)
}

function refreshTrayMenu () {
  if (!tray) return
  const config = settings.load()

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '열기', accelerator: GLOBAL_SHORTCUT, click: showMainWindow },
    { type: 'separator' },
    {
      label: '바탕화면 위젯 모드',
      type: 'checkbox',
      checked: config.widget,
      click: (item) => {
        settings.save({ widget: item.checked })
        applyWindowMode()
      }
    },
    {
      label: '항상 위에 표시',
      type: 'checkbox',
      checked: config.alwaysOnTop,
      click: (item) => {
        settings.save({ alwaysOnTop: item.checked })
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.setAlwaysOnTop(item.checked, 'floating')
        }
        refreshTrayMenu()
      }
    },
    {
      label: '테마',
      submenu: THEMES.map(([value, label]) => ({
        label,
        type: 'radio',
        checked: (config.theme || 'system') === value,
        click: () => {
          settings.save({ theme: value })
          applyTheme(value)
          refreshTrayMenu()
        }
      }))
    },
    {
      label: isMac ? '로그인 시 자동 실행' : 'Windows 시작 시 자동 실행',
      type: 'checkbox',
      checked: config.autoLaunch,
      click: (item) => {
        settings.save({ autoLaunch: item.checked })
        applyAutoLaunch(item.checked)
        refreshTrayMenu()
      }
    },
    { type: 'separator' },
    { label: '웹페이지 열기', click: () => shell.openExternal(`${api.BASE}/company/weeklyreport`) },
    { label: '아카이브 즐겨찾기', submenu: bookmarkMenu() },
    { type: 'separator' },
    updateMenuItem(),
    { label: `버전 ${app.getVersion()}`, enabled: false },
    { type: 'separator' },
    { label: '종료', click: () => { quitting = true; app.quit() } }
  ]))
}

// ---------------------------------------------------------------- 업데이트

/** 트레이 메뉴의 업데이트 항목. 상태에 따라 라벨과 동작이 바뀐다. */
function updateMenuItem () {
  const update = updater.current()
  switch (update.status) {
    case 'downloaded':
      return { label: `v${update.version} 설치 후 재시작`, click: installUpdate }
    case 'available':
      return { label: `v${update.version} 다운로드 페이지 열기`, click: () => updater.openReleases() }
    case 'downloading':
      return { label: `업데이트 내려받는 중… ${update.percent}%`, enabled: false }
    case 'disabled':
      return { label: '업데이트 확인 (개발 실행에서는 꺼짐)', enabled: false }
    default:
      return { label: '업데이트 확인…', click: checkUpdateInteractive }
  }
}

function installUpdate () {
  quitting = true
  rememberBounds()
  return updater.installNow()
}

/** 사용자가 직접 눌렀을 때는 결과를 대화상자로 보여준다. 정기 검사는 조용히 돈다. */
async function checkUpdateInteractive () {
  const result = await updater.checkNow()
  const update = updater.current()
  const parent = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() ? mainWindow : undefined

  if (!result.ok) {
    await dialog.showMessageBox(parent, {
      type: 'error',
      title: '업데이트 확인',
      message: '업데이트를 확인하지 못했습니다.',
      detail: result.message
    })
    return
  }

  if (!result.available) {
    await dialog.showMessageBox(parent, {
      type: 'info',
      title: '업데이트 확인',
      message: `최신 버전입니다. (v${app.getVersion()})`
    })
    return
  }

  if (update.canInstall) {
    // Windows 설치본: 이미 내려받는 중이거나 끝났다.
    if (update.status === 'downloaded') {
      const { response } = await dialog.showMessageBox(parent, {
        type: 'question',
        buttons: ['지금 재시작', '나중에'],
        defaultId: 0,
        cancelId: 1,
        title: '업데이트 준비 완료',
        message: `v${result.version} 설치 준비가 끝났습니다.`,
        detail: '지금 재시작하면 바로 설치됩니다. 나중에 눌러도 다음 종료 때 자동으로 설치됩니다.'
      })
      if (response === 0) installUpdate()
      return
    }
    await dialog.showMessageBox(parent, {
      type: 'info',
      title: '업데이트 확인',
      message: `v${result.version} 을 내려받는 중입니다.`,
      detail: '끝나면 알림이 뜹니다. 계속 사용하셔도 됩니다.'
    })
    return
  }

  const { response } = await dialog.showMessageBox(parent, {
    type: 'info',
    buttons: ['다운로드 페이지 열기', '닫기'],
    defaultId: 0,
    cancelId: 1,
    title: '새 버전',
    message: `v${result.version} 이 나왔습니다. (현재 v${app.getVersion()})`,
    detail: isMac
      ? 'Mac 은 코드 서명이 없어 자동 설치가 되지 않습니다. dmg 를 내려받아 덮어쓰세요.'
      : '무설치 버전은 자동 설치가 되지 않습니다. 새 exe 를 내려받아 바꾸세요.'
  })
  if (response === 0) updater.openReleases()
}

// ---------------------------------------------------------------- 아카이브 즐겨찾기

let bookmarks = settings.load().archiveBookmarks || []
let bookmarksLoading = null

/** 즐겨찾기 목록을 다시 받아 트레이 메뉴를 갱신한다. 실패하면 마지막 목록을 그대로 둔다. */
function refreshBookmarks () {
  if (bookmarksLoading) return bookmarksLoading
  bookmarksLoading = (async () => {
    try {
      bookmarks = await archive.bookmarkedProjects()
      dumpArchive('bookmarks', { bookmarks, raw: archive.lastRaw.bookmarks })
      settings.save({ archiveBookmarks: bookmarks })
      refreshTrayMenu()
      return { ok: true, bookmarks }
    } catch (error) {
      dumpArchive('bookmarks', { error: error.message, code: error.code || null, status: error.status || null })
      return { ok: false, code: error.code || null, message: error.message, bookmarks }
    } finally {
      bookmarksLoading = null
    }
  })()
  return bookmarksLoading
}

function bookmarkMenu () {
  const items = bookmarks.map((project) => ({
    label: project.name,
    click: () => shell.openExternal(archive.projectUrl(project.name))
  }))
  if (!items.length) {
    items.push({ label: '즐겨찾기한 프로젝트가 없습니다', enabled: false })
  }
  items.push(
    { type: 'separator' },
    { label: '새 로그 작성', click: () => openLogPanel() },
    { label: '목록 새로고침', click: () => refreshBookmarks() },
    { label: '아카이브 웹 열기', click: () => shell.openExternal(`${archive.BASE}/project`) }
  )
  return items
}

function openLogPanel () {
  showMainWindow()
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('view:set', 'log')
}

// ---------------------------------------------------------------- 시작

/** 로그인 시 자동 실행. macOS 는 args 를 무시하므로 wasOpenedAtLogin 으로 숨김 여부를 판정한다. */
function applyAutoLaunch (enabled) {
  app.setLoginItemSettings(isMac
    ? { openAtLogin: enabled }
    : { openAtLogin: enabled, args: ['--hidden'] })
}

/** 전역 단축키: 숨겨져 있거나 뒤에 있으면 앞으로 띄우고 오늘 칸에 커서, 이미 앞에 있으면 트레이로 숨긴다. */
function toggleFromShortcut () {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused()) {
    rememberBounds()
    mainWindow.hide()
    return
  }
  showMainWindow()
  if (!mainWindow || mainWindow.isDestroyed()) return
  const focusToday = () => mainWindow.webContents.send('view:focusToday')
  if (mainWindow.webContents.isLoading()) mainWindow.webContents.once('did-finish-load', focusToday)
  else focusToday()
}

function registerGlobalShortcut () {
  try {
    if (!globalShortcut.register(GLOBAL_SHORTCUT, toggleFromShortcut)) {
      console.warn(`전역 단축키 ${GLOBAL_SHORTCUT} 등록 실패: 다른 프로그램이 이미 쓰고 있습니다.`)
    }
  } catch (error) {
    console.warn('전역 단축키 등록 실패:', error.message)
  }
}

function shouldStartHidden () {
  if (process.argv.includes('--hidden')) return true
  if (!isMac) return false
  try {
    return Boolean(app.getLoginItemSettings().wasOpenedAtLogin)
  } catch {
    return false
  }
}

app.whenReady().then(() => {
  // 작업 표시줄 그룹/고정이 설치본 바로가기와 같은 앱으로 묶이도록 AppUserModelId 를 appId 와 맞춘다.
  if (process.platform === 'win32') app.setAppUserModelId('com.insilicogen.routine.weekly')

  api.appSession().setUserAgent(api.USER_AGENT)

  const config = settings.load()
  applyAutoLaunch(config.autoLaunch)
  applyTheme(config.theme)

  createMainWindow()
  buildTray()
  refreshBookmarks()
  registerGlobalShortcut()

  updater.setup({
    onState: (update) => {
      refreshTrayMenu()
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:state', update)
    },
    beforeQuit: () => { quitting = true }
  })

  if (shouldStartHidden() && mainWindow) {
    mainWindow.once('ready-to-show', () => mainWindow.hide())
  }
})

app.on('window-all-closed', () => {
  // 트레이 상주 앱이므로 종료하지 않는다.
})

// macOS: Dock 아이콘 클릭으로 숨긴 창을 다시 연다.
app.on('activate', showMainWindow)

app.on('before-quit', () => {
  quitting = true
  rememberBounds()
  contacts.stop()
})

app.on('will-quit', () => globalShortcut.unregisterAll())

// ---------------------------------------------------------------- IPC

ipcMain.handle('settings:get', () => settings.load())

ipcMain.handle('app:platform', () => process.platform)

ipcMain.handle('settings:set', (_event, patch) => {
  const next = settings.save(patch)
  refreshTrayMenu()
  return next
})

ipcMain.handle('auth:check', async () => {
  try {
    return await api.checkAuth()
  } catch {
    return false
  }
})

ipcMain.handle('auth:login', () => openLoginWindow())

ipcMain.handle('api:getWeek', async (_event, { monday, department }) => {
  try {
    const payload = await api.getWeek(monday, department)
    dumpResponse(payload.result)
    return { ok: true, ...payload }
  } catch (error) {
    return { ok: false, code: error.code || null, message: error.message }
  }
})

ipcMain.handle('api:saveDay', async (_event, { date, patch }) => {
  try {
    const body = await api.saveDay(date, patch)
    return { ok: true, message: (body && body.message) || '저장되었습니다.' }
  } catch (error) {
    return { ok: false, code: error.code || null, message: error.message }
  }
})

ipcMain.handle('app:openWeb', () => shell.openExternal(`${api.BASE}/company/weeklyreport`))

// ---------------------------------------------------------------- IPC: 연락처 QR

/**
 * 조직 현황 API 로 구성원을 받아 .vcf 공유 서버를 열고 QR 을 돌려준다.
 * 응답은 result.organization_list[] 이고 각 행에 department(부서 식별자, 예: 'BS') 가 있다.
 * scope 'team' 이면 앱의 부서 설정과 department 가 같은 사람만(대소문자 무시), 'all' 이면 전 직원.
 */
ipcMain.handle('contacts:start', async (_event, { scope, department, label, myPk }) => {
  try {
    const [{ members, raw }, me] = await Promise.all([api.getOrganization(), api.getProfile()])
    dumpArchive('organization', raw)   // 응답 모양 확인용 (last-archive-organization.json)
    if (!members.length) throw new Error('조직 현황 응답에서 구성원 목록을 찾지 못했습니다.')

    // 본인은 뺀다. 프로필의 username 과 주간 일지 user_data.pk 둘 중 하나라도 맞으면 본인으로 본다.
    const isMe = (m) => (me.username && String(m.username) === me.username) || (myPk != null && m.pk === myPk)
    // 프리랜서(외부 인력)도 뺀다. sub_text 는 "직급 / 직무 / 부서" 꼴이고 프리랜서는 직급 칸에 그대로 적혀 온다.
    const isFreelancer = (m) => String(m.sub_text || m.position || '').split('/')[0].trim() === '프리랜서'
    const others = members.filter((m) => !isMe(m) && !isFreelancer(m))
    let picked = others
    if (scope === 'team') {
      const wanted = String(department || '').trim().toLowerCase()
      picked = others.filter((m) => String(m.department || '').trim().toLowerCase() === wanted)
      if (!picked.length) {
        const known = [...new Set(members.map((m) => m.department).filter(Boolean))].sort().join(', ')
        throw new Error(`조직 현황에 '${department}' 부서가 없습니다. 있는 부서: ${known}`)
      }
    }
    const result = await contacts.start(picked, label || (scope === 'team' ? '부서' : '전 직원'))
    return { ok: true, ...result, total: members.length }
  } catch (error) {
    return { ok: false, code: error.code || null, message: error.message }
  }
})

ipcMain.handle('contacts:stop', async () => {
  await contacts.stop()
  return { ok: true }
})

ipcMain.handle('contacts:state', () => contacts.state())

// ---------------------------------------------------------------- IPC: 업데이트

ipcMain.handle('update:state', () => updater.current())
ipcMain.handle('update:check', () => checkUpdateInteractive())
ipcMain.handle('update:install', () => installUpdate())
ipcMain.handle('update:openReleases', () => updater.openReleases())

// ---------------------------------------------------------------- IPC: 아카이브

/** 아카이브 호출 공통 래퍼. 렌더러에는 { ok, ... } 로만 넘기고, 진단용으로 마지막 결과를 파일에 남긴다. */
async function archiveCall (label, fn) {
  try {
    const value = await fn()
    dumpArchive(label, value)
    return { ok: true, ...value }
  } catch (error) {
    dumpArchive(label, { error: error.message, code: error.code || null, status: error.status || null, serverCode: error.serverCode || null })
    return { ok: false, code: error.code || null, message: error.message }
  }
}

/** %APPDATA%/routine-weekly/last-archive-<label>.json */
function dumpArchive (label, value) {
  try {
    fs.writeFileSync(
      path.join(app.getPath('userData'), `last-archive-${label}.json`),
      JSON.stringify(value, null, 2),
      'utf8'
    )
  } catch { /* 진단용 */ }
}

ipcMain.handle('archive:check', () => archiveCall('check', async () => ({ authed: await archive.checkAuth() })))

ipcMain.handle('archive:login', async () => {
  const ok = await openLoginWindow(archive)
  if (ok) refreshBookmarks()
  return ok
})

ipcMain.handle('archive:bookmarks', () => refreshBookmarks())

ipcMain.handle('archive:searchProjects', (_event, keyword) =>
  archiveCall('searchProjects', async () => ({ projects: await archive.searchProjects(keyword) })))

ipcMain.handle('archive:logInput', (_event, project) =>
  archiveCall('logInput', async () => ({ input: await archive.logInput(project) })))

ipcMain.handle('archive:searchTags', (_event, keyword) =>
  archiveCall('searchTags', async () => ({ tags: await archive.searchTags(keyword) })))

ipcMain.handle('archive:createLog', (_event, form) => archiveCall('createLog', async () => {
  if (!logblocks.hasContent(form.text)) throw new Error('본문이 비어 있습니다.')
  const content = logblocks.textToBlocks(form.text)
  return archive.createLog({ ...form, content })
}))

ipcMain.handle('archive:openProject', (_event, name) =>
  shell.openExternal(name ? archive.projectUrl(name) : `${archive.BASE}/project`))

ipcMain.handle('app:setWidget', (_event, widget) => {
  settings.save({ widget: Boolean(widget) })
  applyWindowMode()
  return true
})

ipcMain.handle('app:hide', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    rememberBounds()
    mainWindow.hide()
  }
})

ipcMain.handle('app:confirm', async (_event, { title, message }) => {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['덮어쓰기', '취소'],
    defaultId: 1,
    cancelId: 1,
    title,
    message
  })
  return response === 0
})

/** 응답 구조 확인용 덤프. 내 업무 행을 못 찾을 때 이 파일을 보면 된다. */
function dumpResponse (result) {
  try {
    fs.writeFileSync(
      path.join(app.getPath('userData'), 'last-response.json'),
      JSON.stringify(result, null, 2),
      'utf8'
    )
  } catch { /* 진단용이므로 실패해도 무시 */ }
}
