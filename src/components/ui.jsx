import { useEffect } from 'react'
import { useI18n } from '../i18n'
import { IconClose } from './Icons'

/* ------------------------------- رأس الصفحة ------------------------------- */

export function PageHeader({ title, subtitle, children }) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 className="text-xl font-bold text-slate-900 sm:text-2xl">{title}</h2>
        {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  )
}

/* --------------------------------- الأزرار -------------------------------- */

export function Button({ variant = 'primary', className = '', ...rest }) {
  const styles = {
    primary: 'bg-brand-600 text-white hover:bg-brand-700 active:bg-brand-800 shadow-sm',
    ghost: 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-50',
    danger: 'bg-red-600 text-white hover:bg-red-700',
    soft: 'bg-brand-50 text-brand-700 hover:bg-brand-100',
  }
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold
                  transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${styles[variant]} ${className}`}
      {...rest}
    />
  )
}

/* --------------------------------- الحقول --------------------------------- */

export function Field({ label, hint, error, children, className = '' }) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1.5 block text-sm font-semibold text-slate-600">{label}</span>
      {children}
      {hint && !error && <span className="mt-1 block text-xs text-slate-400">{hint}</span>}
      {error && <span className="mt-1 block text-xs font-semibold text-red-600">{error}</span>}
    </label>
  )
}

export function Input({ className = '', numeric = false, ...rest }) {
  return (
    <input
      dir={numeric ? 'ltr' : undefined}
      inputMode={numeric ? 'decimal' : undefined}
      className={`w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none
                  transition placeholder:text-slate-400 focus:border-brand-500 focus:ring-4 focus:ring-brand-500/10
                  ${numeric ? 'text-start' : ''} ${className}`}
      {...rest}
    />
  )
}

export function Textarea({ className = '', ...rest }) {
  return (
    <textarea
      rows={3}
      className={`w-full resize-y rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none
                  transition placeholder:text-slate-400 focus:border-brand-500 focus:ring-4 focus:ring-brand-500/10 ${className}`}
      {...rest}
    />
  )
}

export function Select({ className = '', children, ...rest }) {
  return (
    <select
      className={`w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none
                  transition focus:border-brand-500 focus:ring-4 focus:ring-brand-500/10 ${className}`}
      {...rest}
    >
      {children}
    </select>
  )
}

/* -------------------------------- النافذة -------------------------------- */

export function Modal({ open, onClose, title, children, footer, wide = false }) {
  useEffect(() => {
    if (!open) return undefined
    const onKey = (event) => event.key === 'Escape' && onClose?.()
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-slate-900/50 p-0 backdrop-blur-sm dark:bg-black/70 sm:items-start sm:p-6">
      <div
        className={`my-0 w-full rounded-t-3xl bg-white shadow-2xl sm:my-8 sm:rounded-3xl ${
          wide ? 'max-w-4xl' : 'max-w-lg'
        }`}
      >
        <div className="flex items-center justify-between gap-4 border-b border-slate-100 px-6 py-4">
          <h3 className="text-base font-bold text-slate-900">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
          >
            <IconClose />
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto px-6 py-5">{children}</div>

        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 px-6 py-4">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}

/* ------------------------------ تأكيد الحذف ------------------------------ */

export function ConfirmDialog({ open, onClose, onConfirm, title, message, busy }) {
  const { t } = useI18n()
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title ?? t('common.confirm')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={busy}>
            {busy ? t('common.saving') : t('common.delete')}
          </Button>
        </>
      }
    >
      <p className="text-sm leading-relaxed text-slate-600">{message}</p>
    </Modal>
  )
}

/* -------------------------------- الجداول -------------------------------- */

export function TableWrap({ children }) {
  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-start text-sm">{children}</table>
      </div>
    </div>
  )
}

export function Th({ children, className = '' }) {
  return (
    <th
      className={`whitespace-nowrap border-b border-slate-200 bg-slate-50 px-4 py-3 text-start text-xs font-bold
                  uppercase tracking-wide text-slate-500 ${className}`}
    >
      {children}
    </th>
  )
}

export function Td({ children, className = '' }) {
  return <td className={`border-b border-slate-100 px-4 py-3 align-middle ${className}`}>{children}</td>
}

export function EmptyState({ title, message, action }) {
  return (
    <div className="card grid place-items-center px-6 py-16 text-center">
      <div className="mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-slate-100 text-slate-400">
        <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.7">
          <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
          <path d="M3.5 10h17M9 15h6" strokeLinecap="round" />
        </svg>
      </div>
      <h3 className="text-sm font-bold text-slate-800">{title}</h3>
      {message && <p className="mt-1 max-w-xs text-xs text-slate-500">{message}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

/* -------------------------------- الشارات -------------------------------- */

export function Badge({ tone = 'slate', children }) {
  const tones = {
    slate: 'bg-slate-200/70 text-slate-600 dark:bg-slate-200 dark:text-slate-700',
    green: 'bg-emerald-50 text-emerald-700',
    amber: 'bg-amber-50 text-amber-700',
    red: 'bg-red-50 text-red-700',
    brand: 'bg-brand-50 text-brand-700',
    sky: 'bg-sky-50 text-sky-700',
  }
  return (
    <span className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-bold ${tones[tone]}`}>{children}</span>
  )
}

/* ------------------------------ بطاقة إحصائية ---------------------------- */

export function StatCard({ label, value, suffix, tone = 'text-brand-600 bg-brand-50', Icon }) {
  return (
    <div className="card p-5">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-semibold text-slate-500">{label}</p>
        {Icon && (
          <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${tone}`}>
            <Icon className="h-[18px] w-[18px]" />
          </span>
        )}
      </div>
      <p className="mt-4 text-2xl font-extrabold text-slate-900">
        <span className="num">{value}</span>
        {suffix && <span className="ms-1.5 text-sm font-semibold text-slate-400">{suffix}</span>}
      </p>
    </div>
  )
}

/* -------------------------------- البحث ---------------------------------- */

export function SearchInput({ value, onChange, placeholder, className = 'w-full sm:w-72' }) {
  return (
    <div className={`relative ${className}`}>
      <span className="pointer-events-none absolute inset-y-0 start-3 grid place-items-center text-slate-400">
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.2-3.2" strokeLinecap="round" />
        </svg>
      </span>
      <input
        value={value}
        onChange={(event) => {
          if (typeof onChange === 'function') {
            const val = event.target.value
            // Hybrid object supporting string behavior AND .target.value
            const hybrid = Object.assign(new String(val), {
              target: { value: val },
              currentTarget: { value: val },
              toString: () => val,
              valueOf: () => val,
            })
            onChange(hybrid)
          }
        }}
        placeholder={placeholder}
        className="w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white py-2.5 pe-4 ps-9 text-sm outline-none
                   transition placeholder:text-slate-400 focus:border-brand-500 focus:ring-4 focus:ring-brand-500/10"
      />
    </div>
  )
}

/* ------------------------------ حالة التحميل ----------------------------- */

export function Loading() {
  const { t } = useI18n()
  return (
    <div className="grid place-items-center py-20 text-sm font-medium text-slate-400">{t('common.loading')}</div>
  )
}

/* ------------------------------ توقيع المنفّذ ---------------------------- */

/** Evolex هي الجهة المنفّذة للنظام؛ iyora هي الشركة المستخدِمة له. */
export function PoweredBy({ tone = 'light', className = '' }) {
  const colour = tone === 'dark' ? 'text-slate-500' : 'text-slate-400'
  return (
    <p className={`text-[11px] font-semibold tracking-wide ${colour} ${className}`} dir="ltr">
      Powered by <span className="font-extrabold">Evolex</span>
    </p>
  )
}
