import Dexie, { type EntityTable } from 'dexie'

export interface Client {
  id?: number
  syncId?: string
  userId?: string
  syncStatus?: 'pending' | 'synced'
  updatedAt?: string
  archivedAt?: string
  name: string
  phone: string
  createdAt: string
}

export interface SaleItem {
  name: string
  code: string
  price: number
  productSyncId?: string
}

export interface Sale {
  id?: number
  syncId?: string
  userId?: string
  syncStatus?: 'pending' | 'synced'
  updatedAt?: string
  clientId: number
  items: SaleItem[]
  total: number
  date: string
}

export interface Payment {
  id?: number
  syncId?: string
  userId?: string
  syncStatus?: 'pending' | 'synced' | 'conflict'
  syncError?: string
  updatedAt?: string
  clientId: number
  amount: number
  date: string
  note: string
}

export interface Setting {
  key: string
  syncId?: string
  userId?: string
  syncStatus?: 'pending' | 'synced'
  updatedAt?: string
  value: number
}

export interface Product {
  id?: number
  syncId?: string
  userId?: string
  syncStatus?: 'pending' | 'synced'
  updatedAt?: string
  archivedAt?: string
  name: string
  code: string
  price: number
  createdAt: string
}

export interface SyncMetadata {
  key: string
  value: string
}

interface SyncRecord {
  syncId?: string
  userId?: string
  syncStatus?: 'pending' | 'synced' | 'conflict'
  updatedAt?: string
  syncError?: string
}

let activeUserId: string | undefined
let remoteWriteDepth = 0

function markPending<T extends SyncRecord>(record: T): void {
  if (remoteWriteDepth || !activeUserId) return
  record.userId = activeUserId
  record.syncId ??= crypto.randomUUID()
  record.syncStatus = 'pending'
  record.updatedAt = new Date().toISOString()
}

function markUpdated<T extends Partial<SyncRecord>>(changes: T): T | void {
  if (remoteWriteDepth || !activeUserId) return
  return {
    ...changes,
    userId: activeUserId,
    syncStatus: 'pending',
    updatedAt: new Date().toISOString(),
    syncError: undefined,
  }
}

class AtelierDatabase extends Dexie {
  clients!: EntityTable<Client, 'id'>
  sales!: EntityTable<Sale, 'id'>
  payments!: EntityTable<Payment, 'id'>
  settings!: EntityTable<Setting, 'key'>
  products!: EntityTable<Product, 'id'>
  syncMetadata!: EntityTable<SyncMetadata, 'key'>

  constructor() {
    super('atelie-vendas')
    this.version(1).stores({
      clients: '++id, name, createdAt',
      sales: '++id, clientId, date',
      payments: '++id, clientId, date',
    })
    this.version(2).stores({
      clients: '++id, name, createdAt',
      sales: '++id, clientId, date',
      payments: '++id, clientId, date',
      settings: 'key',
    })
    this.version(3).stores({
      clients: '++id, name, createdAt, syncId, userId, syncStatus, archivedAt',
      sales: '++id, clientId, date, syncId, userId, syncStatus',
      payments: '++id, clientId, date, syncId, userId, syncStatus',
      settings: 'key, syncId, userId, syncStatus',
      products: '++id, name, code, syncId, userId, syncStatus, archivedAt',
      syncMetadata: 'key',
    })

    this.clients.hook('creating').subscribe((_key, record) => markPending(record))
    this.sales.hook('creating').subscribe((_key, record) => markPending(record))
    this.payments.hook('creating').subscribe((_key, record) => markPending(record))
    this.settings.hook('creating').subscribe((_key, record) => markPending(record))
    this.products.hook('creating').subscribe((_key, record) => markPending(record))

    this.clients.hook('updating').subscribe((changes) => markUpdated(changes))
    this.sales.hook('updating').subscribe((changes) => markUpdated(changes))
    this.payments.hook('updating').subscribe((changes) => markUpdated(changes))
    this.settings.hook('updating').subscribe((changes) => markUpdated(changes))
    this.products.hook('updating').subscribe((changes) => markUpdated(changes))
  }
}

export const db = new AtelierDatabase()

export function setSyncUser(userId: string | undefined): void {
  activeUserId = userId
}

export async function applyRemoteChanges<T>(operation: () => Promise<T>): Promise<T> {
  remoteWriteDepth += 1
  try {
    return await operation()
  } finally {
    remoteWriteDepth -= 1
  }
}
