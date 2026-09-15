import { useState } from 'react'
import { useI18n } from '../i18n'
import { formatMoney, toNumber } from '../lib/format'
import { lineTotal } from '../lib/invoice'
import { serviceCostBreakdown } from '../lib/costing'
import { Badge, Button, Input, Select } from './ui'
import SearchableSelect from './SearchableSelect'

export const emptyItem = () => ({
  id: `item-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
  serviceId: '',
  name: '',
  price: '',
  qty: 1,
  isAdBudget: false,
  supplierId: '',
  supplierName: '',
  expectedCost: '',
  approvedCost: '',
  costStatus: 'draft',
  costAccountId: '',
})

/**
 * محرّر بنود مشترك بين الفاتورة وعرض السعر والباقة،
 * يدعم إضافة المورد/الفريلانسر والتكلفة المتوقعة والفعلية لكل بند.
 */
export default function ItemsEditor({ items, setItems, services = [], vendors = [], accounts = [], error }) {
  const { t } = useI18n()
  const [openCostIndex, setOpenCostIndex] = useState(null)

  function setItem(index, patch) {
    setItems((current) => current.map((item, position) => (position === index ? { ...item, ...patch } : item)))
  }

  function pickService(index, serviceId) {
    const service = services.find((item) => item.id === serviceId)
    const breakdown = serviceCostBreakdown(service)
    const qty = toNumber(items[index]?.qty || 1)
    const expectedCost = breakdown.hasCosting ? String(breakdown.fullCost * qty) : (items[index]?.expectedCost || '')

    setItem(index, {
      serviceId,
      name: service?.name ?? '',
      price: service ? service.price : '',
      isAdBudget: Boolean(service?.isAdBudget),
      expectedCost,
    })
  }

  function pickSupplier(index, supplierId) {
    const vendor = vendors.find((v) => v.id === supplierId)
    setItem(index, {
      supplierId,
      supplierName: vendor?.name || '',
    })
  }

  const costAccountOptions = (accounts || []).filter((a) => !a.isGroup && !a.archived && String(a.code).startsWith('5'))

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-sm font-bold text-slate-900">{t('invoices.items')}</h4>
        <Button variant="soft" onClick={() => setItems((current) => [...current, emptyItem()])}>
          + {t('invoices.addItem')}
        </Button>
      </div>

      <div className="space-y-3">
        {items.map((item, index) => {
          const isCostOpen = openCostIndex === index
          const hasSupplier = Boolean(item.supplierId)
          const isApproved = item.costStatus === 'approved' || item.costStatus === 'partially_paid' || item.costStatus === 'paid'

          return (
            <div key={item.id || index} className="rounded-2xl bg-slate-50 p-3 space-y-2">
              <div className="grid gap-2 sm:grid-cols-12">
                <div className="sm:col-span-4">
                  <SearchableSelect
                    options={services}
                    value={item.serviceId ?? ''}
                    placeholder={t('invoices.pickService')}
                    searchPlaceholder="ابحث باسم الخدمة..."
                    onChange={(val) => pickService(index, val)}
                  />
                </div>

                <div className="sm:col-span-3">
                  <Input
                    value={item.name ?? ''}
                    onChange={(event) => setItem(index, { name: event.target.value })}
                    placeholder={t('common.description')}
                  />
                </div>

                <div className="sm:col-span-2">
                  <Input
                    numeric
                    value={item.price ?? ''}
                    onChange={(event) => setItem(index, { price: event.target.value })}
                    placeholder={t('common.price')}
                  />
                </div>

                <div className="sm:col-span-1">
                  <Input
                    numeric
                    value={item.qty ?? ''}
                    onChange={(event) => setItem(index, { qty: event.target.value })}
                    placeholder={t('common.qty')}
                  />
                </div>

                <div className="flex items-center justify-between gap-2 sm:col-span-2">
                  <span className="num text-sm font-bold text-slate-800">{formatMoney(lineTotal(item))}</span>
                  {items.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setItems((current) => current.filter((_, position) => position !== index))}
                      className="rounded-lg px-2 py-1 text-xs font-semibold text-red-600 hover:bg-red-50"
                    >
                      ✕
                    </button>
                  )}
                </div>
              </div>

              {/* شريط معلومات المورد والتكلفة السفلي */}
              <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-slate-200/60 text-xs">
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-1.5 text-slate-500">
                    <input
                      type="checkbox"
                      checked={Boolean(item.isAdBudget)}
                      onChange={(event) => setItem(index, { isAdBudget: event.target.checked })}
                      className="h-3.5 w-3.5 accent-amber-500"
                    />
                    <span className="font-medium">{t('invoices.itemIsAdBudget')}</span>
                  </label>

                  <button
                    type="button"
                    onClick={() => setOpenCostIndex(isCostOpen ? null : index)}
                    className="flex items-center gap-1 font-bold text-brand-700 hover:underline"
                  >
                    {hasSupplier ? `🏭 ${item.supplierName || 'مورد محدد'}` : '+ تخصيص مورد / فريلانسر وتكلفة'}
                    {item.expectedCost > 0 && <span className="text-slate-500 font-normal ms-1">(متوقع: {formatMoney(item.expectedCost)})</span>}
                  </button>
                </div>

                {isApproved && (
                  <Badge tone={item.costStatus === 'paid' ? 'green' : item.costStatus === 'partially_paid' ? 'amber' : 'brand'}>
                    تكلفة معتمدة: {formatMoney(item.approvedCost)} EGP
                  </Badge>
                )}
              </div>

              {/* قسم تفاصيل المورد والتكلفة المنسدل */}
              {isCostOpen && (
                <div className="mt-2 rounded-xl bg-white p-3 border border-slate-200 space-y-3 text-xs">
                  <div className="font-bold text-slate-800">تخصيص المورد وتكلفة البند (Supplier & Cost Specification)</div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div>
                      <label className="mb-1 block font-semibold text-slate-600">المورد / الفريلانسر</label>
                      <SearchableSelect
                        options={vendors}
                        value={item.supplierId ?? ''}
                        placeholder="اختر المورد..."
                        searchPlaceholder="ابحث باسم المورد أو التخصص..."
                        onChange={(val) => pickSupplier(index, val)}
                      />
                    </div>

                    <div>
                      <label className="mb-1 block font-semibold text-slate-600">التكلفة المتوقعة (Expected Cost)</label>
                      <Input
                        numeric
                        value={item.expectedCost ?? ''}
                        onChange={(e) => setItem(index, { expectedCost: e.target.value })}
                        placeholder="تقدير التكلفة للمخطط..."
                      />
                    </div>

                    <div>
                      <label className="mb-1 block font-semibold text-slate-600">التكلفة الفعلية (Actual Approved Cost)</label>
                      <Input
                        numeric
                        value={item.approvedCost ?? ''}
                        onChange={(e) => setItem(index, { approvedCost: e.target.value })}
                        placeholder="التكلفة الفعلية للاستحقاق..."
                        disabled={isApproved}
                      />
                    </div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <label className="mb-1 block font-semibold text-slate-600">حساب التكلفة المباشر (Cost Account)</label>
                      <Select
                        value={item.costAccountId ?? ''}
                        onChange={(e) => setItem(index, { costAccountId: e.target.value })}
                        disabled={isApproved}
                      >
                        <option value="">-- اختياري (تلقائي 5101-5106) --</option>
                        {costAccountOptions.map((acct) => (
                          <option key={acct.id} value={acct.id}>
                            {acct.code} - {acct.name}
                          </option>
                        ))}
                      </Select>
                    </div>

                    <div className="flex items-end justify-end">
                      <Button size="xs" variant="secondary" onClick={() => setOpenCostIndex(null)}>
                        إغلاق التفاصيل
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {error && <p className="mt-2 text-xs font-semibold text-red-600">{error}</p>}
    </div>
  )
}

export function validItems(items) {
  return items.filter((item) => item.name?.trim() && toNumber(item.qty) > 0)
}

export function toStoredItems(items) {
  return validItems(items).map((item) => ({
    id: item.id || `item-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
    serviceId: item.serviceId || null,
    name: item.name.trim(),
    price: toNumber(item.price),
    qty: toNumber(item.qty),
    isAdBudget: Boolean(item.isAdBudget),
    total: lineTotal(item),
    supplierId: item.supplierId || null,
    supplierName: item.supplierName || null,
    expectedCost: toNumber(item.expectedCost),
    approvedCost: item.approvedCost !== undefined && item.approvedCost !== null && item.approvedCost !== '' ? toNumber(item.approvedCost) : null,
    costStatus: item.costStatus || 'draft',
    costAccountId: item.costAccountId || null,
    payableId: item.payableId || null,
    payableTransactionId: item.payableTransactionId || null,
  }))
}

