import { useCallback, useEffect, useRef, useState } from 'react'
import { db, applyRemoteChanges, setSyncUser, type Client, type Payment, type Product, type Sale, type Setting, type SyncMetadata } from './db'
import { supabase } from './supabase'

export type SyncStatus = 'starting' | 'synced' | 'offline' | 'pending' | 'error'

interface RemoteClient {
  id: string
  name: string
  phone: string
  created_at: string
  updated_at: string
  archived_at: string | null
}

interface RemoteProduct {
  id: string
  name: string
  code: string
  price: number
  created_at: string
  updated_at: string
  archived_at: string | null
}

interface RemoteSale {
  id: string
  client_id: string
  items: Array<{ name: string; code: string; price: number; product_id: string | null }>
  total: number
  date: string
  updated_at: string
}

interface RemotePayment {
  id: string
  client_id: string
  amount: number
  date: string
  note: string
  updated_at: string
}

interface RemoteSetting {
  key: string
  value: number
  updated_at: string
}

type SyncedTable = 'clients' | 'products' | 'sales' | 'payments' | 'user_settings'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Erro inesperado durante a sincronização.'
}

async function loadRemoteTable(table: SyncedTable): Promise<unknown[]> {
  if (!supabase) throw new Error('Supabase não está configurado.')
  const rows: unknown[] = []
  const pageSize = 500
  let offset = 0

  while (true) {
    const orderColumn = table === 'user_settings' ? 'key' : 'id'
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .order(orderColumn)
      .range(offset, offset + pageSize - 1)
    if (error) throw error
    const page = data ?? []
    rows.push(...page)
    if (page.length < pageSize) return rows
    offset += pageSize
  }
}

async function ensureLocalOwnership(userId: string): Promise<void> {
  const clients = await db.clients.toArray()
  const ownedClientIds = new Set<number>()

  await db.transaction('rw', db.clients, db.sales, db.payments, db.products, db.settings, async () => {
    for (const client of clients) {
      if (client.userId && client.userId !== userId) continue
      if (client.id === undefined) continue
      ownedClientIds.add(client.id)
      if (client.userId === userId && client.syncId && client.syncStatus && client.updatedAt) continue
      await db.clients.update(client.id, {
        userId,
        syncId: client.syncId ?? crypto.randomUUID(),
        syncStatus: client.syncStatus ?? 'pending',
        updatedAt: client.updatedAt ?? new Date().toISOString(),
      })
    }

    for (const table of [db.sales, db.payments] as const) {
      const records = await table.toArray()
      for (const record of records) {
        if (record.userId && record.userId !== userId) continue
        if (record.id === undefined || !ownedClientIds.has(record.clientId)) continue
        if (record.userId === userId && record.syncId && record.syncStatus && record.updatedAt) continue
        await table.update(record.id, {
          userId,
          syncId: record.syncId ?? crypto.randomUUID(),
          syncStatus: record.syncStatus === 'synced' ? 'synced' : 'pending',
          updatedAt: record.updatedAt ?? new Date().toISOString(),
        })
      }
    }

    const products = await db.products.toArray()
    for (const product of products) {
      if (product.userId && product.userId !== userId) continue
      if (product.id === undefined) continue
      if (product.userId === userId && product.syncId && product.syncStatus && product.updatedAt) continue
      await db.products.update(product.id, {
        userId,
        syncId: product.syncId ?? crypto.randomUUID(),
        syncStatus: product.syncStatus ?? 'pending',
        updatedAt: product.updatedAt ?? new Date().toISOString(),
      })
    }

    const settings = await db.settings.toArray()
    for (const setting of settings) {
      if (setting.userId && setting.userId !== userId) continue
      if (setting.key === 'commissionRate') {
        await db.settings.delete(setting.key)
        setting.key = `${userId}:commissionRate`
      }
      if (setting.userId === userId && setting.syncId && setting.syncStatus && setting.updatedAt) continue
      await db.settings.put({
        ...setting,
        userId,
        syncId: setting.syncId ?? crypto.randomUUID(),
        syncStatus: setting.syncStatus ?? 'pending',
        updatedAt: setting.updatedAt ?? new Date().toISOString(),
      })
    }
  })

  const migrationKey = `legacy-migrated:${userId}`
  const migration = await db.syncMetadata.get(migrationKey)
  if (!migration) {
    const record: SyncMetadata = { key: migrationKey, value: new Date().toISOString() }
    await db.syncMetadata.put(record)
  }
}

async function pushPending(userId: string): Promise<void> {
  if (!supabase) throw new Error('Supabase não está configurado.')
  const clients = await db.clients.where('userId').equals(userId).toArray()
  const products = await db.products.where('userId').equals(userId).toArray()
  const sales = await db.sales.where('userId').equals(userId).toArray()
  const payments = await db.payments.where('userId').equals(userId).toArray()
  const settings = await db.settings.where('userId').equals(userId).toArray()

  for (const client of clients.filter((record) => record.syncStatus === 'pending')) {
    if (!client.syncId) throw new Error(`Cliente "${client.name}" sem identificador de sincronização.`)
    const { error } = await supabase.from('clients').upsert({
      id: client.syncId,
      owner_id: userId,
      name: client.name,
      phone: client.phone,
      created_at: client.createdAt,
      updated_at: client.updatedAt ?? new Date().toISOString(),
      archived_at: client.archivedAt ?? null,
    }, { onConflict: 'id' })
    if (error) throw error
    await markClientSynced(client, userId)
  }

  for (const product of products.filter((record) => record.syncStatus === 'pending')) {
    if (!product.syncId) throw new Error(`Produto "${product.name}" sem identificador de sincronização.`)
    const { error } = await supabase.from('products').upsert({
      id: product.syncId,
      owner_id: userId,
      name: product.name,
      code: product.code,
      price: product.price,
      created_at: product.createdAt,
      updated_at: product.updatedAt ?? new Date().toISOString(),
      archived_at: product.archivedAt ?? null,
    }, { onConflict: 'id' })
    if (error) throw error
    await markProductSynced(product, userId)
  }

  for (const sale of sales.filter((record) => record.syncStatus === 'pending')) {
    const client = clients.find((record) => record.id === sale.clientId)
    if (!sale.syncId || !client?.syncId) {
      throw new Error('Não foi possível sincronizar uma venda: cliente ou venda sem identificador.')
    }
    const { error } = await supabase.from('sales').upsert({
      id: sale.syncId,
      owner_id: userId,
      client_id: client.syncId,
      items: sale.items.map((item) => ({
        name: item.name,
        code: item.code,
        price: item.price,
        product_id: item.productSyncId ?? null,
      })),
      total: sale.total,
      date: sale.date,
      updated_at: sale.updatedAt ?? new Date().toISOString(),
    }, { onConflict: 'id' })
    if (error) throw error
    await markSaleSynced(sale, userId)
  }

  for (const payment of payments.filter((record) => record.syncStatus === 'pending')) {
    const client = clients.find((record) => record.id === payment.clientId)
    const paymentId = payment.id
    if (paymentId === undefined || !payment.syncId || !client?.syncId) {
      throw new Error('Não foi possível sincronizar um pagamento: cliente ou pagamento sem identificador.')
    }
    const { error } = await supabase.from('payments').upsert({
      id: payment.syncId,
      owner_id: userId,
      client_id: client.syncId,
      amount: payment.amount,
      date: payment.date,
      note: payment.note,
      updated_at: payment.updatedAt ?? new Date().toISOString(),
    }, { onConflict: 'id' })
    if (error) {
      if (error.code === 'P0001') {
        await applyRemoteChanges(() => db.payments.update(paymentId, {
          syncStatus: 'conflict',
          syncError: error.message,
        }))
      }
      throw error
    }
    await markPaymentSynced(payment, userId)
  }

  for (const setting of settings.filter((record) => record.syncStatus === 'pending')) {
    if (!setting.syncId) throw new Error('Ajuste sem identificador de sincronização.')
    const { error } = await supabase.from('user_settings').upsert({
      owner_id: userId,
      key: setting.key.replace(`${userId}:`, ''),
      value: setting.value,
      updated_at: setting.updatedAt ?? new Date().toISOString(),
    }, { onConflict: 'owner_id,key' })
    if (error) throw error
    await markSettingSynced(setting, userId)
  }
}

function isSameVersion(
  current: { userId?: string; updatedAt?: string },
  record: { updatedAt?: string },
  userId: string,
): boolean {
  return current.userId === userId && current.updatedAt === record.updatedAt
}

async function markClientSynced(record: Client, userId: string): Promise<void> {
  const id = record.id
  if (id === undefined) throw new Error('Cliente local sem chave.')
  const current = await db.clients.get(id)
  if (!current || !isSameVersion(current, record, userId)) return
  await applyRemoteChanges(() => db.clients.update(id, { syncStatus: 'synced' }))
}

async function markProductSynced(record: Product, userId: string): Promise<void> {
  const id = record.id
  if (id === undefined) throw new Error('Produto local sem chave.')
  const current = await db.products.get(id)
  if (!current || !isSameVersion(current, record, userId)) return
  await applyRemoteChanges(() => db.products.update(id, { syncStatus: 'synced' }))
}

async function markSaleSynced(record: Sale, userId: string): Promise<void> {
  const id = record.id
  if (id === undefined) throw new Error('Venda local sem chave.')
  const current = await db.sales.get(id)
  if (!current || !isSameVersion(current, record, userId)) return
  await applyRemoteChanges(() => db.sales.update(id, { syncStatus: 'synced' }))
}

async function markPaymentSynced(record: Payment, userId: string): Promise<void> {
  const id = record.id
  if (id === undefined) throw new Error('Pagamento local sem chave.')
  const current = await db.payments.get(id)
  if (!current || !isSameVersion(current, record, userId)) return
  await applyRemoteChanges(() => db.payments.update(id, { syncStatus: 'synced' }))
}

async function markSettingSynced(record: Setting, userId: string): Promise<void> {
  const current = await db.settings.get(record.key)
  if (!current || !isSameVersion(current, record, userId)) return
  await applyRemoteChanges(() => db.settings.update(record.key, { syncStatus: 'synced' }))
}

async function pullRemote(userId: string): Promise<void> {
  if (!supabase) throw new Error('Supabase não está configurado.')
  const [remoteClients, remoteProducts, remoteSales, remotePayments, remoteSettings] = await Promise.all([
    loadRemoteTable('clients'),
    loadRemoteTable('products'),
    loadRemoteTable('sales'),
    loadRemoteTable('payments'),
    loadRemoteTable('user_settings'),
  ])

  await applyRemoteChanges(() => db.transaction(
    'rw',
    db.clients,
    db.products,
    db.sales,
    db.payments,
    db.settings,
    async () => {
      for (const remote of remoteClients as RemoteClient[]) {
        const existing = await db.clients.where('syncId').equals(remote.id).first()
        if (existing?.syncStatus === 'pending') continue
        const local: Client = {
          ...existing,
          userId,
          syncId: remote.id,
          syncStatus: 'synced',
          name: remote.name,
          phone: remote.phone,
          createdAt: remote.created_at,
          updatedAt: remote.updated_at,
          archivedAt: remote.archived_at ?? undefined,
        }
        if (existing?.id === undefined) await db.clients.add(local)
        else await db.clients.put({ ...local, id: existing.id })
      }

      for (const remote of remoteProducts as RemoteProduct[]) {
        const existing = await db.products.where('syncId').equals(remote.id).first()
        if (existing?.syncStatus === 'pending') continue
        const local: Product = {
          ...existing,
          userId,
          syncId: remote.id,
          syncStatus: 'synced',
          name: remote.name,
          code: remote.code,
          price: Number(remote.price),
          createdAt: remote.created_at,
          updatedAt: remote.updated_at,
          archivedAt: remote.archived_at ?? undefined,
        }
        if (existing?.id === undefined) await db.products.add(local)
        else await db.products.put({ ...local, id: existing.id })
      }

      const localClients = await db.clients.where('userId').equals(userId).toArray()
      for (const remote of remoteSales as RemoteSale[]) {
        const existing = await db.sales.where('syncId').equals(remote.id).first()
        if (existing?.syncStatus === 'pending') continue
        const client = localClients.find((record) => record.syncId === remote.client_id)
        if (client?.id === undefined) throw new Error('Uma venda sincronizada está vinculada a um cliente ausente.')
        const local: Sale = {
          ...existing,
          userId,
          syncId: remote.id,
          syncStatus: 'synced',
          clientId: client.id,
          items: remote.items.map((item) => ({
            name: item.name,
            code: item.code,
            price: Number(item.price),
            productSyncId: item.product_id ?? undefined,
          })),
          total: Number(remote.total),
          date: remote.date,
          updatedAt: remote.updated_at,
        }
        if (existing?.id === undefined) await db.sales.add(local)
        else await db.sales.put({ ...local, id: existing.id })
      }

      for (const remote of remotePayments as RemotePayment[]) {
        const existing = await db.payments.where('syncId').equals(remote.id).first()
        if (existing?.syncStatus === 'pending') continue
        const client = localClients.find((record) => record.syncId === remote.client_id)
        if (client?.id === undefined) throw new Error('Um pagamento sincronizado está vinculado a um cliente ausente.')
        const local: Payment = {
          ...existing,
          userId,
          syncId: remote.id,
          syncStatus: 'synced',
          clientId: client.id,
          amount: Number(remote.amount),
          date: remote.date,
          note: remote.note,
          updatedAt: remote.updated_at,
        }
        if (existing?.id === undefined) await db.payments.add(local)
        else await db.payments.put({ ...local, id: existing.id })
      }

      for (const remote of remoteSettings as RemoteSetting[]) {
        const key = `${userId}:${remote.key}`
        const existing = await db.settings.get(key)
        if (existing?.syncStatus === 'pending') continue
        await db.settings.put({
          ...existing,
          key,
          userId,
          syncId: existing?.syncId ?? crypto.randomUUID(),
          syncStatus: 'synced',
          value: Number(remote.value),
          updatedAt: remote.updated_at,
        })
      }
    },
  ))
}

export function useCloudSync(userId: string): {
  status: SyncStatus
  error: string
  syncNow: () => Promise<void>
} {
  const [status, setStatus] = useState<SyncStatus>('starting')
  const [error, setError] = useState('')
  const activeSync = useRef<Promise<void> | null>(null)
  const mounted = useRef(true)

  const syncNow = useCallback(async () => {
    if (!supabase) throw new Error('Configure o Supabase para sincronizar os dados.')
    if (!navigator.onLine) {
      setStatus('offline')
      return
    }
    if (activeSync.current) return activeSync.current
    const operation = (async () => {
      try {
        setStatus('pending')
        setError('')
        await pushPending(userId)
        await pullRemote(userId)
        if (mounted.current) setStatus('synced')
      } catch (syncError) {
        console.error('Falha ao sincronizar com o Supabase.', syncError)
        if (mounted.current) {
          setError(messageOf(syncError))
          setStatus('error')
        }
        throw syncError
      }
    })()
    activeSync.current = operation
    try {
      await operation
    } finally {
      activeSync.current = null
    }
  }, [userId])

  useEffect(() => {
    mounted.current = true
    setSyncUser(userId)
    let channel: ReturnType<NonNullable<typeof supabase>['channel']> | undefined
    let interval: number | undefined

    const start = async () => {
      try {
        await ensureLocalOwnership(userId)
        if (!navigator.onLine) {
          setStatus('offline')
          return
        }
        await syncNow()
      } catch (syncError) {
        console.error('A inicialização da sincronização falhou.', syncError)
        if (mounted.current) {
          setError(messageOf(syncError))
          setStatus('error')
        }
      }
    }
    const onOnline = () => { void syncNow().catch(() => undefined) }
    const onOffline = () => setStatus('offline')

    void start()
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    interval = window.setInterval(() => {
      if (navigator.onLine) void syncNow().catch(() => undefined)
    }, 30000)

    if (supabase) {
      channel = supabase
        .channel(`account-sync-${userId}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'clients' }, onOnline)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, onOnline)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'sales' }, onOnline)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'payments' }, onOnline)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'user_settings' }, onOnline)
        .subscribe()
    }

    return () => {
      mounted.current = false
      setSyncUser(undefined)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      if (interval !== undefined) window.clearInterval(interval)
      if (channel && supabase) void supabase.removeChannel(channel)
    }
  }, [userId, syncNow])

  return { status, error, syncNow }
}
