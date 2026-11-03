'use strict'

/**
 * 아카이브 '차량예약신청' 위키의 예약 표(Editor.js table 블록)를 예약 목록으로 바꾼다.
 *
 * 위키 본문은 GET /api/project/차량예약신청 → result.content.blocks[] 이고,
 * 예약 표는 첫 행이 머리글인 table 블록이다. 연도별로 표가 여러 개라 머리글에
 * '사용예정일시' 와 '복귀예정일시' 가 둘 다 있는 표를 모두 모은다. 지난 표에는 '차량' 열이 없다.
 *
 * 셀은 사람이 손으로 적은 HTML 이라 모양이 제각각이다.
 *   "2026-11-04(수) 08:00", "2025-11-12 (수) 10:30", "2026-03-06(금) <br> 07:00",
 *   "2025-11-04 (화) 8:00", "2025-10-28 (화) 07:00 <br> 2025-10-29 (수) 07:00"  (여러 날)
 * 날짜를 찾고, 그 뒤 첫 시각을 그 날짜의 시각으로 본다.
 */

const COLUMNS = {
  requested: '신청일',
  start: '사용예정일시',
  driver: '운전자',
  place: '출장지',
  purpose: '출장목적',
  end: '복귀예정일시',
  car: '차량',
  parking: '주차위치',
  keeper: '인수자'
}

/** 날짜 하나가 이 일수를 넘겨 이어지면 오타로 보고 시작일 하루로 줄인다. */
const MAX_SPAN_DAYS = 14

function cellText (html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}

function pad (n) {
  return String(n).padStart(2, '0')
}

/** 셀 글에서 [{ date: 'YYYY-MM-DD', time: 'HH:MM' | null }] 을 순서대로 뽑는다. */
function parseMoments (text) {
  const moments = []
  const re = /(\d{4})-(\d{1,2})-(\d{1,2})|(\d{1,2}):(\d{2})/g
  let match
  while ((match = re.exec(text))) {
    if (match[1]) {
      moments.push({ date: `${match[1]}-${pad(match[2])}-${pad(match[3])}`, time: null })
    } else if (moments.length && !moments[moments.length - 1].time) {
      moments[moments.length - 1].time = `${pad(match[4])}:${match[5]}`
    }
  }
  return moments
}

function daysBetween (a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000)
}

function carName (text) {
  if (/아반떼/.test(text)) return '아반떼'
  if (/투싼/.test(text)) return '투싼'
  return text
}

/** 머리글 행에서 열 위치를 찾는다. 예약 표가 아니면 null. */
function columnIndex (headerRow) {
  const names = headerRow.map((cell) => cellText(cell.content).replace(/\s+/g, ''))
  const index = {}
  for (const [key, label] of Object.entries(COLUMNS)) {
    index[key] = names.findIndex((name) => name.includes(label))
  }
  return index.start >= 0 && index.end >= 0 ? index : null
}

/**
 * @param {object} content Editor.js OutputData
 * @returns {Array<{id,start,end,startTime,endTime,driver,place,purpose,car,parking,keeper,requested}>}
 *   start/end 는 YYYY-MM-DD (end 는 마지막 날 포함). 시각이 없으면 startTime/endTime 은 null.
 */
function parseReservations (content) {
  const blocks = (content && Array.isArray(content.blocks)) ? content.blocks : []
  const list = []

  for (const block of blocks) {
    const rows = block && block.type === 'table' && block.data && block.data.rows
    if (!Array.isArray(rows) || rows.length < 2) continue
    const index = columnIndex(rows[0])
    if (!index) continue

    rows.slice(1).forEach((row, rowNo) => {
      const get = (key) => (index[key] >= 0 && row[index[key]] ? cellText(row[index[key]].content) : '')
      const requested = get('requested')
      if (/예시/.test(requested)) return

      const starts = parseMoments(get('start'))
      if (!starts.length) return
      const ends = parseMoments(get('end'))

      const base = {
        driver: get('driver').replace(/\n/g, ' '),
        place: get('place').replace(/\n/g, ' '),
        purpose: get('purpose'),
        car: carName(get('car')),
        parking: get('parking').replace(/\n/g, ' '),
        keeper: get('keeper'),
        requested: requested.replace(/\n/g, ' ')
      }

      // 한 칸에 날짜가 여러 개면 날마다 따로 잡힌 예약이다. 복귀 칸도 같은 순서로 맞춘다.
      starts.forEach((start, i) => {
        const end = ends[i] || ends[ends.length - 1] || { date: start.date, time: null }
        let endDate = end.date
        const span = daysBetween(start.date, endDate)
        if (!(span >= 0 && span <= MAX_SPAN_DAYS)) endDate = start.date
        list.push({
          id: `${block.id || 'table'}:${rowNo}:${i}`,
          start: start.date,
          end: endDate,
          startTime: start.time,
          endTime: end.time,
          ...base
        })
      })
    })
  }

  list.sort((a, b) => (a.start + (a.startTime || '')).localeCompare(b.start + (b.startTime || '')))
  return list
}

module.exports = { parseReservations, cellText, parseMoments }
