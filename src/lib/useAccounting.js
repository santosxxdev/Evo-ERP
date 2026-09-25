import { useMemo } from 'react'
import { COL, useAllPayments, useCollection, useSettings } from './db'
import { ACCOUNTS_COL, buildCleanAccounts } from './accounts'
import { JOURNAL_COL } from './journal'
import { ASSETS_COL, ASSET_USAGE_COL, MAINTENANCE_COL } from './assets'
import { JOB_COSTS_COL, VENDORS_COL } from '../pages/Vendors'
import { accountBalances, buildJournal, totalOfType } from './ledger'
import { isWithin } from './format'

/**
 * كل ما تحتاجه التقارير المالية في مكان واحد: البيانات الخام + دفتر
 * اليومية المشتق كاملًا. تستخدمه صفحة الحسابات وكل صفحة تقرير مالي،
 * فلا يتكرر بناء القيود في كل صفحة.
 */
export function useAccountingData() {
  const { settings } = useSettings()
  const { rows: rawAccounts, loading } = useCollection(ACCOUNTS_COL, 'code', 'asc')
  const { rows: invoices } = useCollection(COL.invoices, 'date', 'desc')
  const { rows: expenses } = useCollection(COL.expenses, 'date', 'desc')
  const { rows: expenseCategories } = useCollection(COL.expenseCategories, 'name', 'asc')
  const { rows: paymentMethods } = useCollection(COL.paymentMethods, 'name', 'asc')
  const { rows: payments } = useAllPayments()
  const { rows: jobCosts } = useCollection(JOB_COSTS_COL, 'date', 'desc')
  const { rows: vendors } = useCollection(VENDORS_COL, 'name', 'asc')
  const { rows: vouchers } = useCollection(JOURNAL_COL, 'date', 'desc')
  const { rows: assets } = useCollection(ASSETS_COL, 'name', 'asc')
  const { rows: maintenance } = useCollection(MAINTENANCE_COL, 'date', 'desc')
  const { rows: assetUsage } = useCollection(ASSET_USAGE_COL, 'date', 'desc')
  const { rows: clients } = useCollection(COL.clients, 'name', 'asc')
  const { rows: employees } = useCollection(COL.employees, 'name', 'asc')
  const { rows: purchaseInvoices } = useCollection('purchaseInvoices', 'date', 'desc')
  const { rows: vendorPayments } = useCollection('vendorPayments', 'date', 'desc')
  const { rows: accountingTransactions } = useCollection(COL.accountingTransactions, 'transactionDate', 'desc')

  const accounts = useMemo(
    () => buildCleanAccounts(rawAccounts, clients, employees, vendors),
    [rawAccounts, clients, employees, vendors],
  )

  const enrichedPayments = useMemo(() => {
    const numbers = new Map(invoices.map((invoice) => [invoice.id, invoice.number]))
    return payments.map((payment) => ({ ...payment, invoiceNumber: numbers.get(payment.invoiceId) ?? '' }))
  }, [payments, invoices])

  const journal = useMemo(
    () =>
      buildJournal({
        invoices,
        payments: enrichedPayments,
        expenses,
        accounts,
        expenseCategories,
        paymentMethods,
        jobCosts,
        vendors,
        vouchers,
        assets,
        maintenance,
        assetUsage,
        accountingTransactions,
        clients,
        purchaseInvoices,
        vendorPayments,
        settings,
      }),
    [
      invoices,
      enrichedPayments,
      expenses,
      accounts,
      expenseCategories,
      paymentMethods,
      jobCosts,
      vendors,
      vouchers,
      assets,
      maintenance,
      assetUsage,
      accountingTransactions,
      clients,
      purchaseInvoices,
      vendorPayments,
      settings,
    ],
  )

  return {
    accounts,
    rawAccounts,
    invoices,
    expenses,
    expenseCategories,
    paymentMethods,
    jobCosts,
    vendors,
    vouchers,
    assets,
    maintenance,
    assetUsage,
    clients,
    employees,
    purchaseInvoices,
    vendorPayments,
    accountingTransactions,
    journal,
    loading,
  }
}

/** القوائم المالية لفترة: القيود المرشّحة + الأرصدة + الإجماليات */
export function periodStatements(journal, accounts, from, to) {
  const periodJournal = journal.filter((entry) => isWithin(entry.date, from, to))
  const balances = accountBalances(periodJournal, accounts)
  const revenue = totalOfType(balances, 'revenue')
  const expenses = totalOfType(balances, 'expense')
  return { periodJournal, balances, revenue, expenses, profit: revenue - expenses }
}
