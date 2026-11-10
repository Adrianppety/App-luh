import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return response({ error: 'Método não permitido.' }, 405)

  const projectUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!projectUrl || !anonKey || !serviceRoleKey) {
    console.error('Configuração da função de autenticação incompleta.')
    return response({ error: 'Autenticação indisponível no momento.' }, 500)
  }

  let input: unknown
  try {
    input = await request.json()
  } catch {
    return response({ error: 'Requisição inválida.' }, 400)
  }
  if (!input || typeof input !== 'object') return response({ error: 'Requisição inválida.' }, 400)

  const body = input as Record<string, unknown>
  const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : ''
  const password = typeof body.password === 'string' ? body.password : ''
  const action = body.action
  if (!/^[a-z0-9._-]{3,30}$/.test(username) || password.length < 8 || password.length > 72) {
    return response({ error: 'Informe usuário válido e senha com pelo menos 8 caracteres.' }, 400)
  }
  if (action !== 'register' && action !== 'login') {
    return response({ error: 'Ação de autenticação inválida.' }, 400)
  }

  const admin = createClient(projectUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const auth = createClient(projectUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const email = `${username}@users.app-luh.invalid`
  let userId: string

  if (action === 'register') {
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { username },
    })
    if (createError || !created.user) {
      return response({ error: 'Não foi possível criar a conta. Verifique se o usuário já existe.' }, 409)
    }

    userId = created.user.id
    const { error: mappingError } = await admin
      .from('login_names')
      .insert({ username, user_id: userId })
    if (mappingError) {
      const { error: cleanupError } = await admin.auth.admin.deleteUser(userId)
      if (cleanupError) console.error('Falha ao remover conta após erro no cadastro.', cleanupError)
      return response({ error: 'Não foi possível concluir o cadastro.' }, 409)
    }
  } else {
    const { data: mapping, error: lookupError } = await admin
      .from('login_names')
      .select('user_id')
      .eq('username', username)
      .maybeSingle()
    if (lookupError) {
      console.error('Falha ao localizar usuário.', lookupError)
      return response({ error: 'Não foi possível validar o login.' }, 500)
    }
    if (!mapping) return response({ error: 'Usuário ou senha incorretos.' }, 401)
    userId = mapping.user_id
  }

  const { data: signIn, error: signInError } = await auth.auth.signInWithPassword({ email, password })
  if (signInError || !signIn.session || signIn.user?.id !== userId) {
    if (action === 'register') {
      const { error: mappingCleanupError } = await admin.from('login_names').delete().eq('user_id', userId)
      if (mappingCleanupError) console.error('Falha ao remover vínculo de cadastro incompleto.', mappingCleanupError)
      const { error: userCleanupError } = await admin.auth.admin.deleteUser(userId)
      if (userCleanupError) console.error('Falha ao remover cadastro incompleto.', userCleanupError)
    }
    return response({ error: 'Usuário ou senha incorretos.' }, 401)
  }

  return response({ session: signIn.session })
})
