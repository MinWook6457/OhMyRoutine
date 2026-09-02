'use strict'

const fs = require('fs')
const path = require('path')
const { app, BrowserWindow, Menu, Tray, ipcMain, shell, nativeImage, dialog } = require('electron')

const api = require('./api')
const archive = require('./archive')
const logblocks = require('./logblocks')
const settings = require('./settings')

const isMac = process.platform === 'darwin'

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

  return { ...options, backgroundColor: '#ffffff', alwaysOnTop: config.alwaysOnTop }
}

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

    loginWindow = new BrowserWindow({
      width: 520,
      height: 720,
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
    { label: '열기', click: showMainWindow },
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
    { label: '종료', click: () => { quitting = true; app.quit() } }
  ]))
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
  api.appSession().setUserAgent(api.USER_AGENT)

  const config = settings.load()
  applyAutoLaunch(config.autoLaunch)

  createMainWindow()
  buildTray()
  refreshBookmarks()

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
})

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
