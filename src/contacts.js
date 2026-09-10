'use strict'

/**
 * 연락처 QR — 구성원 목록을 vCard(.vcf) 로 묶어 같은 Wi-Fi 의 휴대폰에 넘긴다.
 *
 * QR 한 장에 여러 명의 vCard 를 직접 담을 수는 없다 (용량 한계 + 카메라 앱이 첫 사람만 읽음).
 * 그래서 QR 에는 이 PC 의 LAN 주소만 담고, 그 주소가 안내 페이지와 .vcf 파일을 내려준다.
 *   GET /c/<token>               안내 페이지 (전체 연락처 저장 버튼)
 *   GET /c/<token>/contacts.vcf  vCard 3.0 여러 장을 이어 붙인 파일
 *
 * 개인 휴대전화가 LAN 에 노출되는 셈이라 주소에 무작위 토큰을 붙이고, TTL 이 지나거나
 * 창에서 닫으면 서버를 바로 내린다.
 */

const http = require('http')
const os = require('os')
const crypto = require('crypto')
const QRCode = require('qrcode')

const TTL_MS = 10 * 60 * 1000
const ORG_NAME = '인실리코젠'

let server = null
let current = null   // { token, url, count, expiresAt, vcf, timer }

// ------------------------------------------------------------ vCard

function escapeText (value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;')
}

function digitsOnly (value) {
  return String(value || '').replace(/[^\d+]/g, '')
}

/** 조직 현황 한 행을 vCard 3.0 한 장으로. 이름이나 연락처가 하나도 없으면 null. */
function memberToVCard (member) {
  const name = String(member.name_ko || member.name || '').trim()
  const cell = digitsOnly(member.phone)
  const work = digitsOnly(member.company_phone)
  const ext = String(member.ext || '').trim()
  const email = String(member.email || '').trim()
  if (!name || !(cell || work || email)) return null

  // department 는 'BS' 같은 식별자, sub_text 는 '직급 / 직무 / 부서' (예: '주임 / 개발자 / BS') 꼴.
  const dept = String(member.department || member.department_display_name || '').trim()
  const parts = String(member.sub_text || member.position || '').split('/').map((s) => s.trim())
  if (dept && parts.length > 1 && parts[parts.length - 1] === dept) parts.pop()   // 끝의 부서 반복 제거
  const meaningful = parts.filter((s) => s && s !== '-')
  const rank = meaningful[0] || ''                 // 직책(직급): 주임 · 선임 · 대표이사 …
  const title = meaningful.join(' / ')             // TITLE 에는 직급 / 직무

  // 폰에 보이는 이름: "[인실리코젠] BS 홍길동 주임님". iPhone 은 N, Android 는 FN 을 표시 이름으로 쓰므로 둘 다 같은 문자열로 둔다.
  // 슬래시는 음성 비서가 "슬래시" 로 읽고 통화 화면 폭만 차지해서 넣지 않는다. 직책이 없으면 "홍길동님".
  const display = [`[${ORG_NAME}]`, dept, rank ? `${name} ${rank}님` : `${name}님`].filter(Boolean).join(' ')
  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `N:${escapeText(display)};;;;`,
    `FN:${escapeText(display)}`
  ]
  if (member.name_en) lines.push(`X-PHONETIC-FIRST-NAME:${escapeText(member.name_en)}`)
  if (cell) lines.push(`TEL;TYPE=CELL,VOICE:${cell}`)
  if (work) lines.push(`TEL;TYPE=WORK,VOICE:${work}`)
  if (email) lines.push(`EMAIL;TYPE=INTERNET,WORK:${escapeText(email)}`)
  lines.push(`ORG:${escapeText(ORG_NAME)}${dept ? ';' + escapeText(dept) : ''}`)
  if (title) lines.push(`TITLE:${escapeText(title)}`)
  // 내선은 vCard 3.0 에 표준 필드가 없어 메모로 남긴다 (';ext=' 는 tel URI 문법이라 폰마다 해석이 다르다)
  if (ext) lines.push(`NOTE:${escapeText('내선 ' + ext)}`)
  lines.push('END:VCARD')
  return lines.join('\r\n')
}

/** 구성원 배열 → { vcf, count }. 카드가 안 만들어지는 행은 건너뛴다. */
function buildVcf (members) {
  const cards = members.map(memberToVCard).filter(Boolean)
  return { vcf: cards.join('\r\n') + '\r\n', count: cards.length }
}

// ------------------------------------------------------------ 안내 페이지

function escapeHtml (value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function landingHtml ({ count, label, vcfPath, expiresAt }) {
  const minutes = Math.max(1, Math.round((expiresAt - Date.now()) / 60000))
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>연락처 등록</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 32px 20px; font: 16px/1.5 -apple-system, 'Pretendard', 'Malgun Gothic', sans-serif;
         background: #f2f4f6; color: #191f28; }
  @media (prefers-color-scheme: dark) { body { background: #14161a; color: #e5e8eb; } .card { background: #1b1d22 !important; } }
  .card { max-width: 420px; margin: 0 auto; background: #fff; border-radius: 20px; padding: 28px 24px; box-shadow: 0 4px 24px rgba(0,0,0,.08); }
  h1 { margin: 0 0 6px; font-size: 22px; }
  p { margin: 0 0 12px; color: #6b7684; }
  .btn { display: block; text-align: center; margin: 20px 0 8px; padding: 16px; border-radius: 14px;
         background: #3182f6; color: #fff; font-weight: 700; font-size: 17px; text-decoration: none; }
  .btn:active { background: #2272eb; }
  .count { text-align: center; font-weight: 600; margin-bottom: 20px; color: inherit; }
  h2 { font-size: 14px; margin: 18px 0 4px; color: #8b95a1; }
  ol { margin: 0; padding-left: 20px; color: inherit; }
  li { margin: 2px 0; }
  .ttl { margin-top: 20px; font-size: 13px; color: #8b95a1; text-align: center; }
</style></head><body>
<div class="card">
  <h1>📱 연락처 등록</h1>
  <p>아래 버튼을 누르면 ${escapeHtml(label)} 연락처 파일(.vcf)이 열립니다.</p>
  <a class="btn" href="${vcfPath}">전체 연락처 저장</a>
  <div class="count">총 ${count}명의 연락처가 등록됩니다.</div>
  <h2>iPhone</h2>
  <ol><li>버튼을 누르면 연락처 미리보기가 뜹니다</li><li><b>연락처 ${count}개 모두 추가</b>를 누릅니다</li></ol>
  <h2>Android</h2>
  <ol><li>버튼을 누르면 <b>contacts.vcf</b> 가 다운로드됩니다</li><li>알림 또는 파일 앱에서 열어 <b>연락처</b> 앱으로 가져옵니다</li><li>저장할 계정을 고르면 끝</li></ol>
  <div class="ttl">이 주소는 약 ${minutes}분 뒤 또는 PC 에서 창을 닫으면 사라집니다.</div>
</div>
</body></html>`
}

// ------------------------------------------------------------ 서버

/** 사무실 Wi-Fi 에서 쓰는 사설망 대역(10/8, 172.16/12, 192.168/16)인지. */
function isPrivateLan (address) {
  const [a, b] = address.split('.').map(Number)
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/**
 * 휴대폰이 붙을 수 있는 IPv4 를 고른다. 없으면 null.
 * 순서: 사설망 대역이면서 실제 어댑터 → 사설망이 아닌 것(Tailscale 의 100.64/10 등) → 가상 어댑터.
 */
function lanAddress () {
  const candidates = []
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const info of list || []) {
      if (info.family !== 'IPv4' || info.internal) continue
      const virtual = /virtual|vethernet|vmware|wsl|docker|tap|tun|tailscale|zerotier|hamachi|loopback/i.test(name)
      candidates.push({ address: info.address, score: (isPrivateLan(info.address) ? 0 : 2) + (virtual ? 1 : 0) })
    }
  }
  candidates.sort((a, b) => a.score - b.score)
  return candidates.length ? candidates[0].address : null
}

function isAppleUA (ua) {
  return /iPhone|iPad|iPod|Macintosh/.test(ua || '')
}

function handle (req, res) {
  const url = new URL(req.url, 'http://localhost')
  const base = current ? `/c/${current.token}` : null
  if (!current || !base || req.method !== 'GET' || !url.pathname.startsWith(base)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end('Not Found')
    return
  }
  const rest = url.pathname.slice(base.length)
  if (rest === '' || rest === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(landingHtml({ count: current.count, label: current.label, vcfPath: `${base}/contacts.vcf`, expiresAt: current.expiresAt }))
    return
  }
  if (rest === '/contacts.vcf') {
    // iOS Safari 는 inline 이어야 '연락처 모두 추가' 미리보기를 바로 띄운다. Android 는 파일로 내려받아 연락처 앱으로 연다.
    const disposition = isAppleUA(req.headers['user-agent']) ? 'inline' : 'attachment'
    res.writeHead(200, {
      'Content-Type': 'text/vcard; charset=utf-8',
      'Content-Disposition': `${disposition}; filename="contacts.vcf"`,
      'Cache-Control': 'no-store'
    })
    res.end(current.vcf)
    return
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('Not Found')
}

function listen (address) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(handle)
    srv.once('error', reject)
    srv.listen(0, address, () => resolve(srv))
  })
}

/**
 * 공유 시작. 이미 열려 있으면 내리고 새로 연다.
 * @param {object[]} members 조직 현황 행
 * @param {string} label 안내 페이지에 쓸 범위 설명 (예: 'bs 부서', '전 직원')
 * @returns {{ url, qr, count, expiresAt, skipped }}
 */
async function start (members, label) {
  await stop()

  const { vcf, count } = buildVcf(members)
  if (!count) throw new Error('연락처를 만들 수 있는 구성원이 없습니다.')

  const address = lanAddress()
  if (!address) throw new Error('휴대폰이 접속할 수 있는 네트워크 주소를 찾지 못했습니다. Wi-Fi 나 유선 연결을 확인하세요.')

  const token = crypto.randomBytes(12).toString('base64url')
  server = await listen(address)
  const url = `http://${address}:${server.address().port}/c/${token}`
  const expiresAt = Date.now() + TTL_MS

  current = {
    token,
    url,
    count,
    label,
    vcf,
    expiresAt,
    timer: setTimeout(() => { stop() }, TTL_MS)
  }

  const qr = await QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 1, width: 256 })
  return { url, qr, count, expiresAt, skipped: members.length - count }
}

async function stop () {
  if (current && current.timer) clearTimeout(current.timer)
  current = null
  if (!server) return
  const srv = server
  server = null
  await new Promise((resolve) => srv.close(() => resolve()))
}

function state () {
  if (!current) return { active: false }
  const { url, count, expiresAt, label } = current
  return { active: true, url, count, expiresAt, label }
}

module.exports = { start, stop, state, buildVcf, memberToVCard, lanAddress, TTL_MS }
