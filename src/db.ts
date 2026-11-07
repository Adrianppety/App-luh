import Dexie, { type EntityTable } from 'dexie'

export interface Client {
  id?: number
  name: string
  phone: string
  createdAt: string
}

export interface SaleItem {
  name: string
  code: string
  price: number
}

export interface Sale {
  id?: number
  clientId: number
  items: SaleItem[]
  total: number
  date: string
}

export interface Payment {
  id?: number
  clientId: number
  amount: number
  date: string
  note: string
}

export interface Setting {
  key: string
  value: number
}

class AtelierDatabase extends Dexie {
  clients!: EntityTable<Client, 'id'>
  sales!: EntityTable<Sale, 'id'>
  payments!: EntityTable<Payment, 'id'>
  settings!: EntityTable<Setting, 'key'>

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
  }
}

export const db = new AtelierDatabase()
