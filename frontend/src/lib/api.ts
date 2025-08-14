import axios from 'axios'

const raw = (import.meta.env.VITE_API_BASE_URL as string) || 'http://localhost:4000'
const baseURL = raw.endsWith('/api') ? raw : raw.replace(/\/+$/, '') + '/api'

export const api = axios.create({
  baseURL,
  withCredentials: true,
})