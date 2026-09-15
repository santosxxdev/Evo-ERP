/*
 * رفع الصور إلى Cloudinary عبر «Unsigned upload preset».
 * لا يوجد أي مفتاح سري في الواجهة — الـpreset مصمّم للرفع من المتصفح،
 * واسم الحساب عام. تم إنشاء الـpreset مسبقًا على حساب evolex.
 */
export const CLOUDINARY_CLOUD = 'evolex'
export const CLOUDINARY_PRESET = 'iyora_unsigned'

const MAX_BYTES = 5 * 1024 * 1024

export async function uploadImage(file) {
  if (!file) throw new Error('no-file')
  if (!file.type?.startsWith('image/')) throw new Error('not-image')
  if (file.size > MAX_BYTES) throw new Error('too-large')

  const body = new FormData()
  body.append('file', file)
  body.append('upload_preset', CLOUDINARY_PRESET)

  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/image/upload`,
    { method: 'POST', body },
  )

  if (!response.ok) {
    const detail = await response.json().catch(() => null)
    throw new Error(detail?.error?.message || 'upload-failed')
  }

  const data = await response.json()
  return data.secure_url
}
