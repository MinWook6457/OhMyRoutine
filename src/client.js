'use strict'

/**
 * inpleROUTINE 계열 사내 서비스 공용 HTTP 클라이언트.
 * routine / archive 모두 같은 SSO(httpOnly JWT 쿠키 + csrftoken/X-CSRFToken) 를 쓰므로
 * 호스트만 바꿔 같은 코드를 쓴다. 쿠키는 도메인별로 따로 붙으니 세션 파티션은 하나로 둔다.
 */

const { net, session } = require('electron')

const PARTITION = 'persist:routine'
// Electron 기본 UA 대신 일반 크롬 UA 를 쓴다.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'

class AuthRequiredError extends Error {
  constructor (message = '로그인이 필요합니다.') {
    super(message)
    this.code = 'AUTH_REQUIRED'
  }
}

function appSession () {
  return session.fromPartition(PARTITION)
}

function isAuthFailure (res) {
  if (res.status === 401) return true
  const code = res.data && res.data.code
  return code === 40101 || code === 40102 || code === 'token_not_valid'
}

/**
 * @param {object} options
 * @param {string} options.base        예: https://routine.insilicogen.com
 * @param {string} options.referer     요청에 실을 Referer
 * @param {string} options.profilePath 로그인 여부 확인용 GET 경로
 * @param {string|null} options.refreshPath 토큰 갱신 GET 경로 (없으면 null)
 */
function createClient ({ base, referer, profilePath, refreshPath = null }) {
  async function csrfToken () {
    const cookies = await appSession().cookies.get({ url: base, name: 'csrftoken' })
    return cookies.length ? cookies[0].value : null
  }

  function rawRequest (method, path, body, token) {
    return new Promise((resolve, reject) => {
      const request = net.request({
        method,
        url: base + path,
        session: appSession(),
        useSessionCookies: true // httpOnly 인증 쿠키를 자동 첨부
      })

      request.setHeader('Origin', base)
      request.setHeader('Referer', referer)
      request.setHeader('Accept', 'application/json, text/plain, */*')
      request.setHeader('User-Agent', USER_AGENT)
      if (token) request.setHeader('X-CSRFToken', token) // DRF CSRF 검증
      if (body !== null && body !== undefined) request.setHeader('Content-Type', 'application/json')

      const chunks = []
      request.on('response', (response) => {
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let data = null
          try { data = text ? JSON.parse(text) : null } catch { data = { raw: text } }
          resolve({ status: response.statusCode, data })
        })
        response.on('error', reject)
      })
      request.on('error', reject)

      if (body !== null && body !== undefined) request.write(JSON.stringify(body), 'utf8')
      request.end()
    })
  }

  async function call (method, path, body) {
    let res = await rawRequest(method, path, body, await csrfToken())

    if (isAuthFailure(res)) {
      if (!refreshPath) throw new AuthRequiredError()
      // 액세스 토큰 만료일 수 있으므로 한 번 갱신 후 재시도한다.
      const refreshed = await rawRequest('GET', refreshPath, null, await csrfToken())
      if (refreshed.status !== 200 || isAuthFailure(refreshed)) {
        throw new AuthRequiredError()
      }
      res = await rawRequest(method, path, body, await csrfToken())
      if (isAuthFailure(res)) throw new AuthRequiredError()
    }

    // 서버는 HTTP 200 에 { code, message, result } 를 담고, 실패도 code 4xxxx 로 알린다.
    const bodyCode = res.data && typeof res.data.code === 'number' ? res.data.code : null
    if (res.status >= 400 || (bodyCode !== null && bodyCode >= 40000)) {
      const message = (res.data && res.data.message) || `요청 실패 (HTTP ${res.status})`
      const error = new Error(message)
      error.status = res.status
      error.serverCode = bodyCode
      throw error
    }

    return res.data
  }

  /** 로그인 여부 확인 */
  async function checkAuth () {
    try {
      await call('GET', profilePath)
      return true
    } catch (error) {
      if (error.code === 'AUTH_REQUIRED') return false
      throw error
    }
  }

  return { base, call, checkAuth }
}

function encodeQuery (params) {
  const parts = []
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
  }
  return parts.length ? '?' + parts.join('&') : ''
}

module.exports = {
  PARTITION,
  USER_AGENT,
  AuthRequiredError,
  appSession,
  createClient,
  encodeQuery
}
