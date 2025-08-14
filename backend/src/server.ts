import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import morgan from 'morgan'
import { z } from 'zod'
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import cookieParser from 'cookie-parser'
import { readFoodList, listSheetTitles, readRange, searchFood, findUserByEmail, appendUser, duplicateUserTemplate, ensureUserTab, writeGeneralInfo, readDailyBudget, findBudgetToday, upsertBudgetRow, appendProgressRow } from './gsheets.js'

const prisma = new PrismaClient()
const app = express()

// Disable etag and caching to avoid 304 for dynamic JSON
app.set('etag', false)

app.use(express.json())
app.use(cookieParser())
app.use(helmet())
app.use(cors({ origin: true, credentials: true }))
app.use((_, res, next) => { res.setHeader('Cache-Control', 'no-store'); next() })
app.use(morgan('dev'))

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret'

function setAuthCookie(res: express.Response, userId: string) {
  const token = jwt.sign({ uid: userId }, JWT_SECRET, { expiresIn: '7d' })
  res.cookie('session', token, { httpOnly: true, sameSite: 'lax' })
}

async function requireUser(req: express.Request): Promise<string | null> {
  try {
    const raw = req.cookies?.session
    if (!raw) return null
    const payload: any = jwt.verify(raw, JWT_SECRET)
    return payload?.uid || null
  } catch {
    return null
  }
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

app.get('/api/me', async (req, res) => {
  const uid = await requireUser(req)
  if (!uid) return res.status(401).json({ error: 'unauthorized' })
  const user = await prisma.user.findUnique({ where: { id: uid }, include: { profile: true } })
  const last = await prisma.weightLog.findFirst({ where: { userId: uid }, orderBy: { date: 'desc' } })
  res.json({ id: user?.id, name: user?.name, email: user?.email, profile: user?.profile, lastWeightKg: last ? Number(last.weightKg as any) : null })
})

const RegisterSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(6)
})

app.post('/api/auth/register', async (req, res) => {
  const parse = RegisterSchema.safeParse(req.body)
  if (!parse.success) return res.status(400).json({ error: 'Invalid input' })
  const { name, email, password } = parse.data

  const sheetId = process.env.GOOGLE_SHEETS_ID
  const hasSheetsAuth = !!(sheetId && (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS))
  const passwordHash = await bcrypt.hash(password, 10)

  if (hasSheetsAuth) {
    const exists = await findUserByEmail(sheetId!, email)
    if (exists) return res.status(409).json({ error: 'Email already in use' })
    await appendUser(sheetId!, { name, email, passwordHash })
    try { await duplicateUserTemplate(sheetId!, name, 'UserTemplate') } catch (e) { /* ignore template errors */ }
    // Also mirror minimal user in DB to get a user id for sessions
    const user = await prisma.user.upsert({
      where: { email },
      update: { name, passwordHash },
      create: { name, email, passwordHash },
    })
    setAuthCookie(res, user.id)
    return res.status(201).json({ id: user.id, name: user.name, email: user.email })
  }

  const exists = await prisma.user.findUnique({ where: { email } })
  if (exists) return res.status(409).json({ error: 'Email already in use' })
  const user = await prisma.user.create({ data: { name, email, passwordHash } })
  setAuthCookie(res, user.id)
  res.status(201).json({ id: user.id, name: user.name, email: user.email })
})

const LoginSchema = z.object({ email: z.string().email(), password: z.string().min(1) })
app.post('/api/auth/login', async (req, res) => {
  const parse = LoginSchema.safeParse(req.body)
  if (!parse.success) return res.status(400).json({ error: 'Invalid input' })
  const { email, password } = parse.data

  const sheetId = process.env.GOOGLE_SHEETS_ID
  const hasSheetsAuth = !!(sheetId && (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS))

  if (hasSheetsAuth) {
    const u = await findUserByEmail(sheetId!, email)
    if (!u) return res.status(401).json({ error: 'invalid credentials' })
    const ok = await bcrypt.compare(password, u.passwordHash)
    if (!ok) return res.status(401).json({ error: 'invalid credentials' })
    // Ensure we have a local id for session
    const user = await prisma.user.upsert({
      where: { email },
      update: { name: u.name, passwordHash: u.passwordHash },
      create: { name: u.name, email, passwordHash: u.passwordHash },
    })
    setAuthCookie(res, user.id)
    return res.json({ id: user.id, name: user.name, email: user.email })
  }

  const user = await prisma.user.findUnique({ where: { email } })
  if (!user) return res.status(401).json({ error: 'invalid credentials' })
  const ok = await bcrypt.compare(password, user.passwordHash)
  if (!ok) return res.status(401).json({ error: 'invalid credentials' })
  setAuthCookie(res, user.id)
  res.json({ id: user.id, name: user.name, email: user.email })
})

app.post('/api/auth/logout', async (_req, res) => {
  res.clearCookie('session')
  res.json({ ok: true })
})

const ProfileSchema = z.object({
  height_cm: z.number().int().positive(),
  current_weight_kg: z.number().positive(),
  goal_weight_kg: z.number().positive(),
  target_date: z.string().optional(),
  gender: z.string(),
  age: z.number().int().positive(),
  activity_level: z.enum(['sedentary', 'light', 'moderate', 'intense'])
})

function computeDailyDuby(bmr: number, activity: 'sedentary'|'light'|'moderate'|'intense', wwPoints?: number): number {
  if (wwPoints && wwPoints > 0) return wwPoints * 9 + 2
  const factor = activity === 'sedentary' ? 1.2 : activity === 'light' ? 1.375 : activity === 'moderate' ? 1.55 : 1.725
  const tdee = bmr * factor
  return Math.round(tdee / 300) // fallback simple mapping
}

function estimateWWPoints(gender: string, age: number, heightCm: number, weightKg: number): number {
  // Very rough heuristic approximating old WW daily points (not official)
  const isMale = gender.toLowerCase().startsWith('m')
  let pts = 0
  pts += isMale ? 15 : 7
  pts += weightKg >= 90 ? 5 : weightKg >= 75 ? 4 : weightKg >= 60 ? 3 : 2
  pts += heightCm >= 175 ? 2 : heightCm >= 160 ? 1 : 0
  pts += age < 26 ? 4 : age < 37 ? 3 : age < 47 ? 2 : age < 58 ? 1 : 0
  return pts
}

app.put('/api/me/profile', async (req, res) => {
  const uid = await requireUser(req)
  if (!uid) return res.status(401).json({ error: 'unauthorized' })
  const parse = ProfileSchema.safeParse(req.body)
  if (!parse.success) return res.status(400).json({ error: 'Invalid profile' })
  const p = parse.data
  const user = await prisma.user.findUnique({ where: { id: uid } })
  const isMale = p.gender.toLowerCase().startsWith('m')
  const bmr = isMale
    ? 10 * p.current_weight_kg + 6.25 * p.height_cm - 5 * p.age + 5
    : 10 * p.current_weight_kg + 6.25 * p.height_cm - 5 * p.age - 161
  const ww = estimateWWPoints(p.gender, p.age, p.height_cm, p.current_weight_kg)
  const daily = computeDailyDuby(bmr, p.activity_level, ww)
  await prisma.profile.upsert({
    where: { userId: uid },
    update: {
      heightCm: p.height_cm,
      currentWeightKg: p.current_weight_kg as any,
      goalWeightKg: p.goal_weight_kg as any,
      targetDate: p.target_date ? new Date(p.target_date) : null,
      gender: p.gender,
      age: p.age,
      activityLevel: p.activity_level as any,
      dailyDubyBudget: daily,
    },
    create: {
      userId: uid,
      heightCm: p.height_cm,
      currentWeightKg: p.current_weight_kg as any,
      goalWeightKg: p.goal_weight_kg as any,
      targetDate: p.target_date ? new Date(p.target_date) : null,
      gender: p.gender,
      age: p.age,
      activityLevel: p.activity_level as any,
      dailyDubyBudget: daily,
    },
  })

  try {
    const sheetId = process.env.GOOGLE_SHEETS_ID
    const hasSheetsAuth = !!(sheetId && (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS))
    if (sheetId && hasSheetsAuth && user?.name) {
      const tab = await ensureUserTab(sheetId, user.name, 'UserTemplate')
      await writeGeneralInfo(sheetId, tab, {
        name: user.name,
        heightCm: p.height_cm,
        startWeightKg: p.current_weight_kg,
        gender: p.gender,
        age: p.age,
        targetWeightKg: p.goal_weight_kg,
        targetDateIso: p.target_date,
        dailyBudget: daily,
      })
    }
  } catch {}

  res.json({ daily_duby_budget: daily })
})

app.get('/api/dashboard', async (req, res) => {
  try {
    const uid = await requireUser(req)
    const user = uid ? await prisma.user.findUnique({ where: { id: uid } }) : null

    const now = new Date()
    const start = new Date(now)
    start.setHours(0, 0, 0, 0)
    const end = new Date(start)
    end.setDate(end.getDate() + 1)

    // Always load today's logs to build itemized view
    const dayLogs = await prisma.foodLog.findMany({
      where: { userId: uid || 'demo', occurredAt: { gte: start, lt: end } },
      include: { foodItem: true },
      orderBy: { occurredAt: 'asc' },
    })
    const items = dayLogs.map(l => ({
      id: l.id,
      time: l.occurredAt.toISOString().slice(11, 16),
      food: l.foodItem?.name || '',
      price: Number(l.dubyCost || 0),
    }))

    let remaining = 24
    let foodList = items.map(i => i.food).join(' | ')
    let price = items.reduce((s, l) => s + l.price, 0)

    try {
      const sheetId = process.env.GOOGLE_SHEETS_ID
      const hasSheetsAuth = !!(sheetId && (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS))
      if (sheetId && hasSheetsAuth && user?.name) {
        const tab = await ensureUserTab(sheetId, user.name, 'UserTemplate')
        const today = await findBudgetToday(sheetId, tab, now)
        if (today) {
          remaining = today.surplus
          foodList = today.food
          price = today.price
        } else {
          const dailyBudget = await readDailyBudget(sheetId, tab)
          remaining = dailyBudget - price
        }
      }
    } catch {}

    // compute next Friday
    const nextFriday = (() => {
      const d = new Date(now)
      const day = d.getDay() // 0=Sun..6=Sat
      const add = (5 - day + 7) % 7 || 7
      d.setDate(d.getDate() + add)
      return d.toISOString().slice(0,10)
    })()

    res.json({
      remainingDubyToday: remaining,
      entries: [
        { time: now.toISOString().slice(0,10), food: foodList, dubyCost: price },
      ],
      items,
      nextWeighIn: nextFriday,
    })
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'Failed to load dashboard' })
  }
})

app.delete('/api/food-log/:id', async (req, res) => {
  try {
    const uid = (await requireUser(req)) || 'demo'
    const id = String(req.params.id)
    const entry = await prisma.foodLog.findUnique({ where: { id }, include: { foodItem: true } })
    if (!entry || entry.userId !== uid) return res.status(404).json({ error: 'not found' })

    await prisma.foodLog.delete({ where: { id } })

    // Update sheet budget row after deletion
    try {
      const sheetId = process.env.GOOGLE_SHEETS_ID
      const hasSheetsAuth = !!(sheetId && (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS))
      const user = await prisma.user.findUnique({ where: { id: uid } })
      if (sheetId && hasSheetsAuth && user?.name) {
        const tab = await ensureUserTab(sheetId, user.name, 'UserTemplate')
        const day = new Date(entry.occurredAt)
        const start = new Date(day); start.setHours(0,0,0,0)
        const end = new Date(start); end.setDate(end.getDate()+1)
        const logs = await prisma.foodLog.findMany({ where: { userId: uid, occurredAt: { gte: start, lt: end } }, include: { foodItem: true }, orderBy: { occurredAt: 'asc' } })
        const foodJoined = logs.map(l => l.foodItem?.name || '').join(' | ')
        const price = logs.reduce((s, l) => s + Number(l.dubyCost || 0), 0)
        const dailyBudget = await readDailyBudget(sheetId, tab)
        await upsertBudgetRow(sheetId, tab, start.toISOString().slice(0,10), dailyBudget, price, foodJoined)
      }
    } catch {}

    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'Failed to delete' })
  }
})

app.get('/api/debug/sheets', async (_req, res) => {
  try {
    const sheetId = process.env.GOOGLE_SHEETS_ID
    if (!sheetId) return res.status(400).json({ error: 'GOOGLE_SHEETS_ID not set' })
    const titles = await listSheetTitles(sheetId)
    res.json({ titles })
  } catch (e: any) {
    res.status(500).json({ error: e?.message })
  }
})

app.get('/api/debug/range', async (req, res) => {
  try {
    const sheetId = process.env.GOOGLE_SHEETS_ID
    const range = String(req.query.range || 'FoodList!A1:C10')
    if (!sheetId) return res.status(400).json({ error: 'GOOGLE_SHEETS_ID not set' })
    const values = await readRange(sheetId, range)
    res.json({ range, values })
  } catch (e: any) {
    res.status(500).json({ error: e?.message })
  }
})

app.get('/api/food', async (_req, res) => {
  try {
    const sheetId = process.env.GOOGLE_SHEETS_ID
    const hasInline = !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON
    const hasKeyFile = !!process.env.GOOGLE_APPLICATION_CREDENTIALS
    if (sheetId && (hasInline || hasKeyFile)) {
      const rows = await readFoodList(sheetId)
      return res.json(rows)
    }
    const items = await prisma.foodItem.findMany({ orderBy: { name: 'asc' } })
    res.json(items)
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'Failed to load food list' })
  }
})

app.get('/api/food/search', async (req, res) => {
  try {
    const q = String(req.query.q || '')
    const sheetId = process.env.GOOGLE_SHEETS_ID
    if (!sheetId) return res.json([])
    const rows = await searchFood(sheetId, q)
    res.json(rows)
  } catch (e: any) {
    res.status(500).json({ error: e?.message })
  }
})

const FoodLogSchema = z.object({
  name: z.string(),
  duby: z.number(),
  unit: z.string(),
  portion: z.number().positive(),
  occurred_at: z.string().optional(),
})

app.post('/api/food-log', async (req, res) => {
  try {
    const parse = FoodLogSchema.safeParse(req.body)
    if (!parse.success) return res.status(400).json({ error: 'Invalid input' })
    const { name, duby, unit, portion, occurred_at } = parse.data

    const uid = (await requireUser(req)) || 'demo'

    // Ensure user exists to satisfy FK
    if (uid === 'demo') {
      await prisma.user.upsert({ where: { id: 'demo' }, update: {}, create: { id: 'demo', name: 'Demo', email: 'demo@example.com', passwordHash: 'x' } })
    }

    // Avoid upsert by non-unique field: find/update or create
    const existing = await prisma.foodItem.findFirst({ where: { name } })
    let foodId: string
    if (existing) {
      const updated = await prisma.foodItem.update({ where: { id: existing.id }, data: { duby: (Number(duby) as any), unit } })
      foodId = updated.id
    } else {
      const created = await prisma.foodItem.create({ data: { name, duby: (Number(duby) as any), unit } })
      foodId = created.id
    }

    const entry = await prisma.foodLog.create({
      data: {
        userId: uid,
        foodItemId: foodId,
        portion: (Number(portion) as any),
        occurredAt: occurred_at ? new Date(occurred_at) : new Date(),
        dubyCost: ((Number(duby) || 0) * (Number(portion) || 1)) as any,
      },
    })

    // Also reflect into user's sheet Budget row (if configured)
    try {
      const sheetId = process.env.GOOGLE_SHEETS_ID
      const hasSheetsAuth = !!(sheetId && (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS))
      const user = await prisma.user.findUnique({ where: { id: uid } })
      if (sheetId && hasSheetsAuth && user?.name) {
        const tab = await ensureUserTab(sheetId, user.name, 'UserTemplate')
        const today = new Date()
        const start = new Date(today); start.setHours(0,0,0,0)
        const end = new Date(start); end.setDate(end.getDate()+1)
        const logs = await prisma.foodLog.findMany({ where: { userId: uid, occurredAt: { gte: start, lt: end } }, include: { foodItem: true }, orderBy: { occurredAt: 'asc' } })
        const foodJoined = logs.map(l => l.foodItem?.name || '').join(' | ')
        const price = logs.reduce((s, l) => s + Number(l.dubyCost || 0), 0)
        const dailyBudget = await readDailyBudget(sheetId, tab)
        await upsertBudgetRow(sheetId, tab, start.toISOString().slice(0,10), dailyBudget, price, foodJoined)
      }
    } catch {}

    res.status(201).json({ id: entry.id })
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'Failed to create log' })
  }
})

const WeightLogSchema = z.object({
  weight_kg: z.number().positive(),
  date: z.string().optional(),
})

app.post('/api/weight-log', async (req, res) => {
  try {
    const parse = WeightLogSchema.safeParse(req.body)
    if (!parse.success) return res.status(400).json({ error: 'Invalid input' })
    const { weight_kg, date } = parse.data

    const uid = (await requireUser(req)) || 'demo'
    if (uid === 'demo') {
      await prisma.user.upsert({ where: { id: 'demo' }, update: {}, create: { id: 'demo', name: 'Demo', email: 'demo@example.com', passwordHash: 'x' } })
    }

    // Optionally also store in DB for completeness
    await prisma.weightLog.create({ data: { userId: uid, weightKg: weight_kg as any, date: date ? new Date(date) : new Date() } })

    // Write to user's sheet Progress table if configured
    try {
      const sheetId = process.env.GOOGLE_SHEETS_ID
      const hasSheetsAuth = !!(sheetId && (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS))
      const user = await prisma.user.findUnique({ where: { id: uid } })
      if (sheetId && hasSheetsAuth && user?.name) {
        const tab = await ensureUserTab(sheetId, user.name, 'UserTemplate')
        const dateIso = (date ? new Date(date) : new Date()).toISOString().slice(0,10)
        await appendProgressRow(sheetId, tab, dateIso, weight_kg)
      }
    } catch {}

    res.status(201).json({ ok: true })
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'Failed to log weight' })
  }
})

const port = process.env.PORT ? Number(process.env.PORT) : 4000
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`API listening on http://localhost:${port}`)
})