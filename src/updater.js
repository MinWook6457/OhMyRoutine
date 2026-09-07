'use strict'

/**
 * GitHub Releases 기반 자동 업데이트 (electron-updater).
 *
 * 릴리스 워크플로가 설치 파일과 함께 올리는 latest.yml / latest-mac.yml 을 주기적으로 읽어
 * 지금 실행 중인 버전보다 높은 릴리스가 있으면 알린다.
 *
 *  - Windows 설치본(NSIS): 백그라운드로 내려받고, 끝나면 앱 안 우측 하단 토스트 + 트레이 메뉴로 알린다.
 *    "지금 재시작" 을 누르거나 앱을 종료하면 조용히 설치되고 다시 뜬다.
 *    운영체제(데스크톱) 알림은 쓰지 않는다. 창이 트레이에 숨어 있으면 트레이 메뉴 라벨로만 보인다.
 *  - Windows 무설치본(portable): 실행 중인 exe 를 스스로 바꿀 수 없어 새 버전 안내만 한다.
 *  - macOS: 코드 서명이 없어 Squirrel.Mac 이 설치를 거부하므로 안내 + Releases 페이지 열기만 한다.
 *  - 개발 실행(npm start)에서는 검사하지 않는다.
 */

const fs = require('fs')
const path = require('path')
const { app, shell } = require('electron')
const { autoUpdater } = require('electron-updater')

const RELEASES_URL = 'https://github.com/MinWook6457/OhMyRoutine/releases/latest'
const FIRST_CHECK_DELAY = 15 * 1000            // 시작 직후에는 로그인/데이터 로딩을 방해하지 않도록 잠깐 기다린다
const CHECK_INTERVAL = 4 * 60 * 60 * 1000      // 이후 4시간마다

const isPortable = Boolean(process.env.PORTABLE_EXECUTABLE_DIR)
/** 내려받아 설치까지 스스로 할 수 있는 환경인지. 아니면 안내만 한다. */
const canInstall = process.platform === 'win32' && !isPortable

/**
 * status
 *   disabled    개발 실행 등 검사하지 않음
 *   idle        아직 검사 전
 *   checking    서버 확인 중
 *   none        최신 버전
 *   available   새 버전 있음 (안내만 하는 환경)
 *   downloading 새 버전 내려받는 중 (percent)
 *   downloaded  설치 준비 완료
 *   error       마지막 검사 실패 (message)
 */
const state = {
  status: 'idle',
  current: app.getVersion(),
  version: null,
  percent: 0,
  message: null,
  canInstall,
  releasesUrl: RELEASES_URL
}

let hooks = { onState: () => {}, beforeQuit: () => {} }
let timer = null

function set (patch) {
  Object.assign(state, patch)
  try { hooks.onState({ ...state }) } catch { /* 렌더러 없음 등 */ }
}

// ---------------------------------------------------------------- 로그

/** %APPDATA%/routine-weekly/update.log. 업데이트가 안 될 때 이 파일을 본다. */
function appendLog (level, args) {
  try {
    const line = `${new Date().toISOString()} [${level}] ${args.map(String).join(' ')}\n`
    fs.appendFileSync(path.join(app.getPath('userData'), 'update.log'), line, 'utf8')
  } catch { /* 진단용 */ }
}

const logger = {
  info: (...args) => appendLog('info', args),
  warn: (...args) => appendLog('warn', args),
  error: (...args) => appendLog('error', args),
  debug: () => {}
}

// ---------------------------------------------------------------- 동작

function openReleases () {
  return shell.openExternal(RELEASES_URL)
}

/** 내려받은 업데이트를 조용히 설치하고 앱을 다시 띄운다. */
function installNow () {
  if (state.status !== 'downloaded') return false
  try { hooks.beforeQuit() } catch { /* 무시 */ }
  // isSilent=true: 설치 마법사 없이 이전 위치에 덮어씀. isForceRunAfter=true: 설치 후 자동 실행.
  setImmediate(() => autoUpdater.quitAndInstall(true, true))
  return true
}

/**
 * 지금 바로 검사한다 (트레이 "업데이트 확인"). 결과를 돌려주며 상태 이벤트도 함께 발생한다.
 * @returns {Promise<{ok:boolean, available?:boolean, version?:string, message?:string}>}
 */
async function checkNow () {
  if (!app.isPackaged) return { ok: false, message: '개발 실행에서는 업데이트를 확인하지 않습니다.' }
  try {
    const result = await autoUpdater.checkForUpdates()
    if (!result) return { ok: true, available: false, version: state.current }
    return { ok: true, available: Boolean(result.isUpdateAvailable), version: result.updateInfo.version }
  } catch (error) {
    return { ok: false, message: error.message }
  }
}

function checkQuietly () {
  autoUpdater.checkForUpdates().catch((error) => logger.warn('정기 검사 실패:', error.message))
}

/**
 * @param {object} options
 * @param {(state:object)=>void} options.onState   상태가 바뀔 때마다 (트레이/렌더러 갱신용)
 * @param {()=>void} options.beforeQuit            설치를 위해 종료하기 직전 (창 닫기 가로채기 해제용)
 */
function setup (options = {}) {
  hooks = { ...hooks, ...options }

  if (!app.isPackaged) {
    set({ status: 'disabled', message: '개발 실행' })
    return
  }

  autoUpdater.logger = logger
  autoUpdater.autoDownload = canInstall
  autoUpdater.autoInstallOnAppQuit = canInstall
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = false

  autoUpdater.on('checking-for-update', () => set({ status: 'checking', message: null }))

  autoUpdater.on('update-available', (info) => {
    if (canInstall) {
      set({ status: 'downloading', version: info.version, percent: 0 })
      return
    }
    set({ status: 'available', version: info.version })
  })

  autoUpdater.on('update-not-available', () => set({ status: 'none', version: null, percent: 0 }))

  autoUpdater.on('download-progress', (progress) => {
    set({ status: 'downloading', percent: Math.round(progress.percent) })
  })

  autoUpdater.on('update-downloaded', (info) => {
    set({ status: 'downloaded', version: info.version, percent: 100 })
  })

  autoUpdater.on('error', (error) => {
    // 오프라인 등은 흔한 일이라 사용자에게는 알리지 않고 상태와 로그에만 남긴다.
    set({ status: 'error', message: error ? error.message : String(error) })
  })

  clearTimeout(timer)
  timer = setTimeout(() => {
    checkQuietly()
    setInterval(checkQuietly, CHECK_INTERVAL)
  }, FIRST_CHECK_DELAY)
}

function current () {
  return { ...state }
}

module.exports = { setup, checkNow, installNow, openReleases, current, RELEASES_URL }
