'use strict'

/**
 * archive.insilicogen.com — 프로젝트 아카이브 API 중 앱이 쓰는 최소 부분.
 *
 * 번들(app.7c658073.js, 2263.6abc133f.js, 2335.5c00c3b2.js) 분석으로 확인한 계약.
 * 응답은 routine 과 같은 { code, message, result } 이고 성공 code 는 20000/20001.
 *
 *   GET  /api/user/info                             로그인 확인
 *   GET  /api/project?is_bookmark=true&size=&page=  프로젝트 목록 → result.data[] / result.count
 *   GET  /api/project?search=                       프로젝트 검색
 *   GET  /api/project/log/input?project=<name>      로그 입력 폼 기본값
 *        → result.managers[] { user_id, user, department, job_position, organization }
 *          result.groups[]   { id, name, count, member_list[] }
 *          result.manager    { user }                기본 담당자
 *          result.member     { group[], user[] }     기본 참여인원
 *   GET  /api/common/tag?target=project&q=          태그 검색 → result: string[]
 *   POST /api/project/log                           로그 생성
 *
 * 프로젝트 식별자는 pk 가 아니라 이름(name) 문자열이다. 웹 URL 도 /project/<name> 이다.
 */

const { createClient, encodeQuery } = require('./client')

const BASE = 'https://archive.insilicogen.com'

const client = createClient({
  base: BASE,
  referer: `${BASE}/project`,
  profilePath: '/api/user/info',
  refreshPath: null // 아카이브 번들에는 토큰 갱신 호출이 없다. 만료되면 다시 로그인한다.
})

const { call, checkAuth } = client

function projectUrl (name) {
  return `${BASE}/project/${encodeURIComponent(name)}`
}

function pickProject (item) {
  return {
    id: item.id,
    name: item.name,
    isPublic: Boolean(item.is_public),
    isBookmark: Boolean(item.is_bookmark),
    manager: item.manager_name || ''
  }
}

/** 즐겨찾기한 프로젝트. 트레이 메뉴와 로그 패널의 기본 선택지로 쓴다. */
async function bookmarkedProjects () {
  const body = await call('GET', '/api/project' + encodeQuery({ is_bookmark: 'true', size: 100, page: 1 }))
  const data = (body && body.result && body.result.data) || []
  lastRaw.bookmarks = body
  return data.map(pickProject)
}

/** 진단용: 마지막 원본 응답 */
const lastRaw = { bookmarks: null }

/** 이름으로 프로젝트 검색. */
async function searchProjects (keyword) {
  const body = await call('GET', '/api/project' + encodeQuery({ search: keyword, size: 20, page: 1 }))
  const data = (body && body.result && body.result.data) || []
  return data.map(pickProject)
}

/** 로그 입력 폼의 기본값(담당자 후보, 기본 담당자·참여인원). */
async function logInput (project) {
  const body = await call('GET', '/api/project/log/input' + encodeQuery({ project }))
  const result = (body && body.result) || {}
  return {
    managers: (result.managers || []).map((m) => ({
      userId: m.user_id,
      name: m.user,
      department: m.department || '',
      position: m.job_position || ''
    })),
    groups: (result.groups || []).map((g) => ({ id: g.id, name: g.name, count: g.count })),
    defaultManager: result.manager && result.manager.user ? result.manager.user : null,
    defaultMember: {
      group: (result.member && result.member.group) || [],
      user: (result.member && result.member.user) || []
    }
  }
}

async function searchTags (keyword) {
  const body = await call('GET', '/api/common/tag' + encodeQuery({ target: 'project', q: keyword }))
  const result = body && body.result
  return Array.isArray(result) ? result.filter((t) => typeof t === 'string') : []
}

/**
 * 로그 생성. 웹의 AppProjectLogCreate.createProjectLog() 와 같은 payload 를 보낸다.
 *
 * @param {object} input
 * @param {string}  input.project      프로젝트 이름
 * @param {string}  input.date         YYYY-MM-DD
 * @param {string}  input.startTime    HH:MM
 * @param {string}  input.endTime      HH:MM
 * @param {boolean} input.presentation 세일즈 회의 발표 여부
 * @param {number|null} input.manager  담당자 user_id
 * @param {{group:number[],user:number[]}} input.member 참여인원
 * @param {string[]} input.tags
 * @param {object}  input.content      Editor.js OutputData
 */
async function createLog (input) {
  const hasMember = input.member &&
    ((input.member.group && input.member.group.length) || (input.member.user && input.member.user.length))

  const payload = {
    project: input.project,
    is_presentation_mode: Boolean(input.presentation),
    started_at: `${input.date} ${toSeconds(input.startTime)}`,
    ended_at: `${input.date} ${toSeconds(input.endTime)}`,
    content: input.content,
    manager: input.manager ? { user: input.manager } : null,
    member: hasMember ? [{ group: input.member.group || [], user: input.member.user || [] }] : [],
    tag: input.tags || []
  }

  const body = await call('POST', '/api/project/log', payload)
  return { message: (body && body.message) || '프로젝트 로그가 생성되었습니다.', result: body && body.result }
}

/** "HH:MM" → "HH:MM:00" (이미 초가 있으면 그대로) */
function toSeconds (time) {
  return /^\d{2}:\d{2}$/.test(time) ? `${time}:00` : time
}

module.exports = {
  BASE,
  lastRaw,
  checkAuth,
  projectUrl,
  bookmarkedProjects,
  searchProjects,
  logInput,
  searchTags,
  createLog
}
