import { useMemo, useState, useEffect } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { useI18n } from '../i18n'
import { useAuth } from '../context/AuthContext'
import { COL, useCollection, useSettings } from '../lib/db'
import {
  VENDORS_COL,
  JOB_COSTS_COL,
  PURCHASE_INVOICES_COL,
  PURCHASE_RETURNS_COL,
  SUPPLIER_CREDIT_NOTES_COL,
  VENDOR_ADVANCES_COL,
  SUPPLIER_PAYABLES_COL,
} from './Vendors'
import { formatDate, formatMoney, formatNumber, todayISO, toNumber, round2 } from '../lib/format'
import { vendorTypeLabel, formalVendorBalance } from '../lib/costing'
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Loading,
  PageHeader,
  SearchInput,
  Select,
  StatCard,
  TableWrap,
  Td,
  Th,
} from '../components/ui'
import {
  IconVendors,
  IconInvoices,
  IconTrendUp,
  IconReports,
  IconPrinter,
  IconExport,
} from '../components/Icons'
import ReportPrintHeader from '../components/ReportPrintHeader'
import PrintDocument from '../components/PrintDocument'

export default function VendorStatement() {
  const { t, locale } = useI18n()
  const { role } = useAuth()
  const { settings } = useSettings()
  const [searchParams, setSearchParams] = useSearchParams()

  // Realtime Collections
  const { rows: vendors, loading: loadingVendors } = useCollection(VENDORS_COL, 'name', 'asc')
  const { rows: purchaseInvoices, loading: loadingInvoices } = useCollection(PURCHASE_INVOICES_COL, 'date', 'desc')
  const { rows: supplierPayables, loading: loadingPayables } = useCollection(SUPPLIER_PAYABLES_COL, 'createdAt', 'desc')
  const { rows: purchaseReturns, loading: loadingReturns } = useCollection(PURCHASE_RETURNS_COL, 'returnDate', 'desc')
  const { rows: creditNotes, loading: loadingCreditNotes } = useCollection(SUPPLIER_CREDIT_NOTES_COL, 'creditNoteDate', 'desc')
  const { rows: advances, loading: loadingAdvances } = useCollection(VENDOR_ADVANCES_COL, 'advanceDate', 'desc')
  const { rows: costs, loading: loadingCosts } = useCollection(JOB_COSTS_COL, 'date', 'desc')

  // Selected vendor state
  const vendorIdFromQuery = searchParams.get('vendorId') || ''
  const [selectedVendorId, setSelectedVendorId] = useState(vendorIdFromQuery)

  // Sync if URL query changes
  useEffect(() => {
    if (vendorIdFromQuery && vendorIdFromQuery !== selectedVendorId) {
      setSelectedVendorId(vendorIdFromQuery)
    } else if (!selectedVendorId && vendors.length > 0) {
      const firstActive = vendors.find((v) => !v.archived)
      if (firstActive) {
        setSelectedVendorId(firstActive.id)
      }
    }
  }, [vendorIdFromQuery, vendors, selectedVendorId])

  // Filters
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [activePreset, setActivePreset] = useState('all')
  const [typeFilter, setTypeFilter] = useState('all')
  const [searchQuery, setSearchQuery] = useState('')

  const activeVendors = useMemo(() => vendors.filter((v) => !v.archived), [vendors])
  const selectedVendor = useMemo(
    () => vendors.find((v) => v.id === selectedVendorId) || null,
    [vendors, selectedVendorId]
  )

  // Apply Quick Date Presets
  function applyDatePreset(key) {
    setActivePreset(key)
    const now = new Date()
    const y = now.getFullYear()
    const m = now.getMonth()
    const pad = (n) => String(n).padStart(2, '0')

    if (key === 'thisMonth') {
      setStartDate(`${y}-${pad(m + 1)}-01`)
      setEndDate(todayISO())
    } else if (key === 'lastMonth') {
      const prevMonth = new Date(y, m - 1, 1)
      const lastDayPrev = new Date(y, m, 0)
      setStartDate(`${prevMonth.getFullYear()}-${pad(prevMonth.getMonth() + 1)}-01`)
      setEndDate(`${lastDayPrev.getFullYear()}-${pad(lastDayPrev.getMonth() + 1)}-${pad(lastDayPrev.getDate())}`)
    } else if (key === 'thisYear') {
      setStartDate(`${y}-01-01`)
      setEndDate(todayISO())
    } else if (key === 'all') {
      setStartDate('')
      setEndDate('')
    }
  }

  function handleVendorChange(newId) {
    setSelectedVendorId(newId)
    setSearchParams(newId ? { vendorId: newId } : {})
  }

  // 1. Build unified chronologically sorted ledger events for the selected vendor
  const rawLedgerEvents = useMemo(() => {
    if (!selectedVendorId) return []

    const vId = selectedVendorId
    const events = []

    // 1.1 Purchase Invoices (Credit = invoice total liability)
    const vendorPurchases = purchaseInvoices.filter((inv) => inv.vendorId === vId)
    vendorPurchases.forEach((inv) => {
      const invDate = inv.date || inv.invoiceDate || todayISO()
      events.push({
        id: `pi-${inv.id}`,
        rawId: inv.id,
        date: invDate,
        type: 'فاتورة شراء',
        kind: 'invoice',
        ref: inv.number || inv.invoiceNumber || inv.id.slice(0, 6),
        desc: inv.description || (inv.purchaseType === 'asset' ? 'شراء أصل ثابت' : inv.purchaseType === 'inventory' ? 'مشتريات مخزون' : 'فاتورة مشتريات / خدمات'),
        debit: 0,
        credit: inv.cancelled ? 0 : toNumber(inv.total),
        cancelled: Boolean(inv.cancelled),
        method: '',
        meta: inv,
      })

      // 1.2 Payments attached to this invoice (Debit = paid amount)
      if (Array.isArray(inv.payments)) {
        inv.payments.forEach((p, idx) => {
          events.push({
            id: `pay-${inv.id}-${idx}`,
            rawId: inv.id,
            date: p.date || invDate,
            type: 'سند صرف / دفعة فاتورة',
            kind: 'payment',
            ref: p.receiptNumber || `PAY-${inv.number || inv.id.slice(0, 4)}`,
            desc: `سداد دفعة من فاتورة الشراء رقم ${inv.number || inv.id.slice(0, 6)} ${p.notes ? `(${p.notes})` : ''}`,
            debit: toNumber(p.amount),
            credit: 0,
            cancelled: Boolean(inv.cancelled),
            method: p.paymentMethod || 'نقداً / تحويل',
            meta: p,
          })
        })
      }
    })

    // 1.3 Project Supplier Payables (Costs for client jobs)
    const vendorPayables = supplierPayables.filter((sp) => sp.supplierId === vId)
    vendorPayables.forEach((sp) => {
      const isReconciled = sp.status === 'reconciled'
      const isCancelled = sp.status === 'cancelled'
      const spDate = (sp.approvedAt ? sp.approvedAt.slice(0, 10) : '') || sp.createdAt?.slice(0, 10) || todayISO()

      if (!isReconciled) {
        events.push({
          id: `sp-${sp.id}`,
          rawId: sp.id,
          date: spDate,
          type: 'تكلفة بند مشروع معتمدة',
          kind: 'payable',
          ref: `SP-${sp.id.slice(-6)}`,
          desc: sp.notes || (sp.supplierName ? `بند مشروع: ${sp.supplierName}` : 'استحقاق تكلفة بند عمل'),
          debit: 0,
          credit: isCancelled ? 0 : toNumber(sp.approvedCost),
          cancelled: isCancelled,
          method: '',
          meta: sp,
        })
      }

      // Payments made against this supplier payable
      if (Array.isArray(sp.payments)) {
        sp.payments.forEach((p, pIdx) => {
          events.push({
            id: `sppay-${sp.id}-${pIdx}`,
            rawId: sp.id,
            date: p.date || spDate,
            type: 'سند صرف بند مشروع',
            kind: 'payment',
            ref: p.receiptNumber || `PAY-SP-${sp.id.slice(-4)}`,
            desc: `سداد مستحق بند مشروع SP-${sp.id.slice(-6)} ${p.notes ? `(${p.notes})` : ''}`,
            debit: toNumber(p.amount),
            credit: 0,
            cancelled: isCancelled,
            method: p.paymentMethod || 'نقداً / تحويل',
            meta: p,
          })
        })
      }
    })

    // 1.4 Purchase Returns (Debit = reduces liability)
    const vendorReturns = purchaseReturns.filter((r) => r.vendorId === vId)
    vendorReturns.forEach((ret) => {
      events.push({
        id: `ret-${ret.id}`,
        rawId: ret.id,
        date: ret.returnDate || todayISO(),
        type: 'مردود مشتريات',
        kind: 'return',
        ref: ret.number || ret.id.slice(0, 6),
        desc: ret.reason ? `مردود مشتريات: ${ret.reason}` : 'إرجاع مشتريات للمورد',
        debit: ret.cancelled ? 0 : toNumber(ret.total),
        credit: 0,
        cancelled: Boolean(ret.cancelled),
        method: '',
        meta: ret,
      })
    })

    // 1.5 Supplier Credit Notes (Debit = reduces liability)
    const vendorCreditNotes = creditNotes.filter((cn) => cn.vendorId === vId)
    vendorCreditNotes.forEach((cn) => {
      events.push({
        id: `cn-${cn.id}`,
        rawId: cn.id,
        date: cn.creditNoteDate || todayISO(),
        type: 'إشعار دائن من المورد',
        kind: 'creditNote',
        ref: cn.creditNoteNumber || cn.id.slice(0, 6),
        desc: cn.reason ? `إشعار دائن: ${cn.reason}` : 'إشعار دائن مسجل لحساب المورد',
        debit: cn.cancelled ? 0 : toNumber(cn.total),
        credit: 0,
        cancelled: Boolean(cn.cancelled),
        method: '',
        meta: cn,
      })
    })

    // 1.6 Vendor Advances (Debit = prepayment to vendor)
    const vendorAdvances = advances.filter((adv) => adv.vendorId === vId)
    vendorAdvances.forEach((adv) => {
      events.push({
        id: `adv-${adv.id}`,
        rawId: adv.id,
        date: adv.advanceDate || todayISO(),
        type: 'سلفة مورد (دفعة مقدمة)',
        kind: 'advance',
        ref: adv.advanceNumber || `ADV-${adv.id.slice(0, 6)}`,
        desc: `سلفة نقدية / دفعة مقدمة للمورد تحت الحساب ${adv.notes ? `(${adv.notes})` : ''}`,
        debit: adv.reversed ? 0 : toNumber(adv.amount),
        credit: 0,
        cancelled: Boolean(adv.reversed),
        method: adv.paymentMethod || 'خزينة / بنك',
        meta: adv,
      })
    })

    // 1.7 Freelancer Costs
    const vendorCosts = costs.filter((c) => c.vendorId === vId && c.type !== 'commission')
    vendorCosts.forEach((c) => {
      events.push({
        id: `cost-${c.id}`,
        rawId: c.id,
        date: c.date || todayISO(),
        type: 'تكلفة شغلانة / فريلانسر',
        kind: 'jobCost',
        ref: c.id.slice(-6),
        desc: c.description || 'تكلفة خدمة عمل منفذة',
        debit: 0,
        credit: toNumber(c.amount),
        cancelled: false,
        method: '',
        meta: c,
      })

      if (c.paid) {
        events.push({
          id: `costpay-${c.id}`,
          rawId: c.id,
          date: c.paidDate || c.date || todayISO(),
          type: 'سداد تكلفة شغلانة',
          kind: 'payment',
          ref: `PAY-${c.id.slice(-4)}`,
          desc: `سداد تكلفة العمل (${c.description || 'خدمة منفذة'})`,
          debit: toNumber(c.amount),
          credit: 0,
          cancelled: false,
          method: 'مسدد',
          meta: c,
        })
      }
    })

    events.sort((a, b) => {
      const dA = a.date || ''
      const dB = b.date || ''
      if (dA !== dB) return dA.localeCompare(dB)
      return (b.credit || 0) - (a.credit || 0)
    })

    return events
  }, [selectedVendorId, purchaseInvoices, supplierPayables, purchaseReturns, creditNotes, advances, costs])

  // 2. Compute Running Balance and Filter by Dates & Types
  const { ledgerRows, openingBalance, periodSummary } = useMemo(() => {
    let running = 0
    let openBal = 0
    let totalDebit = 0
    let totalCredit = 0

    const rowsWithBalance = rawLedgerEvents.map((evt) => {
      if (!evt.cancelled) {
        running += evt.credit - evt.debit
      }
      return {
        ...evt,
        balanceAfter: round2(running),
      }
    })

    const inPeriodRows = []

    rowsWithBalance.forEach((row) => {
      const isBeforeStart = startDate && row.date < startDate
      const isAfterEnd = endDate && row.date > endDate

      if (isBeforeStart) {
        if (!row.cancelled) {
          openBal += row.credit - row.debit
        }
      } else if (!isAfterEnd) {
        if (typeFilter !== 'all' && row.kind !== typeFilter) return

        if (searchQuery.trim()) {
          const q = searchQuery.toLowerCase()
          const matches =
            row.desc.toLowerCase().includes(q) ||
            row.ref.toLowerCase().includes(q) ||
            row.type.toLowerCase().includes(q)
          if (!matches) return
        }

        inPeriodRows.push(row)
        if (!row.cancelled) {
          totalCredit += row.credit
          totalDebit += row.debit
        }
      }
    })

    const closingBalance = round2(openBal + totalCredit - totalDebit)

    return {
      ledgerRows: inPeriodRows,
      openingBalance: round2(openBal),
      periodSummary: {
        totalCredit: round2(totalCredit),
        totalDebit: round2(totalDebit),
        closingBalance,
        totalEvents: inPeriodRows.length,
      },
    }
  }, [rawLedgerEvents, startDate, endDate, typeFilter, searchQuery])

  // CSV Export
  function exportCSV() {
    if (!ledgerRows.length || !selectedVendor) return
    const headers = ['التاريخ', 'نوع المستند', 'رقم المرجع', 'البيان', 'طريقة الدفع', 'مدين (مسدد)', 'دائن (مستحق)', 'الرصيد بعد الحركة']
    const csvRows = [headers.join(',')]

    ledgerRows.forEach((r) => {
      const cleanDesc = (r.desc || '').replace(/"/g, '""')
      csvRows.push(
        [
          r.date,
          `"${r.type}"`,
          `"${r.ref}"`,
          `"${cleanDesc}"`,
          `"${r.method || ''}"`,
          r.debit || 0,
          r.credit || 0,
          r.balanceAfter,
        ].join(',')
      )
    })

    const blob = new Blob(['\uFEFF' + csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `كشف_حساب_مورد_${selectedVendor.name}_${todayISO()}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  function handlePrint() {
    window.print()
  }

  if (loadingVendors || loadingInvoices || loadingPayables) {
    return <Loading />
  }

  return (
    <div className="space-y-6">
      {/* Native Page Header with Actions */}
      <PageHeader
        title="حركة الحساب وكشف حساب المورد"
        subtitle="كشف حساب تفصيلي وحركات التوريد وفواتير الشراء وسندات الصرف والسلف (حساب 2101 / 211)"
      >
        <Button variant="ghost" onClick={handlePrint}>
          <IconPrinter className="w-4 h-4 ml-1.5" />
          طباعة كشف الحساب
        </Button>
        <Button variant="ghost" onClick={exportCSV} disabled={!ledgerRows.length}>
          <IconExport className="w-4 h-4 ml-1.5" />
          تصدير CSV
        </Button>
        <Link to="/vendors">
          <Button variant="secondary">
            إدارة الموردين والفواتير ←
          </Button>
        </Link>
      </PageHeader>

      {/* KPI Stat Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="رصيد أول الفترة (افتتاحي)"
          value={formatMoney(openingBalance)}
          suffix={t('common.currency')}
          tone="text-slate-600 bg-slate-100"
          Icon={IconReports}
        />
        <StatCard
          label="إجمالي المشتريات (دائن)"
          value={formatMoney(periodSummary.totalCredit)}
          suffix={t('common.currency')}
          tone="text-sky-600 bg-sky-50"
          Icon={IconInvoices}
        />
        <StatCard
          label="إجمالي المسدد (مدين)"
          value={formatMoney(periodSummary.totalDebit)}
          suffix={t('common.currency')}
          tone="text-emerald-600 bg-emerald-50"
          Icon={IconTrendUp}
        />
        <StatCard
          label="صافي الرصيد المستحق (نهاية الفترة)"
          value={formatMoney(periodSummary.closingBalance)}
          suffix={t('common.currency')}
          tone="text-amber-600 bg-amber-50"
          Icon={IconVendors}
        />
      </div>

      {/* Filter & Selector Card */}
      <div className="card p-4 space-y-4">
        {/* Row 1: Vendor Selection & Presets */}
        <div className="flex flex-wrap items-center justify-between gap-4 pb-3 border-b border-slate-100">
          <div className="w-full sm:w-80">
            <Field label="المورد / الدائن التجاري:">
              <Select
                value={selectedVendorId}
                onChange={(e) => handleVendorChange(e.target.value)}
              >
                {activeVendors.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name} {v.specialty ? `(${vendorTypeLabel(v.specialty, t)})` : ''} {v.phone ? `— ${v.phone}` : ''}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 pt-4 sm:pt-0">
            <span className="text-xs font-semibold text-slate-500 ml-1">فترة سريعة:</span>
            {[
              { key: 'all', label: 'جميع الحركات' },
              { key: 'thisMonth', label: 'هذا الشهر' },
              { key: 'lastMonth', label: 'الشهر الماضي' },
              { key: 'thisYear', label: 'هذا العام' },
            ].map((preset) => (
              <button
                key={preset.key}
                type="button"
                onClick={() => applyDatePreset(preset.key)}
                className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition-all ${
                  activePreset === preset.key
                    ? 'bg-brand-600 text-white shadow-xs'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>

        {/* Row 2: Date Pickers, Type Filter & Search */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 items-end">
          <Field label="من تاريخ">
            <Input
              type="date"
              value={startDate}
              onChange={(e) => {
                setStartDate(e.target.value)
                setActivePreset('custom')
              }}
            />
          </Field>

          <Field label="إلى تاريخ">
            <Input
              type="date"
              value={endDate}
              onChange={(e) => {
                setEndDate(e.target.value)
                setActivePreset('custom')
              }}
            />
          </Field>

          <Field label="نوع الحركة">
            <Select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
            >
              <option value="all">جميع الحركات</option>
              <option value="invoice">فواتير الشراء</option>
              <option value="payment">سندات الصرف والمدفوعات</option>
              <option value="return">مردودات المشتريات</option>
              <option value="creditNote">إشعارات دائنة</option>
              <option value="advance">سلف الموردين</option>
              <option value="jobCost">تكاليف العمل المنفذة</option>
            </Select>
          </Field>

          <Field label="بحث سريع">
            <SearchInput
              value={searchQuery}
              onChange={(val) => setSearchQuery(typeof val === 'string' ? val : val?.target?.value ?? '')}
              placeholder="بحث برقم الفاتورة، السند، البيان..."
              className="w-full"
            />
          </Field>
        </div>
      </div>

      {/* Main Ledger Table */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <span className="text-slate-900 dark:text-white">كشف الحركات: {selectedVendor?.name || 'لم يتم تحديد مورد'}</span>
            <span className="rounded-full bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-bold px-2.5 py-0.5 text-xs num">
              {ledgerRows.length} حركة
            </span>
          </h3>
          <span className="text-xs text-slate-400">
            * الرصيد التراكمي يتم احتسابه سطراً بسطر
          </span>
        </div>

        <TableWrap>
          <thead className="bg-slate-50 text-xs font-bold uppercase text-slate-500">
            <tr>
              <Th className="w-28">التاريخ</Th>
              <Th className="w-40">نوع المستند</Th>
              <Th className="w-36">رقم المرجع</Th>
              <Th>البيان والتفاصيل</Th>
              <Th className="text-end w-32">مدين (مسدد)</Th>
              <Th className="text-end w-32">دائن (مستحق)</Th>
              <Th className="text-end w-36">الرصيد التراكمي</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 font-medium">
            {ledgerRows.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-16 text-center">
                  <div className="mx-auto flex max-w-sm flex-col items-center justify-center gap-2 text-center">
                    <div className="grid h-12 w-12 place-items-center rounded-2xl bg-slate-100 dark:bg-slate-800 text-slate-400">
                      <IconReports className="h-6 w-6" />
                    </div>
                    <h4 className="text-sm font-bold text-slate-800 dark:text-slate-200">
                      لا توجد حركات مسجلة
                    </h4>
                    <p className="text-xs text-slate-400 leading-relaxed">
                      لم يتم العثور على فواتير أو سندات صرف مسجلة لهذا المورد في النطاق الزمني المحدد.
                    </p>
                  </div>
                </td>
              </tr>
            ) : (
              <>
                {startDate && (
                  <tr className="bg-slate-50/80 font-bold text-slate-700 text-xs">
                    <Td className="num text-slate-500">{startDate}</Td>
                    <Td>
                      <Badge tone="slate">رصيد افتتاحي</Badge>
                    </Td>
                    <Td className="num font-mono text-slate-400">—</Td>
                    <Td className="text-slate-600 font-semibold">
                      رصيد ما قبل الفترة من {startDate}
                    </Td>
                    <Td className="text-end num text-slate-400">—</Td>
                    <Td className="text-end num text-slate-400">—</Td>
                    <Td className="text-end num font-black text-slate-900">
                      {formatMoney(openingBalance)}
                    </Td>
                  </tr>
                )}

                {ledgerRows.map((row) => {
                  const badgeTone =
                    row.kind === 'invoice'
                      ? 'brand'
                      : row.kind === 'payment'
                      ? 'green'
                      : row.kind === 'return'
                      ? 'red'
                      : row.kind === 'creditNote'
                      ? 'brand'
                      : row.kind === 'advance'
                      ? 'amber'
                      : 'slate'

                  return (
                    <tr
                      key={row.id}
                      className={`hover:bg-slate-50/80 transition-colors ${
                        row.cancelled ? 'opacity-50 line-through' : ''
                      }`}
                    >
                      <Td className="num text-xs text-slate-600">{row.date}</Td>
                      <Td>
                        <Badge tone={badgeTone}>{row.type}</Badge>
                      </Td>
                      <Td className="font-mono text-xs font-bold text-slate-800">
                        {row.ref}
                      </Td>
                      <Td className="text-xs text-slate-700">
                        <div>{row.desc}</div>
                        {row.method && (
                          <span className="text-[11px] text-slate-400 mt-0.5 block">
                            طريقة السداد: {row.method}
                          </span>
                        )}
                      </Td>
                      <Td className="text-end num font-bold text-emerald-700">
                        {row.debit > 0 ? formatMoney(row.debit) : '—'}
                      </Td>
                      <Td className="text-end num font-bold text-slate-900">
                        {row.credit > 0 ? formatMoney(row.credit) : '—'}
                      </Td>
                      <Td className="text-end num font-black text-slate-900">
                        <span
                          className={
                            row.balanceAfter > 0
                              ? 'text-amber-700'
                              : row.balanceAfter < 0
                              ? 'text-emerald-700'
                              : 'text-slate-600'
                          }
                        >
                          {formatMoney(row.balanceAfter)}
                        </span>
                      </Td>
                    </tr>
                  )
                })}
              </>
            )}
          </tbody>
          {ledgerRows.length > 0 && (
            <tfoot className="bg-slate-100/80 font-bold border-t-2 border-slate-200 text-xs text-slate-900">
              <tr>
                <Td colSpan={4} className="text-start font-black">
                  إجمالي حركات الفترة / الرصيد الختامي:
                </Td>
                <Td className="text-end num font-black text-emerald-700">
                  {formatMoney(periodSummary.totalDebit)}
                </Td>
                <Td className="text-end num font-black text-slate-900">
                  {formatMoney(periodSummary.totalCredit)}
                </Td>
                <Td className="text-end num font-black text-amber-700 text-sm">
                  {formatMoney(periodSummary.closingBalance)}
                </Td>
              </tr>
            </tfoot>
          )}
        </TableWrap>
      </div>

      {/* Official Formal Printable Document Portal */}
      <PrintDocument>
        <div className="p-4 text-slate-900 text-sm">
          <ReportPrintHeader
            title="كشف حساب مورد / دائن تجاري"
            subtitle={`المورد: ${selectedVendor?.name || ''} — كود الحساب: 2101`}
            from={startDate}
            to={endDate}
            extra={
              selectedVendor && (
                <div className="grid grid-cols-3 gap-2 p-2 bg-slate-50 rounded-lg border border-slate-200 text-xs">
                  <div><strong>اسم المورد:</strong> {selectedVendor.name}</div>
                  <div><strong>التخصص:</strong> {vendorTypeLabel(selectedVendor.specialty, t) || 'عام'}</div>
                  <div><strong>الهاتف:</strong> {selectedVendor.phone || '—'}</div>
                </div>
              )
            }
          />

          <table className="w-full text-start text-xs border-collapse border border-slate-300 mt-4">
            <thead>
              <tr className="bg-slate-100">
                <th className="border border-slate-300 p-2 text-start">التاريخ</th>
                <th className="border border-slate-300 p-2 text-start">نوع المستند</th>
                <th className="border border-slate-300 p-2 text-start">رقم المرجع</th>
                <th className="border border-slate-300 p-2 text-start">البيان</th>
                <th className="border border-slate-300 p-2 text-end">مدين (مسدد)</th>
                <th className="border border-slate-300 p-2 text-end">دائن (مستحق)</th>
                <th className="border border-slate-300 p-2 text-end">الرصيد</th>
              </tr>
            </thead>
            <tbody>
              {startDate && (
                <tr className="bg-slate-50 font-bold">
                  <td className="border border-slate-300 p-2 num">{startDate}</td>
                  <td className="border border-slate-300 p-2" colSpan={3}>رصيد افتتاحي ما قبل الفترة</td>
                  <td className="border border-slate-300 p-2 text-end num">—</td>
                  <td className="border border-slate-300 p-2 text-end num">—</td>
                  <td className="border border-slate-300 p-2 text-end num">{formatMoney(openingBalance)}</td>
                </tr>
              )}
              {ledgerRows.map((r) => (
                <tr key={r.id}>
                  <td className="border border-slate-300 p-2 num">{r.date}</td>
                  <td className="border border-slate-300 p-2">{r.type}</td>
                  <td className="border border-slate-300 p-2 font-mono">{r.ref}</td>
                  <td className="border border-slate-300 p-2">{r.desc}</td>
                  <td className="border border-slate-300 p-2 text-end num">{r.debit > 0 ? formatMoney(r.debit) : '—'}</td>
                  <td className="border border-slate-300 p-2 text-end num">{r.credit > 0 ? formatMoney(r.credit) : '—'}</td>
                  <td className="border border-slate-300 p-2 text-end num font-bold">{formatMoney(r.balanceAfter)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-slate-100 font-bold">
                <td colSpan={4} className="border border-slate-300 p-2">الإجمالي والرصيد المستحق النهائي:</td>
                <td className="border border-slate-300 p-2 text-end num">{formatMoney(periodSummary.totalDebit)}</td>
                <td className="border border-slate-300 p-2 text-end num">{formatMoney(periodSummary.totalCredit)}</td>
                <td className="border border-slate-300 p-2 text-end num text-sm font-black">{formatMoney(periodSummary.closingBalance)}</td>
              </tr>
            </tfoot>
          </table>

          <div className="mt-8 grid grid-cols-3 text-center text-xs font-bold pt-6 border-t border-slate-300">
            <div>
              <p>المحاسب المسؤول</p>
              <p className="mt-8 text-slate-400">.......................</p>
            </div>
            <div>
              <p>المراجع الداخلي</p>
              <p className="mt-8 text-slate-400">.......................</p>
            </div>
            <div>
              <p>اعتماد الإدارة المالية / الختم</p>
              <p className="mt-8 text-slate-400">.......................</p>
            </div>
          </div>
        </div>
      </PrintDocument>
    </div>
  )
}
