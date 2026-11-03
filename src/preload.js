'use strict'

const { contextBridge, ipcRenderer } = require('electron')
const tree = require('./tree')

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  isMac: process.platform === 'darwin',

  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  checkAuth: () => ipcRenderer.invoke('auth:check'),
  login: () => ipcRenderer.invoke('auth:login'),

  getWeek: (monday, department) => ipcRenderer.invoke('api:getWeek', { monday, department }),
  saveDay: (date, patch) => ipcRenderer.invoke('api:saveDay', { date, patch }),

  openWeb: () => ipcRenderer.invoke('app:openWeb'),
  setWidget: (widget) => ipcRenderer.invoke('app:setWidget', widget),
  hideWindow: () => ipcRenderer.invoke('app:hide'),
  confirm: (title, message) => ipcRenderer.invoke('app:confirm', { title, message }),

  onWindowFocus: (handler) => ipcRenderer.on('window:focused', handler),
  onSetView: (handler) => ipcRenderer.on('view:set', (_event, view) => handler(view)),
  onFocusToday: (handler) => ipcRenderer.on('view:focusToday', () => handler()),

  // 자동 업데이트 (GitHub Releases)
  update: {
    getState: () => ipcRenderer.invoke('update:state'),
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install'),
    openReleases: () => ipcRenderer.invoke('update:openReleases'),
    onState: (handler) => ipcRenderer.on('update:state', (_event, state) => handler(state))
  },

  // 아카이브 (프로젝트 로그)
  archive: {
    check: () => ipcRenderer.invoke('archive:check'),
    login: () => ipcRenderer.invoke('archive:login'),
    bookmarks: () => ipcRenderer.invoke('archive:bookmarks'),
    searchProjects: (keyword) => ipcRenderer.invoke('archive:searchProjects', keyword),
    logInput: (project) => ipcRenderer.invoke('archive:logInput', project),
    searchTags: (keyword) => ipcRenderer.invoke('archive:searchTags', keyword),
    createLog: (form) => ipcRenderer.invoke('archive:createLog', form),
    openProject: (name) => ipcRenderer.invoke('archive:openProject', name),
    vehicles: () => ipcRenderer.invoke('archive:vehicles'),
    openVehicles: () => ipcRenderer.invoke('archive:openVehicles')
  },

  // 연락처 QR (.vcf 를 LAN 으로 공유)
  contacts: {
    start: (scope, department, label, myPk) => ipcRenderer.invoke('contacts:start', { scope, department, label, myPk }),
    stop: () => ipcRenderer.invoke('contacts:stop'),
    state: () => ipcRenderer.invoke('contacts:state')
  },

  // 트리 <-> 평문 변환과 글머리 기호 헬퍼
  treeToText: (nodes) => tree.treeToText(nodes),
  textToTree: (text) => tree.textToTree(text),
  treeKey: (value) => tree.treeKey(value),
  statusToText: (nodes) => tree.statusToText(nodes),
  textToStatus: (text) => tree.textToStatus(text),
  statusKey: (value) => tree.statusKey(value),
  depthOf: (line) => tree.depthOf(line),
  prefixFor: (depth) => tree.prefixFor(depth),
  shiftLine: (line, delta) => tree.shiftLine(line, delta)
})
