import { useMemo, useState } from 'react'
import { Navigate, useParams } from 'react-router-dom'
import { useI18n } from '../i18n'
import {
  COL,
  createDoc,
  deleteDocById,
  saveSettings,
  updateDocById,
  useCollection,
  useSettings,
} from '../lib/db'
import { toNumber } from '../lib/format'
import { ACCOUNTS_COL, DEFAULT_PAYMENT_METHODS, accountLabel, nextChildCode } from '../lib/accounts'
import { resetSystemData } from '../lib/resetSystem'
import { uploadImage } from '../lib/cloudinary'
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
  Select,
  Td,
  TableWrap,
  Textarea,
  Th,
} from '../components/ui'
import SearchableSelect from '../components/SearchableSelect'

/* الفئات الافتراضية التي تُقترح عند فتح القائمة لأول مرة */
const DEFAULT_EXPENSE_CATEGORIES = [
  { name: 'مرتبات', system: 'salary' },
  { name: 'إعلانات', isAdSpend: true },
  { name: 'إيجار' },
  { name: 'إنترنت' },
  { name: 'معدات' },
  { name: 'مواصلات' },
  { name: 'أخرى' },
]

const TABS = [
  { id: 'expenseCategories', slug: 'expense-categories', labelKey: 'settings.expenseCategories', path: COL.expenseCategories },
  { id: 'activityTypes', slug: 'activity-types', labelKey: 'settings.activityTypes', path: COL.activityTypes },
  { id: 'paymentMethods', slug: 'payment-methods', labelKey: 'settings.paymentMethods', path: COL.paymentMethods },
  { id: 'serviceCategories', slug: 'service-categories', labelKey: 'settings.serviceCategories', path: COL.serviceCategories },
  { id: 'company', slug: 'company', labelKey: 'settings.company', path: null },
]

export default function Settings() {
  const { t } = useI18n()
  const { section } = useParams()

  const active = TABS.find((item) => item.slug === section)
  if (!active) return <Navigate to="/settings/expense-categories" replace />

  return (
    <div>
      <PageHeader title={t(active.labelKey)} subtitle={t('settings.subtitle')} />
      {active.id === 'company' ? <CompanySettings /> : <ListManager key={active.id} tab={active.id} />}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  إدارة قائمة                                                        */
/* ------------------------------------------------------------------ */

function ListManager({ tab }) {
  const { t } = useI18n()
  const config = TABS.find((item) => item.id === tab)
  const isPaymentMethod = tab === 'paymentMethods'

  const { rows, loading } = useCollection(config.path, 'name', 'asc')
  const { rows: expenses } = useCollection(COL.expenses, 'date', 'desc')
  const { rows: clients } = useCollection(COL.clients, 'name', 'asc')
  const { rows: accounts } = useCollection(ACCOUNTS_COL, 'code', 'asc')

  const [editing, setEditing] = useState(null)
  const [removing, setRemoving] = useState(null)
  const [busy, setBusy] = useState(false)

  /* عدد السجلات المرتبطة بكل عنصر — لمنع حذف عنصر مستخدم */
  const usage = useMemo(() => {
    const map = new Map()
    if (tab === 'expenseCategories') {
      for (const expense of expenses) {
        map.set(expense.categoryId, (map.get(expense.categoryId) ?? 0) + 1)
      }
    }
    if (tab === 'activityTypes') {
      for (const client of clients) {
        map.set(client.activityTypeId, (map.get(client.activityTypeId) ?? 0) + 1)
      }
    }
    return map
  }, [tab, expenses, clients])

  async function seedDefaults() {
    setBusy(true)
    if (tab === 'expenseCategories') {
      for (const item of DEFAULT_EXPENSE_CATEGORIES) {
        await createDoc(config.path, {
          name: item.name,
          system: item.system ?? null,
          isAdSpend: Boolean(item.isAdSpend),
          archived: false,
        })
      }
    } else if (tab === 'paymentMethods') {
      for (const pm of DEFAULT_PAYMENT_METHODS) {
        const linkedAccount = accounts.find((acct) => acct.code === pm.accountCode)
        await createDoc(config.path, {
          name: pm.name,
          type: pm.type,
          accountId: linkedAccount ? linkedAccount.id : null,
          accountNumber: '',
          accountHolder: '',
          archived: false,
          active: true,
        })
      }
    }
    setBusy(false)
  }

  /*
   * كل طريقة تحويل جديدة تاخد حسابها الخاص في الشجرة تلقائيًا (تحت
   * «الخزينة» أو «البنوك والمحافظ») لو المستخدم سايب الحساب على تلقائي —
   * من غيرها كل الخزائن أو كل البنوك بتتجمّع في حساب واحد فمينفعش تعرف
   * رصيد كل واحدة لوحدها في شاشة الخزينة.
   */
  async function ensureOwnAccount(values) {
    if (!isPaymentMethod || values.accountId) return values

    const cleanName = String(values.name ?? '').trim().toLowerCase()
    const existing = accounts.find(
      (account) => String(account.name).trim().toLowerCase() === cleanName
    )
    if (existing) return { ...values, accountId: existing.id }

    const targetCode = values.type === 'cash' ? '110101' : '110102'
    const fallbackCode = values.type === 'cash' ? '1111' : '1112'
    const parent = accounts.find((account) => account.code === targetCode) || accounts.find((account) => account.code === fallbackCode)
    if (!parent) return values
    const parentCode = parent.code

    const code = nextChildCode(accounts, parentCode)
    const account = await createDoc(ACCOUNTS_COL, {
      code,
      name: values.name,
      nameEn: '',
      type: 'asset',
      isGroup: false,
      role: null,
      parentCode,
      archived: false,
    })
    return { ...values, accountId: account.id }
  }

  async function handleSave(values) {
    setBusy(true)
    if (editing?.id) {
      const withAccount = await ensureOwnAccount(values)
      await updateDocById(config.path, editing.id, { ...withAccount, active: true })
    } else {
      const withAccount = await ensureOwnAccount(values)
      await createDoc(config.path, { ...withAccount, archived: false, active: true })
    }
    setBusy(false)
    setEditing(null)
  }

  async function handleDelete() {
    setBusy(true)
    await deleteDocById(config.path, removing.id)
    setBusy(false)
    setRemoving(null)
  }

  async function toggleArchive(row) {
    await updateDocById(config.path, row.id, { archived: !row.archived })
  }

  if (loading) return <Loading />

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-500">{t('common.results', { count: rows.length })}</p>
        <div className="flex gap-2">
          {tab === 'expenseCategories' && rows.length === 0 && (
            <Button variant="ghost" onClick={seedDefaults} disabled={busy}>
              {t('settings.addItem')} ×{DEFAULT_EXPENSE_CATEGORIES.length}
            </Button>
          )}
          {tab === 'paymentMethods' && rows.length === 0 && (
            <Button variant="ghost" onClick={seedDefaults} disabled={busy}>
              + إضافة الطرق الحسابية الافتراضية (×{DEFAULT_PAYMENT_METHODS.length})
            </Button>
          )}
          <Button onClick={() => setEditing({})}>+ {t('settings.addItem')}</Button>
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title={t('settings.emptyList')}
          action={
            <div className="flex flex-wrap justify-center gap-2">
              {tab === 'paymentMethods' && (
                <Button variant="secondary" onClick={seedDefaults} disabled={busy}>
                  ⚡ إنشاء وربط طرق التحويل بالحسابات الفرعية (×{DEFAULT_PAYMENT_METHODS.length})
                </Button>
              )}
              <Button onClick={() => setEditing({})}>+ {t('settings.addItem')}</Button>
            </div>
          }
        />
      ) : (
        <TableWrap>
          <thead>
            <tr>
              <Th>{t('settings.itemName')}</Th>
              {isPaymentMethod && <Th>{t('settings.methodType')}</Th>}
              {isPaymentMethod && <Th>{t('settings.accountNumber')}</Th>}
              {isPaymentMethod && <Th>{t('settings.accountHolder')}</Th>}
              {!isPaymentMethod && <Th>{t('common.description')}</Th>}
              <Th className="w-px">{t('common.actions')}</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const used = usage.get(row.id) ?? 0
              const locked = Boolean(row.system)
              return (
                <tr key={row.id} className={row.archived ? 'opacity-50' : ''}>
                  <Td>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-slate-800">{row.name}</span>
                      {locked && <Badge tone="brand">{t('common.system')}</Badge>}
                      {row.archived && <Badge>{t('common.archived')}</Badge>}
                    </div>
                  </Td>

                  {isPaymentMethod && (
                    <Td>
                      <Badge tone={row.type === 'cash' ? 'slate' : 'sky'}>
                        {t(`settings.methodType.${row.type ?? 'cash'}`)}
                      </Badge>
                    </Td>
                  )}
                  {isPaymentMethod && (
                    <Td>
                      <span className="num text-slate-600">{row.accountNumber || '—'}</span>
                    </Td>
                  )}
                  {isPaymentMethod && <Td className="text-slate-600">{row.accountHolder || '—'}</Td>}
                  {!isPaymentMethod && <Td className="text-slate-500">{row.description || '—'}</Td>}

                  <Td>
                    <div className="flex gap-1.5">
                      <button
                        type="button"
                        onClick={() => setEditing(row)}
                        className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100"
                      >
                        {t('common.edit')}
                      </button>
                      <button
                        type="button"
                        onClick={() => toggleArchive(row)}
                        className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100"
                      >
                        {row.archived ? t('common.restore') : t('common.archive')}
                      </button>
                      {!locked && used === 0 && (
                        <button
                          type="button"
                          onClick={() => setRemoving(row)}
                          className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50"
                        >
                          {t('common.delete')}
                        </button>
                      )}
                    </div>
                    {locked && <p className="mt-1 text-[11px] text-slate-400">{t('settings.systemLocked')}</p>}
                    {!locked && used > 0 && (
                      <p className="mt-1 text-[11px] text-slate-400">{t('settings.inUse', { count: used })}</p>
                    )}
                  </Td>
                </tr>
              )
            })}
          </tbody>
        </TableWrap>
      )}

      <ListForm
        open={Boolean(editing)}
        row={editing}
        isPaymentMethod={isPaymentMethod}
        isExpenseCategory={tab === 'expenseCategories'}
        accounts={accounts}
        busy={busy}
        onClose={() => setEditing(null)}
        onSave={handleSave}
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

function ListForm({ open, row, isPaymentMethod, isExpenseCategory, accounts = [], busy, onClose, onSave }) {
  const { t, lang } = useI18n()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [type, setType] = useState('wallet')
  const [accountNumber, setAccountNumber] = useState('')
  const [accountHolder, setAccountHolder] = useState('')
  const [isAdSpend, setIsAdSpend] = useState(false)
  const [accountId, setAccountId] = useState('')
  const [touched, setTouched] = useState(false)

  /* إعادة ملء الحقول عند فتح النافذة على عنصر مختلف */
  const key = row?.id ?? 'new'
  const [lastKey, setLastKey] = useState(null)
  if (open && lastKey !== key) {
    setLastKey(key)
    setName(row?.name ?? '')
    setDescription(row?.description ?? '')
    setType(row?.type ?? 'wallet')
    setAccountNumber(row?.accountNumber ?? '')
    setAccountHolder(row?.accountHolder ?? '')
    setIsAdSpend(Boolean(row?.isAdSpend))
    setAccountId(row?.accountId ?? '')
    setTouched(false)
  }
  if (!open && lastKey !== null) setLastKey(null)

  function submit() {
    setTouched(true)
    if (!name.trim()) return
    onSave(
      isPaymentMethod
        ? {
            name: name.trim(),
            type,
            accountNumber: type === 'cash' ? '' : accountNumber.trim(),
            accountHolder: type === 'cash' ? '' : accountHolder.trim(),
            accountId: accountId || null,
          }
        : isExpenseCategory
          ? { name: name.trim(), description: description.trim(), isAdSpend, accountId: accountId || null }
          : { name: name.trim(), description: description.trim() },
    )
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={row?.id ? t('common.edit') : t('settings.addItem')}
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
        <Field label={t('settings.itemName')} error={touched && !name.trim() ? t('common.required') : null}>
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </Field>

        {isPaymentMethod ? (
          <>
            <Field label={t('settings.methodType')}>
              <Select value={type} onChange={(event) => setType(event.target.value)}>
                <option value="wallet">{t('settings.methodType.wallet')}</option>
                <option value="bank">{t('settings.methodType.bank')}</option>
                <option value="cash">{t('settings.methodType.cash')}</option>
              </Select>
            </Field>

            {type !== 'cash' && (
              <>
                <Field label={t('settings.accountNumber')}>
                  <Input
                    numeric
                    value={accountNumber}
                    onChange={(event) => setAccountNumber(event.target.value)}
                    placeholder="01xxxxxxxxx"
                  />
                </Field>
                <Field label={`${t('settings.accountHolder')} (${t('common.optional')})`}>
                  <Input value={accountHolder} onChange={(event) => setAccountHolder(event.target.value)} />
                </Field>
              </>
            )}

            {accounts.length > 0 && (
              <Field label={t('settings.linkedAccount')} hint={t('settings.linkedAccountHint')}>
                <SearchableSelect
                  options={accounts
                    .filter((account) => !account.isGroup && account.type === 'asset')
                    .map((account) => ({
                      id: account.id,
                      name: `${account.code} — ${accountLabel(account, lang)}`,
                      code: account.code,
                    }))}
                  value={accountId}
                  placeholder={t('settings.autoAccount')}
                  searchPlaceholder="ابحث بكود الحساب أو اسمه..."
                  onChange={(val) => setAccountId(val)}
                />
              </Field>
            )}
          </>
        ) : (
          <>
            <Field label={`${t('common.description')} (${t('common.optional')})`}>
              <Input value={description} onChange={(event) => setDescription(event.target.value)} />
            </Field>

            {isExpenseCategory && (
              <label className="flex items-start gap-3 rounded-xl border border-slate-200 px-4 py-3">
                <input
                  type="checkbox"
                  checked={isAdSpend}
                  onChange={(event) => setIsAdSpend(event.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-brand-600"
                />
                <span>
                  <span className="block text-sm font-semibold text-slate-700">
                    {t('settings.isAdSpend')}
                  </span>
                  <span className="mt-0.5 block text-xs text-slate-500">{t('settings.isAdSpendHint')}</span>
                </span>
              </label>
            )}

            {isExpenseCategory && accounts.length > 0 && (
              <Field label={t('settings.linkedAccount')} hint={t('settings.linkedAccountHint')}>
                <SearchableSelect
                  options={accounts
                    .filter((account) => !account.isGroup && account.type === 'expense')
                    .map((account) => ({
                      id: account.id,
                      name: `${account.code} — ${accountLabel(account, lang)}`,
                      code: account.code,
                    }))}
                  value={accountId}
                  placeholder={t('settings.autoAccount')}
                  searchPlaceholder="ابحث بكود الحساب أو اسمه..."
                  onChange={(val) => setAccountId(val)}
                />
              </Field>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}

/* ------------------------------------------------------------------ */
/*  بيانات الشركة                                                      */
/* ------------------------------------------------------------------ */

function CompanySettings() {
  const { t } = useI18n()
  const { settings, loading } = useSettings()
  const [draft, setDraft] = useState(null)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState(null)

  const value = draft ?? settings

  function set(field, next) {
    setDraft({ ...value, [field]: next })
    setSaved(false)
  }

  async function pickLogo(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setUploadError(null)
    setUploading(true)
    try {
      const url = await uploadImage(file)
      set('logoUrl', url)
    } catch (error) {
      setUploadError(
        error.message === 'too-large'
          ? t('settings.logoTooLarge')
          : error.message === 'not-image'
            ? t('settings.logoNotImage')
            : t('settings.logoFailed'),
      )
    }
    setUploading(false)
  }

  async function save() {
    setBusy(true)
    await saveSettings({
      companyName: value.companyName ?? '',
      taxEnabled: Boolean(value.taxEnabled),
      taxRate: toNumber(value.taxRate1 ?? value.taxRate),
      taxRate1: toNumber(value.taxRate1 ?? value.taxRate),
      taxRate2: toNumber(value.taxRate2),
      taxLabel1: value.taxLabel1?.trim() || 'ضريبة القيمة المضافة',
      taxLabel2: value.taxLabel2?.trim() || 'ضريبة الخصم والإضافة',
      invoicePrefix: (value.invoicePrefix || 'INV').toUpperCase(),
      logoUrl: value.logoUrl ?? '',
      websiteUrl: value.websiteUrl?.trim() ?? '',
      companyPhone: value.companyPhone?.trim() ?? '',
      companyEmail: value.companyEmail?.trim() ?? '',
      companyAddress: value.companyAddress?.trim() ?? '',
      bankName: value.bankName?.trim() ?? '',
      bankAccount: value.bankAccount?.trim() ?? '',
      bankHolder: value.bankHolder?.trim() ?? '',
      contractTerms: value.contractTerms ?? '',
      closedPeriodBefore: value.closedPeriodBefore ?? '',
    })
    setBusy(false)
    setDraft(null)
    setSaved(true)
  }

  if (loading) return <Loading />

  return (
    <div className="card max-w-2xl p-6">
      <div className="space-y-5">
        {/* الشعار */}
        <div>
          <span className="mb-1.5 block text-sm font-semibold text-slate-600">{t('settings.logo')}</span>
          <div className="flex items-center gap-4">
            <div className="grid h-20 w-20 shrink-0 place-items-center overflow-hidden rounded-2xl border border-slate-200 bg-slate-50">
              {value.logoUrl ? (
                <img src={value.logoUrl} alt="logo" className="h-full w-full object-contain" />
              ) : (
                <span className="text-xs text-slate-400">{t('settings.noLogo')}</span>
              )}
            </div>
            <div className="space-y-1.5">
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
                <input type="file" accept="image/*" className="hidden" onChange={pickLogo} disabled={uploading} />
                {uploading ? t('common.saving') : t('settings.uploadLogo')}
              </label>
              {value.logoUrl && (
                <button
                  type="button"
                  onClick={() => set('logoUrl', '')}
                  className="ms-2 text-xs font-semibold text-red-600 hover:underline"
                >
                  {t('common.delete')}
                </button>
              )}
              <p className="text-xs text-slate-400">{t('settings.logoHint')}</p>
              {uploadError && <p className="text-xs font-semibold text-red-600">{uploadError}</p>}
            </div>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('settings.companyName')}>
            <Input value={value.companyName ?? ''} onChange={(event) => set('companyName', event.target.value)} />
          </Field>
          <Field label={t('settings.invoicePrefix')}>
            <Input
              value={value.invoicePrefix ?? 'INV'}
              onChange={(event) => set('invoicePrefix', event.target.value)}
              placeholder="INV"
            />
          </Field>
          <Field label={t('settings.website')} hint={t('settings.websiteHint')}>
            <Input
              dir="ltr"
              value={value.websiteUrl ?? ''}
              onChange={(event) => set('websiteUrl', event.target.value)}
              placeholder="https://iyora.example"
            />
          </Field>
          <Field label={t('common.phone')}>
            <Input numeric value={value.companyPhone ?? ''} onChange={(event) => set('companyPhone', event.target.value)} />
          </Field>
          <Field label={t('common.email')}>
            <Input dir="ltr" value={value.companyEmail ?? ''} onChange={(event) => set('companyEmail', event.target.value)} />
          </Field>
          <Field label={t('common.address')}>
            <Input value={value.companyAddress ?? ''} onChange={(event) => set('companyAddress', event.target.value)} />
          </Field>
        </div>

        {/* الحساب البنكي للتحويل */}
        <div className="rounded-2xl border border-slate-200 p-4">
          <h4 className="mb-3 text-sm font-bold text-slate-900">{t('settings.bankBlock')}</h4>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={t('settings.bankName')}>
              <Input value={value.bankName ?? ''} onChange={(event) => set('bankName', event.target.value)} />
            </Field>
            <Field label={t('settings.bankAccount')}>
              <Input dir="ltr" value={value.bankAccount ?? ''} onChange={(event) => set('bankAccount', event.target.value)} />
            </Field>
            <Field label={t('settings.bankHolder')}>
              <Input value={value.bankHolder ?? ''} onChange={(event) => set('bankHolder', event.target.value)} />
            </Field>
          </div>
        </div>

        <Field label={t('settings.contractTerms')} hint={t('settings.contractTermsHint')}>
          <Textarea
            rows={5}
            value={value.contractTerms ?? ''}
            onChange={(event) => set('contractTerms', event.target.value)}
          />
        </Field>

        <div className="rounded-2xl border border-slate-200 p-4">
          <h4 className="mb-3 text-sm font-bold text-slate-900">Accounting Period Lock</h4>
          <p className="mb-4 text-xs text-slate-500">
            Any accounting transactions dated before this date will be locked and cannot be added or modified.
          </p>
          <div className="w-48">
            <Field label="Close Books Before">
              <Input
                type="date"
                value={value.closedPeriodBefore ?? ''}
                onChange={(event) => set('closedPeriodBefore', event.target.value)}
              />
            </Field>
          </div>
        </div>

        <label className="flex items-center gap-3 rounded-xl border border-slate-200 px-4 py-3">
          <input
            type="checkbox"
            checked={Boolean(value.taxEnabled)}
            onChange={(event) => set('taxEnabled', event.target.checked)}
            className="h-4 w-4 accent-brand-600"
          />
          <span className="text-sm font-semibold text-slate-700">{t('settings.taxEnabled')}</span>
        </label>

        {value.taxEnabled && (
          <div className="rounded-2xl border border-slate-200 p-4">
            <h4 className="mb-3 text-sm font-bold text-slate-900">{t('settings.taxRatesBlock')}</h4>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('settings.taxLabel1')}>
                <Input
                  value={value.taxLabel1 ?? 'ضريبة القيمة المضافة'}
                  onChange={(event) => set('taxLabel1', event.target.value)}
                />
              </Field>
              <Field label={t('settings.taxRate1')}>
                <Input
                  numeric
                  value={value.taxRate1 ?? value.taxRate ?? 14}
                  onChange={(event) => set('taxRate1', event.target.value)}
                />
              </Field>
              <Field label={t('settings.taxLabel2')}>
                <Input
                  value={value.taxLabel2 ?? 'ضريبة الخصم والإضافة'}
                  onChange={(event) => set('taxLabel2', event.target.value)}
                />
              </Field>
              <Field label={t('settings.taxRate2')}>
                <Input
                  numeric
                  value={value.taxRate2 ?? 0}
                  onChange={(event) => set('taxRate2', event.target.value)}
                />
              </Field>
            </div>
          </div>
        )}
      </div>

      <div className="mt-6 flex items-center gap-3">
        <Button onClick={save} disabled={busy}>
          {busy ? t('common.saving') : t('common.save')}
        </Button>
        {saved && <span className="text-sm font-semibold text-emerald-600">{t('settings.saved')}</span>}
      </div>
    </div>
  )
}
