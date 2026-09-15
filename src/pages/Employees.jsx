import { useMemo, useState, useEffect } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { useI18n } from '../i18n'
import {
  COL,
  createDoc,
  deleteDocById,
  nextEmployeeCode,
  nextNumber,
  updateDocById,
  useCollection,
  useLookup,
  useSettings,
} from '../lib/db'
import { useAuth } from '../context/AuthContext'
import {
  postAdvanceRecovery,
  postCommissionToAccounting,
  postSalaryAccrual,
} from '../lib/employeeAccounting'
import {
  createDepartment,
  createPosition,
  dryRunEmployeeMigration,
  executeEmployeeMigration,
  setDepartmentActive,
  setPositionActive,
  updateDepartment,
  updatePosition,
} from '../lib/hr'
import { clearDemoData, seedDemoData } from '../lib/seedData'
import { formatDate, formatMoney, monthKey, round2, todayISO, toNumber } from '../lib/format'
import {
  buildDetailedEmployeeMonthReport,
  employeeCommission,
  employeeJobPay,
  monthlyEmployeeTierBreakdowns,
  targetBonusRows,
  vendorTypeLabel,
} from '../lib/costing'
import { JOB_COSTS_COL } from './Vendors'
import PrintDocument from '../components/PrintDocument'
import ReportPrintHeader from '../components/ReportPrintHeader'
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Field,
  Input,
  Loading,
  Modal,
  PageHeader,
  SearchInput,
  Select,
  Td,
  TableWrap,
  Textarea,
  Th,
} from '../components/ui'

/*
 * حركات الكشف اليدوية — «commission» مشالت عمدًا: عمولة الموظف تُحسب
 * تلقائيًا من الفواتير (planCommission) وتظهر في عمود العمولة، فإضافتها
 * يدويًا كانت تسبب حسابًا مزدوجًا في نفس الشهر.
 */
const ENTRY_TYPES = ['salary', 'bonus', 'raise', 'deduction']

/** الخصم يقلّل ما صُرف فعليًا، والباقي يزيده */
function signedAmount(type, amount) {
  return type === 'deduction' ? -toNumber(amount) : toNumber(amount)
}

/**
 * كشف شهري احترافي: كل شهر لوحده — مرتب، بونص، خصم، عمولة (لو موظف
 * مبيعات)، وحالة الصرف. يجمع بين حركات كشف الموظف اليدوية وعمولاته
 * التلقائية من الفواتير في صف واحد لكل شهر.
 */
function buildMonthlyStatement(entries, commissionRows, jobPayRows = [], bonusRows = []) {
  const months = new Map()
  const ensure = (key) =>
    months.get(key) ??
    {
      month: key,
      salary: 0,
      bonus: 0,
      raise: 0,
      deduction: 0,
      commission: 0,
      commissionPaid: 0,
      jobPay: 0,
      targetBonus: 0,
      paid: 0,
      due: 0,
    }

  for (const entry of entries) {
    const key = monthKey(entry.date)
    if (!key) continue
    const row = ensure(key)
    const amount = toNumber(entry.amount)
    row[entry.type] = (row[entry.type] ?? 0) + amount
    if (entry.paid) row.paid += signedAmount(entry.type, amount)
    else row.due += signedAmount(entry.type, amount)
    months.set(key, row)
  }

  for (const cost of commissionRows) {
    const key = monthKey(cost.date)
    if (!key) continue
    const row = ensure(key)
    const amount = toNumber(cost.amount)
    row.commission += amount
    if (cost.paid) {
      row.commissionPaid += amount
      row.paid += amount
    } else {
      row.due += amount
    }
    months.set(key, row)
  }

  for (const cost of jobPayRows) {
    const key = monthKey(cost.date)
    if (!key) continue
    const row = ensure(key)
    const amount = toNumber(cost.amount)
    row.jobPay += amount
    if (cost.paid) row.paid += amount
    else row.due += amount
    months.set(key, row)
  }

  /* بونص التارجت: تقدير شهري يظهر في صافي الكشف، لكنه لا يُحتسب ضمن
     «المتبقي» — يُصرف بتسجيله كحركة بونص يدوية حتى لا يُحسب مرتين */
  for (const row of bonusRows) {
    if (!row.month || row.earned <= 0) continue
    const bucket = ensure(row.month)
    bucket.targetBonus += toNumber(row.earned)
    months.set(row.month, bucket)
  }

  return [...months.values()]
    .map((row) => ({
      ...row,
      net: round2(
        row.salary + row.bonus + row.raise - row.deduction + row.commission + row.jobPay + row.targetBonus,
      ),
      paid: round2(row.paid),
      due: round2(row.due),
    }))
    .sort((a, b) => b.month.localeCompare(a.month))
}

function StatusBadge({ status, archived }) {
  if (archived || status === 'archived') {
    return <Badge variant="neutral">مؤرشف</Badge>
  }
  switch (status) {
    case 'active':
      return <Badge variant="success">نشط</Badge>
    case 'on_leave':
      return <Badge variant="warning">في إجازة</Badge>
    case 'suspended':
      return <Badge variant="purple">موقوف</Badge>
    case 'terminated':
      return <Badge variant="danger">منتهي خدماته</Badge>
    default:
      return <Badge variant="success">نشط</Badge>
  }
}

export default function Employees() {
  const { t, locale } = useI18n()
  const authContext = useAuth()
  const role = authContext?.role
  const canModify = role === 'admin' || role === 'accountant'
  const { settings } = useSettings()
  const { rows, loading } = useCollection(COL.employees, 'name', 'asc')
  const { rows: clients } = useCollection(COL.clients, 'name', 'asc')
  const { rows: jobCosts } = useCollection(JOB_COSTS_COL, 'date', 'desc')
  const { rows: invoices } = useCollection(COL.invoices, 'date', 'desc')
  const { rows: entries } = useCollection(COL.employeeEntries, 'date', 'desc')
  const { rows: expenseCategories } = useCollection(COL.expenseCategories, 'name', 'asc')
  const { rows: customEmployeeTypes } = useCollection(COL.employeeTypes, 'name', 'asc')
  const { rows: allExpenses } = useCollection(COL.expenses, 'date', 'desc')
  const { rows: departments } = useCollection(COL.departments, 'name', 'asc')
  const { rows: positions } = useCollection(COL.positions, 'name', 'asc')
  const { rows: accounts } = useCollection(COL.accounts, 'code', 'asc')
  const { rows: accountingTxs } = useCollection(COL.accountingTransactions, 'transactionDate', 'desc')

  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const modalParam = searchParams.get('modal')

  useEffect(() => {
    if (modalParam === 'positions') {
      navigate('/positions', { replace: true })
    }
    if (modalParam === 'depts') {
      navigate('/departments', { replace: true })
    }
    if (modalParam === 'migration') {
      navigate('/employee-migration', { replace: true })
    }
  }, [modalParam, navigate])

  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState(null)
  const [viewing, setViewing] = useState(null)
  const [removing, setRemoving] = useState(null)

  const showDeptsModal = modalParam === 'depts'
  const showPositionsModal = modalParam === 'positions'
  const showMigrationModal = modalParam === 'migration'

  const setShowDeptsModal = (open) => {
    setSearchParams((prev) => {
      if (open) prev.set('modal', 'depts')
      else prev.delete('modal')
      return prev
    }, { replace: true })
  }

  const setShowPositionsModal = (open) => {
    setSearchParams((prev) => {
      if (open) prev.set('modal', 'positions')
      else prev.delete('modal')
      return prev
    }, { replace: true })
  }

  const setShowMigrationModal = (open) => {
    setSearchParams((prev) => {
      if (open) prev.set('modal', 'migration')
      else prev.delete('modal')
      return prev
    }, { replace: true })
  }

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [postingState, setPostingState] = useState({ busy: false, msg: null, err: null })

  async function handlePostSalary(employee, report) {
    if (!report || !employee) return
    setPostingState({ busy: true, msg: null, err: null })
    try {
      const [year, mStr] = report.month.split('-')
      const salaryAmount = report.salaryTotal > 0 ? report.salaryTotal : (employee.baseSalary || 0)
      const res = await postSalaryAccrual({
        employeeId: employee.id,
        employeeName: employee.name,
        amount: salaryAmount,
        year,
        month: mStr,
        uid: authContext?.user?.uid,
        accounts,
        settings,
      })
      setPostingState({ busy: false, msg: res.message, err: null })
    } catch (err) {
      setPostingState({ busy: false, msg: null, err: err.message || 'خطأ أثناء ترحيل المرتب' })
    }
  }

  async function handlePostCommission(cost, employee) {
    if (!cost || !employee) return
    setPostingState({ busy: true, msg: null, err: null })
    try {
      const res = await postCommissionToAccounting({
        jobCost: cost,
        employeeId: employee.id,
        employeeName: employee.name,
        uid: authContext?.user?.uid,
        accounts,
        settings,
      })
      setPostingState({ busy: false, msg: res.message, err: null })
    } catch (err) {
      setPostingState({ busy: false, msg: null, err: err.message || 'خطأ أثناء ترحيل العمولة' })
    }
  }

  async function handlePostAdvanceRecovery(employee, report) {
    if (!report || !employee) return
    setPostingState({ busy: true, msg: null, err: null })
    try {
      const [year, mStr] = report.month.split('-')
      const recoveryAmount = report.deductionTotal || 0
      const res = await postAdvanceRecovery({
        employeeId: employee.id,
        employeeName: employee.name,
        amount: recoveryAmount,
        year,
        month: mStr,
        uid: authContext?.user?.uid,
        accounts,
        settings,
      })
      setPostingState({ busy: false, msg: res.message, err: null })
    } catch (err) {
      setPostingState({ busy: false, msg: null, err: err.message || 'خطأ أثناء ترحيل استقطاع السلفة' })
    }
  }

  const deptMap = useMemo(() => new Map(departments.map((d) => [d.id, d.name])), [departments])
  const posMap = useMemo(() => new Map(positions.map((p) => [p.id, p.name])), [positions])

  /* إحصاءات كل موظف */
  const stats = useMemo(() => {
    const map = new Map()
    const ensure = (id) =>
      map.get(id) ?? { clients: 0, broughtIn: 0, closedClients: new Set(), netPaid: 0, invoices: 0 }

    for (const client of clients) {
      if (!client.employeeId) continue
      const stat = ensure(client.employeeId)
      stat.clients += 1
      map.set(client.employeeId, stat)
    }
    for (const invoice of invoices) {
      if (!invoice.employeeId) continue
      const stat = ensure(invoice.employeeId)
      stat.broughtIn += toNumber(invoice.total)
      stat.invoices += 1
      if (invoice.clientId) stat.closedClients.add(invoice.clientId)
      map.set(invoice.employeeId, stat)
    }
    for (const entry of entries) {
      if (!entry.employeeId) continue
      const stat = ensure(entry.employeeId)
      if (entry.paid) stat.netPaid += signedAmount(entry.type, entry.amount)
      map.set(entry.employeeId, stat)
    }
    return map
  }, [clients, invoices, entries])

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return rows
    return rows.filter((row) =>
      [row.name, row.employeeCode, row.phone, row.email].filter(Boolean).join(' ').toLowerCase().includes(term),
    )
  }, [rows, search])

  async function handleSave(values) {
    setBusy(true)
    let payload = { ...values }
    // توليد كود تلقائي عبر nextEmployeeCode فقط عند إضافة موظف جديد إذا لم يُدخل كود
    if (!editing?.id && !payload.employeeCode?.trim()) {
      payload.employeeCode = await nextEmployeeCode('EMP')
    }
    if (editing?.id) await updateDocById(COL.employees, editing.id, payload)
    else await createDoc(COL.employees, payload)
    setBusy(false)
    setEditing(null)
  }

  function askDelete(row) {
    const linkedClients = clients.some((client) => client.employeeId === row.id || client.secondEmployeeId === row.id)
    const linkedInvoices = invoices.some((invoice) => invoice.employeeId === row.id)
    const linkedCosts = jobCosts.some((cost) => cost.employeeId === row.id)
    const linkedEntries = entries.some((entry) => entry.employeeId === row.id)
    const linkedExpenses = allExpenses.some((exp) => exp.target?.kind === 'employee' && exp.target.id === row.id)

    if (linkedClients || linkedInvoices || linkedCosts || linkedEntries || linkedExpenses) {
      setError('لا يمكن حذف هذا الموظف نهائيًا نظراً لوجود معاملات سابقة مرتبطة به. سيتم أرشفته بدلاً من ذلك لحفظ سلامة البيانات.')
      setRemoving({ ...row, forceArchiveOnly: true })
      return
    }
    setError(null)
    setRemoving(row)
  }

  async function handleDelete() {
    if (!removing) return
    setBusy(true)
    if (removing.forceArchiveOnly || removing.archived) {
      await updateDocById(COL.employees, removing.id, { archived: true, status: 'archived' })
    } else {
      await deleteDocById(COL.employees, removing.id)
    }
    setBusy(false)
    setRemoving(null)
  }

  const [seeding, setSeeding] = useState(false)

  async function handleSeedDemo() {
    setSeeding(true)
    try {
      await seedDemoData()
    } catch (err) {
      console.error('Failed to seed demo data:', err)
    } finally {
      setSeeding(false)
    }
  }

  const [clearing, setClearing] = useState(false)

  async function handleClearDemo() {
    if (!window.confirm('هل أنت تأكد من حذف كافة البيانات التجريبية نهائياً؟')) return
    setClearing(true)
    try {
      await clearDemoData()
      alert('تم حذف كافة البيانات التجريبية بنجاح!')
    } catch (err) {
      console.error('Failed to clear demo data:', err)
    } finally {
      setClearing(false)
    }
  }

  if (loading) return <Loading />

  return (
    <div>
      <PageHeader title={t('employees.title')} subtitle={t('employees.subtitle')}>
        <div className="flex flex-wrap gap-2">
          {canModify && (
            <>
              <Button onClick={handleClearDemo} disabled={clearing || seeding} variant="danger">
                {clearing ? 'جاري الحذف...' : 'حذف البيانات التجريبية'}
              </Button>
              <Button onClick={handleSeedDemo} disabled={seeding || clearing} variant="secondary">
                {seeding ? 'جاري التوليد...' : 'توليد بيانات تجريبية'}
              </Button>
            </>
          )}
          <Button onClick={() => setEditing({})}>+ {t('employees.add')}</Button>
        </div>
      </PageHeader>

      {error && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
          {error}
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState
          title={t('employees.empty')}
          message={t('employees.emptyHint')}
          action={
            <div className="flex justify-center gap-3">
              {canModify && (
                <Button onClick={handleSeedDemo} disabled={seeding} variant="secondary">
                  {seeding ? 'جاري التوليد...' : 'توليد بيانات تجريبية'}
                </Button>
              )}
              <Button onClick={() => setEditing({})}>+ {t('employees.add')}</Button>
            </div>
          }
        />
      ) : (
        <>
          <div className="mb-4">
            <SearchInput value={search} onChange={setSearch} placeholder={t('common.search')} />
          </div>

          <TableWrap>
            <thead>
              <tr>
                <Th>كود الموظف</Th>
                <Th>{t('employees.name')}</Th>
                <Th>القسم والوظيفة</Th>
                <Th>{t('common.phone')}</Th>
                <Th>الحالة</Th>
                <Th>{t('employees.baseSalary')}</Th>
                <Th>{t('employees.clientsCount')}</Th>
                <Th>{t('employees.broughtIn')}</Th>
                <Th>{t('employees.netPaid')}</Th>
                <Th className="w-px">{t('common.actions')}</Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => {
                const stat = stats.get(row.id)
                const deptName = deptMap.get(row.departmentId)
                const posName = posMap.get(row.positionId)

                return (
                  <tr key={row.id}>
                    <Td>
                      <span className="num font-mono text-xs font-semibold text-slate-600">
                        {row.employeeCode?.trim() || <span className="text-amber-600 font-sans">غير مُرقّم</span>}
                      </span>
                    </Td>
                    <Td>
                      <button
                        type="button"
                        onClick={() => setViewing(row)}
                        className="text-start font-semibold text-slate-800 hover:text-brand-600"
                      >
                        {row.name}
                      </button>
                    </Td>
                    <Td>
                      <span className="text-xs text-slate-600">
                        {deptName || posName ? `${deptName ?? '—'} / ${posName ?? '—'}` : '—'}
                      </span>
                    </Td>
                    <Td>
                      <span className="num text-slate-600">{row.phone || '—'}</span>
                    </Td>
                    <Td>
                      <StatusBadge status={row.status} archived={row.archived} />
                    </Td>
                    <Td>
                      <span className="num text-slate-700">{formatMoney(row.baseSalary || row.basicSalary || 0)}</span>
                    </Td>
                    <Td>
                      <span className="num font-semibold text-slate-800">{stat?.clients ?? 0}</span>
                    </Td>
                    <Td>
                      <span className="num font-semibold text-emerald-600">
                        {formatMoney(stat?.broughtIn ?? 0)}
                      </span>
                    </Td>
                    <Td>
                      <span className="num font-semibold text-rose-600">{formatMoney(stat?.netPaid ?? 0)}</span>
                    </Td>
                    <Td>
                      <div className="flex gap-1.5">
                        <button
                          type="button"
                          onClick={() => setViewing(row)}
                          className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-brand-700 hover:bg-brand-50"
                        >
                          {t('employees.ledger')}
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditing(row)}
                          className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100"
                        >
                          {t('common.edit')}
                        </button>
                        <button
                          type="button"
                          onClick={() => askDelete(row)}
                          className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50"
                        >
                          {t('common.delete')}
                        </button>
                      </div>
                    </Td>
                  </tr>
                )
              })}
            </tbody>
          </TableWrap>
        </>
      )}

      <EmployeeForm
        open={Boolean(editing)}
        row={editing}
        departments={departments}
        positions={positions}
        customEmployeeTypes={customEmployeeTypes}
        busy={busy}
        onClose={() => setEditing(null)}
        onSave={handleSave}
      />

      <DepartmentsModal
        open={showDeptsModal}
        departments={departments}
        onClose={() => setShowDeptsModal(false)}
      />

      <PositionsModal
        open={showPositionsModal}
        positions={positions}
        departments={departments}
        onClose={() => setShowPositionsModal(false)}
      />

      <EmployeeMigrationModal
        open={showMigrationModal}
        employees={rows}
        onClose={() => setShowMigrationModal(false)}
      />

      <EmployeeProfile
        jobCosts={jobCosts}
        open={Boolean(viewing)}
        employee={viewing}
        entries={entries.filter((entry) => entry.employeeId === viewing?.id)}
        clients={clients.filter((client) => client.employeeId === viewing?.id)}
        stat={stats.get(viewing?.id)}
        expenseCategories={expenseCategories}
        linkedExpenses={allExpenses.filter(
          (expense) => expense.target?.kind === 'employee' && expense.target.id === viewing?.id,
        )}
        invoices={invoices}
        locale={locale}
        onClose={() => setViewing(null)}
      />

      <ConfirmDialog
        open={Boolean(removing)}
        busy={busy}
        onClose={() => setRemoving(null)}
        onConfirm={handleDelete}
        title={t('common.deleteTitle')}
        message={t('common.deleteMsg', { name: removing?.name ?? '' })}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ */

function EmployeeForm({ open, row, departments = [], positions = [], customEmployeeTypes = [], busy, onClose, onSave }) {
  const { t } = useI18n()
  const [form, setForm] = useState({})
  const [touched, setTouched] = useState(false)
  const [showTypesModal, setShowTypesModal] = useState(false)

  const key = row?.id ?? 'new'
  const [lastKey, setLastKey] = useState(null)
  if (open && lastKey !== key) {
    setLastKey(key)
    setForm({
      employeeCode: row?.employeeCode ?? '',
      name: row?.name ?? '',
      phone: row?.phone ?? '',
      email: row?.email ?? '',
      address: row?.address ?? '',
      status: row?.status ?? (row?.archived ? 'archived' : 'active'),
      departmentId: row?.departmentId ?? '',
      positionId: row?.positionId ?? '',
      hireDate: row?.hireDate ?? '',
      userId: row?.userId ?? '',
      baseSalary: row?.baseSalary ?? '',
      commissionRate: row?.commissionRate ?? '',
      targetAmount: row?.targetAmount ?? '',
      requireTargetForCommission: Boolean(row?.requireTargetForCommission),
      overTargetCommissionEnabled: Boolean(row?.overTargetCommissionEnabled),
      overTargetCommissionRate: row?.overTargetCommissionRate ?? '',
      role: row?.role ?? 'sales',
      notes: row?.notes ?? '',
      targetBonusEnabled: Boolean(row?.targetBonus?.enabled),
      targetMetric: row?.targetBonus?.metric === 'value' ? 'value' : 'count',
      targetValue: row?.targetBonus?.target ?? '',
      bonusAmount: row?.targetBonus?.bonus ?? '',
    })
    setTouched(false)
  }
  if (!open && lastKey !== null) setLastKey(null)

  const set = (field, value) => setForm((current) => ({ ...current, [field]: value }))

  const filteredPositions = useMemo(() => {
    if (!form.departmentId) return positions
    return positions.filter((p) => !p.departmentId || p.departmentId === form.departmentId)
  }, [positions, form.departmentId])

  function submit() {
    setTouched(true)
    if (!form.name?.trim()) return
    onSave({
      employeeCode: form.employeeCode?.trim() ?? '',
      name: form.name.trim(),
      phone: form.phone?.trim() ?? '',
      email: form.email?.trim() ?? '',
      address: form.address?.trim() ?? '',
      status: form.status || 'active',
      departmentId: form.departmentId || null,
      positionId: form.positionId || null,
      hireDate: form.hireDate || null,
      userId: form.userId?.trim() || null,
      baseSalary: toNumber(form.baseSalary),
      commissionRate: toNumber(form.commissionRate),
      targetAmount: toNumber(form.targetAmount),
      requireTargetForCommission: Boolean(form.requireTargetForCommission),
      overTargetCommissionEnabled: Boolean(form.overTargetCommissionEnabled),
      overTargetCommissionRate: toNumber(form.overTargetCommissionRate),
      role: form.role || 'sales',
      notes: form.notes?.trim() ?? '',
      targetBonus: {
        enabled: Boolean(form.targetBonusEnabled),
        metric: form.targetMetric === 'value' ? 'value' : 'count',
        target: toNumber(form.targetValue),
        bonus: toNumber(form.bonusAmount),
      },
    })
  }

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        wide
        title={row?.id ? t('employees.edit') : t('employees.add')}
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button onClick={submit} disabled={busy}>
              {busy ? t('common.saving') : t('common.save')}
            </Button>
          </>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="كود الموظف" hint={!row?.id ? 'يُولد تلقائياً (EMP-000X) إذا تُرك فارغاً' : null}>
            <Input
              value={form.employeeCode ?? ''}
              onChange={(event) => set('employeeCode', event.target.value)}
              placeholder="تلقائي EMP-..."
            />
          </Field>

          <Field label={t('employees.name')} error={touched && !form.name?.trim() ? t('common.required') : null}>
            <Input value={form.name ?? ''} onChange={(event) => set('name', event.target.value)} />
          </Field>

          <Field label="الحالة التشغيلية">
            <Select value={form.status ?? 'active'} onChange={(event) => set('status', event.target.value)}>
              <option value="active">نشط (Active)</option>
              <option value="on_leave">في إجازة (On Leave)</option>
              <option value="suspended">موقوف (Suspended)</option>
              <option value="terminated">منتهي خدماته (Terminated)</option>
              <option value="archived">مؤرشف (Archived)</option>
            </Select>
          </Field>

          <Field label="القسم">
            <Select value={form.departmentId ?? ''} onChange={(event) => set('departmentId', event.target.value)}>
              <option value="">-- اختر القسم --</option>
              {departments.filter((d) => d.active !== false || d.id === form.departmentId).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} {d.code ? `(${d.code})` : ''}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="الوظيفة">
            <Select value={form.positionId ?? ''} onChange={(event) => set('positionId', event.target.value)}>
              <option value="">-- اختر الوظيفة --</option>
              {filteredPositions.filter((p) => p.active !== false || p.id === form.positionId).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} {p.code ? `(${p.code})` : ''}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="تاريخ التعيين">
            <Input type="date" value={form.hireDate ?? ''} onChange={(event) => set('hireDate', event.target.value)} />
          </Field>

          <Field label="معرف مستخدم النظام (User ID)" hint="اختياري: لربط الموظف بمستخدم تسجيل دخول">
            <Input value={form.userId ?? ''} onChange={(event) => set('userId', event.target.value)} placeholder="مثال: user_123" />
          </Field>

          <Field label={t('common.phone')}>
            <Input numeric value={form.phone ?? ''} onChange={(event) => set('phone', event.target.value)} />
          </Field>

          <Field label={`${t('common.email')} (${t('common.optional')})`}>
            <Input
              type="email"
              dir="ltr"
              value={form.email ?? ''}
              onChange={(event) => set('email', event.target.value)}
            />
          </Field>

          <Field label={t('employees.baseSalary')}>
            <Input numeric value={form.baseSalary ?? ''} onChange={(event) => set('baseSalary', event.target.value)} />
          </Field>

          <Field label={t('common.address')}>
            <Input value={form.address ?? ''} onChange={(event) => set('address', event.target.value)} />
          </Field>

          {/* قسم الشرايح والتارجت والعمولات */}
          <div className="rounded-2xl border border-sky-200 bg-sky-50/40 p-4 sm:col-span-2 space-y-4">
            <h4 className="text-sm font-bold text-sky-950 flex items-center gap-2">
              <span>🎯</span> {t('employees.commissionTierSummary')}
            </h4>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('employees.commissionRate')} hint={t('employees.commissionHint')}>
                <Input
                  numeric
                  value={form.commissionRate ?? ''}
                  onChange={(event) => set('commissionRate', event.target.value)}
                  placeholder="20"
                />
              </Field>
              <Field label={t('employees.targetAmount')} hint={t('employees.targetAmountHint')}>
                <Input
                  numeric
                  value={form.targetAmount ?? ''}
                  onChange={(event) => set('targetAmount', event.target.value)}
                  placeholder="50000"
                />
              </Field>
            </div>

            {toNumber(form.targetAmount) > 0 && (
              <div className="space-y-3 pt-3 border-t border-sky-200/60">
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={Boolean(form.requireTargetForCommission)}
                    onChange={(event) => set('requireTargetForCommission', event.target.checked)}
                    className="mt-0.5 h-4 w-4 accent-sky-600 rounded"
                  />
                  <span>
                    <span className="block text-sm font-semibold text-slate-800">{t('employees.requireTargetForCommission')}</span>
                    <span className="mt-0.5 block text-xs text-slate-500">{t('employees.requireTargetHint')}</span>
                  </span>
                </label>

                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={Boolean(form.overTargetCommissionEnabled)}
                    onChange={(event) => set('overTargetCommissionEnabled', event.target.checked)}
                    className="mt-0.5 h-4 w-4 accent-sky-600 rounded"
                  />
                  <span>
                    <span className="block text-sm font-semibold text-slate-800">{t('employees.overTargetEnable')}</span>
                    <span className="mt-0.5 block text-xs text-slate-500">{t('employees.overTargetHint')}</span>
                  </span>
                </label>

                {form.overTargetCommissionEnabled && (
                  <div className="pt-2 sm:w-1/2">
                    <Field label={t('employees.overTargetCommissionRate')}>
                      <Input
                        numeric
                        value={form.overTargetCommissionRate ?? ''}
                        onChange={(event) => set('overTargetCommissionRate', event.target.value)}
                        placeholder="10"
                      />
                    </Field>
                  </div>
                )}
              </div>
            )}
          </div>

          <Field label={`${t('common.notes')} (${t('common.optional')})`} className="sm:col-span-2">
            <Textarea value={form.notes ?? ''} onChange={(event) => set('notes', event.target.value)} />
          </Field>

          <div className="rounded-2xl border border-slate-200 p-4 sm:col-span-2">
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={Boolean(form.targetBonusEnabled)}
                onChange={(event) => set('targetBonusEnabled', event.target.checked)}
                className="mt-0.5 h-4 w-4 accent-brand-600"
              />
              <span>
                <span className="block text-sm font-semibold text-slate-700">{t('employees.targetBonusEnable')}</span>
                <span className="mt-0.5 block text-xs text-slate-500">{t('employees.targetBonusHint')}</span>
              </span>
            </label>

            {form.targetBonusEnabled && (
              <div className="mt-4 grid gap-4 sm:grid-cols-3">
                <Field label={t('employees.targetMetric')}>
                  <Select value={form.targetMetric} onChange={(event) => set('targetMetric', event.target.value)}>
                    <option value="count">{t('employees.targetMetric.count')}</option>
                    <option value="value">{t('employees.targetMetric.value')}</option>
                  </Select>
                </Field>
                <Field label={t('employees.targetValue')}>
                  <Input numeric value={form.targetValue ?? ''} onChange={(event) => set('targetValue', event.target.value)} />
                </Field>
                <Field label={t('employees.bonusAmount')}>
                  <Input numeric value={form.bonusAmount ?? ''} onChange={(event) => set('bonusAmount', event.target.value)} />
                </Field>
              </div>
            )}
          </div>
        </div>
      </Modal>

      <EmployeeTypesModal
        open={showTypesModal}
        types={customEmployeeTypes}
        onClose={() => setShowTypesModal(false)}
        onSelectType={(newTypeName) => {
          set('role', newTypeName)
        }}
      />
    </>
  )
}

/* ------------------------------------------------------------------ */

function EmployeeProfile({ open, employee, entries, clients, stat, expenseCategories, linkedExpenses = [], jobCosts = [], invoices = [], locale, onClose }) {
  const { t } = useI18n()
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState(null)
  const [selectedMonthReport, setSelectedMonthReport] = useState(null)

  if (!employee) return null

  const commission = employeeCommission(employee.id, jobCosts)
  const jobPay = employeeJobPay(employee.id, jobCosts)
  const bonusRows = targetBonusRows(employee, invoices)
  const bonusDue = bonusRows.reduce((sum, row) => sum + toNumber(row.earned), 0)
  const monthly = buildMonthlyStatement(entries, commission.rows, jobPay.rows, bonusRows)
  const tierBreakdowns = monthlyEmployeeTierBreakdowns(employee, invoices)

  async function toggleJobPayPaid(cost) {
    await updateDocById(JOB_COSTS_COL, cost.id, { paid: !cost.paid, paidDate: cost.paid ? null : todayISO() })
  }

  /* فئة «مرتبات» — تُنشأ تلقائيًا إذا لم تكن موجودة */
  async function salaryCategory() {
    const existing = expenseCategories.find((category) => category.system === 'salary')
    if (existing) return existing
    const created = await createDoc(COL.expenseCategories, {
      name: 'مرتبات',
      system: 'salary',
      archived: false,
    })
    return { id: created.id, name: 'مرتبات' }
  }

  /**
   * تسجيل الصرف الفعلي: ينشئ مصروف "مرتبات" ويربطه برقم سند صرف
   * متسلسل — لحظة الصرف الحقيقية، لا لحظة تسجيل الاستحقاق.
   */
  async function disburse(entryId, values) {
    const category = await salaryCategory()
    const voucherNumber = await nextNumber('payroll', 'PV')
    const expense = await createDoc(COL.expenses, {
      categoryId: category.id,
      categoryName: category.name,
      description: `${t(`employees.type.${values.type}`)} — ${employee.name} — ${voucherNumber}`,
      amount: signedAmount(values.type, values.amount),
      date: values.date,
      paidBy: '',
      source: 'employee',
      employeeId: employee.id,
    })
    await updateDocById(COL.employeeEntries, entryId, {
      paid: true,
      paidDate: todayISO(),
      voucherNumber,
      expenseId: expense.id,
    })
  }

  async function addEntry(values) {
    setBusy(true)
    const created = await createDoc(COL.employeeEntries, {
      employeeId: employee.id,
      employeeName: employee.name,
      type: values.type,
      amount: toNumber(values.amount),
      date: values.date,
      note: values.note,
      paid: false,
      paidDate: null,
      voucherNumber: null,
      expenseId: null,
    })

    if (values.paidNow) await disburse(created.id, values)

    setBusy(false)
    setAdding(false)
  }

  async function togglePaid(entry) {
    if (entry.paid) {
      /* التراجع عن الصرف: يشيل قيد المصروف المرتبط ويرجّع الحالة معلّقة */
      if (entry.expenseId) await deleteDocById(COL.expenses, entry.expenseId).catch(() => {})
      await updateDocById(COL.employeeEntries, entry.id, {
        paid: false,
        paidDate: null,
        voucherNumber: null,
        expenseId: null,
      })
    } else {
      await disburse(entry.id, entry)
    }
  }

  async function deleteEntry() {
    setBusy(true)
    if (removing.expenseId) await deleteDocById(COL.expenses, removing.expenseId).catch(() => {})
    await deleteDocById(COL.employeeEntries, removing.id)
    setBusy(false)
    setRemoving(null)
  }

  return (
    <>
      <Modal open={open} onClose={onClose} wide title={`${t('employees.profile')} — ${employee.name}`}>
        <div className="mb-6 grid gap-3 sm:grid-cols-4">
          <Tile label={t('employees.clientsCount')} value={stat?.clients ?? 0} plain />
          <Tile label={t('employees.closedClients')} value={stat?.closedClients?.size ?? 0} plain />
          <Tile label={t('employees.broughtIn')} value={stat?.broughtIn ?? 0} tone="text-emerald-600" />
          <Tile label={t('employees.netPaid')} value={stat?.netPaid ?? 0} tone="text-rose-600" />
        </div>

        {clients.length > 0 && (
          <div className="mb-6">
            <h4 className="mb-2 text-sm font-bold text-slate-900">{t('employees.clients')}</h4>
            <div className="flex flex-wrap gap-2">
              {clients.map((client) => (
                <Badge key={client.id} tone="sky">
                  {client.name}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {(employee.targetAmount > 0 || employee.overTargetCommissionEnabled || employee.commissionRate > 0) && (
          <div className="mb-6 rounded-2xl border border-sky-100 bg-sky-50/50 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <h4 className="text-sm font-bold text-sky-950 flex items-center gap-2">
                <span>🎯</span> {t('employees.commissionTierSummary')}
              </h4>
              <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-slate-600">
                <span>العمولة الأساسية: <strong className="text-sky-700">{employee.commissionRate || 0}%</strong></span>
                {employee.targetAmount > 0 && (
                  <>
                    <span>•</span>
                    <span>التارجت: <strong className="text-slate-800">{formatMoney(employee.targetAmount)}</strong></span>
                  </>
                )}
                {employee.overTargetCommissionEnabled && (
                  <>
                    <span>•</span>
                    <span>ما فوق التارجت: <strong className="text-emerald-700">{employee.overTargetCommissionRate || 0}%</strong></span>
                  </>
                )}
              </div>
            </div>

            {tierBreakdowns.length === 0 ? (
              <p className="text-xs text-slate-500">{t('employees.noEntries')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-sky-100 text-slate-500 text-start font-semibold">
                      <th className="py-2 pe-3 text-start">{t('employees.month')}</th>
                      <th className="py-2 px-3 text-start">{t('reports.sales')}</th>
                      <th className="py-2 px-3 text-start">{t('employees.targetStatus')}</th>
                      <th className="py-2 px-3 text-start">{t('employees.baseTierCommission')}</th>
                      {employee.overTargetCommissionEnabled && (
                        <th className="py-2 px-3 text-start">{t('employees.overTierCommission')}</th>
                      )}
                      <th className="py-2 ps-3 text-start">{t('employees.commission')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-sky-100/60">
                    {tierBreakdowns.map((row) => (
                      <tr key={row.month} className="hover:bg-sky-100/30">
                        <td className="py-2 pe-3 font-bold text-slate-800">{row.month}</td>
                        <td className="py-2 px-3 num font-semibold text-slate-700">{formatMoney(row.totalSales)}</td>
                        <td className="py-2 px-3">
                          <Badge tone={row.hitTarget ? 'green' : 'amber'}>
                            {row.hitTarget ? t('employees.targetHit') : t('employees.targetNotHit')}
                          </Badge>
                        </td>
                        <td className="py-2 px-3 num text-sky-700">
                          {formatMoney(row.baseCommission)} ({formatMoney(row.baseSales)} × {employee.commissionRate}%)
                        </td>
                        {employee.overTargetCommissionEnabled && (
                          <td className="py-2 px-3 num text-emerald-700">
                            {formatMoney(row.overCommission)} ({formatMoney(row.overSales)} × {employee.overTargetCommissionRate}%)
                          </td>
                        )}
                        <td className="py-2 ps-3 num font-extrabold text-sky-900">{formatMoney(row.totalCommission)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h4 className="text-sm font-bold text-slate-900">{t('employees.monthlyStatement')}</h4>
          {commission.count > 0 && (
            <span className="text-xs font-semibold text-slate-500">
              {t('employees.commissionDue')}:{' '}
              <span className="num font-bold text-amber-600">{formatMoney(commission.due)}</span>
            </span>
          )}
          {bonusDue > 0 && (
            <span className="text-xs font-semibold text-slate-500">
              {t('employees.targetBonus')}:{' '}
              <span className="num font-bold text-amber-600">{formatMoney(bonusDue)}</span>
            </span>
          )}
          <Button variant="soft" onClick={() => setAdding(true)}>
            + {t('employees.addEntry')}
          </Button>
        </div>

        {monthly.length === 0 ? (
          <p className="rounded-xl bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
            {t('employees.noEntries')}
          </p>
        ) : (
          <div className="mb-6 overflow-x-auto">
            <table className="w-full min-w-[940px] text-sm">
              <thead>
                <tr>
                  <Th>{t('employees.month')}</Th>
                  <Th>{t('employees.type.salary')}</Th>
                  <Th>{t('employees.type.bonus')}</Th>
                  <Th>{t('employees.type.deduction')}</Th>
                  <Th>{t('employees.commission')}</Th>
                  <Th>{t('employees.jobPay')}</Th>
                  <Th>{t('employees.targetBonus')}</Th>
                  <Th>{t('common.total')}</Th>
                  <Th>{t('common.status')}</Th>
                  <Th className="w-px" />
                </tr>
              </thead>
              <tbody>
                {monthly.map((row) => (
                  <tr key={row.month}>
                    <Td>
                      <span className="num font-bold text-slate-800">{row.month}</span>
                    </Td>
                    <Td>
                      <span className="num text-slate-700">{row.salary ? formatMoney(row.salary) : '—'}</span>
                    </Td>
                    <Td>
                      <span className="num text-emerald-600">{row.bonus ? formatMoney(row.bonus) : '—'}</span>
                    </Td>
                    <Td>
                      <span className="num text-rose-600">{row.deduction ? `−${formatMoney(row.deduction)}` : '—'}</span>
                    </Td>
                    <Td>
                      <span className="num text-sky-600">{row.commission ? formatMoney(row.commission) : '—'}</span>
                    </Td>
                    <Td>
                      <span className="num text-brand-600">{row.jobPay ? formatMoney(row.jobPay) : '—'}</span>
                    </Td>
                    <Td>
                      <span className="num text-amber-600">{row.targetBonus ? formatMoney(row.targetBonus) : '—'}</span>
                    </Td>
                    <Td>
                      <span className="num font-extrabold text-slate-900">{formatMoney(row.net)}</span>
                    </Td>
                    <Td>
                      {row.due > 0.01 ? (
                        <Badge tone="amber">
                          {t('employees.dueAmount', { amount: formatMoney(row.due) })}
                        </Badge>
                      ) : (
                        <Badge tone="green">{t('employees.fullyPaid')}</Badge>
                      )}
                    </Td>
                    <Td>
                      <button
                        type="button"
                        onClick={() => setSelectedMonthReport(row.month)}
                        className="inline-flex items-center gap-1 whitespace-nowrap rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-bold text-slate-700 hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 transition"
                        title="عرض تقرير وتفاصيل كشف حساب الشهر بالكامل"
                      >
                        <span>📄</span> التقرير المفصّل
                      </button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {jobPay.rows.length > 0 && (
          <div className="mb-6">
            <h4 className="mb-2 text-sm font-bold text-slate-900">{t('employees.extraJobs')}</h4>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr>
                    <Th>{t('common.date')}</Th>
                    <Th>{t('common.type')}</Th>
                    <Th>{t('common.description')}</Th>
                    <Th>{t('common.amount')}</Th>
                    <Th>{t('common.status')}</Th>
                  </tr>
                </thead>
                <tbody>
                  {jobPay.rows.map((cost) => (
                    <tr key={cost.id}>
                      <Td className="whitespace-nowrap text-slate-600">{formatDate(cost.date, locale)}</Td>
                      <Td>
                        <Badge tone="brand">{vendorTypeLabel(cost.type, t)}</Badge>
                      </Td>
                      <Td className="text-slate-700">{cost.description || '—'}</Td>
                      <Td>
                        <span className="num font-bold text-slate-800">{formatMoney(cost.amount)}</span>
                      </Td>
                      <Td>
                        <button type="button" onClick={() => toggleJobPayPaid(cost)}>
                          <Badge tone={cost.paid ? 'green' : 'amber'}>
                            {cost.paid ? t('vendors.settled') : t('vendors.unpaid')}
                          </Badge>
                        </button>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {linkedExpenses.length > 0 && (
          <div className="mb-6">
            <h4 className="mb-2 text-sm font-bold text-slate-900">{t('vendors.linkedExpenses')}</h4>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-sm">
                <thead>
                  <tr>
                    <Th>{t('common.date')}</Th>
                    <Th>{t('expenses.category')}</Th>
                    <Th>{t('common.description')}</Th>
                    <Th>{t('common.amount')}</Th>
                  </tr>
                </thead>
                <tbody>
                  {linkedExpenses.map((expense) => (
                    <tr key={expense.id}>
                      <Td className="whitespace-nowrap text-slate-600">{formatDate(expense.date, locale)}</Td>
                      <Td>
                        <Badge tone="brand">{expense.categoryName || '—'}</Badge>
                      </Td>
                      <Td className="text-slate-700">{expense.description || '—'}</Td>
                      <Td>
                        <span className="num font-bold text-rose-600">{formatMoney(expense.amount)}</span>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <h4 className="mb-2 text-sm font-bold text-slate-900">{t('employees.movements')}</h4>

        {entries.length === 0 ? (
          <p className="rounded-xl bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
            {t('employees.noEntries')}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[600px] text-sm">
              <thead>
                <tr>
                  <Th>{t('common.date')}</Th>
                  <Th>{t('employees.entryType')}</Th>
                  <Th>{t('common.amount')}</Th>
                  <Th>{t('employees.voucherNumber')}</Th>
                  <Th>{t('common.status')}</Th>
                  <Th className="w-px" />
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <Td className="whitespace-nowrap text-slate-600">{formatDate(entry.date, locale)}</Td>
                    <Td>
                      <Badge
                        tone={
                          entry.type === 'deduction'
                            ? 'red'
                            : entry.type === 'salary'
                              ? 'slate'
                              : entry.type === 'commission'
                                ? 'sky'
                                : 'green'
                        }
                      >
                        {t(`employees.type.${entry.type}`)}
                      </Badge>
                      {entry.note && <span className="ms-2 text-xs text-slate-400">{entry.note}</span>}
                    </Td>
                    <Td>
                      <span
                        className={`num font-bold ${
                          entry.type === 'deduction' ? 'text-rose-600' : 'text-slate-800'
                        }`}
                      >
                        {entry.type === 'deduction' ? '−' : ''}
                        {formatMoney(entry.amount)}
                      </span>
                    </Td>
                    <Td>
                      <span className="num text-xs font-bold text-slate-500">{entry.voucherNumber || '—'}</span>
                    </Td>
                    <Td>
                      <button type="button" onClick={() => togglePaid(entry)}>
                        <Badge tone={entry.paid ? 'green' : 'amber'}>
                          {entry.paid ? t('employees.disbursed') : t('employees.pending')}
                        </Badge>
                      </button>
                    </Td>
                    <Td>
                      <button
                        type="button"
                        onClick={() => setRemoving(entry)}
                        className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50"
                      >
                        {t('common.delete')}
                      </button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Modal>

      <EntryForm
        open={adding}
        busy={busy}
        defaultSalary={employee.baseSalary}
        onClose={() => setAdding(false)}
        onSave={addEntry}
      />

      <ConfirmDialog
        open={Boolean(removing)}
        busy={busy}
        onClose={() => setRemoving(null)}
        onConfirm={deleteEntry}
        title={t('common.deleteTitle')}
        message={t('common.deleteMsg', { name: removing ? t(`employees.type.${removing.type}`) : '' })}
      />

      <EmployeeDetailedMonthReportModal
        open={Boolean(selectedMonthReport)}
        employee={employee}
        month={selectedMonthReport}
        entries={entries}
        jobCosts={jobCosts}
        invoices={invoices}
        locale={locale}
        onClose={() => setSelectedMonthReport(null)}
      />
    </>
  )
}

function EmployeeDetailedMonthReportModal({ open, employee, month, entries, jobCosts, invoices, locale, onClose }) {
  const { t } = useI18n()
  const [printing, setPrinting] = useState(false)

  const report = useMemo(() => {
    if (!open || !employee || !month) return null
    return buildDetailedEmployeeMonthReport({ employee, month, entries, jobCosts, invoices })
  }, [open, employee, month, entries, jobCosts, invoices])

  if (!open || !report) return null

  function handlePrint() {
    setPrinting(true)
    setTimeout(() => {
      window.print()
      setPrinting(false)
    }, 150)
  }

  return (
    <>
      <Modal open={open} onClose={onClose} wide title={`تقرير كشف حساب الموظف الشامل — ${employee.name} (${month})`}>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 bg-slate-50 p-3 rounded-xl border border-slate-200">
          <div>
            <span className="text-xs text-slate-500 block">فترة التقرير</span>
            <span className="num text-base font-black text-slate-900">{month}</span>
          </div>
          <div className="flex gap-2">
            <Button variant="soft" onClick={handlePrint}>
              🖨️ طباعة تقرير كشف الحساب
            </Button>
            <Button variant="ghost" onClick={onClose}>
              إغلاق
            </Button>
          </div>
        </div>

        {/* 1. ملخص المستحقات والاستقطاعات والصافي */}
        <div className="mb-6 grid gap-3 sm:grid-cols-3">
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50/50 p-4">
            <span className="text-xs font-bold text-emerald-800 uppercase block mb-1">إجمالي المستحقات (Gross Entitlements)</span>
            <span className="num text-2xl font-black text-emerald-700">{formatMoney(report.grossEntitlements)}</span>
            <div className="mt-2 space-y-1 text-xs text-slate-600 border-t border-emerald-200/60 pt-2">
              <div className="flex justify-between"><span>المرتب الأساسي:</span><strong className="num">{formatMoney(report.salaryTotal)}</strong></div>
              <div className="flex justify-between"><span>البونص والزيادات:</span><strong className="num">{formatMoney(report.bonusTotal + report.raiseTotal)}</strong></div>
              <div className="flex justify-between"><span>عمولات المبيعات:</span><strong className="num text-sky-700">{formatMoney(report.commissionTotal)}</strong></div>
              <div className="flex justify-between"><span>أجر أعمال إضافية:</span><strong className="num text-brand-700">{formatMoney(report.jobPayTotal)}</strong></div>
              {report.targetBonusTotal > 0 && (
                <div className="flex justify-between"><span>بونص التارجت:</span><strong className="num text-amber-700">{formatMoney(report.targetBonusTotal)}</strong></div>
              )}
            </div>
          </div>

          <div className="rounded-2xl border border-rose-200 bg-rose-50/50 p-4">
            <span className="text-xs font-bold text-rose-800 uppercase block mb-1">إجمالي الخصومات والمسحوبات</span>
            <span className="num text-2xl font-black text-rose-700">{formatMoney(report.deductionTotal + report.totalPaid)}</span>
            <div className="mt-2 space-y-1 text-xs text-slate-600 border-t border-rose-200/60 pt-2">
              <div className="flex justify-between"><span>الخصومات والتأخيرات:</span><strong className="num text-rose-700">−{formatMoney(report.deductionTotal)}</strong></div>
              <div className="flex justify-between"><span>المصروف فعليًا (سندات الصرف):</span><strong className="num text-rose-700">{formatMoney(report.totalPaid)}</strong></div>
            </div>
          </div>

          <div className="rounded-2xl border border-sky-200 bg-sky-50/60 p-4">
            <span className="text-xs font-bold text-sky-900 uppercase block mb-1">الرصيد المتبقي المستحق للموظف</span>
            <span className={`num text-2xl font-black ${report.dueBalance > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>
              {formatMoney(report.dueBalance)}
            </span>
            <div className="mt-2 space-y-1 text-xs text-slate-600 border-t border-sky-200/60 pt-2">
              <div className="flex justify-between"><span>حالة الشهر:</span>
                <Badge tone={report.dueBalance <= 0.01 ? 'green' : 'amber'}>
                  {report.dueBalance <= 0.01 ? 'خالص بالكامل' : `مستحق له ${formatMoney(report.dueBalance)}`}
                </Badge>
              </div>
              <div className="flex justify-between"><span>مبيعات الشهر:</span><strong className="num text-slate-800">{formatMoney(report.totalSales)} ({report.salesCount} فاتورة)</strong></div>
            </div>
          </div>
        </div>

        {/* 2. تحليل الشرايح والعمولات لشهر التقرير */}
        {(employee.targetAmount > 0 || employee.commissionRate > 0) && (
          <div className="mb-6 rounded-2xl border border-slate-200 bg-white p-4">
            <h4 className="text-sm font-bold text-slate-900 mb-2">🎯 ملخص تارجت وشرايح عمولات الشهر ({month})</h4>
            <div className="grid gap-3 sm:grid-cols-4 text-xs">
              <div className="rounded-xl bg-slate-50 p-2.5">
                <span className="text-slate-500 block">المبيعات المحققة</span>
                <span className="num font-bold text-slate-900">{formatMoney(report.totalSales)}</span>
              </div>
              <div className="rounded-xl bg-slate-50 p-2.5">
                <span className="text-slate-500 block">التارجت المستهدف</span>
                <span className="num font-bold text-slate-900">{formatMoney(employee.targetAmount || 0)}</span>
              </div>
              <div className="rounded-xl bg-slate-50 p-2.5">
                <span className="text-slate-500 block">عمولة التارجت ({employee.commissionRate}%)</span>
                <span className="num font-bold text-sky-700">{formatMoney(report.tierCalc.baseCommission)}</span>
              </div>
              {employee.overTargetCommissionEnabled && (
                <div className="rounded-xl bg-slate-50 p-2.5">
                  <span className="text-slate-500 block">عمولة ما فوق التارجت ({employee.overTargetCommissionRate}%)</span>
                  <span className="num font-bold text-emerald-700">{formatMoney(report.tierCalc.overCommission)}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* 2.5 إجراءات المحاسبة والترحيل لـ GL */}
        <div className="mb-6 rounded-2xl border border-indigo-200 bg-indigo-50/50 p-4">
          <h4 className="text-sm font-bold text-indigo-950 mb-2 flex items-center justify-between">
            <span>🏛️ قيود اليومية وتأكيد الترحيل لـ GL ({month})</span>
            {postingState.busy && <span className="text-xs text-indigo-700 font-normal">جاري المعالجة...</span>}
          </h4>
          {postingState.msg && (
            <div className="mb-3 rounded-xl bg-emerald-100 p-2.5 text-xs font-bold text-emerald-800 border border-emerald-300">
              ✓ {postingState.msg}
            </div>
          )}
          {postingState.err && (
            <div className="mb-3 rounded-xl bg-rose-100 p-2.5 text-xs font-bold text-rose-800 border border-rose-300">
              ✖ {postingState.err}
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-3 text-xs">
            {/* المرتب */}
            <div className="rounded-xl bg-white p-3 border border-indigo-100 shadow-2xs">
              <span className="font-bold block text-slate-800 mb-1">استحقاق المرتب الشهري</span>
              <span className="num font-bold block text-slate-600 mb-2">
                {formatMoney(report.salaryTotal > 0 ? report.salaryTotal : (employee.baseSalary || 0))}
              </span>
              {(() => {
                const [y, m] = month.split('-')
                const detId = `emp_salary_${employee.id}_${y}_${m}`
                const isPosted = accountingTxs.some((tx) => tx.id === detId)
                if (isPosted) {
                  return <Badge tone="green">مُرَحَّل لـ GL (Dr 5201 / Cr 210201)</Badge>
                }
                return (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={postingState.busy || (report.salaryTotal <= 0 && (!employee.baseSalary || employee.baseSalary <= 0))}
                    onClick={() => handlePostSalary(employee, report)}
                  >
                    رحّل المرتب لـ GL
                  </Button>
                )
              })()}
            </div>

            {/* العمولات */}
            <div className="rounded-xl bg-white p-3 border border-indigo-100 shadow-2xs">
              <span className="font-bold block text-slate-800 mb-1">عمولات مبيعات الشهر</span>
              <span className="num font-bold block text-slate-600 mb-2">{formatMoney(report.commissionTotal)}</span>
              {(() => {
                const monthCommissionCosts = report.commissionRows || []
                const unpostedCosts = monthCommissionCosts.filter(
                  (c) => !accountingTxs.some((tx) => tx.id === `jobCosts_${c.id}`),
                )
                if (monthCommissionCosts.length > 0 && unpostedCosts.length === 0) {
                  return <Badge tone="green">كل العمولات مُرَحَّلة لـ GL</Badge>
                }
                if (monthCommissionCosts.length === 0) {
                  return <span className="text-slate-400 text-[11px]">لا توجد عمولات هذا الشهر</span>
                }
                return (
                  <div className="space-y-1.5">
                    {unpostedCosts.map((c) => (
                      <Button
                        key={c.id}
                        size="sm"
                        variant="secondary"
                        disabled={postingState.busy}
                        onClick={() => handlePostCommission(c, employee)}
                      >
                        رحّل عمولة ({formatMoney(c.amount)})
                      </Button>
                    ))}
                  </div>
                )
              })()}
            </div>

            {/* السلفة */}
            <div className="rounded-xl bg-white p-3 border border-indigo-100 shadow-2xs">
              <span className="font-bold block text-slate-800 mb-1">خصومات / تسوية السلفة</span>
              <span className="num font-bold block text-slate-600 mb-2">{formatMoney(report.deductionTotal)}</span>
              {(() => {
                const [y, m] = month.split('-')
                const detId = `emp_advance_rec_${employee.id}_${y}_${m}`
                const isPosted = accountingTxs.some((tx) => tx.id === detId)
                if (isPosted) {
                  return <Badge tone="green">تسوية السلفة مُرَحَّلة (Dr 210201 / Cr 110203)</Badge>
                }
                return (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={postingState.busy || report.deductionTotal <= 0}
                    onClick={() => handlePostAdvanceRecovery(employee, report)}
                  >
                    رحّل استقطاع السلفة لـ GL
                  </Button>
                )
              })()}
            </div>
          </div>
        </div>

        {/* 3. سجل الحركات والقيود التفصيلي للشهر */}
        <h4 className="text-sm font-bold text-slate-900 mb-2">📋 سجل الحركات والقيود التفصيلي للشهر ({report.movementRows.length} حركة)</h4>
        {report.movementRows.length === 0 ? (
          <p className="text-xs text-slate-500 bg-slate-50 p-4 rounded-xl text-center">لا توجد حركات مسجلة لهذا الشهر.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-100 border-b border-slate-200 text-slate-700">
                  <Th className="py-2.5">التاريخ</Th>
                  <Th className="py-2.5">المرجع / الرقم</Th>
                  <Th className="py-2.5">نوع الحركة</Th>
                  <Th className="py-2.5">البيان والتفاصيل</Th>
                  <Th className="py-2.5 text-emerald-700">المستحق (+)</Th>
                  <Th className="py-2.5 text-rose-700">الخصم (-)</Th>
                  <Th className="py-2.5 text-slate-900">المدفوع / المصروف</Th>
                  <Th className="py-2.5">الحالة</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {report.movementRows.map((row) => (
                  <tr key={row.id} className="hover:bg-slate-50">
                    <Td className="whitespace-nowrap text-slate-600">{formatDate(row.date, locale)}</Td>
                    <Td><span className="num font-bold text-slate-700">{row.ref}</span></Td>
                    <Td>
                      <Badge
                        tone={
                          row.type === 'deduction'
                            ? 'red'
                            : row.type === 'salary'
                              ? 'slate'
                              : row.type === 'commission'
                                ? 'sky'
                                : row.type === 'bonus' || row.type === 'raise'
                                  ? 'green'
                                  : 'brand'
                        }
                      >
                        {row.type === 'commission'
                          ? 'عمولة مبيعات'
                          : row.type === 'jobPay'
                            ? 'أجر شغلانة'
                            : t(`employees.type.${row.type}`) || row.type}
                      </Badge>
                    </Td>
                    <Td className="text-slate-800">{row.description}</Td>
                    <Td className="num font-semibold text-emerald-700">{row.earned ? formatMoney(row.earned) : '—'}</Td>
                    <Td className="num font-semibold text-rose-700">{row.deduction ? `−${formatMoney(row.deduction)}` : '—'}</Td>
                    <Td className="num font-bold text-slate-900">{row.paid ? formatMoney(row.paid) : '—'}</Td>
                    <Td>
                      <Badge tone={row.paidStatus ? 'green' : 'amber'}>
                        {row.paidStatus ? 'صُرف' : 'معلّق / مستحق'}
                      </Badge>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Modal>

      {/* سند الطباعة المباشرة الرسمي */}
      {printing && (
        <PrintDocument>
          <div className="p-6 dir-rtl text-slate-900 font-sans">
            <ReportPrintHeader
              title={`كشف حساب موظف تفصيلي — ${employee.name}`}
              subtitle={`فترة كشف الحساب: ${month}`}
            />

            <div className="my-4 grid grid-cols-2 gap-4 text-xs border border-slate-300 p-3 rounded-lg bg-slate-50">
              <div>
                <p><strong>اسم الموظف:</strong> {employee.name}</p>
                <p><strong>الوظيفة:</strong> {posMap.get(employee.positionId) || '—'}</p>
                <p><strong>المرتب الأساسي:</strong> {formatMoney(employee.baseSalary)}</p>
              </div>
              <div>
                <p><strong>الهاتف:</strong> {employee.phone || '—'}</p>
                <p><strong>تارجت المبيعات:</strong> {employee.targetAmount ? formatMoney(employee.targetAmount) : 'غير محدد'}</p>
                <p><strong>نسبة العمولة:</strong> {employee.commissionRate || 0}% {employee.overTargetCommissionEnabled ? `/ ما فوق التارجت ${employee.overTargetCommissionRate}%` : ''}</p>
              </div>
            </div>

            <div className="my-4 border border-slate-400 p-3 rounded-lg">
              <h3 className="font-bold text-sm mb-2 border-b border-slate-300 pb-1">ملخص المستحقات والمنصرفات لشهر {month}</h3>
              <table className="w-full text-xs text-start">
                <tbody>
                  <tr>
                    <td className="py-1">إجمالي المستحقات (مرتب + عمولات + بونص + أعمال):</td>
                    <td className="py-1 num font-bold text-end">{formatMoney(report.grossEntitlements)}</td>
                  </tr>
                  <tr>
                    <td className="py-1">إجمالي الخصومات والتأخيرات:</td>
                    <td className="py-1 num font-bold text-rose-700 text-end">−{formatMoney(report.deductionTotal)}</td>
                  </tr>
                  <tr>
                    <td className="py-1">إجمالي الصرف الفعلي (المدفوع بالسندات):</td>
                    <td className="py-1 num font-bold text-end">{formatMoney(report.totalPaid)}</td>
                  </tr>
                  <tr className="border-t border-slate-400 font-black">
                    <td className="py-2 text-sm">الرصيد المتبقي المستحق للموظف:</td>
                    <td className="py-2 text-sm num text-end">{formatMoney(report.dueBalance)}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <h3 className="font-bold text-xs mb-2">تفاصيل سجل الحركات لشهـر {month}</h3>
            <table className="w-full text-xs border border-slate-300 border-collapse">
              <thead>
                <tr className="bg-slate-200 text-slate-900 border-b border-slate-300">
                  <th className="p-1.5 border-e text-start">التاريخ</th>
                  <th className="p-1.5 border-e text-start">المرجع</th>
                  <th className="p-1.5 border-e text-start">نوع الحركة</th>
                  <th className="p-1.5 border-e text-start">البيان</th>
                  <th className="p-1.5 border-e text-end">المستحق</th>
                  <th className="p-1.5 border-e text-end">الخصم</th>
                  <th className="p-1.5 text-end">المدفوع</th>
                </tr>
              </thead>
              <tbody>
                {report.movementRows.map((r) => (
                  <tr key={r.id} className="border-b border-slate-200">
                    <td className="p-1.5 border-e whitespace-nowrap">{formatDate(r.date, locale)}</td>
                    <td className="p-1.5 border-e num font-bold">{r.ref}</td>
                    <td className="p-1.5 border-e">{r.type === 'commission' ? 'عمولة' : r.type}</td>
                    <td className="p-1.5 border-e">{r.description}</td>
                    <td className="p-1.5 border-e num text-end">{r.earned ? formatMoney(r.earned) : '—'}</td>
                    <td className="p-1.5 border-e num text-end">{r.deduction ? formatMoney(r.deduction) : '—'}</td>
                    <td className="p-1.5 num text-end">{r.paid ? formatMoney(r.paid) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="mt-12 grid grid-cols-2 text-center text-xs font-bold pt-8 border-t border-slate-300">
              <div>
                <p>توقيع المحاسب المسؤول / الإدارة</p>
                <p className="mt-8 text-slate-400">...................................................</p>
              </div>
              <div>
                <p>توقيع الموظف بالاستلام والتصفية</p>
                <p className="mt-8 text-slate-400">...................................................</p>
              </div>
            </div>
          </div>
        </PrintDocument>
      )}
    </>
  )
}

function EntryForm({ open, busy, defaultSalary, onClose, onSave }) {
  const { t } = useI18n()
  const [type, setType] = useState('salary')
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(todayISO())
  const [note, setNote] = useState('')
  const [paidNow, setPaidNow] = useState(true)
  const [touched, setTouched] = useState(false)

  const [wasOpen, setWasOpen] = useState(false)
  if (open && !wasOpen) {
    setWasOpen(true)
    setType('salary')
    setAmount(defaultSalary ? String(defaultSalary) : '')
    setDate(todayISO())
    setNote('')
    setPaidNow(true)
    setTouched(false)
  }
  if (!open && wasOpen) setWasOpen(false)

  function submit() {
    setTouched(true)
    if (toNumber(amount) <= 0) return
    onSave({ type, amount, date, note: note.trim(), paidNow })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('employees.addEntry')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? t('common.saving') : t('common.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t('employees.entryType')}>
          <Select value={type} onChange={(event) => setType(event.target.value)}>
            {ENTRY_TYPES.map((item) => (
              <option key={item} value={item}>
                {t(`employees.type.${item}`)}
              </option>
            ))}
          </Select>
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={t('common.amount')}
            error={touched && toNumber(amount) <= 0 ? t('common.required') : null}
          >
            <Input numeric value={amount} onChange={(event) => setAmount(event.target.value)} />
          </Field>

          <Field label={t('common.date')}>
            <Input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </Field>
        </div>

        <Field label={`${t('common.notes')} (${t('common.optional')})`}>
          <Input value={note} onChange={(event) => setNote(event.target.value)} />
        </Field>

        <label className="flex items-start gap-3 rounded-xl border border-slate-200 px-4 py-3">
          <input
            type="checkbox"
            checked={paidNow}
            onChange={(event) => setPaidNow(event.target.checked)}
            className="mt-0.5 h-4 w-4 accent-brand-600"
          />
          <span>
            <span className="block text-sm font-semibold text-slate-700">{t('employees.paidNow')}</span>
            <span className="mt-0.5 block text-xs text-slate-500">{t('employees.paidNowHint')}</span>
          </span>
        </label>
      </div>
    </Modal>
  )
}

function Tile({ label, value, tone = 'text-slate-900', plain = false }) {
  const { t } = useI18n()
  return (
    <div className="rounded-2xl bg-slate-50 px-4 py-3">
      <p className="text-xs font-semibold text-slate-500">{label}</p>
      <p className={`mt-1 text-lg font-extrabold ${tone}`}>
        <span className="num">{plain ? value : formatMoney(value)}</span>
        {!plain && <span className="ms-1 text-xs font-semibold text-slate-400">{t('common.currency')}</span>}
      </p>
    </div>
  )
}

function EmployeeTypesModal({ open, types = [], onClose, onSelectType }) {
  const { t } = useI18n()
  const [name, setName] = useState('')
  const [editingItem, setEditingItem] = useState(null)
  const [editingName, setEditingName] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleAdd() {
    if (!name.trim()) return
    setBusy(true)
    try {
      const created = await createDoc(COL.employeeTypes, { name: name.trim() })
      if (onSelectType && created?.id) {
        onSelectType(name.trim())
      }
      setName('')
    } catch (err) {
      console.error('Error creating employee type:', err)
    } finally {
      setBusy(false)
    }
  }

  async function handleSaveEdit() {
    if (!editingItem || !editingName.trim()) return
    setBusy(true)
    try {
      await updateDocById(COL.employeeTypes, editingItem.id, { name: editingName.trim() })
      if (onSelectType) {
        onSelectType(editingName.trim())
      }
      setEditingItem(null)
      setEditingName('')
    } catch (err) {
      console.error('Error updating employee type:', err)
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete(typeId) {
    setBusy(true)
    try {
      await deleteDocById(COL.employeeTypes, typeId)
    } catch (err) {
      console.error('Error deleting employee type:', err)
    } finally {
      setBusy(false)
    }
  }

  async function seedDefaults() {
    setBusy(true)
    const defaults = ['تصوير ومونتاج', 'تصميم جرافيك', 'إدارة حملات', 'ميديا باير', 'مستشار']
    try {
      for (const d of defaults) {
        if (!types.some((item) => item.name === d)) {
          await createDoc(COL.employeeTypes, { name: d })
        }
      }
    } catch (err) {
      console.error('Error seeding employee types:', err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={t('employees.manageRoles')}>
      <div className="space-y-4">
        <div className="flex gap-2">
          <Input
            placeholder={t('employees.roleName')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                handleAdd()
              }
            }}
          />
          <Button onClick={handleAdd} disabled={busy || !name.trim()}>
            + {t('employees.addRole')}
          </Button>
        </div>

        <div className="divide-y divide-slate-100 rounded-2xl border border-slate-200">
          {types.length === 0 ? (
            <div className="p-4 text-center text-sm text-slate-500">
              لا توجد أنواع موظفين مخصصة بعد.
              <div className="mt-2">
                <Button variant="ghost" onClick={seedDefaults} disabled={busy}>
                  إضافة اقتراحات افتراضية (تصوير، تصميم، إلخ)
                </Button>
              </div>
            </div>
          ) : (
            types.map((typeItem) => (
              <div key={typeItem.id} className="flex items-center justify-between p-3 text-sm">
                {editingItem?.id === typeItem.id ? (
                  <div className="flex w-full items-center gap-2">
                    <Input
                      value={editingName}
                      onChange={(e) => setEditingName(e.target.value)}
                      className="py-1"
                    />
                    <Button variant="soft" onClick={handleSaveEdit} disabled={busy}>
                      {t('common.save')}
                    </Button>
                    <Button variant="ghost" onClick={() => setEditingItem(null)}>
                      {t('common.cancel')}
                    </Button>
                  </div>
                ) : (
                  <>
                    <span className="font-semibold text-slate-800">{typeItem.name}</span>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          setEditingItem(typeItem)
                          setEditingName(typeItem.name)
                        }}
                        className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100"
                      >
                        {t('common.edit')}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(typeItem.id)}
                        className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50"
                      >
                        {t('common.delete')}
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </Modal>
  )
}

/* ------------------------------------------------------------------ */
/*  مودال إدارة الأقسام (Departments Modal)                           */
/* ------------------------------------------------------------------ */

function DepartmentsModal({ open, departments = [], onClose }) {
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [description, setDescription] = useState('')
  const [editingId, setEditingId] = useState(null)
  const [busy, setBusy] = useState(false)

  async function handleSave() {
    if (!name.trim()) return
    setBusy(true)
    try {
      if (editingId) {
        await updateDepartment(editingId, { name, code, description })
      } else {
        await createDepartment({ name, code, description })
      }
      setName('')
      setCode('')
      setDescription('')
      setEditingId(null)
    } finally {
      setBusy(false)
    }
  }

  function startEdit(dept) {
    setEditingId(dept.id)
    setName(dept.name)
    setCode(dept.code || '')
    setDescription(dept.description || '')
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title="إدارة الأقسام (Departments)"
      footer={
        <Button variant="ghost" onClick={onClose}>
          إغلاق
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Input placeholder="اسم القسم (مثال: المبيعات)" value={name} onChange={(e) => setName(e.target.value)} />
          <Input placeholder="كود القسم (مثال: SAL)" value={code} onChange={(e) => setCode(e.target.value)} />
          <Button onClick={handleSave} disabled={busy || !name.trim()}>
            {editingId ? 'تحديث القسم' : '+ إضافة قسم'}
          </Button>
        </div>

        <div className="divide-y divide-slate-100 rounded-2xl border border-slate-200">
          {departments.length === 0 ? (
            <div className="p-4 text-center text-sm text-slate-500">لا توجد أقسام مسجلة بعد.</div>
          ) : (
            departments.map((dept) => (
              <div key={dept.id} className="flex items-center justify-between p-3 text-sm">
                <div>
                  <span className="font-bold text-slate-800">{dept.name}</span>
                  {dept.code && <span className="ms-2 font-mono text-xs text-slate-500">({dept.code})</span>}
                  {dept.active === false && <Badge variant="neutral" className="ms-2">معطّل</Badge>}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setDepartmentActive(dept.id, dept.active === false)}
                    className="text-xs text-slate-600 hover:text-brand-600 font-semibold"
                  >
                    {dept.active === false ? 'تفعيل' : 'تعطيل'}
                  </button>
                  <button
                    type="button"
                    onClick={() => startEdit(dept)}
                    className="text-xs text-brand-700 font-semibold hover:underline"
                  >
                    تعديل
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </Modal>
  )
}

/* ------------------------------------------------------------------ */
/*  مودال إدارة الوظائف (Positions Modal)                             */
/* ------------------------------------------------------------------ */

function PositionsModal({ open, positions = [], departments = [], onClose }) {
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [departmentId, setDepartmentId] = useState('')
  const [editingId, setEditingId] = useState(null)
  const [busy, setBusy] = useState(false)

  const deptMap = useMemo(() => new Map(departments.map((d) => [d.id, d.name])), [departments])

  async function handleSave() {
    if (!name.trim()) return
    setBusy(true)
    try {
      if (editingId) {
        await updatePosition(editingId, { name, code, departmentId })
      } else {
        await createPosition({ name, code, departmentId })
      }
      setName('')
      setCode('')
      setDepartmentId('')
      setEditingId(null)
    } finally {
      setBusy(false)
    }
  }

  function startEdit(pos) {
    setEditingId(pos.id)
    setName(pos.name)
    setCode(pos.code || '')
    setDepartmentId(pos.departmentId || '')
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title="إدارة الوظائف والمسميات (Positions)"
      footer={
        <Button variant="ghost" onClick={onClose}>
          إغلاق
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-4">
          <Input placeholder="المسمى الوظيفي (مثال: محرر فيديو)" value={name} onChange={(e) => setName(e.target.value)} />
          <Input placeholder="كود الوظيفة (مثال: VID-ED)" value={code} onChange={(e) => setCode(e.target.value)} />
          <Select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
            <option value="">-- القسم التابع --</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
          <Button onClick={handleSave} disabled={busy || !name.trim()}>
            {editingId ? 'تحديث الوظيفة' : '+ إضافة وظيفة'}
          </Button>
        </div>

        <div className="divide-y divide-slate-100 rounded-2xl border border-slate-200">
          {positions.length === 0 ? (
            <div className="p-4 text-center text-sm text-slate-500">لا توجد وظائف مسجلة بعد.</div>
          ) : (
            positions.map((pos) => (
              <div key={pos.id} className="flex items-center justify-between p-3 text-sm">
                <div>
                  <span className="font-bold text-slate-800">{pos.name}</span>
                  {pos.code && <span className="ms-2 font-mono text-xs text-slate-500">({pos.code})</span>}
                  {pos.departmentId && deptMap.has(pos.departmentId) && (
                    <span className="ms-2 text-xs text-brand-600 bg-brand-50 px-2 py-0.5 rounded-md font-semibold">
                      {deptMap.get(pos.departmentId)}
                    </span>
                  )}
                  {pos.active === false && <Badge variant="neutral" className="ms-2">معطّلة</Badge>}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setPositionActive(pos.id, pos.active === false)}
                    className="text-xs text-slate-600 hover:text-brand-600 font-semibold"
                  >
                    {pos.active === false ? 'تفعيل' : 'تعطيل'}
                  </button>
                  <button
                    type="button"
                    onClick={() => startEdit(pos)}
                    className="text-xs text-brand-700 font-semibold hover:underline"
                  >
                    تعديل
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </Modal>
  )
}

/* ------------------------------------------------------------------ */
/*  مودال ترقيم الموظفين الصريح (Dry-Run & Explicit Execution Modal)    */
/* ------------------------------------------------------------------ */

function EmployeeMigrationModal({ open, employees = [], onClose }) {
  const dryRun = useMemo(() => dryRunEmployeeMigration(employees), [employees])
  const [selectedMap, setSelectedMap] = useState({})
  const [statusMap, setStatusMap] = useState({})
  const [busy, setBusy] = useState(false)
  const [successMsg, setSuccessMsg] = useState(null)

  // Initialize selectedMap when dryRun items update
  const unnumberedItems = useMemo(
    () => dryRun.items.filter((i) => i.needsCode || i.needsStatus),
    [dryRun.items],
  )

  function toggleSelect(id) {
    setSelectedMap((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  function handleStatusChange(id, status) {
    setStatusMap((prev) => ({ ...prev, [id]: status }))
  }

  async function handleExecute() {
    const selectedItems = unnumberedItems.filter((item) => selectedMap[item.id] !== false)
    if (selectedItems.length === 0) return

    setBusy(true)
    setSuccessMsg(null)
    try {
      const res = await executeEmployeeMigration(selectedItems, statusMap)
      setSuccessMsg(`تم تحديث وترقيم ${res.updatedCount} موظفاً بنجاح دون أي تكرار.`)
    } catch (err) {
      console.error('Error executing migration:', err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title="أداة ترقيم الموظفين (Dry-Run Migration Tool)"
      footer={
        <div className="flex items-center justify-between w-full">
          <Button variant="ghost" onClick={onClose}>
            إغلاق
          </Button>
          <Button onClick={handleExecute} disabled={busy || unnumberedItems.length === 0}>
            {busy ? 'جاري الترقيم...' : 'اعتماد وترقيم الموظفين المحددين'}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {/* إحصائيات الـ Dry-Run */}
        <div className="grid grid-cols-3 gap-3 text-center">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <p className="text-xs font-semibold text-slate-500">إجمالي الموظفين</p>
            <p className="text-lg font-bold text-slate-800">{dryRun.scannedCount}</p>
          </div>
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
            <p className="text-xs font-semibold text-amber-700">غير مُرقمين (بدون كود)</p>
            <p className="text-lg font-bold text-amber-800">{dryRun.missingCodeCount}</p>
          </div>
          <div className="rounded-xl border border-sky-200 bg-sky-50 p-3">
            <p className="text-xs font-semibold text-sky-700">بدون حالة تشغيلية</p>
            <p className="text-lg font-bold text-sky-800">{dryRun.missingStatusCount}</p>
          </div>
        </div>

        {successMsg && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm font-semibold text-emerald-800">
            ✅ {successMsg}
          </div>
        )}

        <div className="rounded-xl border border-slate-200 bg-white p-3 space-y-3">
          <h4 className="text-sm font-bold text-slate-800">
            قائمة الموظفين التي تتطلب الترقيم والاعتماد الصريح ({unnumberedItems.length}):
          </h4>

          {unnumberedItems.length === 0 ? (
            <div className="text-center py-6 text-sm text-emerald-600 font-semibold">
              🎉 جميع الموظفين مكوَّدون ومُعرَّفون بحالاتهم التشغيلية بالفعل. لا يوجد عمل متبقٍ.
            </div>
          ) : (
            <div className="divide-y divide-slate-100 max-h-72 overflow-y-auto">
              {unnumberedItems.map((item) => {
                const isSelected = selectedMap[item.id] !== false
                const currentStatus = statusMap[item.id] || item.suggestedStatus

                return (
                  <div key={item.id} className="flex items-center justify-between py-2 text-sm">
                    <label className="flex items-center gap-3 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelect(item.id)}
                        className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                      />
                      <div>
                        <span className="font-bold text-slate-800">{item.name}</span>
                        <span className="ms-2 font-mono text-xs text-slate-500">
                          {item.employeeCode || '(غير مُرقّم)'}
                        </span>
                      </div>
                    </label>

                    <div className="flex items-center gap-2">
                      <span className="text-xs text-slate-500">الحالة الصريحة:</span>
                      <Select
                        value={currentStatus}
                        onChange={(e) => handleStatusChange(item.id, e.target.value)}
                        className="py-1 text-xs"
                      >
                        <option value="active">نشط (Active)</option>
                        <option value="on_leave">في إجازة (On Leave)</option>
                        <option value="suspended">موقوف (Suspended)</option>
                        <option value="terminated">منتهي خدماته (Terminated)</option>
                        <option value="archived">مؤرشف (Archived)</option>
                      </Select>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}
