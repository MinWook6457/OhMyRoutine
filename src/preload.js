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

  // 아카이브 (프로젝트 로그)
  archive: {
    check: () => ipcRenderer.invoke('archive:check'),
    login: () => ipcRenderer.invoke('archive:login'),
    bookmarks: () => ipcRenderer.invoke('archive:bookmarks'),
    searchProjects: (keyword) => ipcRenderer.invoke('archive:searchProjects', keyword),
    logInput: (project) => ipcRenderer.invoke('archive:logInput', project),
    searchTags: (keyword) => ipcRenderer.invoke('archive:searchTags', keyword),
    createLog: (form) => ipcRenderer.invoke('archive:createLog', form),
    openProject: (name) => ipcRenderer.invoke('archive:openProject', name)
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
