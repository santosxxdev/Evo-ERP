import { useEffect, useRef, useState } from 'react'

export default function SearchableSelect({
  options = [],
  value,
  onChange,
  placeholder = 'اختر من القائمة...',
  searchPlaceholder = 'ابحث بالاسم، الهاتف، أو الكود...',
  disabled = false,
  className = '',
  emptyText = 'لا توجد نتائج طابقت البحث',
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const containerRef = useRef(null)
  const searchInputRef = useRef(null)

  const selectedOption = options.find((opt) => String(opt.id ?? opt.value ?? opt) === String(value))

  const normalize = (text = '') =>
    String(text)
      .toLowerCase()
      .replace(/[أإآ]/g, 'ا')
      .replace(/[يى]/g, 'ي')
      .replace(/ة/g, 'ه')
      .replace(/ـ/g, '')
      .trim()

  const queryNormalized = normalize(search)

  const filteredOptions = options.filter((opt) => {
    if (!queryNormalized) return true
    const name = normalize(opt.name ?? opt.label ?? opt)
    const code = normalize(opt.code ?? opt.accountNumber ?? '')
    const phone = normalize(opt.phone ?? opt.mobile ?? '')
    const email = normalize(opt.email ?? '')
    return (
      name.includes(queryNormalized) ||
      code.includes(queryNormalized) ||
      phone.includes(queryNormalized) ||
      email.includes(queryNormalized)
    )
  })

  useEffect(() => {
    function handleClickOutside(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  useEffect(() => {
    if (open) {
      setTimeout(() => searchInputRef.current?.focus(), 50)
    } else {
      setSearch('')
    }
  }, [open])

  function handleSelect(optValue) {
    onChange(optValue)
    setOpen(false)
  }

  return (
    <div ref={containerRef} className={`relative w-full ${className}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((prev) => !prev)}
        className={`flex w-full items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm text-slate-800 outline-none transition focus:border-brand-500 focus:ring-4 focus:ring-brand-500/10 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:opacity-60 ${
          open ? 'border-brand-500 ring-4 ring-brand-500/10' : ''
        }`}
      >
        <span className={`truncate ${!selectedOption ? 'text-slate-400' : 'font-semibold text-slate-800'}`}>
          {selectedOption ? (selectedOption.name ?? selectedOption.label ?? selectedOption) : placeholder}
        </span>
        <svg
          className={`h-4 w-4 shrink-0 text-slate-400 transition-transform duration-200 ${open ? 'rotate-180 text-brand-600' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 max-h-72 w-full min-w-[220px] overflow-hidden rounded-2xl border border-slate-200 bg-white p-2 shadow-xl ring-1 ring-black/5 animate-in fade-in slide-in-from-top-2 duration-150">
          <div className="relative mb-2">
            <svg
              className="pointer-events-none absolute right-3 top-3 h-4 w-4 text-slate-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
            <input
              ref={searchInputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={searchPlaceholder}
              className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2 pr-9 pl-7 text-xs outline-none transition focus:border-brand-500 focus:bg-white focus:ring-2 focus:ring-brand-500/10"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute left-2.5 top-2.5 text-xs text-slate-400 hover:text-slate-600"
              >
                ✕
              </button>
            )}
          </div>

          <div className="max-h-52 overflow-y-auto space-y-0.5 pr-1 scrollbar-thin">
            <button
              type="button"
              onClick={() => handleSelect('')}
              className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-xs font-medium transition ${
                !value ? 'bg-brand-50 text-brand-700 font-bold' : 'text-slate-500 hover:bg-slate-50'
              }`}
            >
              <span>— {placeholder}</span>
            </button>

            {filteredOptions.length === 0 ? (
              <div className="px-3 py-4 text-center text-xs font-medium text-slate-400">{emptyText}</div>
            ) : (
              filteredOptions.map((opt) => {
                const optId = opt.id ?? opt.value ?? opt
                const optName = opt.name ?? opt.label ?? opt
                const isSelected = String(optId) === String(value)
                const isGroup = Boolean(opt.isGroup)

                return (
                  <button
                    key={optId}
                    type="button"
                    onClick={() => handleSelect(optId)}
                    className={`flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-xs transition ${
                      isSelected
                        ? 'bg-brand-600 text-white font-bold shadow-sm'
                        : isGroup
                        ? 'bg-purple-50/80 text-purple-950 font-bold hover:bg-purple-100 border-r-4 border-r-purple-600'
                        : 'text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    <div className="flex items-center gap-2 truncate min-w-0">
                      {opt.icon && <span className="shrink-0">{opt.icon}</span>}
                      <span className="truncate">{optName}</span>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0 ms-2">
                      {opt.badge && (
                        <span
                          className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold ${
                            isSelected
                              ? 'bg-white/20 text-white'
                              : isGroup
                              ? 'bg-purple-200/80 text-purple-800 border border-purple-300'
                              : 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                          }`}
                        >
                          {opt.badge}
                        </span>
                      )}
                      {opt.phone && (
                        <span
                          className={`text-[10px] dir-ltr ${
                            isSelected ? 'text-brand-100' : 'text-slate-400'
                          }`}
                        >
                          {opt.phone}
                        </span>
                      )}
                    </div>
                  </button>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}
