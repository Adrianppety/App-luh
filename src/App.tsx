import { useEffect, useMemo, useRef, useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type Client, type Payment, type Product, type Sale, type SaleItem } from './db'
import { AuthScreen } from './AuthScreen'
import { supabase, isSupabaseConfigured } from './supabase'
import { useCloudSync, type SyncStatus } from './sync'

type Page = 'Visão geral' | 'Clientes' | 'Produtos' | 'Vendas' | 'Pagamentos' | 'Relatórios' | 'Ajustes'

const pages: { name: Page; icon: string }[] = [
  { name: 'Visão geral', icon: '⌂' },
  { name: 'Clientes', icon: '♧' },
  { name: 'Produtos', icon: '□' },
  { name: 'Vendas', icon: '◇' },
  { name: 'Pagamentos', icon: '↙' },
  { name: 'Relatórios', icon: '▤' },
  { name: 'Ajustes', icon: '⚙' },
]

const money = (value: number) =>
  value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const parseDecimal = (value: string) => {
  const normalized = value.trim().replace(/\s/g, '')
  if (!normalized) return Number.NaN
  return Number(normalized.includes(',')
    ? normalized.replace(/\./g, '').replace(',', '.')
    : normalized)
}
const today = () => {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
const formatDate = (date: string) =>
  new Date(`${date.slice(0, 10)}T12:00:00`).toLocaleDateString('pt-BR')
const monthName = (date: Date) =>
  date.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })

function Modal({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: ReactNode
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-stone-950/35 p-0 sm:items-center sm:p-5"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section className="max-h-[92dvh] w-full overflow-y-auto rounded-t-[28px] bg-white p-6 shadow-2xl sm:max-w-lg sm:rounded-[24px]">
        <div className="mb-6 flex items-center justify-between">
          <h2 className="font-serif text-2xl text-stone-800">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Fechar"
            className="button-icon grid h-9 w-9 place-items-center rounded-full text-xl"
          >
            ×
          </button>
        </div>
        {children}
      </section>
    </div>
  )
}

function Field({
  label,
  ...props
}: { label: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block text-sm font-medium text-stone-600">
      {label}
      <input
        {...props}
        className={`mt-2 w-full rounded-xl border border-stone-200 bg-white px-3.5 py-3 text-base outline-none transition focus:border-[#b48b50] focus:ring-2 focus:ring-[#b48b50]/15 ${props.className ?? ''}`}
      />
    </label>
  )
}

function Dashboard({
  userId,
  username,
  syncStatus,
  syncError,
  syncNow,
  onSignOut,
}: {
  userId: string
  username: string
  syncStatus: SyncStatus
  syncError: string
  syncNow: () => Promise<void>
  onSignOut: () => Promise<void>
}) {
  const clients = useLiveQuery(
    () => db.clients.where('userId').equals(userId).sortBy('name'),
    [userId],
  ) ?? []
  const sales = useLiveQuery(() => db.sales.where('userId').equals(userId).toArray(), [userId]) ?? []
  const payments = useLiveQuery(() => db.payments.where('userId').equals(userId).toArray(), [userId]) ?? []
  const products = useLiveQuery(
    () => db.products.where('userId').equals(userId).filter((product) => !product.archivedAt).sortBy('name'),
    [userId],
  ) ?? []
  const setting = useLiveQuery(() => db.settings.get(`${userId}:commissionRate`), [userId])
  const rate = setting?.value ?? 30
  const [page, setPage] = useState<Page>('Visão geral')
  const [modal, setModal] = useState<'client' | 'sale' | 'payment' | null>(null)
  const [productModal, setProductModal] = useState(false)
  const [activeClient, setActiveClient] = useState<number | null>(null)
  const [activeSale, setActiveSale] = useState<Sale | null>(null)
  const [activePayment, setActivePayment] = useState<Payment | null>(null)
  const [clientReportOpen, setClientReportOpen] = useState(false)
  const [clientReportText, setClientReportText] = useState('')
  const [whatsAppPhoneDraft, setWhatsAppPhoneDraft] = useState('')
  const [paymentClientId, setPaymentClientId] = useState<number | undefined>()
  const [search, setSearch] = useState('')
  const [reportMonth, setReportMonth] = useState(today().slice(0, 7))
  const [reportTab, setReportTab] = useState<'resumo' | 'pdf'>('resumo')
  const [pdfStartMonth, setPdfStartMonth] = useState(today().slice(0, 7))
  const [pdfEndMonth, setPdfEndMonth] = useState(today().slice(0, 7))
  const [message, setMessage] = useState('')
  const [draftRate, setDraftRate] = useState('')
  const importRef = useRef<HTMLInputElement>(null)

  const balances = useMemo(() => {
    const result = new Map<number, { sold: number; paid: number; due: number }>()
    clients.forEach((client) => {
      if (client.id !== undefined) result.set(client.id, { sold: 0, paid: 0, due: 0 })
    })
    sales.forEach((sale) => {
      const totals = result.get(sale.clientId)
      if (totals) totals.sold += sale.total
    })
    payments.forEach((payment) => {
      if (payment.syncStatus === 'conflict') return
      const totals = result.get(payment.clientId)
      if (totals) totals.paid += payment.amount
    })
    result.forEach((totals) => { totals.due = Math.max(0, totals.sold - totals.paid) })
    return result
  }, [clients, sales, payments])

  const monthSales = sales.filter((sale) => sale.date.startsWith(today().slice(0, 7)))
  const monthPayments = payments.filter((payment) =>
    payment.syncStatus !== 'conflict' && payment.date.startsWith(today().slice(0, 7)),
  )
  const monthSold = monthSales.reduce((sum, sale) => sum + sale.total, 0)
  const monthReceived = monthPayments.reduce((sum, payment) => sum + payment.amount, 0)
  const totalDue = [...balances.values()].reduce((sum, values) => sum + values.due, 0)
  const reportSales = sales.filter((sale) => reportMonth && sale.date.startsWith(reportMonth))
  const reportPayments = payments.filter((payment) =>
    payment.syncStatus !== 'conflict' && reportMonth && payment.date.startsWith(reportMonth),
  )
  const reportSold = reportSales.reduce((sum, sale) => sum + sale.total, 0)
  const reportReceived = reportPayments.reduce((sum, payment) => sum + payment.amount, 0)
  const pdfReportSales = sales
    .filter((sale) => {
      const month = sale.date.slice(0, 7)
      return pdfStartMonth <= pdfEndMonth && month >= pdfStartMonth && month <= pdfEndMonth
    })
    .sort((a, b) => a.date.localeCompare(b.date))
  const pdfReportTotal = pdfReportSales.reduce((sum, sale) => sum + sale.total, 0)
  const active = clients.find((client) => client.id === activeClient)
  const activeClients = clients.filter((client) => !client.archivedAt)
  const visibleClients = clients.filter((client) =>
    !client.archivedAt &&
      `${client.name} ${client.phone}`.toLocaleLowerCase('pt-BR').includes(search.toLocaleLowerCase('pt-BR')),
  )
  const recentEntries = [
    ...sales.map((sale) => ({ kind: 'Venda', label: sale.items.map((item) => item.name).join(', '), date: sale.date, amount: sale.total, clientId: sale.clientId })),
    ...payments.map((payment) => ({
      kind: 'Pagamento',
      label: `${payment.note || 'Pagamento recebido'}${payment.syncStatus === 'conflict' ? ' · não sincronizado' : ''}`,
      date: payment.date,
      amount: payment.amount,
      clientId: payment.clientId,
    })),
  ].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5)

  function notify(text: string) {
    setMessage(text)
    window.setTimeout(() => setMessage(''), 3500)
  }

  function queueSync() {
    void syncNow().catch(() => undefined)
  }

  function openClientReport(client: Client) {
    const clientSales = sales
      .filter((sale) => sale.clientId === client.id)
      .sort((a, b) => a.date.localeCompare(b.date))
    const clientPayments = payments.filter((payment) =>
      payment.clientId === client.id && payment.syncStatus !== 'conflict',
    )
    const totalPurchases = clientSales.reduce((sum, sale) => sum + sale.total, 0)
    const totalPaid = clientPayments.reduce((sum, payment) => sum + payment.amount, 0)
    const currentBalance = balances.get(client.id ?? -1)?.due ?? 0
    const purchaseHistory = clientSales.length
      ? clientSales
          .map((sale) => {
            const products = sale.items
              .map(
                (item) =>
                  `  • ${item.name}${item.code ? ` (código: ${item.code})` : ''} — ${money(item.price)}`,
              )
              .join('\n')
            return `* Data da compra: ${formatDate(sale.date)}*\n${products}\nTotal da venda: ${money(sale.total)}`
          })
          .join('\n\n')
      : 'Nenhuma compra registrada.'

    setClientReportText(
      `Olá, tudo bem? Passando para informar o relatório da sua compra 🧡\n\n${purchaseHistory}\n\n*Total geral da compra:* ${money(totalPurchases)}\n*Total de pagamentos realizados:* ${money(totalPaid)}\n*Saldo devedor atual:* ${money(currentBalance)}`,
    )
    setWhatsAppPhoneDraft(client.phone ?? '')
    setClientReportOpen(true)
  }

  async function copyClientReport() {
    try {
      await navigator.clipboard.writeText(clientReportText)
      notify('Relatório copiado.')
    } catch (error) {
      console.error(error)
      notify('Não foi possível copiar o relatório neste aparelho.')
    }
  }

  async function saveWhatsAppPhone() {
    if (active?.id === undefined) return
    const phone = whatsAppPhoneDraft.trim()
    if (!phone) {
      notify('Digite o telefone/WhatsApp da cliente.')
      return
    }

    try {
      await db.clients.update(active.id, { phone })
      queueSync()
      setWhatsAppPhoneDraft(phone)
      notify('Telefone salvo no cadastro da cliente.')
    } catch (error) {
      console.error(error)
      notify('Não foi possível salvar o telefone.')
    }
  }

  function sendClientReportByWhatsApp() {
    if (!active?.phone.trim()) {
      notify('Cadastre o telefone da cliente antes de abrir o WhatsApp.')
      return
    }

    const hasInternationalPrefix = active.phone.trim().startsWith('+') || active.phone.trim().startsWith('00')
    const rawPhoneDigits = active.phone.replace(/\D/g, '')
    const phoneDigits = hasInternationalPrefix
      ? rawPhoneDigits.replace(/^00/, '')
      : rawPhoneDigits.replace(/^0+/, '')
    if (phoneDigits.length < 10) {
      notify('O telefone salvo parece incompleto. Atualize o número antes de continuar.')
      return
    }

    const whatsappNumber = hasInternationalPrefix ? phoneDigits : `55${phoneDigits}`
    const url = `https://wa.me/${whatsappNumber}?text=${encodeURIComponent(clientReportText)}`
    const whatsappWindow = window.open(url, '_blank')
    if (!whatsappWindow) {
      notify('Não foi possível abrir o WhatsApp. Verifique o bloqueador de pop-ups.')
      return
    }
    whatsappWindow.opener = null
  }

  function generateSalesPdf() {
    if (!pdfStartMonth || !pdfEndMonth) {
      notify('Selecione o mês inicial e o mês final.')
      return
    }

    if (pdfStartMonth > pdfEndMonth) {
      notify('O mês inicial deve ser anterior ou igual ao mês final.')
      return
    }

    if (!pdfReportSales.length) {
      notify('Não há vendas registradas no período selecionado.')
      return
    }

    const printWindow = window.open('', '_blank')
    if (!printWindow) {
      notify('Permita a abertura de janelas para gerar o PDF.')
      return
    }

    const escapeHtml = (value: string) =>
      value.replace(/[&<>"']/g, (character) => {
        const entities: Record<string, string> = {
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        }
        return entities[character]
      })
    const periodLabel = `${monthName(new Date(`${pdfStartMonth}-15T12:00:00`))} a ${monthName(
      new Date(`${pdfEndMonth}-15T12:00:00`),
    )}`
    const rows = pdfReportSales
      .flatMap((sale) => {
        const clientName = clients.find((client) => client.id === sale.clientId)?.name ?? 'Cliente'
        return sale.items.map(
          (item) => `<tr>
            <td>${escapeHtml(clientName)}</td>
            <td>${escapeHtml(item.name)}</td>
            <td>${escapeHtml(item.code || 'Sem ID')}</td>
            <td>${money(item.price)}</td>
          </tr>`,
        )
      })
      .join('')

    printWindow.document.write(`<!doctype html>
      <html lang="pt-BR">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Relatório de vendas - ${escapeHtml(periodLabel)}</title>
          <style>
            * { box-sizing: border-box; }
            body { margin: 0; padding: 32px; color: #292524; font: 14px Arial, sans-serif; }
            h1 { margin: 0 0 8px; font-size: 24px; }
            p { margin: 0 0 24px; color: #78716c; }
            table { width: 100%; border-collapse: collapse; }
            th, td { padding: 10px 8px; border-bottom: 1px solid #e7e5e4; text-align: left; }
            th { background: #f5f5f4; font-size: 12px; }
            td:nth-child(4), th:nth-child(4) { text-align: right; white-space: nowrap; }
            tfoot td { border: 0; font-weight: bold; }
            @media print { body { padding: 0; } tr { break-inside: avoid; } }
          </style>
        </head>
        <body>
          <h1>Relatório de vendas</h1>
          <p>Período: ${escapeHtml(periodLabel)}</p>
          <table>
            <thead>
              <tr><th>Cliente</th><th>Produto</th><th>ID do produto</th><th>Valor</th></tr>
            </thead>
            <tbody>${rows}</tbody>
            <tfoot>
              <tr><td colspan="3">Total do período</td><td>${money(pdfReportTotal)}</td></tr>
            </tfoot>
          </table>
        </body>
      </html>`)
    printWindow.document.close()
    printWindow.focus()
    printWindow.setTimeout(() => printWindow.print(), 250)
  }

  async function saveClient(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const name = String(form.get('name')).trim()
    const phone = String(form.get('phone')).trim()
    if (!name) return
    try {
      await db.clients.add({ name, phone, createdAt: new Date().toISOString() })
      queueSync()
      setModal(null)
      notify('Cliente cadastrado com sucesso.')
    } catch (error) {
      console.error(error)
      notify('Não foi possível salvar o cliente.')
    }
  }

  async function saveSale(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const clientId = activePayment?.clientId ?? Number(form.get('clientId'))
    const date = String(form.get('date'))
    const itemRows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[data-item]'))
    const saleItems: SaleItem[] = itemRows.map((row) => ({
      name: (row.querySelector<HTMLInputElement>('[name="itemName"]')?.value ?? '').trim(),
      code: (row.querySelector<HTMLInputElement>('[name="itemCode"]')?.value ?? '').trim(),
      price: parseDecimal(row.querySelector<HTMLInputElement>('[name="itemPrice"]')?.value ?? ''),
      productSyncId: row.querySelector<HTMLInputElement>('[name="productSyncId"]')?.value || undefined,
    }))
    if (!clientId || !saleItems.length || saleItems.some((item) => !item.name || !Number.isFinite(item.price) || item.price <= 0)) {
      notify('Preencha o cliente e os dados de cada item com valores válidos.')
      return
    }
    try {
      await db.sales.add({ clientId, items: saleItems, total: saleItems.reduce((sum, item) => sum + item.price, 0), date: `${date}T12:00:00` })
      queueSync()
      setModal(null)
      notify('Venda registrada com sucesso.')
    } catch (error) {
      console.error(error)
      notify('Não foi possível registrar a venda.')
    }
  }

  async function savePayment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const clientId = Number(form.get('clientId'))
    const amount = parseDecimal(String(form.get('amount') ?? ''))
    const date = String(form.get('date'))
    const note = String(form.get('note')).trim()
    const due = (balances.get(clientId)?.due ?? 0) +
      (activePayment?.syncStatus !== 'conflict' ? activePayment?.amount ?? 0 : 0)
    if (!clientId || !Number.isFinite(amount) || amount <= 0 || amount > due) {
      notify(amount > due ? 'O valor não pode ser maior que o saldo devedor.' : 'Informe um valor válido.')
      return
    }
    try {
      if (activePayment?.id !== undefined) {
        await db.payments.update(activePayment.id, { clientId, amount, date: `${date}T12:00:00`, note })
      } else {
        await db.payments.add({ clientId, amount, date: `${date}T12:00:00`, note })
      }
      queueSync()
      setModal(null)
      setActivePayment(null)
      notify(activePayment ? 'Pagamento ajustado e enviado para sincronização.' : 'Pagamento registrado e abatido do saldo.')
    } catch (error) {
      console.error(error)
      notify('Não foi possível registrar o pagamento.')
    }
  }

  async function saveRate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const value = parseDecimal(draftRate)
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      notify('Informe uma comissão entre 0% e 100%.')
      return
    }
    try {
      await db.settings.put({ key: `${userId}:commissionRate`, userId, value })
      queueSync()
      notify('Comissão atualizada.')
    } catch (error) {
      console.error(error)
      notify('Não foi possível salvar a comissão.')
    }
  }

  async function deleteClient(clientId: number | null | undefined) {
    if (clientId === null || clientId === undefined) return
    const clientName = clients.find((client) => client.id === clientId)?.name ?? 'esta cliente'
    if (!window.confirm(`Arquivar ${clientName}? O histórico financeiro será preservado e não será mais exibido na lista de clientes.`)) return
    try {
      await db.clients.update(clientId, { archivedAt: new Date().toISOString() })
      queueSync()
      setActiveClient(null)
      notify('Cliente arquivada. O histórico financeiro foi preservado.')
    } catch (error) {
      console.error(error)
      notify('Não foi possível arquivar a cliente.')
    }
  }

  async function saveProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const name = String(form.get('name') ?? '').trim()
    const code = String(form.get('code') ?? '').trim()
    const price = parseDecimal(String(form.get('price') ?? ''))
    if (!name || !Number.isFinite(price) || price <= 0) {
      notify('Informe o nome do produto e um preço válido.')
      return
    }
    try {
      await db.products.add({ name, code, price, createdAt: new Date().toISOString() })
      queueSync()
      setProductModal(false)
      notify('Produto cadastrado com sucesso.')
    } catch (error) {
      console.error(error)
      notify('Não foi possível salvar o produto.')
    }
  }

  async function archiveProduct(product: Product) {
    if (product.id === undefined || !window.confirm(`Arquivar o produto ${product.name}?`)) return
    try {
      await db.products.update(product.id, { archivedAt: new Date().toISOString() })
      queueSync()
      notify('Produto arquivado. Os itens já vendidos foram preservados.')
    } catch (error) {
      console.error(error)
      notify('Não foi possível arquivar o produto.')
    }
  }

  async function exportBackup() {
    try {
      const data = {
        version: 2,
        exportedAt: new Date().toISOString(),
        clients: await db.clients.where('userId').equals(userId).toArray(),
        products: await db.products.where('userId').equals(userId).toArray(),
        sales: await db.sales.where('userId').equals(userId).toArray(),
        payments: await db.payments.where('userId').equals(userId).toArray(),
        commissionRate: (await db.settings.get(`${userId}:commissionRate`))?.value ?? 30,
      }
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `backup-atelie-${today()}.json`
      link.click()
      URL.revokeObjectURL(url)
      notify('Backup exportado.')
    } catch (error) {
      console.error(error)
      notify('Não foi possível exportar o backup.')
    }
  }

  async function importBackup(file?: File) {
    if (!file) return
    try {
      const data: unknown = JSON.parse(await file.text())
      if (!isBackup(data)) throw new Error('Formato de backup inválido.')
      if (!window.confirm('Os registros deste backup serão mesclados com os dados atuais. Nenhuma venda ou pagamento existente será apagado. Deseja continuar?')) return
      const backupProducts = data.products ?? []
      const importId = await stableBackupId(userId, JSON.stringify(data))
      const clientIds = new Map<number, number>()
      const productIds = new Map<string, string>()
      await db.transaction('rw', db.clients, db.products, db.sales, db.payments, db.settings, async () => {
        for (const product of backupProducts) {
          const syncId = await stableBackupId(userId, `product:${product.syncId ?? product.id}:${importId}`)
          productIds.set(product.syncId ?? String(product.id), syncId)
          const existing = await db.products.where('syncId').equals(syncId).first()
          if (!existing) {
            await db.products.add({
              name: product.name,
              code: product.code,
              price: product.price,
              createdAt: product.createdAt,
              syncId,
            })
          }
        }

        for (const client of data.clients) {
          const syncId = await stableBackupId(userId, `client:${client.syncId ?? client.id}:${importId}`)
          const existing = await db.clients.where('syncId').equals(syncId).first()
          const localId = existing?.id ?? await db.clients.add({
            name: client.name,
            phone: client.phone,
            createdAt: client.createdAt,
            syncId,
          })
          if (client.id !== undefined && localId !== undefined) clientIds.set(client.id, localId)
        }

        for (const sale of data.sales) {
          const clientId = clientIds.get(sale.clientId)
          if (clientId === undefined) throw new Error('O backup contém uma venda sem cliente correspondente.')
          const syncId = await stableBackupId(userId, `sale:${sale.syncId ?? sale.id}:${importId}`)
          const existing = await db.sales.where('syncId').equals(syncId).first()
          if (!existing) {
            await db.sales.add({
              clientId,
              items: sale.items.map((item) => ({
                ...item,
                productSyncId: item.productSyncId
                  ? productIds.get(item.productSyncId) ?? item.productSyncId
                  : undefined,
              })),
              total: sale.total,
              date: sale.date,
              syncId,
            })
          }
        }

        for (const payment of data.payments) {
          const clientId = clientIds.get(payment.clientId)
          if (clientId === undefined) throw new Error('O backup contém um pagamento sem cliente correspondente.')
          const syncId = await stableBackupId(userId, `payment:${payment.syncId ?? payment.id}:${importId}`)
          const existing = await db.payments.where('syncId').equals(syncId).first()
          if (!existing) {
            await db.payments.add({
              clientId,
              amount: payment.amount,
              date: payment.date,
              note: payment.note,
              syncId,
            })
          }
        }

        await db.settings.put({ key: `${userId}:commissionRate`, value: data.commissionRate })
      })
      queueSync()
      notify('Backup mesclado com sucesso. Os novos dados serão sincronizados.')
    } catch (error) {
      console.error(error)
      notify('Backup inválido ou não foi possível importar.')
    } finally {
      if (importRef.current) importRef.current.value = ''
    }
  }

  const monthTitle = new Date(`${reportMonth}-15T12:00:00`).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })

  return (
    <div className="min-h-screen bg-[#f8f6f1] text-stone-800">
    <div className="mx-auto flex min-h-screen max-w-[1440px]">
      <aside className="hidden w-[248px] shrink-0 border-r border-stone-200/80 bg-[#fbfaf7] px-5 py-8 md:flex md:flex-col">
          <Brand />
          <p className="mb-3 mt-12 px-3 text-[10px] font-semibold uppercase tracking-[.2em] text-stone-400">
            Menu principal
          </p>
          <Nav page={page} setPage={setPage} />
          <div className="mt-auto rounded-2xl border border-[#e8dfd0] bg-[#f3eee4] p-4">
            <p className="font-serif text-lg text-stone-700">Seja sua própria referência.</p>
            <p className="mt-1 text-xs leading-relaxed text-stone-500">
              Suas vendas, clientes e pagamentos em um só lugar.
            </p>
          </div>
        </aside>

        <main className="min-w-0 flex-1 pb-24 md:pb-8">
          <header className="sticky top-0 z-20 flex h-[76px] items-center justify-between border-b border-stone-200/70 bg-[#f8f6f1]/90 px-5 backdrop-blur-md sm:px-8 lg:px-11">
            <div className="md:hidden">
              <Brand compact />
            </div>
            <div className="hidden md:block">
              <p className="text-sm text-stone-500">
                {new Date().toLocaleDateString('pt-BR', {
                  weekday: 'long',
                  day: 'numeric',
                  month: 'long',
                })}
              </p>
              <h1 className="font-serif text-[26px] leading-tight capitalize">{page}</h1>
            </div>
            <button
              onClick={() => setModal('sale')}
              className="button-primary rounded-full px-4 py-2.5 text-sm font-semibold shadow-sm sm:px-5"
            >
              <span className="mr-1.5">＋</span> Nova venda
            </button>
            <button
              onClick={() => setPage('Ajustes')}
              aria-label="Abrir ajustes"
              className="button-icon ml-2 grid h-10 w-10 place-items-center rounded-full md:hidden"
            >
              ⚙
            </button>
          </header>

          <div className="mx-auto max-w-[1160px] px-5 py-7 sm:px-8 lg:px-11 lg:py-9">
            <SyncStatusBar
              status={syncStatus}
              error={syncError}
              username={username}
              onSync={() => void syncNow().catch(() => undefined)}
              onSignOut={() => void onSignOut()}
            />
            <div className="mb-7 md:hidden">
              <p className="text-xs capitalize text-stone-500">
                {new Date().toLocaleDateString('pt-BR', {
                  weekday: 'long',
                  day: 'numeric',
                  month: 'long',
                })}
              </p>
              <h1 className="mt-1 font-serif text-3xl capitalize">{page}</h1>
            </div>

            {page === 'Visão geral' && (
              <section>
                <div className="mb-7 flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <p className="font-serif text-2xl">Olá, Luiza ✨</p>
                    <p className="mt-1 text-sm font-semibold text-stone-500">
                      Aqui está o resumo do seu mês.
                    </p>
                  </div>
                  <span className="rounded-full border border-stone-200 bg-white/70 px-3 py-1.5 text-xs capitalize text-stone-500">
                    {monthName(new Date())}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
                  <Metric
                    label="Vendido no mês"
                    value={money(monthSold)}
                    icon="◇"
                    tint="sand"
                    detail={`${monthSales.length} vendas`}
                  />
                  <Metric
                    label="Recebido no mês"
                    value={money(monthReceived)}
                    icon="↙"
                    tint="sage"
                    detail={`${monthPayments.length} pagamentos`}
                  />
                  <Metric
                    label="A receber"
                    value={money(totalDue)}
                    icon="◷"
                    tint="rose"
                    detail={`${[...balances.values()].filter((item) => item.due > 0).length} clientes`}
                  />
                  <Metric
                    label="Comissão estimada"
                    value={money(monthSold * rate / 100)}
                    icon="✧"
                    tint="gold"
                    detail={`${rate}% sobre as vendas`}
                  />
                </div>

                <div className="mt-7 grid gap-5 lg:grid-cols-[1.4fr_1fr]">
                  <section className="rounded-[22px] border border-stone-200/70 bg-white p-5 sm:p-6">
                    <div className="mb-5 flex items-center justify-between">
                      <div>
                        <h2 className="font-serif text-xl">Movimentações recentes</h2>
                        <p className="mt-1 text-xs text-stone-500">O que aconteceu por último</p>
                      </div>
                      <button
                        onClick={() => setPage('Vendas')}
                        className="button-link text-xs font-semibold"
                      >
                        Ver tudo →
                      </button>
                    </div>

                    {recentEntries.length ? (
                      <div className="divide-y divide-stone-100">
                        {recentEntries.map((entry, index) => {
                          const client = clients.find((item) => item.id === entry.clientId)
                          const isSale = entry.kind === 'Venda'

                          return (
                            <div
                              key={`${entry.kind}-${entry.date}-${index}`}
                              className="flex items-center gap-3 py-3 first:pt-0 last:pb-0"
                            >
                              <span
                                className={`grid h-10 w-10 shrink-0 place-items-center rounded-full text-sm ${
                                  isSale
                                    ? 'bg-[#f3eee4] text-[#9f7945]'
                                    : 'bg-[#edf2ed] text-[#728a77]'
                                }`}
                              >
                                {isSale ? '◇' : '↙'}
                              </span>
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-medium">
                                  {client?.name ?? 'Cliente'}
                                </p>
                                <p className="truncate text-xs text-stone-500">
                                  {entry.label} · {formatDate(entry.date)}
                                </p>
                              </div>
                              <span className="financial-value whitespace-nowrap text-sm font-semibold">
                                {money(entry.amount)}
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    ) : (
                      <EmptyState text="Suas movimentações aparecerão aqui." />
                    )}
                  </section>

                  <section className="rounded-[22px] border border-stone-200/70 bg-white p-5 sm:p-6">
                    <div className="mb-5">
                      <h2 className="font-serif text-xl">A receber</h2>
                      <p className="mt-1 text-xs text-stone-500">Clientes com saldo em aberto</p>
                    </div>
                    {clients
                      .filter((client) => (balances.get(client.id ?? -1)?.due ?? 0) > 0)
                      .slice(0, 4)
                      .map((client) => (
                        <button
                          key={client.id}
                          onClick={() => setActiveClient(client.id ?? null)}
                          className="button-row flex w-full items-center gap-3 border-t border-stone-100 py-3 text-left first:border-0"
                        >
                          <Avatar name={client.name} />
                          <span className="min-w-0 flex-1 truncate text-sm font-medium">
                            {client.name}
                          </span>
                          <span className="financial-value text-sm font-semibold text-[#9f7945]">
                            {money(balances.get(client.id ?? -1)?.due ?? 0)}
                          </span>
                        </button>
                      ))}
                    {!clients.some((client) => (balances.get(client.id ?? -1)?.due ?? 0) > 0) && (
                      <EmptyState text="Tudo em dia por aqui." />
                    )}
                    {totalDue > 0 && (
                      <button
                        onClick={() => setModal('payment')}
                        className="button-primary mt-3 w-full rounded-xl py-2.5 text-sm font-semibold"
                      >
                        Registrar pagamento
                      </button>
                    )}
                  </section>
                </div>

                <div className="mt-5 grid gap-4 sm:grid-cols-3">
                  <QuickAction
                    icon="♧"
                    title="Nova cliente"
                    description="Cadastre uma cliente"
                    onClick={() => setModal('client')}
                  />
                  <QuickAction
                    icon="◇"
                    title="Registrar venda"
                    description="Adicione peças vendidas"
                    onClick={() => setModal('sale')}
                  />
                  <QuickAction
                    icon="↙"
                    title="Anotar pagamento"
                    description="Atualize um saldo"
                    onClick={() => setModal('payment')}
                  />
                </div>
              </section>
            )}

            {page === 'Clientes' && (
              <section>
                <PageHeading
                  title="Suas clientes"
                  subtitle="Acompanhe compras e saldos em aberto."
                  button="＋ Adicionar cliente"
                  onClick={() => setModal('client')}
                />
                <div className="mb-4">
                  <input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Buscar por nome ou telefone..."
                    className="w-full rounded-xl border border-stone-200 bg-white px-4 py-3 text-sm outline-none focus:border-[#b48b50] sm:max-w-sm"
                  />
                </div>
                <div className="overflow-hidden rounded-[22px] border border-stone-200/70 bg-white">
                  <div className="hidden grid-cols-[1.5fr_1fr_1fr_1fr] gap-3 bg-[#fbfaf7] px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-stone-400 sm:grid">
                    <span>Cliente</span>
                    <span>Compras</span>
                    <span>Pago</span>
                    <span>Saldo Devedor</span>
                  </div>
                  {visibleClients.map((client) => {
                    const totals = balances.get(client.id ?? -1) ?? { sold: 0, paid: 0, due: 0 }

                    return (
                      <button
                        key={client.id}
                        onClick={() => setActiveClient(client.id ?? null)}
                        className="button-row flex w-full items-center gap-3 border-t border-stone-100 px-4 py-4 text-left first:border-0 sm:grid sm:grid-cols-[1.5fr_1fr_1fr_1fr] sm:gap-3 sm:px-5"
                      >
                        <Avatar name={client.name} />
                        <span className="min-w-0 flex-1 sm:flex-auto">
                          <span className="block truncate text-sm font-semibold">{client.name}</span>
                          <span className="block text-xs text-stone-500">
                            {client.phone || 'Sem telefone'}
                          </span>
                        </span>
                        <span className="financial-value hidden text-sm text-stone-600 sm:block">
                          {money(totals.sold)}
                        </span>
                        <span className="financial-value hidden text-sm text-stone-600 sm:block">
                          {money(totals.paid)}
                        </span>
                        <span className="text-right sm:text-left">
                          <span
                            className={`financial-value text-sm font-semibold ${
                              totals.due > 0 ? 'text-[#9f7945]' : 'text-stone-600'
                            }`}
                          >
                            {money(totals.due)}
                          </span>
                          <span className="block text-[10px] text-stone-400 sm:hidden">saldo</span>
                        </span>
                      </button>
                    )
                  })}
                  {!visibleClients.length && (
                    <EmptyState
                      text={
                        activeClients.length
                          ? 'Nenhuma cliente encontrada.'
                          : 'Cadastre sua primeira cliente para começar.'
                      }
                    />
                  )}
                </div>
              </section>
            )}

            {page === 'Produtos' && (
              <section>
                <PageHeading
                  title="Produtos"
                  subtitle="Organize o catálogo e reutilize os itens ao registrar vendas."
                  button="＋ Adicionar produto"
                  onClick={() => setProductModal(true)}
                />
                <div className="overflow-hidden rounded-[22px] border border-stone-200/70 bg-white">
                  {products.map((product) => (
                    <div key={product.id} className="flex items-center gap-3 border-t border-stone-100 px-4 py-4 first:border-0 sm:px-5">
                      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[#fff1e8] text-[#e85d0b]">□</span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold">{product.name}</p>
                        <p className="truncate text-xs text-stone-500">{product.code || 'Sem código'}</p>
                      </div>
                      <span className="financial-value whitespace-nowrap text-sm font-semibold">{money(product.price)}</span>
                      <button
                        type="button"
                        onClick={() => void archiveProduct(product)}
                        className="button-secondary rounded-lg px-3 py-2 text-xs font-semibold"
                      >
                        Arquivar
                      </button>
                    </div>
                  ))}
                  {!products.length && <EmptyState text="Cadastre produtos para selecioná-los ao registrar uma venda." />}
                </div>
              </section>
            )}

            {page === 'Vendas' && (
              <section>
                <PageHeading
                  title="Vendas"
                  subtitle="Cada registro pode incluir várias peças."
                  button="＋ Nova venda"
                  onClick={() => setModal('sale')}
                />
                <div className="overflow-hidden rounded-[22px] border border-stone-200/70 bg-white">
                  {sales
                    .slice()
                    .sort((a, b) => b.date.localeCompare(a.date))
                    .map((sale) => (
                      <MovementRow
                        key={sale.id}
                        type="Venda"
                        title={clients.find((client) => client.id === sale.clientId)?.name ?? 'Cliente'}
                        subtitle={`${sale.items
                          .map((item) => `${item.name}${item.code ? ` · ${item.code}` : ''}`)
                          .join(', ')} · ${formatDate(sale.date)}`}
                        amount={sale.total}
                        onClick={() => setActiveSale(sale)}
                      />
                    ))}
                  {!sales.length && <EmptyState text="Suas vendas registradas aparecerão aqui." />}
                </div>
              </section>
            )}

            {page === 'Pagamentos' && (
              <section>
                <PageHeading
                  title="Pagamentos"
                  subtitle="Registre valores recebidos, sem parcelas fixas."
                  button="＋ Registrar pagamento"
                  onClick={() => setModal('payment')}
                />
                <div className="overflow-hidden rounded-[22px] border border-stone-200/70 bg-white">
                  {payments
                    .slice()
                    .sort((a, b) => b.date.localeCompare(a.date))
                    .map((payment) => (
                      <MovementRow
                        key={payment.id}
                        type="Pagamento"
                        title={
                          clients.find((client) => client.id === payment.clientId)?.name ?? 'Cliente'
                        }
                        subtitle={`${payment.note || 'Pagamento recebido'} · ${formatDate(payment.date)}${payment.syncStatus === 'conflict' ? ' · Sincronização pendente' : ''}`}
                        amount={payment.amount}
                        onClick={payment.syncStatus === 'conflict' ? () => {
                          setActivePayment(payment)
                          setModal('payment')
                        } : undefined}
                      />
                    ))}
                  {!payments.length && (
                    <EmptyState text="Os pagamentos recebidos aparecerão aqui." />
                  )}
                </div>
              </section>
            )}

            {page === 'Relatórios' && (
              <section>
                <PageHeading
                  title="Relatórios"
                  subtitle="Acompanhe suas movimentações ou gere um PDF de vendas."
                />
                <div className="mb-5 flex gap-2" role="tablist" aria-label="Opções de relatório">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={reportTab === 'resumo'}
                    onClick={() => setReportTab('resumo')}
                    className={`rounded-full px-4 py-2 text-sm font-semibold ${
                      reportTab === 'resumo' ? 'button-primary' : 'button-secondary'
                    }`}
                  >
                    Resumo mensal
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={reportTab === 'pdf'}
                    onClick={() => setReportTab('pdf')}
                    className={`rounded-full px-4 py-2 text-sm font-semibold ${
                      reportTab === 'pdf' ? 'button-primary' : 'button-secondary'
                    }`}
                  >
                    Gerar PDF
                  </button>
                </div>
                {reportTab === 'resumo' ? (
                  <>
                    <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-[22px] border border-stone-200/70 bg-white p-4 sm:px-5">
                      <p className="font-serif text-xl capitalize">{monthTitle}</p>
                      <input
                        aria-label="Mês do relatório"
                        type="month"
                        value={reportMonth}
                        onChange={(event) =>
                          setReportMonth(event.target.value || today().slice(0, 7))
                        }
                        className="rounded-xl border border-stone-200 px-3 py-2 text-sm outline-none focus:border-[#b48b50]"
                      />
                    </div>
                    <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
                      <Metric
                        label="Vendas do mês"
                        value={money(reportSold)}
                        icon="◇"
                        tint="sand"
                        detail={`${reportSales.length} vendas`}
                      />
                      <Metric
                        label="Recebimentos"
                        value={money(reportReceived)}
                        icon="↙"
                        tint="sage"
                        detail={`${reportPayments.length} pagamentos`}
                      />
                      <Metric
                        label="Comissão estimada"
                        value={money(reportSold * rate / 100)}
                        icon="✧"
                        tint="gold"
                        detail={`${rate}% sobre as vendas`}
                      />
                    </div>
                    <div className="grid gap-5 lg:grid-cols-2">
                      <section className="rounded-[22px] border border-stone-200/70 bg-white p-5">
                        <h2 className="mb-3 font-serif text-xl">Vendas</h2>
                        {reportSales.length ? (
                          reportSales.map((sale) => (
                            <MovementRow
                              key={sale.id}
                              type="Venda"
                              title={
                                clients.find((client) => client.id === sale.clientId)?.name ??
                                'Cliente'
                              }
                              subtitle={`${sale.items.map((item) => item.name).join(', ')} · ${formatDate(sale.date)}`}
                              amount={sale.total}
                              onClick={() => setActiveSale(sale)}
                            />
                          ))
                        ) : (
                          <EmptyState text="Nenhuma venda neste mês." />
                        )}
                      </section>
                      <section className="rounded-[22px] border border-stone-200/70 bg-white p-5">
                        <h2 className="mb-3 font-serif text-xl">Recebimentos</h2>
                        {reportPayments.length ? (
                          reportPayments.map((payment) => (
                            <MovementRow
                              key={payment.id}
                              type="Pagamento"
                              title={
                                clients.find((client) => client.id === payment.clientId)?.name ??
                                'Cliente'
                              }
                              subtitle={`${payment.note || 'Pagamento recebido'} · ${formatDate(payment.date)}`}
                              amount={payment.amount}
                            />
                          ))
                        ) : (
                          <EmptyState text="Nenhum recebimento neste mês." />
                        )}
                      </section>
                    </div>
                  </>
                ) : (
                  <section className="rounded-[22px] border border-stone-200/70 bg-white p-5 sm:p-6">
                    <h2 className="font-serif text-xl">PDF de vendas</h2>
                    <p className="mt-1 text-sm text-stone-500">
                      Escolha um período. O relatório lista cada produto com cliente, valor e ID.
                    </p>
                    <div className="mt-5 grid gap-4 sm:grid-cols-2">
                      <label className="block text-sm font-medium text-stone-600">
                        Mês inicial
                        <input
                          aria-label="Mês inicial do PDF"
                          type="month"
                          value={pdfStartMonth}
                          onChange={(event) => setPdfStartMonth(event.target.value)}
                          className="mt-2 w-full rounded-xl border border-stone-200 px-3 py-3 text-sm outline-none focus:border-[#b48b50]"
                        />
                      </label>
                      <label className="block text-sm font-medium text-stone-600">
                        Mês final
                        <input
                          aria-label="Mês final do PDF"
                          type="month"
                          value={pdfEndMonth}
                          onChange={(event) => setPdfEndMonth(event.target.value)}
                          className="mt-2 w-full rounded-xl border border-stone-200 px-3 py-3 text-sm outline-none focus:border-[#b48b50]"
                        />
                      </label>
                    </div>
                    <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-[#fbfaf7] p-4">
                      <p className="text-sm text-stone-600">
                        {pdfReportSales.length} vendas · Total de {money(pdfReportTotal)}
                      </p>
                      <button
                        type="button"
                        onClick={generateSalesPdf}
                        className="button-primary rounded-xl px-5 py-3 text-sm font-semibold"
                      >
                        Gerar PDF
                      </button>
                    </div>
                    <p className="mt-3 text-xs text-stone-400">
                      Na janela de impressão, escolha “Salvar como PDF”.
                    </p>
                  </section>
                )}
              </section>
            )}

            {page === 'Ajustes' && (
              <section>
                <PageHeading
                  title="Ajustes"
                  subtitle="Personalize sua comissão e faça cópias de segurança."
                />
                <div className="grid gap-5 lg:grid-cols-2">
                  <section className="rounded-[22px] border border-stone-200/70 bg-white p-5 sm:p-6">
                    <h2 className="font-serif text-xl">Comissão</h2>
                    <p className="mt-1 text-sm text-stone-500">
                      Usada para estimar a comissão sobre as vendas.
                    </p>
                    <form onSubmit={saveRate} className="mt-5 flex items-end gap-3">
                      <Field
                        label="Percentual (%)"
                        name="rate"
                        type="text"
                        inputMode="decimal"
                        value={draftRate || String(rate)}
                        onChange={(event) => setDraftRate(event.target.value)}
                        required
                      />
                      <button className="button-primary shrink-0 rounded-xl px-5 py-3 text-sm font-semibold">
                        Salvar
                      </button>
                    </form>
                  </section>
                  <section className="rounded-[22px] border border-stone-200/70 bg-white p-5 sm:p-6">
                    <h2 className="font-serif text-xl">Backup dos dados</h2>
                    <p className="mt-1 text-sm leading-relaxed text-stone-500">
                      Exporte uma cópia local de clientes, produtos, vendas e pagamentos. Restaurar
                      mescla os dados e preserva o histórico existente.
                    </p>
                    <div className="mt-5 flex flex-wrap gap-3">
                      <button
                        onClick={exportBackup}
                        className="button-primary rounded-xl px-4 py-3 text-sm font-semibold"
                      >
                        ↓ Exportar backup
                      </button>
                      <button
                        onClick={() => importRef.current?.click()}
                        className="button-secondary rounded-xl px-4 py-3 text-sm font-semibold"
                      >
                        ↑ Importar backup
                      </button>
                      <input
                        ref={importRef}
                        type="file"
                        accept="application/json,.json"
                        className="hidden"
                        onChange={(event) => void importBackup(event.target.files?.[0])}
                      />
                    </div>
                  </section>
                  <section className="rounded-[22px] border border-[#e8dfd0] bg-[#f3eee4] p-5 sm:col-span-2 sm:p-6">
                    <h2 className="font-serif text-xl">Seus dados sincronizados</h2>
                    <p className="mt-1 max-w-2xl text-sm leading-relaxed text-stone-600">
                      O Supabase é a fonte principal dos dados. O IndexedDB mantém uma cópia local
                      para consulta offline e envia alterações pendentes quando a conexão voltar.
                      Faça backups periódicos em Ajustes.
                    </p>
                  </section>
                </div>
              </section>
            )}
          </div>
        </main>
      </div>

      <nav className="safe-bottom fixed inset-x-0 bottom-0 z-30 flex justify-start gap-1 overflow-x-auto border-t border-stone-200/80 bg-[#fbfaf7]/95 px-1 pt-2 backdrop-blur-md md:hidden">
        {pages.filter((item) => item.name !== 'Ajustes').map((item) => (
          <button
            key={item.name}
            onClick={() => setPage(item.name)}
            className={`button-mobile-nav flex min-w-[60px] flex-col items-center gap-0.5 px-1 py-1 text-[10px] ${
              page === item.name ? 'button-mobile-nav-active' : ''
            }`}
          >
            <span className="text-xl leading-6">{item.icon}</span>
            {item.name === 'Visão geral' ? 'Início' : item.name}
          </button>
        ))}
      </nav>

      {message && (
        <div
          role="status"
          className="fixed bottom-24 left-1/2 z-[60] -translate-x-1/2 rounded-full bg-stone-800 px-5 py-3 text-center text-sm text-white shadow-lg md:bottom-7"
        >
          {message}
        </div>
      )}

      {modal === 'client' && (
        <Modal title="Nova cliente" onClose={() => setModal(null)}>
          <form onSubmit={saveClient} className="space-y-4">
            <Field label="Nome" name="name" placeholder="Nome da cliente" required autoFocus />
            <Field label="Telefone" name="phone" type="tel" placeholder="(00) 00000-0000" />
            <FormActions onCancel={() => setModal(null)} submit="Salvar cliente" />
          </form>
        </Modal>
      )}

      {modal === 'sale' && (
        <SaleForm clients={activeClients} products={products} onClose={() => setModal(null)} onSubmit={saveSale} />
      )}

      {modal === 'payment' && (
        <PaymentForm
          clients={clients}
          balances={balances}
          initialClientId={paymentClientId}
          initialPayment={activePayment ?? undefined}
          onClose={() => {
            setModal(null)
            setPaymentClientId(undefined)
            setActivePayment(null)
          }}
          onSubmit={savePayment}
        />
      )}

      {productModal && (
        <ProductForm onClose={() => setProductModal(false)} onSubmit={saveProduct} />
      )}

      {active && (
        <Modal
          title={active.name}
          onClose={() => {
            setClientReportOpen(false)
            setActiveClient(null)
          }}
        >
          {clientReportOpen ? (
            <div className="space-y-4">
              <p className="text-sm leading-relaxed text-stone-500">
                Confira e, se quiser, edite o texto antes de abrir o WhatsApp. A mensagem só será
                enviada depois da sua confirmação no aplicativo.
              </p>
              <label className="block text-sm font-medium text-stone-600">
                Prévia da mensagem
                <textarea
                  value={clientReportText}
                  onChange={(event) => setClientReportText(event.target.value)}
                  rows={14}
                  className="mt-2 w-full resize-y rounded-xl border border-stone-200 bg-white px-3.5 py-3 text-sm leading-relaxed outline-none focus:border-[#b48b50] focus:ring-2 focus:ring-[#b48b50]/15"
                />
              </label>
              <div className="rounded-xl border border-[#e8dfd0] bg-[#fbfaf7] p-4">
                <p className="text-sm font-medium text-stone-700">
                  {active.phone.trim()
                    ? 'Telefone/WhatsApp da cliente'
                    : 'Esta cliente ainda não tem telefone cadastrado.'}
                </p>
                <p className="mt-1 text-xs text-stone-500">
                  Informe ou atualize o número e salve antes de abrir a conversa.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <input
                    type="tel"
                    value={whatsAppPhoneDraft}
                    onChange={(event) => setWhatsAppPhoneDraft(event.target.value)}
                    placeholder="DDD + número"
                    aria-label="Telefone/WhatsApp da cliente"
                    className="min-w-0 flex-1 rounded-xl border border-stone-200 bg-white px-3.5 py-3 text-sm outline-none focus:border-[#b48b50]"
                  />
                  <button
                    type="button"
                    onClick={() => void saveWhatsAppPhone()}
                    className="button-secondary rounded-xl px-4 py-3 text-sm font-semibold"
                  >
                    Salvar número
                  </button>
                </div>
              </div>
              <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                <button
                  type="button"
                  onClick={() => setClientReportOpen(false)}
                  className="button-secondary rounded-xl px-4 py-3 text-sm font-semibold"
                >
                  Voltar à ficha
                </button>
                <button
                  type="button"
                  onClick={() => void copyClientReport()}
                  className="button-secondary rounded-xl px-4 py-3 text-sm font-semibold"
                >
                  Copiar relatório
                </button>
                <button
                  type="button"
                  onClick={sendClientReportByWhatsApp}
                  className="button-primary rounded-xl px-4 py-3 text-sm font-semibold"
                >
                  Enviar pelo WhatsApp
                </button>
              </div>
            </div>
          ) : (
            <>
          <div className="mb-5 flex items-center gap-3 rounded-2xl bg-[#f8f6f1] p-4">
            <Avatar name={active.name} />
            <div>
              <p className="font-medium">{active.phone || 'Sem telefone cadastrado'}</p>
              <p className="text-xs text-stone-500">
                Cliente desde {formatDate(active.createdAt)}
              </p>
            </div>
          </div>
          <div className="mb-5 grid grid-cols-3 gap-2 text-center">
            <Summary label="Compras" value={money(balances.get(active.id ?? -1)?.sold ?? 0)} />
            <Summary label="Pago" value={money(balances.get(active.id ?? -1)?.paid ?? 0)} />
            <Summary label="Saldo" value={money(balances.get(active.id ?? -1)?.due ?? 0)} />
          </div>
          <div className="mb-4 flex items-center justify-between gap-3">
            <h3 className="font-serif text-lg">Histórico</h3>
            <button
              onClick={() => {
                setPaymentClientId(active.id)
                setActiveClient(null)
                setModal('payment')
              }}
              className="button-link text-xs font-semibold"
            >
              ＋ Pagamento
            </button>
          </div>
          <button
            type="button"
            onClick={() => openClientReport(active)}
            className="button-primary mb-4 w-full rounded-xl px-4 py-3 text-sm font-semibold"
          >
            Enviar relatório pelo WhatsApp
          </button>
          <button
            onClick={() => void deleteClient(active.id)}
            className="button-secondary mb-4 w-full rounded-xl px-4 py-3 text-sm font-semibold"
          >
            Excluir cliente
          </button>
          <div className="max-h-64 divide-y divide-stone-100 overflow-y-auto">
            {[
              ...sales
                .filter((sale) => sale.clientId === active.id)
                .map((sale) => ({
                  kind: 'Venda' as const,
                  sale,
                  label: sale.items
                    .map((item) => `${item.name}${item.code ? ` (${item.code})` : ''}`)
                    .join(', '),
                  amount: sale.total,
                  date: sale.date,
                })),
              ...payments
                .filter((payment) => payment.clientId === active.id)
                .map((payment) => ({
                  kind: 'Pagamento' as const,
                  label: payment.note || 'Pagamento recebido',
                  amount: payment.amount,
                  date: payment.date,
                })),
            ]
              .sort((a, b) => b.date.localeCompare(a.date))
              .map((entry, index) => {
                const content = (
                  <>
                    <div className="min-w-0 flex-1 text-left">
                      <p className="text-sm font-medium">{entry.kind}</p>
                      <p className="truncate text-xs text-stone-500">
                        {entry.label} · {formatDate(entry.date)}
                      </p>
                    </div>
                    <span className="whitespace-nowrap text-sm font-semibold">
                      {money(entry.amount)}
                    </span>
                    {entry.kind === 'Venda' && (
                      <span aria-hidden="true" className="text-stone-400">›</span>
                    )}
                  </>
                )

                return entry.kind === 'Venda' ? (
                  <button
                    key={`Venda-${entry.sale.id ?? index}`}
                    type="button"
                    onClick={() => setActiveSale(entry.sale)}
                    aria-label={`Ver itens da venda de ${formatDate(entry.date)}`}
                    className="button-row flex w-full items-center justify-between gap-3 py-3 text-left"
                  >
                    {content}
                  </button>
                ) : (
                  <div
                    key={`Pagamento-${entry.date}-${index}`}
                    className="flex items-center justify-between gap-3 py-3"
                  >
                    {content}
                  </div>
                )
              })}
            {!sales.some((sale) => sale.clientId === active.id) &&
              !payments.some((payment) => payment.clientId === active.id) && (
                <p className="py-5 text-center text-sm text-stone-400">
                  Ainda não há movimentações.
                </p>
              )}
          </div>
            </>
          )}
        </Modal>
      )}

      {activeSale && (
        <Modal title="Itens da venda" onClose={() => setActiveSale(null)}>
          <div className="mb-4 rounded-2xl bg-[#f8f6f1] p-4">
            <p className="font-semibold">
              {clients.find((client) => client.id === activeSale.clientId)?.name ?? 'Cliente'}
            </p>
            <p className="mt-1 text-sm text-stone-500">{formatDate(activeSale.date)}</p>
          </div>
          <div className="divide-y divide-stone-100">
            {activeSale.items.map((item, index) => (
              <div
                key={`${item.name}-${item.code}-${index}`}
                className="flex items-center justify-between gap-3 py-3"
              >
                <div className="min-w-0">
                  <p className="text-sm font-semibold">{item.name}</p>
                  {item.code && <p className="mt-0.5 text-xs text-stone-500">Código: {item.code}</p>}
                </div>
                <span className="whitespace-nowrap text-sm font-semibold">{money(item.price)}</span>
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center justify-between border-t border-stone-200 pt-4">
            <span className="font-semibold">Total da venda</span>
            <span className="financial-value text-lg">{money(activeSale.total)}</span>
          </div>
        </Modal>
      )}
    </div>
  )
}

function SignedInApp({ session }: { session: Session }) {
  const { status, error, syncNow } = useCloudSync(session.user.id)
  const username = typeof session.user.user_metadata.username === 'string'
    ? session.user.user_metadata.username
    : 'Conta'

  async function signOut() {
    if (!supabase) throw new Error('Supabase não está configurado.')
    const { error: signOutError } = await supabase.auth.signOut()
    if (signOutError) throw signOutError
  }

  return (
    <Dashboard
      userId={session.user.id}
      username={username}
      syncStatus={status}
      syncError={error}
      syncNow={syncNow}
      onSignOut={signOut}
    />
  )
}

function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [configurationError, setConfigurationError] = useState('')

  useEffect(() => {
    if (!supabase) {
      setLoading(false)
      return
    }

    let active = true
    const client = supabase
    const { data: authListener } = client.auth.onAuthStateChange((_event, nextSession) => {
      if (active) {
        setSession(nextSession)
        setLoading(false)
      }
    })
    void client.auth.getSession().then(({ data, error }) => {
      if (!active) return
      if (error) {
        console.error('Não foi possível restaurar a sessão.', error)
        setConfigurationError('Não foi possível restaurar a sessão. Tente entrar novamente.')
      } else {
        setSession(data.session)
      }
      setLoading(false)
    })

    return () => {
      active = false
      authListener.subscription.unsubscribe()
    }
  }, [])

  if (!isSupabaseConfigured) {
    return (
      <main className="grid min-h-screen place-items-center px-4 py-10">
        <section className="max-w-lg rounded-[24px] border border-stone-200 bg-white p-7">
          <h1 className="font-serif text-2xl">Configure o Supabase</h1>
          <p className="mt-3 text-sm leading-relaxed text-stone-600">
            Defina VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY no ambiente de execução, aplique a
            migração SQL e publique a função username-auth. Nenhuma chave service_role deve ser
            adicionada ao frontend.
          </p>
        </section>
      </main>
    )
  }

  if (loading) {
    return <main className="grid min-h-screen place-items-center text-sm text-stone-500">Carregando sua sessão...</main>
  }
  if (session) return <SignedInApp session={session} />
  return (
    <>
      <AuthScreen onAuthenticated={setSession} notice={configurationError} />
    </>
  )
}

function isBackup(
  value: unknown,
): value is {
  version: 1 | 2
  clients: Client[]
  products?: Product[]
  sales: Sale[]
  payments: Payment[]
  commissionRate: number
} {
  if (!value || typeof value !== 'object') {
    return false
  }

  const data = value as Record<string, unknown>
  const validClients =
    Array.isArray(data.clients) &&
    data.clients.every(
      (item) =>
        isRecord(item) &&
        typeof item.id === 'number' &&
        typeof item.name === 'string' &&
        typeof item.phone === 'string' &&
        typeof item.createdAt === 'string',
    )
  const validSales =
    Array.isArray(data.sales) &&
    data.sales.every(
      (item) =>
        isRecord(item) &&
        typeof item.id === 'number' &&
        typeof item.clientId === 'number' &&
        typeof item.date === 'string' &&
        typeof item.total === 'number' &&
        Array.isArray(item.items) &&
        item.items.every(
          (product: unknown) =>
            isRecord(product) &&
            typeof product.name === 'string' &&
            typeof product.code === 'string' &&
            typeof product.price === 'number',
        ),
    )
  const validPayments =
    Array.isArray(data.payments) &&
    data.payments.every(
      (item) =>
        isRecord(item) &&
        typeof item.id === 'number' &&
        typeof item.clientId === 'number' &&
        typeof item.amount === 'number' &&
        typeof item.date === 'string' &&
        typeof item.note === 'string',
    )
  const validProducts =
    data.version === 1 ||
    (Array.isArray(data.products) &&
      data.products.every(
        (item) =>
          isRecord(item) &&
          typeof item.id === 'number' &&
          typeof item.name === 'string' &&
          typeof item.code === 'string' &&
          typeof item.price === 'number' &&
          typeof item.createdAt === 'string',
      ))

  return (
    (data.version === 1 || data.version === 2) &&
    validClients &&
    validProducts &&
    validSales &&
    validPayments &&
    typeof data.commissionRate === 'number' &&
    data.commissionRate >= 0 &&
    data.commissionRate <= 100
  )
}

async function stableBackupId(userId: string, value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${userId}:${value}`))
  const bytes = new Uint8Array(digest).slice(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="grid h-9 w-9 place-items-center rounded-full border border-[#d6c4a5]">
        <img src="/LOGOTIPO_2-icon.png" alt="Logotipo" className="h-8 w-8 object-contain" />
      </span>
      <span className={`font-serif text-xl tracking-wide text-stone-700 ${compact ? 'text-lg' : ''}`}>
        Luiza
      </span>
    </div>
  )
}

function Nav({ page, setPage }: { page: Page; setPage: (page: Page) => void }) {
  return (
    <nav className="space-y-1">
      {pages.map((item) => (
        <button
          key={item.name}
          onClick={() => setPage(item.name)}
          className={`button-nav flex w-full items-center gap-3 rounded-xl px-3.5 py-3 text-left text-sm ${
            page === item.name ? 'button-nav-active' : ''
          }`}
        >
          <span className="w-5 text-center text-lg">{item.icon}</span>
          {item.name}
        </button>
      ))}
    </nav>
  )
}

function Metric({
  label,
  value,
  icon,
  tint,
  detail,
}: {
  label: string
  value: string
  icon: string
  tint: string
  detail: string
}) {
  const colors: Record<string, string> = {
    sand: 'bg-[#f3eee4] text-[#9f7945]',
    sage: 'bg-[#edf2ed] text-[#718a77]',
    rose: 'bg-[#f5eeeb] text-[#a37b68]',
    gold: 'bg-[#f6f0df] text-[#a8863d]',
  }

  return (
    <article className="rounded-[20px] border border-stone-200/70 bg-white p-4 sm:p-5">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold leading-tight text-stone-500 sm:text-xs">{label}</p>
        <span className={`grid h-8 w-8 place-items-center rounded-full text-sm ${colors[tint]}`}>
          {icon}
        </span>
      </div>
      <p className="financial-value mt-3 truncate text-xl font-semibold tracking-tight sm:text-2xl">
        {value}
      </p>
      <p className="mt-1 truncate text-[10px] text-stone-400 sm:text-xs">{detail}</p>
    </article>
  )
}

function PageHeading({
  title,
  subtitle,
  button,
  onClick,
}: {
  title: string
  subtitle: string
  button?: string
  onClick?: () => void
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="font-serif text-2xl">{title}</h2>
        <p className="mt-1 text-sm font-semibold text-stone-500">{subtitle}</p>
      </div>
      {button && (
        <button
          onClick={onClick}
          className="button-primary rounded-full px-4 py-2.5 text-sm font-semibold"
        >
          {button}
        </button>
      )}
    </div>
  )
}

function EmptyState({ text }: { text: string }) {
  return <div className="px-4 py-9 text-center text-sm text-stone-400">{text}</div>
}

function SyncStatusBar({
  status,
  error,
  username,
  onSync,
  onSignOut,
}: {
  status: SyncStatus
  error: string
  username: string
  onSync: () => void
  onSignOut: () => void
}) {
  const labels: Record<SyncStatus, string> = {
    starting: 'Preparando dados...',
    synced: 'Sincronizado',
    offline: 'Offline — alterações ficam neste aparelho até a conexão voltar',
    pending: 'Sincronizando alterações...',
    error: `Falha na sincronização: ${error}`,
  }
  const tone = status === 'error'
    ? 'border-red-200 bg-red-50 text-red-700'
    : status === 'offline' || status === 'pending' || status === 'starting'
      ? 'border-[#f3d4bd] bg-[#fff7f1] text-[#9f4b12]'
      : 'border-[#d7e5d8] bg-[#f2f8f2] text-[#4c7151]'

  return (
    <div className={`mb-5 flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3 py-2.5 text-xs ${tone}`}>
      <span role="status" aria-live="polite" className="min-w-0 flex-1">{labels[status]}</span>
      <div className="flex items-center gap-3">
        {status !== 'synced' && (
          <button type="button" onClick={onSync} className="font-semibold underline underline-offset-2">
            Tentar novamente
          </button>
        )}
        <span className="hidden text-stone-500 sm:inline">{username}</span>
        <button
          type="button"
          onClick={() => {
            void Promise.resolve(onSignOut()).catch((signOutError: unknown) => {
              console.error('Não foi possível encerrar a sessão.', signOutError)
              window.alert('Não foi possível encerrar a sessão. Tente novamente.')
            })
          }}
          className="font-semibold underline underline-offset-2"
        >
          Sair
        </button>
      </div>
    </div>
  )
}

function Avatar({ name }: { name: string }) {
  return (
    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[#f3eee4] font-serif text-sm uppercase text-[#9f7945]">
      {name.trim().slice(0, 1) || '•'}
    </span>
  )
}

function QuickAction({
  icon,
  title,
  description,
  onClick,
}: {
  icon: string
  title: string
  description: string
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="button-card flex items-center gap-3 rounded-[18px] border p-4 text-left"
    >
      <span className="grid h-10 w-10 place-items-center rounded-full bg-[#fff1e8] text-lg text-[#e85d0b]">
        {icon}
      </span>
      <span>
        <span className="block text-sm font-semibold">{title}</span>
        <span className="mt-0.5 block text-xs text-stone-500">{description}</span>
      </span>
      <span className="ml-auto text-stone-400">→</span>
    </button>
  )
}

function MovementRow({
  type,
  title,
  subtitle,
  amount,
  onClick,
}: {
  type: string
  title: string
  subtitle: string
  amount: number
  onClick?: () => void
}) {
  const isSale = type === 'Venda'
  const content = (
    <>
      <span
        className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-sm ${
          isSale ? 'bg-[#f3eee4] text-[#9f7945]' : 'bg-[#edf2ed] text-[#718a77]'
        }`}
      >
        {isSale ? '◇' : '↙'}
      </span>
      <div className="min-w-0 flex-1 text-left">
        <p className="truncate text-sm font-semibold">{title}</p>
        <p className="truncate text-xs text-stone-500">{subtitle}</p>
      </div>
      <span className="financial-value whitespace-nowrap text-sm font-semibold">
        {money(amount)}
      </span>
      {onClick && <span aria-hidden="true" className="text-stone-400">›</span>}
    </>
  )

  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      className="button-row flex w-full items-center gap-3 border-t border-stone-100 px-4 py-4 text-left first:border-0 sm:px-5"
    >
      {content}
    </button>
  ) : (
    <div className="flex items-center gap-3 border-t border-stone-100 px-4 py-4 first:border-0 sm:px-5">
      {content}
    </div>
  )
}

function FormActions({ onCancel, submit }: { onCancel: () => void; submit: string }) {
  return (
    <div className="flex gap-3 pt-2">
      <button
        type="button"
        onClick={onCancel}
        className="button-secondary flex-1 rounded-xl py-3 text-sm font-semibold"
      >
        Cancelar
      </button>
      <button type="submit" className="button-primary flex-1 rounded-xl py-3 text-sm font-semibold">
        {submit}
      </button>
    </div>
  )
}

function SaleForm({
  clients,
  products,
  onClose,
  onSubmit,
}: {
  clients: Client[]
  products: Product[]
  onClose: () => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}) {
  const [itemCount, setItemCount] = useState(1)
  return (
    <Modal title="Nova venda" onClose={onClose}>
      {!clients.length ? (
        <>
          <EmptyState text="Cadastre uma cliente antes de registrar uma venda." />
          <button
            type="button"
            onClick={onClose}
            className="button-secondary w-full rounded-xl py-3 text-sm font-semibold"
          >
            Fechar
          </button>
        </>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4">
          <label className="block text-sm font-medium text-stone-600">
            Cliente
            <select
              name="clientId"
              required
              defaultValue=""
              className="mt-2 w-full rounded-xl border border-stone-200 bg-white px-3.5 py-3 text-base outline-none focus:border-[#b48b50]"
            >
              <option value="" disabled>
                Selecione uma cliente
              </option>
              {clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </select>
          </label>
          <Field label="Data da venda" name="date" type="date" defaultValue={today()} required />
          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-medium text-stone-600">Item</p>
              <button
                type="button"
                onClick={() => setItemCount((count) => count + 1)}
                className="button-link text-xs font-semibold"
              >
                ＋ Adicionar item
              </button>
            </div>
            <div className="space-y-3">
              {Array.from({ length: itemCount }, (_, index) => (
                <fieldset
                  data-item
                  key={index}
                  className="grid grid-cols-2 gap-2 rounded-xl border border-stone-100 bg-stone-50/60 p-3"
                >
                  {products.length > 0 && (
                    <select
                      aria-label="Selecionar produto do catálogo"
                      defaultValue=""
                      onChange={(event) => {
                        const product = products.find((entry) => entry.syncId === event.target.value)
                        const row = event.currentTarget.closest('[data-item]')
                        if (!product || !row) return
                        const nameInput = row.querySelector<HTMLInputElement>('[name="itemName"]')
                        const codeInput = row.querySelector<HTMLInputElement>('[name="itemCode"]')
                        const priceInput = row.querySelector<HTMLInputElement>('[name="itemPrice"]')
                        const productIdInput = row.querySelector<HTMLInputElement>('[name="productSyncId"]')
                        if (!nameInput || !codeInput || !priceInput || !productIdInput) return
                        nameInput.value = product.name
                        codeInput.value = product.code
                        priceInput.value = String(product.price).replace('.', ',')
                        productIdInput.value = product.syncId ?? ''
                      }}
                      className="col-span-2 rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-[#b48b50]"
                    >
                      <option value="">Preencher pelo catálogo (opcional)</option>
                      {products.map((product) => (
                        <option key={product.id} value={product.syncId ?? ''}>
                          {product.name}{product.code ? ` · ${product.code}` : ''}
                        </option>
                      ))}
                    </select>
                  )}
                  <input type="hidden" name="productSyncId" />
                  <input
                    name="itemName"
                    required
                    placeholder="Nome do produto"
                    aria-label="Nome do produto"
                    className="col-span-2 rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-[#b48b50]"
                  />
                  <input
                    name="itemCode"
                    placeholder="Código (opcional)"
                    aria-label="Código do produto"
                    className="rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-[#b48b50]"
                  />
                  <input
                    name="itemPrice"
                    type="text"
                    inputMode="decimal"
                    required
                    placeholder="Valor (R$)"
                    aria-label="Valor do produto"
                    className="rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-[#b48b50]"
                  />
                </fieldset>
              ))}
            </div>
          </div>
          <FormActions onCancel={onClose} submit="Salvar venda" />
        </form>
      )}
    </Modal>
  )
}

function ProductForm({
  onClose,
  onSubmit,
}: {
  onClose: () => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}) {
  return (
    <Modal title="Novo produto" onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Nome" name="name" required maxLength={120} />
        <Field label="Código (opcional)" name="code" maxLength={80} />
        <Field label="Preço de referência" name="price" type="text" inputMode="decimal" placeholder="R$ 0,00" required />
        <FormActions onCancel={onClose} submit="Salvar produto" />
      </form>
    </Modal>
  )
}

function PaymentForm({
  clients,
  balances,
  initialClientId,
  initialPayment,
  onClose,
  onSubmit,
}: {
  clients: Client[]
  balances: Map<number, { sold: number; paid: number; due: number }>
  initialClientId?: number
  initialPayment?: Payment
  onClose: () => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}) {
  const eligible = clients.filter((client) =>
    (balances.get(client.id ?? -1)?.due ?? 0) > 0 || client.id === initialPayment?.clientId,
  )
  const [clientId, setClientId] = useState(
    String(initialPayment?.clientId ?? eligible.find((client) => client.id === initialClientId)?.id ?? eligible[0]?.id ?? ''),
  )
  const due = (balances.get(Number(clientId))?.due ?? 0) +
    (initialPayment?.syncStatus !== 'conflict' ? initialPayment?.amount ?? 0 : 0)
  return (
    <Modal title={initialPayment ? 'Ajustar pagamento pendente' : 'Registrar pagamento'} onClose={onClose}>
      {!eligible.length ? (
        <>
          <EmptyState text="Não há saldo em aberto para receber." />
          <button
            type="button"
            onClick={onClose}
            className="button-secondary w-full rounded-xl py-3 text-sm font-semibold"
          >
            Fechar
          </button>
        </>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4">
          <label className="block text-sm font-medium text-stone-600">
            Cliente
            <select
              name="clientId"
              value={clientId}
              onChange={(event) => setClientId(event.target.value)}
              disabled={Boolean(initialPayment)}
              required
              className="mt-2 w-full rounded-xl border border-stone-200 bg-white px-3.5 py-3 text-base outline-none focus:border-[#b48b50]"
            >
              {eligible.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name} — {money(balances.get(client.id ?? -1)?.due ?? 0)} em aberto
                </option>
              ))}
            </select>
          </label>
          <div className="rounded-xl bg-[#f3eee4] px-4 py-3 text-sm text-stone-600">
            Saldo disponível: <strong className="text-stone-800">{money(due)}</strong>
          </div>
          <Field
            label="Valor recebido (R$)"
            name="amount"
            type="text"
            inputMode="decimal"
            placeholder="0,00"
            defaultValue={initialPayment ? String(initialPayment.amount).replace('.', ',') : ''}
            required
          />
          <Field
            label="Data do recebimento"
            name="date"
            type="date"
            defaultValue={initialPayment?.date.slice(0, 10) ?? today()}
            required
          />
          <Field
            label="Observação (opcional)"
            name="note"
            placeholder="Ex.: Pix, dinheiro..."
            defaultValue={initialPayment?.note ?? ''}
          />
          <FormActions onCancel={onClose} submit={initialPayment ? 'Salvar ajuste' : 'Registrar recebimento'} />
        </form>
      )}
    </Modal>
  )
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-stone-50 p-3">
      <p className="text-[10px] text-stone-500">{label}</p>
      <p className="financial-value mt-1 truncate text-xs font-semibold sm:text-sm">{value}</p>
    </div>
  )
}

export default App
