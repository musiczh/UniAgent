import { createMonitorHandler } from './handler.ts'

const url = Deno.env.get('SUPABASE_URL')!
const secretKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
Deno.serve(createMonitorHandler({ url, secretKey }))
