import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useI18n } from '../i18n'
import { useAuth } from '../context/AuthContext'
import {
  COL,
  createDoc,
  deleteDocById,
  recalcClientTotals,
  sumPayments,
  updateDocById,
  useCollection,
  useLookup,
  useSettings,
  useSubCollection,
} from '../lib/db'

import { createPaymentClientSide, reversePaymentClientSide } from '../lib/clientInvoices'
import { canSeeMoneyInternals } from '../lib/roles'
import { formatDate, formatMoney, toNumber } from '../lib/format'
import { remainingOf } from '../lib/invoice'
import { JOB_COSTS_COL } from './Vendors'
import {
  InvoiceForm,
  InvoicePrintable,
  PaymentForm,
  persistInvoiceEdit,
} from './Invoices'
import PrintDocument from '../components/PrintDocument'
import QrImage from '../components/QrImage'
import JobCosts from '../components/JobCosts'
import {
  Button,
  ConfirmDialog,
  EmptyState,
  Loading,
  PageHeader,
  TableWrap,
  Td,
  Th,
} from '../components/ui'

/** صفحة الفاتورة: معاينة كاملة + صفحة تعديل مستقلة (`/invoices/:id/edit`) */
export default function InvoiceView({ mode = 'view' }) {
  const { id } = useParams()
  const navigate = useNavigate()
  const { t, locale } = useI18n()
  const { role, profile, username, user } = useAuth()
  const { settings } = useSettings()
  const finance = canSeeMoneyInternals(role)

  const { rows: invoices, loading } = useCollection(COL.invoices, 'date', 'desc')
  const { rows: clients } = useCollection(COL.clients, 'name', 'asc')
  const { rows: employees } = useCollection(COL.employees, 'name', 'asc')
  const { rows: services } = useCollection(COL.services, 'name', 'asc')
  const { rows: methods } = useCollection(COL.paymentMethods, 'name', 'asc')
  const { rows: jobCosts } = useCollection(JOB_COSTS_COL, 'date', 'desc')
  const { rows: payments } = useSubCollection(COL.invoices, id, 'payments', 'date')

  const clientMap = useLookup(clients)
  const employeeMap = useLookup(employees)

  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState(null)

  const invoice = invoices.find((row) => row.id === id)

  if (loading) return <Loading />

  if (!invoice) {
    return (
      <div>
        <PageHeader title={t('invoices.title')} />
        <EmptyState
          title={t('clientProfile.notFound')}
          action={<Button onClick={() => navigate('/invoices')}>{t('common.back')}</Button>}
        />
      </div>
    )
  }

  const client = clientMap.get(invoice.clientId)

  // syncPaid was removed because backend handles paidAmount

  async function addPayment(values) {
    setBusy(true)
    try {
      const collectorName = values.collectorName || profile?.name || username || ''
      await createPaymentClientSide({
        invoiceId: invoice.id,
        payment: {
          ...values,
          collectorId: profile?.id || user?.uid || null,
          collectorName,
          collectedBy: collectorName,
          collectedByUsername: username || '',
        },
        uid: user?.uid,
      })
      
      const newPaidAmount = (invoice.paidAmount || 0) + Number(values.amount)
      await recalcClientTotals(
        invoice.clientId,
        invoices.map((item) => (item.id === invoice.id ? { ...item, paidAmount: newPaidAmount } : item)),
      )
    } catch (err) {
      console.error(err)
      alert(err?.message || 'حدث خطأ أثناء تسجيل الدفعة.')
    }
    setBusy(false)
    setAdding(false)
  }

  async function deletePayment() {
    setBusy(true)
    try {
      await reversePaymentClientSide({ invoiceId: invoice.id, paymentId: removing.id, uid: user?.uid })
      
      const paymentAmount = Number(removing.amount || 0)
      const newPaidAmount = Math.max(0, (invoice.paidAmount || 0) - paymentAmount)
      await recalcClientTotals(
        invoice.clientId,
        invoices.map((item) => (item.id === invoice.id ? { ...item, paidAmount: newPaidAmount } : item)),
      )
    } catch (err) {
      console.error(err)
      alert(err?.message || 'حدث خطأ أثناء إلغاء الدفعة.')
    }
    setBusy(false)
    setRemoving(null)
  }

  async function saveEdit(values, payment) {
    setBusy(true)
    await persistInvoiceEdit({ invoice, values, payment, invoices, employees, jobCosts })
    setBusy(false)
    navigate(`/invoices/${invoice.id}`)
  }

  /* ----- وضع التعديل ----- */
  if (mode === 'edit') {
    return (
      <div>
        <div className="no-print mb-4">
          <button
            type="button"
            onClick={() => navigate(`/invoices/${invoice.id}`)}
            className="text-sm font-semibold text-brand-700 hover:underline"
          >
            ← {t('common.back')}
          </button>
        </div>
        <InvoiceForm
          asPage
          open
          invoice={invoice}
          clients={clients}
          employees={employees}
          services={services}
          methods={methods}
          settings={settings}
          busy={busy}
          onClose={() => navigate(`/invoices/${invoice.id}`)}
          onSave={saveEdit}
        />
      </div>
    )
  }

  /* ----- وضع المعاينة ----- */
  const link = settings.websiteUrl?.trim()

  return (
    <div>
      <div className="no-print mb-4 flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => navigate('/invoices')}
          className="text-sm font-semibold text-brand-700 hover:underline"
        >
          ← {t('nav.invoices')}
        </button>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" onClick={() => window.print()}>
            {t('invoices.print')}
          </Button>
          <Button variant="ghost" onClick={() => setAdding(true)}>
            + {t('invoices.addPayment')}
          </Button>
          <Button onClick={() => navigate(`/invoices/${invoice.id}/edit`)}>{t('common.edit')}</Button>
        </div>
      </div>

      {/* شريط البيانات الداخلية للموظفين والمنشئ — داخلي بالنظام فقط */}
      <div className="card mb-4 flex flex-wrap items-center justify-between gap-4 p-4 text-xs">
        <div>
          <span className="text-slate-400">منشئ الفاتورة (Created By): </span>
          <span className="font-bold text-slate-800">{invoice.createdByName || invoice.accountantName || '—'}</span>
        </div>
        <div>
          <span className="text-slate-400">الموظف المسؤول (Responsible Employee): </span>
          <span className="font-bold text-brand-700">
            {invoice.responsibleEmployeeName || invoice.employeeName || (invoice.employeeId ? employeeMap.get(invoice.employeeId)?.name : '—')}
          </span>
        </div>
      </div>

      <div className="card p-6">
        <InvoicePrintable
          invoice={invoice}
          client={client}
          employeeMap={employeeMap}
          settings={settings}
          locale={locale}
        />
      </div>

      <div className="mt-6">
        <h4 className="mb-3 text-sm font-bold text-slate-900">{t('invoices.payments')}</h4>
        {payments.length === 0 ? (
          <p className="rounded-xl bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
            {t('invoices.noPayments')}
          </p>
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <Th>{t('common.date')}</Th>
                <Th>{t('common.amount')}</Th>
                <Th>{t('invoices.method')}</Th>
                <Th>{t('invoices.collectedBy')}</Th>
                <Th>{t('invoices.ourAccount')}</Th>
                <Th>{t('invoices.clientAccount')}</Th>
                <Th className="w-px" />
              </tr>
            </thead>
            <tbody>
              {payments.map((payment) => (
                <tr key={payment.id}>
                  <Td className="text-slate-600">{formatDate(payment.date, locale)}</Td>
                  <Td>
                    <span className="num font-bold text-emerald-600">{formatMoney(payment.amount)}</span>
                  </Td>
                  <Td className="text-slate-700">{payment.methodName || '—'}</Td>
                  <Td className="text-slate-600">{payment.collectorName || payment.collectedBy || '—'}</Td>
                  <Td>
                    <span className="num text-slate-500">{payment.ourAccount || '—'}</span>
                  </Td>
                  <Td>
                    <span className="num text-slate-500">{payment.clientAccount || '—'}</span>
                  </Td>
                  <Td>
                    {payment.reversed ? (
                      <span className="text-xs text-slate-400">{t('invoices.cancelled')}</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setRemoving(payment)}
                        className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50"
                      >
                        {t('common.delete')}
                      </button>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </div>

      {finance && (
        <div className="mt-6">
          <JobCosts invoice={invoice} />
        </div>
      )}

      <PrintDocument>
        <InvoicePrintable
          invoice={invoice}
          client={client}
          employeeMap={employeeMap}
          settings={settings}
          locale={locale}
        />
      </PrintDocument>

      <PaymentForm
        open={adding}
        busy={busy}
        methods={methods}
        remaining={remainingOf(invoice)}
        onClose={() => setAdding(false)}
        onSave={addPayment}
      />

      <ConfirmDialog
        open={Boolean(removing)}
        busy={busy}
        onClose={() => setRemoving(null)}
        onConfirm={deletePayment}
        title={t('common.deleteTitle')}
        message={t('common.deleteMsg', { name: formatMoney(removing?.amount) })}
      />
    </div>
  )
}
