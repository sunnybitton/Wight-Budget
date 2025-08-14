import { google } from 'googleapis'

export type FoodRow = { name: string; duby: number; unit: string }
export type SheetUser = { name: string; email: string; passwordHash: string }
export type BudgetRow = { surplus: number; price: number; food: string; dailyBudget: number; date: string }

function getSheetsClient() {
  // broaden scope to allow reads and writes
  const scopes = ['https://www.googleapis.com/auth/spreadsheets']

  const inlineJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS

  let auth: any
  if (inlineJson) {
    const credentials = JSON.parse(inlineJson)
    auth = new google.auth.GoogleAuth({ credentials, scopes })
  } else if (keyFile) {
    auth = new google.auth.GoogleAuth({ keyFile, scopes })
  } else {
    throw new Error('Missing credentials: set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS')
  }

  const sheets = google.sheets({ version: 'v4', auth })
  return sheets
}

export async function readDailyBudget(spreadsheetId: string, tabTitle: string): Promise<number> {
  const sheets = getSheetsClient()
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${tabTitle}!H2:H2` })
  const v = (res.data.values?.[0]?.[0] ?? '').toString()
  const n = Number(v)
  return isNaN(n) ? 0 : n
}

export async function listSheetTitles(spreadsheetId: string): Promise<string[]> {
  const sheets = getSheetsClient()
  const meta = await sheets.spreadsheets.get({ spreadsheetId })
  return (meta.data.sheets || [])
    .map(s => s.properties?.title)
    .filter(Boolean) as string[]
}

async function getSheetIdByTitle(spreadsheetId: string, title: string): Promise<number | null> {
  const sheets = getSheetsClient()
  const meta = await sheets.spreadsheets.get({ spreadsheetId })
  const found = (meta.data.sheets || []).find(s => s.properties?.title === title)
  return found?.properties?.sheetId ?? null
}

function sanitizeSheetTitle(input: string): string {
  // Remove forbidden characters : \ / ? * [ ] and trim
  let t = input.replace(/[:\\/\?\*\[\]]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!t) t = 'User'
  if (t.length > 80) t = t.slice(0, 80)
  return t
}

async function uniqueTitle(spreadsheetId: string, base: string): Promise<string> {
  const titles = await listSheetTitles(spreadsheetId)
  if (!titles.includes(base)) return base
  let i = 1
  while (titles.includes(`${base} (${i})`)) i++
  return `${base} (${i})`
}

export async function duplicateUserTemplate(spreadsheetId: string, userName: string, templateName = 'UserTemplate'): Promise<string> {
  const sourceSheetId = await getSheetIdByTitle(spreadsheetId, templateName)
  if (sourceSheetId == null) throw new Error(`Template sheet not found: ${templateName}`)
  const baseTitle = sanitizeSheetTitle(userName)
  const newTitle = await uniqueTitle(spreadsheetId, baseTitle)
  const sheets = getSheetsClient()
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          duplicateSheet: {
            sourceSheetId: sourceSheetId,
            newSheetName: newTitle,
          },
        },
      ],
    },
  })
  return newTitle
}

export async function ensureUserTab(spreadsheetId: string, userName: string, templateName = 'UserTemplate'): Promise<string> {
  const baseTitle = sanitizeSheetTitle(userName)
  const titles = await listSheetTitles(spreadsheetId)
  const exact = titles.find(t => t === baseTitle || t.startsWith(`${baseTitle} (`))
  if (exact) return exact
  return duplicateUserTemplate(spreadsheetId, userName, templateName)
}

export async function writeGeneralInfo(
  spreadsheetId: string,
  tabTitle: string,
  info: { name: string; heightCm: number; startWeightKg: number; gender: string; age: number; targetWeightKg: number; targetDateIso?: string; dailyBudget?: number }
) {
  const sheets = getSheetsClient()
  // Expected order in columns A..H: Name | Hight | Start wight | Gender | Age | Target wight | Target Date | Daily Budget
  const values = [[
    info.name,
    info.heightCm,
    info.startWeightKg,
    info.gender,
    info.age,
    info.targetWeightKg,
    info.targetDateIso || '',
    info.dailyBudget ?? ''
  ]]
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tabTitle}!A2:H2`,
    valueInputOption: 'RAW',
    requestBody: { values },
  })
}

export async function readRange(spreadsheetId: string, a1Range: string): Promise<any[][]> {
  const sheets = getSheetsClient()
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: a1Range })
  return (res.data.values || []) as any[][]
}

async function readRangeUnformatted(spreadsheetId: string, a1Range: string): Promise<any[][]> {
  const sheets = getSheetsClient()
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: a1Range, valueRenderOption: 'UNFORMATTED_VALUE' })
  return (res.data.values || []) as any[][]
}

export async function readFoodList(spreadsheetId: string, sheetName = 'FoodList'): Promise<FoodRow[]> {
  const rows = await readRange(spreadsheetId, `${sheetName}!A2:C`)
  return rows
    .filter(r => r && r.length >= 3 && String(r[0] ?? '').trim() !== '')
    .map(([name, duby, unit]) => ({ name: String(name || ''), duby: Number(duby || 0), unit: String(unit || '') }))
}

export async function searchFood(spreadsheetId: string, query: string, sheetName = 'FoodList'): Promise<FoodRow[]> {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const all = await readFoodList(spreadsheetId, sheetName)
  return all.filter(r => r.name.toLowerCase().includes(q)).slice(0, 10)
}

export async function findUserByEmail(spreadsheetId: string, email: string, sheetName = 'Users'): Promise<SheetUser | null> {
  const rows = await readRange(spreadsheetId, `${sheetName}!A2:C`)
  for (const r of rows) {
    const name = String(r[0] || '').trim()
    const em = String(r[1] || '').trim().toLowerCase()
    const passwordHash = String(r[2] || '').trim()
    if (em && em === email.toLowerCase()) return { name, email: em, passwordHash }
  }
  return null
}

export async function appendUser(spreadsheetId: string, user: SheetUser, sheetName = 'Users'): Promise<void> {
  const sheets = getSheetsClient()
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetName}!A2:C`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [[user.name, user.email, user.passwordHash]],
      majorDimension: 'ROWS',
    },
  })
}

export async function readBudgetRows(spreadsheetId: string, tabTitle: string): Promise<BudgetRow[]> {
  // Table layout starting at column D: D=Date, E=Daily Budget, F=Food, G=Price, H=Budget Left
  const rows = await readRange(spreadsheetId, `${tabTitle}!D6:H1000`)
  return rows
    .filter(r => r && r.length > 0)
    .map(r => ({
      date: String(r[0] || ''),
      dailyBudget: Number(r[1] || 0),
      food: String(r[2] || ''),
      price: Number(r[3] || 0),
      surplus: Number(r[4] || 0),
    }))
}

// Date helpers
function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate()
}

function serialToDate(n: number): Date {
  // Google Sheets serial (like Excel) days since 1899-12-30
  const ms = Math.round((n - 25569) * 86400) * 1000
  return new Date(ms)
}

function parseAnyDateValue(v: any): Date | null {
  if (typeof v === 'number') return serialToDate(v)
  const s = String(v || '')
  if (!s) return null
  const d1 = new Date(s)
  if (!isNaN(+d1)) return d1
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/)
  if (m) {
    const a = Number(m[1]), b = Number(m[2]), c = Number(m[3])
    const dmy = new Date(c<100?2000+c:c, b-1, a)
    if (!isNaN(+dmy)) return dmy
    const mdy = new Date(c<100?2000+c:c, a-1, b)
    if (!isNaN(+mdy)) return mdy
  }
  return null
}

export async function findBudgetToday(spreadsheetId: string, tabTitle: string, today = new Date()): Promise<BudgetRow | null> {
  const rows = await readRange(spreadsheetId, `${tabTitle}!D6:H1000`)
  for (const r of rows) {
    const d = parseAnyDateValue(r[0])
    if (d && sameDay(d, today)) {
      return {
        date: String(r[0] || ''),
        dailyBudget: Number(r[1] || 0),
        food: String(r[2] || ''),
        price: Number(r[3] || 0),
        surplus: Number(r[4] || 0),
      }
    }
  }
  return null
}

export async function findBudgetRowIndex(spreadsheetId: string, tabTitle: string, today = new Date()): Promise<number | null> {
  // Look for matching date in column D
  const rows = await readRangeUnformatted(spreadsheetId, `${tabTitle}!D6:D1000`)
  for (let i = 0; i < rows.length; i++) {
    const v = rows[i]?.[0]
    const d = parseAnyDateValue(v)
    if (d && sameDay(d, today)) return 6 + i
  }
  return null
}

export async function upsertBudgetRow(
  spreadsheetId: string,
  tabTitle: string,
  dateIso: string,
  dailyBudget: number,
  price: number,
  foodJoined: string
): Promise<void> {
  const sheets = getSheetsClient()
  const surplus = dailyBudget - price
  const rowIndex = await findBudgetRowIndex(spreadsheetId, tabTitle, new Date(dateIso))
  // Write in the order: D=Date, E=Daily Budget, F=Food, G=Price, H=Budget Left
  const values = [[dateIso, dailyBudget, foodJoined, price, surplus]]
  if (rowIndex !== null) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${tabTitle}!D${rowIndex}:H${rowIndex}`,
      valueInputOption: 'RAW',
      requestBody: { values },
    })
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${tabTitle}!D6:H6`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values },
    })
  }
}

export async function appendProgressRow(spreadsheetId: string, tabTitle: string, dateIso: string, weightKg: number): Promise<void> {
  const sheets = getSheetsClient()
  const values = [[dateIso, weightKg]]
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${tabTitle}!A6:B6`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  })
}