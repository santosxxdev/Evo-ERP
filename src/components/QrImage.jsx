import { useEffect, useState } from 'react'
import QRCode from 'qrcode'

/** كود QR كصورة PNG — يتولّد في المتصفح، بلا خدمة خارجية */
export default function QrImage({ value, size = 96, className = '' }) {
  const [src, setSrc] = useState('')

  useEffect(() => {
    let alive = true
    if (!value) {
      setSrc('')
      return undefined
    }
    QRCode.toDataURL(String(value), { margin: 1, width: size * 2, errorCorrectionLevel: 'M' })
      .then((url) => alive && setSrc(url))
      .catch(() => alive && setSrc(''))
    return () => {
      alive = false
    }
  }, [value, size])

  if (!src) return null
  return (
    <img
      src={src}
      alt="QR"
      width={size}
      height={size}
      className={className}
      style={{ width: size, height: size, imageRendering: 'pixelated' }}
    />
  )
}
