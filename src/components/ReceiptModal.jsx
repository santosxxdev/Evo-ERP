import { useMemo, useState } from 'react'
import { collection, doc, serverTimestamp, writeBatch } from 'firebase/firestore'
import { useI18n } from '../i18n'
import { useAuth } from '../context/AuthContext'
import { createPaymentClientSide } from '../lib/clientInvoices'
import { COL, recalcClientTotals } from '../lib/db'
import { formatDate, formatMoney, round2, todayISO, toNumber } from '../lib/format'
import { remainingOf } from '../lib/invoice'
import { Button, Field, Input, Modal, Select, Td, Th } from '../components/ui'
import SearchableSelect from '../components/SearchableSelect'

/**
 * سند تحصيل: مبلغ واحد من العميل يوزَّع على فواتيره المستحقة.
 * يغطي الحالات الثلاث — سداد متأخرات قديمة، سداد جزئي، وتخصيص المبلغ لفاتورة بعينها.
 */
export default function ReceiptModal({ open, onClose, clients, invoices, methods, presetClientId }) {
  const { t, locale } = useI18n()
  const { user, profile, username } = useAuth()

  const [clientId, setClientId] = useState(presetClientId ?? '')
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(todayISO())
  const [methodId, setMethodId] = useState('')
  const [clientAccount, setClientAccount] = useState('')
  const [allocation, setAllocation] = useState({})
  const [busy, setBusy] = useState(false)
  const [touched, setTouched] = useState(false)

  const [wasOpen, setWasOpen] = useState(false)
  if (open && !wasOpen) {
    setWasOpen(true)
    setClientId(presetClientId ?? '')
    setAmount('')
    setDate(todayISO())
    setMethodId('')
    setClientAccount('')
    setAllocation({})
    setTouched(false)
  }
  if (!open && wasOpen) setWasOpen(false)

  /* فواتير العميل التي عليها متبقٍ، من الأقدم للأحدث */
  const outstanding = useMemo(() => {
    if (!clientId) return []
    return invoices
      .filter((invoice) => invoice.clientId === clientId && remainingOf(invoice) > 0)
      .sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')))
  }, [invoices, clientId])

  const collected = toNumber(amount)
  const allocated = Object.values(allocation).reduce((sum, value) => sum + toNumber(value), 0)
  const unallocated = collected - allocated
  const method = methods.find((item) => item.id === methodId)

  function autoAllocate() {
    let left = collected
    const next = {}
    for (const invoice of outstanding) {
      if (left <= 0) break
      const take = Math.min(left, remainingOf(invoice))
      if (take > 0) {
        next[invoice.id] = take
        left -= take
      }
    }
    setAllocation(next)
  }

  function setLine(invoiceId, value) {
    setAllocation((current) => ({ ...current, [invoiceId]: value }))
  }

  const overAllocated = allocated > collected + 0.001
  const invalid = !clientId || collected <= 0 || allocated <= 0 || overAllocated

  async function save() {
    setTouched(true)
    if (invalid) return
    setBusy(true)

    /*
     * كل الدفعات + تحديثات الفواتير في معاملة واحدة ذرّية — إما تُسجَّل
     * كلها أو لا شيء، فلا تظهر فاتورة مدفوعة جزئيًا لو انقطع الاتصال.
     */
    try {
      const nextPaid = new Map()
      
      const promises = Object.entries(allocation).map(([invoiceId, raw]) => {
        const value = toNumber(raw)
        if (value <= 0) return Promise.resolve()

        const paymentPayload = {
          amount: value,
          date,
          methodId: methodId || null,
          methodName: method?.name ?? '',
          methodType: method?.type ?? '',
          treasuryAccountId: method?.treasuryAccountId ?? '', // Map the method to the proper account
          ourAccount: method?.accountNumber ?? '',
          clientAccount: clientAccount.trim(),
          collectedBy: profile?.name || username || '',
        }
        
        const invoice = outstanding.find((i) => i.id === invoiceId)
        nextPaid.set(invoiceId, toNumber(invoice.paidAmount) + value)

        return createPaymentClientSide({ invoiceId, payment: paymentPayload, uid: user?.uid })
      })

      await Promise.all(promises)

      // Update client totals on frontend optimistically or let realtime handle it
      const patched = invoices.map((invoice) =>
        nextPaid.has(invoice.id) ? { ...invoice, paidAmount: nextPaid.get(invoice.id) } : invoice,
      )
      await recalcClientTotals(clientId, patched)
    } catch (error) {
      console.error(error)
      alert(error.message)
    }

    setBusy(false)
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={t('receipts.title')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy ? t('common.saving') : t('common.save')}
          </Button>
        </>
      }
    >
      <p className="mb-4 rounded-xl bg-slate-50 px-4 py-3 text-xs leading-relaxed text-slate-600">
        {t('receipts.hint')}
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('common.client')} error={touched && !clientId ? t('receipts.pickClient') : null}>
          <SearchableSelect
            options={clients}
            value={clientId}
            placeholder={t('common.client')}
            searchPlaceholder="ابحث باسم العميل أو الهاتف..."
            onChange={(val) => {
              setClientId(val)
              setAllocation({})
            }}
          />
        </Field>

        <Field label={t('receipts.amount')} error={touched && collected <= 0 ? t('common.required') : null}>
          <Input numeric value={amount} onChange={(event) => setAmount(event.target.value)} />
        </Field>

        <Field label={t('common.date')}>
          <Input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
        </Field>

        <Field label={t('invoices.method')}>
          <Select value={methodId} onChange={(event) => setMethodId(event.target.value)}>
            <option value="">{t('common.none')}</option>
            {methods
              .filter((item) => !item.archived)
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                  {item.accountNumber ? ` — ${item.accountNumber}` : ''}
                </option>
              ))}
          </Select>
        </Field>

        {method && method.type !== 'cash' && (
          <Field label={t('invoices.clientAccount')} hint={t('invoices.clientAccountHint')} className="sm:col-span-2">
            <Input numeric value={clientAccount} onChange={(event) => setClientAccount(event.target.value)} />
          </Field>
        )}
      </div>

      {clientId && (
        <div className="mt-6">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-sm font-bold text-slate-900">{t('receipts.allocation')}</h4>
            <div className="flex gap-2">
              <Button variant="soft" onClick={autoAllocate} disabled={collected <= 0}>
                {t('receipts.autoAllocate')}
              </Button>
              <Button variant="ghost" onClick={() => setAllocation({})}>
                {t('receipts.clearAllocation')}
              </Button>
            </div>
          </div>

          {outstanding.length === 0 ? (
            <p className="rounded-xl bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
              {t('receipts.noOutstanding')}
            </p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm">
                  <thead>
                    <tr>
                      <Th>{t('invoices.number')}</Th>
                      <Th>{t('common.date')}</Th>
                      <Th>{t('invoices.total')}</Th>
                      <Th>{t('receipts.invoiceRemaining')}</Th>
                      <Th className="w-40">{t('receipts.allocated')}</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {outstanding.map((invoice) => {
                      const remaining = remainingOf(invoice)
                      const value = toNumber(allocation[invoice.id])
                      const over = value > remaining + 0.001
                      return (
                        <tr key={invoice.id}>
                          <Td>
                            <span className="num font-bold text-slate-800">{invoice.number}</span>
                          </Td>
                          <Td className="text-slate-600">{formatDate(invoice.date, locale)}</Td>
                          <Td>
                            <span className="num text-slate-600">{formatMoney(invoice.total)}</span>
                          </Td>
                          <Td>
                            <span className="num font-semibold text-amber-600">{formatMoney(remaining)}</span>
                          </Td>
                          <Td>
                            <Input
                              numeric
                              value={allocation[invoice.id] ?? ''}
                              onChange={(event) => setLine(invoice.id, event.target.value)}
                              placeholder="0"
                              className={over ? 'border-red-300' : ''}
                            />
                            {over && (
                              <span className="mt-1 block text-[11px] font-semibold text-red-600">
                                {t('receipts.overInvoice')}
                              </span>
                            )}
                          </Td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl bg-slate-50 px-4 py-3">
                <span className="text-xs font-semibold text-slate-500">
                  {t('receipts.allocated')}:{' '}
                  <span className="num font-bold text-slate-800">{formatMoney(allocated)}</span>
                </span>
                <span className="text-xs font-semibold text-slate-500">
                  {t('receipts.unallocated')}:{' '}
                  <span className={`num font-bold ${unallocated < 0 ? 'text-red-600' : 'text-slate-800'}`}>
                    {formatMoney(unallocated)}
                  </span>
                </span>
                {overAllocated && (
                  <span className="text-xs font-bold text-red-600">{t('receipts.overAllocated')}</span>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </Modal>
  )
}
