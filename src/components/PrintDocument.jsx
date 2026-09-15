import { useEffect } from 'react'
import { createPortal } from 'react-dom'

/**
 * يرسم المحتوى داخل <div class="print-doc"> ملحق مباشرةً بـ <body>.
 * مخفي على الشاشة، ويظهر وحده عند الطباعة — فتطلع صفحة واحدة نظيفة
 * بلا مساحات المودال والقوائم ولا تكرار.
 */
export default function PrintDocument({ children }) {
  useEffect(() => {
    const on = () => document.body.classList.add('printing-doc')
    const off = () => document.body.classList.remove('printing-doc')
    window.addEventListener('beforeprint', on)
    window.addEventListener('afterprint', off)
    return () => {
      window.removeEventListener('beforeprint', on)
      window.removeEventListener('afterprint', off)
      document.body.classList.remove('printing-doc')
    }
  }, [])

  if (typeof document === 'undefined') return null
  return createPortal(<div className="print-doc">{children}</div>, document.body)
}
