'use strict'

const fs = require('fs')
const path = require('path')
const { app } = require('electron')

const DEFAULTS = {
  department: 'bs',
  autoLaunch: false,
  alwaysOnTop: false,
  widget: false,
  view: 'week',
  bounds: null,
  widgetBounds: null,
  archiveBookmarks: [],   // 트레이 메뉴용 캐시. 시작할 때 다시 받아온다
  logProject: ''          // 로그 패널에서 마지막으로 고른 프로젝트
}

function file () {
  return path.join(app.getPath('userData'), 'settings.json')
}

function load () {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(), 'utf8')) }
  } catch {
    return { ...DEFAULTS }
  }
}

function save (patch) {
  const next = { ...load(), ...patch }
  try {
    fs.writeFileSync(file(), JSON.stringify(next, null, 2), 'utf8')
  } catch (error) {
    console.error('설정 저장 실패:', error.message)
  }
  return next
}

module.exports = { load, save, DEFAULTS }
