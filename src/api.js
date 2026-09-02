'use strict'

/**
 * routine.insilicogen.com — 주간 업무 일지 API.
 * 공용 HTTP 처리(쿠키·CSRF·토큰 갱신)는 client.js 에 있다.
 */

const {
  PARTITION,
  USER_AGENT,
  AuthRequiredError,
  appSession,
  createClient
} = require('./client')

const BASE = 'https://routine.insilicogen.com'

const client = createClient({
  base: BASE,
  referer: `${BASE}/company/weeklyreport`,
  profilePath: '/api/info/profile',
  refreshPath: '/sso/token/refresh'
})

const { call, checkAuth } = client

/**
 * 주간 업무 일지 조회.
 * 원본 페이지와 동일하게 (해당 주 월요일 -7일) ~ (+6일) 범위를 조회한다.
 */
async function getWeek (mondayISO, department) {
  const start = shiftDate(mondayISO, -7)
  const end = shiftDate(mondayISO, 6)
  const query = `?start_date=${start}&end_date=${end}&department=${encodeURIComponent(department)}`
  const body = await call('GET', '/api/weekly-task' + query)
  return { result: body && body.result, range: { start, end } }
}

// 원본 페이지는 좌측(업무 내용)과 우측(상태) 에디터가 각각 따로 POST 한다.
// 한 요청에 한 필드만 담기는 계약이라 같은 방식으로 나눠 보낸다.
const SAVE_FIELDS = ['task_description', 'task_status']

/**
 * 하루치 저장.
 * patch = { task_description?, task_status? } — 담긴 필드만 각각 POST 한다.
 */
async function saveDay (date, patch) {
  let last = null
  for (const field of SAVE_FIELDS) {
    const value = patch && patch[field]
    if (value === undefined) continue
    last = await call('POST', '/api/weekly-task', { date, [field]: value })
  }
  return last
}

function shiftDate (iso, days) {
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

module.exports = {
  BASE,
  PARTITION,
  USER_AGENT,
  AuthRequiredError,
  appSession,
  checkAuth,
  getWeek,
  saveDay,
  shiftDate
}
