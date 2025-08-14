import { BrowserRouter, Routes, Route, Navigate, Link, useLocation, useNavigate } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { api } from './lib/api'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Trash2 } from 'lucide-react'

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-shell">
      <div className="header-gradient">
        <div className="header-bar">
          <h1 className="header-title">Weight Budget</h1>
        </div>
      </div>
      <main className="main">{children}</main>
      <BottomNav />
    </div>
  )
}

function Card({ title, children, actions }: { title: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <section className="card">
      <div className="card-header">
        <h2 className="card-title">{title}</h2>
      </div>
      <div className="card-body">{children}</div>
      {actions && <div className="card-footer">{actions}</div>}
    </section>
  )
}

function Auth() {
  const [mode, setMode] = useState<'login'|'register'>('register')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [status, setStatus] = useState('')
  const navigate = useNavigate()

  const submit = async () => {
    try {
      setStatus('Please wait…')
      if (mode === 'register') {
        await api.post('/auth/register', { name, email, password })
        setStatus('Registered!')
        navigate('/onboarding')
      } else {
        await api.post('/auth/login', { email, password })
        setStatus('Logged in!')
        navigate('/dashboard')
      }
    } catch (e: any) {
      setStatus(e?.response?.data?.error || e?.message || 'Failed')
    }
  }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <Card title="Welcome">
        <div className="segmented">
          <button className={`seg-btn ${mode==='register'?'seg-active':''}`} onClick={() => setMode('register')}>Register</button>
          <button className={`seg-btn ${mode==='login'?'seg-active':''}`} onClick={() => setMode('login')}>Login</button>
        </div>
        {mode==='register' && (
          <div style={{ display: 'grid', gap: 12, marginTop: 8 }}>
            <input className="input" placeholder="Full Name" value={name} onChange={e=>setName(e.target.value)} />
            <input className="input" placeholder="Email" value={email} onChange={e=>setEmail(e.target.value)} />
            <input className="input" placeholder="Password" type="password" value={password} onChange={e=>setPassword(e.target.value)} />
            <button className="btn btn-primary" onClick={submit}>Create Account</button>
          </div>
        )}
        {mode==='login' && (
          <div style={{ display: 'grid', gap: 12, marginTop: 8 }}>
            <input className="input" placeholder="Email" value={email} onChange={e=>setEmail(e.target.value)} />
            <input className="input" placeholder="Password" type="password" value={password} onChange={e=>setPassword(e.target.value)} />
            <button className="btn btn-primary" onClick={submit}>Sign In</button>
          </div>
        )}
        {status && <div className="meta">{status}</div>}
      </Card>
      <div className="chips">
        <span className="chip chip-purple">Secure</span>
        <span className="chip">PWA</span>
      </div>
      <div style={{ display: 'flex', gap: 12 }}>
        <Link className="btn btn-secondary" to="/dashboard">Skip (Demo)</Link>
      </div>
    </div>
  )
}

function Dashboard() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({ queryKey: ['dashboard'], queryFn: async () => (await api.get('/dashboard')).data })
  const remaining = data?.remainingDubyToday ?? 24
  const items = (data?.items ?? []) as { id: string; time: string; food: string; price: number }[]
  const nextWeigh = data?.nextWeighIn ?? ''

  const remove = async (id: string) => {
    await api.delete(`/food-log/${id}`)
    await qc.invalidateQueries({ queryKey: ['dashboard'] })
  }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <Card title="Today">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div className="meta">Remaining Duby Today</div>
            <div className="text-strong">{remaining}</div>
          </div>
          <div className="text-right">
            <div className="meta">Next Weigh-In</div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{nextWeigh || '—'}</div>
          </div>
        </div>
      </Card>
      <Card title="Daily Log">
        {isLoading && <div className="meta">Loading…</div>}
        {!isLoading && items.length === 0 && <div className="meta">No entries yet</div>}
        {!isLoading && items.length > 0 && (
          <ul className="list">
            {items.map((e) => (
              <li key={e.id} className="list-item"><span>{e.time} · {e.food}</span><span style={{ display:'flex', alignItems:'center', gap:8 }}><span style={{ fontWeight: 600 }}>-{e.price}</span><button className="btn btn-ghost" aria-label="Remove" title="Remove" onClick={() => remove(e.id)}><Trash2 size={16} /></button></span></li>
            ))}
          </ul>
        )}
      </Card>
      <div style={{ display: 'flex', gap: 12 }}>
        <Link className="btn btn-primary" to="/add-food">+ Add Food</Link>
        <Link className="btn btn-primary" to="/weigh-in">Weigh-In</Link>
        <Link className="btn btn-secondary" to="/profile">Edit Profile</Link>
      </div>
    </div>
  )
}

function AddFood() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ name: string; duby: number; unit: string }[]>([])
  const [portion, setPortion] = useState('1')
  const [selected, setSelected] = useState<{ name: string; duby: number; unit: string } | null>(null)
  const [status, setStatus] = useState<string>('')
  const navigate = useNavigate()
  const qc = useQueryClient()

  useEffect(() => {
    const t = setTimeout(() => {
      const q = query.trim()
      if (!q) { setResults([]); return }
      api.get('/food/search', { params: { q } }).then(r => setResults(r.data)).catch(() => setResults([]))
    }, 200)
    return () => clearTimeout(t)
  }, [query])

  const submit = async () => {
    if (!selected) { setStatus('Pick a food'); return }
    const body = {
      name: selected.name,
      duby: Number(selected.duby) || 0,
      unit: selected.unit,
      portion: Number(portion) || 1,
    }
    try {
      setStatus('Saving…')
      await api.post('/food-log', body)
      await qc.invalidateQueries({ queryKey: ['dashboard'] })
      navigate('/dashboard')
    } catch (e: any) {
      setStatus(e?.message || 'Failed')
    }
  }

  return (
    <Card title="Add Food" actions={
      <>
        <button className="btn btn-secondary" onClick={() => { setSelected(null); setQuery(''); setResults([]) }}>Clear</button>
        <button className="btn btn-primary" onClick={submit}>Add</button>
      </>
    }>
      <div style={{ display: 'grid', gap: 12 }}>
        <input className="input" placeholder="Search food" value={query} onChange={e => setQuery(e.target.value)} />
        {results.length > 0 && (
          <div className="card" style={{ padding: 8 }}>
            {results.map((r, i) => (
              <button key={i} className="btn btn-secondary" style={{ width: '100%', justifyContent: 'space-between', marginBottom: 8 }} onClick={() => { setSelected(r); setQuery(r.name); setResults([]) }}>
                <span>{r.name} ({r.unit})</span>
                <span>-{Number(r.duby) || 0}</span>
              </button>
            ))}
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <input className="input" placeholder="Portion" value={portion} onChange={e => setPortion(e.target.value)} />
          <input className="input" placeholder="Time (optional)" readOnly value={new Date().toLocaleTimeString()} />
        </div>
        {selected && <div className="meta">Selected: {selected.name} · -{Number(selected.duby) || 0} per {selected.unit}</div>}
        {status && <div className="meta">{status}</div>}
      </div>
    </Card>
  )
}

function Onboarding() {
  const [height, setHeight] = useState('')
  const [weight, setWeight] = useState('')
  const [goal, setGoal] = useState('')
  const [date, setDate] = useState('')
  const [gender, setGender] = useState('Male')
  const [age, setAge] = useState('')
  const [status, setStatus] = useState('')
  const navigate = useNavigate()

  const submit = async () => {
    try {
      setStatus('Saving…')
      await api.put('/me/profile', {
        height_cm: Number(height),
        current_weight_kg: Number(weight),
        goal_weight_kg: Number(goal),
        target_date: date || undefined,
        gender,
        age: Number(age),
        activity_level: 'light',
      })
      setStatus('Saved!')
      navigate('/dashboard')
    } catch (e: any) {
      setStatus(e?.response?.data?.error || e?.message || 'Failed')
    }
  }

  const today = new Date().toISOString().slice(0,10)

  return (
    <Card title="Onboarding" actions={
      <>
        <button className="btn btn-primary" onClick={submit}>Save & Continue</button>
      </>
    }>
      <div style={{ display: 'grid', gap: 12 }}>
        <input className="input" placeholder="Height (cm)" value={height} onChange={e=>setHeight(e.target.value)} />
        <input className="input" placeholder="Current Weight (kg)" value={weight} onChange={e=>setWeight(e.target.value)} />
        <input className="input" placeholder="Goal Weight (kg)" value={goal} onChange={e=>setGoal(e.target.value)} />
        <input className="input" type="date" value={date} min={today} onChange={e=>setDate(e.target.value)} />
        <select className="select" value={gender} onChange={e=>setGender(e.target.value)}>
          <option>Male</option>
          <option>Female</option>
        </select>
        <input className="input" placeholder="Age" value={age} onChange={e=>setAge(e.target.value)} />
        {status && <div className="meta">{status}</div>}
      </div>
    </Card>
  )
}

function WeighIn() {
  const [w, setW] = useState('')
  const [date, setDate] = useState(new Date().toISOString().slice(0,10))
  const [status, setStatus] = useState('')
  const navigate = useNavigate()
  const qc = useQueryClient()

  const submit = async () => {
    try {
      setStatus('Saving…')
      await api.post('/weight-log', { weight_kg: Number(w), date })
      await qc.invalidateQueries({ queryKey: ['dashboard'] })
      setStatus('Saved!')
      navigate('/dashboard')
    } catch (e: any) {
      setStatus(e?.message || 'Failed')
    }
  }

  return (
    <Card title="Weigh-In" actions={
      <>
        <button className="btn btn-secondary" onClick={() => { setW('') }}>Clear</button>
        <button className="btn btn-primary" onClick={submit}>Submit</button>
      </>
    }>
      <div style={{ display: 'grid', gap: 12 }}>
        <input className="input" placeholder="Current Weight (kg)" value={w} onChange={e=>setW(e.target.value)} />
        <input className="input" type="date" value={date} onChange={e=>setDate(e.target.value)} />
        {status && <div className="meta">{status}</div>}
      </div>
    </Card>
  )
}

function Profile() {
  const { data, isLoading, error } = useQuery({ queryKey: ['me'], queryFn: async () => (await api.get('/me')).data, retry: false })
  const p = data?.profile
  const last = data?.lastWeightKg as number | undefined
  const fmt = (d?: string) => d ? new Date(d).toISOString().slice(0,10) : ''

  // Interpret profile.currentWeightKg as starting weight from onboarding
  const starting = p ? Number(p.currentWeightKg) : undefined
  const goal = p ? Number(p.goalWeightKg) : undefined
  const mainGoal = starting!=null && goal!=null ? (starting - goal) : undefined
  const progress = (last!=null && goal!=null) ? (last - goal) : (starting!=null && goal!=null ? (starting - goal) : undefined)

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <Card title="Profile">
        {isLoading && <div className="meta">Loading…</div>}
        {!isLoading && error && <div className="meta">Please sign in to view your profile</div>}
        {!isLoading && !error && (
          <div style={{ display: 'grid', gap: 12 }}>
            <div className="chips">
              <span className="chip">{data?.name || ''}</span>
              <span className="chip chip-purple">{data?.email || ''}</span>
            </div>
            <div className="chips">
              <span className="chip">Daily Duby Budget</span>
              <span className="chip chip-purple">{p?.dailyDubyBudget ?? '—'}</span>
              {p?.targetDate && (<><span className="chip">Target Date</span><span className="chip chip-purple">{fmt(p?.targetDate)}</span></>)}
            </div>
            <div className="card" style={{ padding: 12 }}>
              <div className="meta">Main Goal (starting − goal)</div>
              <div style={{ display:'flex', alignItems:'baseline', gap:12 }}>
                <div style={{ fontSize:18, fontWeight:700 }}>{starting ?? '—'} kg</div>
                <div className="meta">→</div>
                <div style={{ fontSize:18, fontWeight:700 }}>{goal ?? '—'} kg</div>
                <div className="chip" style={{ marginLeft:'auto' }}>{mainGoal!=null ? `${mainGoal.toFixed(1)} kg` : '—'}</div>
              </div>
            </div>
            <div className="card" style={{ padding: 12 }}>
              <div className="meta">Progress (current − goal)</div>
              <div style={{ display:'flex', alignItems:'baseline', gap:12 }}>
                <div style={{ fontSize:18, fontWeight:700 }}>{last ?? starting ?? '—'} kg</div>
                <div className="meta">→</div>
                <div style={{ fontSize:18, fontWeight:700 }}>{goal ?? '—'} kg</div>
                <div className="chip" style={{ marginLeft:'auto' }}>{progress!=null ? `${progress.toFixed(1)} kg` : '—'}</div>
              </div>
            </div>
          </div>
        )}
      </Card>
      <div style={{ display: 'flex', gap: 12 }}>
        <Link className="btn btn-primary" to="/add-food">+ Add Food</Link>
        <Link className="btn btn-primary" to="/weigh-in">Weigh-In</Link>
        <Link className="btn btn-secondary" to="/dashboard">Back to Dashboard</Link>
      </div>
    </div>
  )
}

function BottomNav() {
  const { pathname } = useLocation()
  const active = (p: string) => pathname === p
  return (
    <nav className="nav">
      <div className="nav-inner">
        <Link to="/dashboard" className={`nav-item ${active('/dashboard') ? 'nav-item-active' : ''}`}>Home</Link>
        <Link to="/add-food" className={`nav-item ${active('/add-food') ? 'nav-item-active' : ''}`}>Add</Link>
        <Link to="/weigh-in" className={`nav-item ${active('/weigh-in') ? 'nav-item-active' : ''}`}>Weigh</Link>
        <Link to="/profile" className={`nav-item ${active('/profile') ? 'nav-item-active' : ''}`}>Profile</Link>
      </div>
    </nav>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <Shell>
        <Routes>
          <Route path="/" element={<Navigate to="/auth" replace />} />
          <Route path="/auth" element={<Auth />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/add-food" element={<AddFood />} />
          <Route path="/onboarding" element={<Onboarding />} />
          <Route path="/weigh-in" element={<WeighIn />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Shell>
    </BrowserRouter>
  )
}

