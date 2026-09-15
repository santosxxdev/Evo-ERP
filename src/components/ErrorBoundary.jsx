import React from 'react'

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, errorInfo) {
    console.error('Uncaught React Error:', error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="grid min-h-dvh place-items-center bg-slate-900 px-4 text-center text-white">
          <div className="max-w-md space-y-4 rounded-2xl bg-slate-800 p-6 shadow-2xl border border-slate-700">
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-red-500/20 text-red-400">
              ⚠️
            </div>
            <h2 className="text-lg font-bold">حدث خطأ في تحميل الصفحة</h2>
            <p className="text-xs text-slate-400 leading-relaxed dir-ltr font-mono bg-slate-950 p-3 rounded-xl overflow-auto max-h-32 text-start">
              {this.state.error?.message || String(this.state.error)}
            </p>
            <div className="flex gap-2 justify-center pt-2">
              <button
                type="button"
                onClick={() => (window.location.href = '/')}
                className="rounded-xl bg-brand-600 px-4 py-2 text-xs font-semibold text-white hover:bg-brand-500"
              >
                الرئيسية
              </button>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="rounded-xl border border-slate-600 px-4 py-2 text-xs font-semibold text-slate-300 hover:bg-slate-700"
              >
                إعادة تحميل
              </button>
            </div>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
