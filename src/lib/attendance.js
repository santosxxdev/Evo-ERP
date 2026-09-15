import { addDoc, collection, doc, getDoc, getDocs, setDoc, updateDoc } from 'firebase/firestore'
import * as XLSX from 'xlsx'
import { db } from './firebase'
import { COL } from './db'

export const DEFAULT_ATTENDANCE_SETTINGS = {
  shiftStartTime: '09:00',
  shiftEndTime: '17:00',
  workHoursPerDay: 8,
  gracePeriodMinutes: 15,
  overtimeRate: 1.5,
  lateDeductionRate: 1.0,
  absenceDeductionDays: 1.0,
}

export async function getAttendanceSettings() {
  try {
    const snap = await getDoc(doc(db, 'attendanceSettings', 'default'))
    if (snap.exists()) {
      return { ...DEFAULT_ATTENDANCE_SETTINGS, ...snap.data() }
    }
  } catch (err) {
    console.error('Failed to get attendance settings:', err)
  }
  return DEFAULT_ATTENDANCE_SETTINGS
}

export async function saveAttendanceSettings(settings) {
  const settingsRef = doc(db, 'attendanceSettings', 'default')
  await setDoc(settingsRef, { ...settings, updatedAt: new Date() }, { merge: true })
}

/**
 * Parses uploaded Excel / CSV file containing fingerprint attendance logs.
 * Supports multiple standard headers (Arabic & English).
 */
export async function parseBiometricExcelFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()

    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result)
        const workbook = XLSX.read(data, { type: 'array' })
        const firstSheetName = workbook.SheetNames[0]
        const worksheet = workbook.Sheets[firstSheetName]
        const jsonRows = XLSX.utils.sheet_to_json(worksheet, { defval: '' })

        if (!jsonRows || jsonRows.length === 0) {
          throw new Error('الملف فارغ أو لا يحتوي على بيانات صحيحة.')
        }

        const parsedRecords = []

        jsonRows.forEach((row, index) => {
          // Detect headers dynamically
          const keys = Object.keys(row)
          const findVal = (possibleKeys) => {
            const matchedKey = keys.find((k) =>
              possibleKeys.some((p) => k.toLowerCase().trim() === p.toLowerCase().trim()),
            )
            return matchedKey ? String(row[matchedKey]).trim() : ''
          }

          const employeeCode = findVal(['كود الموظف', 'رقم الموظف', 'الرقم الوظيفي', 'employeeCode', 'code', 'emp_code', 'emp_id', 'ID', 'EmpNo', 'User ID'])
          const employeeName = findVal(['اسم الموظف', 'الموظف', 'name', 'emp_name', 'Employee Name', 'Name'])
          const dateVal = findVal(['التاريخ', 'تاريخ', 'date', 'Date', 'AttDate', 'WorkDate'])
          const checkIn = findVal(['وقت الحضور', 'حضور', 'دخول', 'checkIn', 'check_in', 'InTime', 'TimeIn', 'In', 'Clock In'])
          const checkOut = findVal(['وقت الانصراف', 'انصراف', 'خروج', 'checkOut', 'check_out', 'OutTime', 'TimeOut', 'Out', 'Clock Out'])

          if (employeeCode || employeeName || dateVal) {
            parsedRecords.push({
              rowNumber: index + 2,
              employeeCode,
              employeeName,
              date: dateVal,
              checkIn,
              checkOut,
              rawRow: row,
            })
          }
        })

        resolve(parsedRecords)
      } catch (err) {
        reject(err)
      }
    }

    reader.onerror = (error) => reject(error)
    reader.readAsArrayBuffer(file)
  })
}

/**
 * Calculates late minutes, work hours, overtime based on company attendance settings.
 */
export function calculateAttendanceMetrics(checkIn, checkOut, settings = DEFAULT_ATTENDANCE_SETTINGS) {
  let lateMinutes = 0
  let overtimeHours = 0
  let workHours = 0
  let status = 'present'

  if (!checkIn) {
    return {
      status: 'absent',
      lateMinutes: 0,
      overtimeHours: 0,
      workHours: 0,
    }
  }

  // Parse shift start time (e.g. "09:00")
  const [shiftStartH, shiftStartM] = (settings.shiftStartTime || '09:00').split(':').map(Number)
  const shiftStartTotalMins = shiftStartH * 60 + shiftStartM
  const graceMins = Number(settings.gracePeriodMinutes || 15)

  // Parse actual check in time
  const cleanInStr = checkIn.replace(/[^\d:]/g, '')
  if (cleanInStr && cleanInStr.includes(':')) {
    const [inH, inM] = cleanInStr.split(':').map(Number)
    const inTotalMins = inH * 60 + inM
    if (inTotalMins > shiftStartTotalMins + graceMins) {
      lateMinutes = inTotalMins - shiftStartTotalMins
      status = 'late'
    }
  }

  // Parse check out & work hours
  if (checkIn && checkOut) {
    const cleanOutStr = checkOut.replace(/[^\d:]/g, '')
    if (cleanInStr.includes(':') && cleanOutStr.includes(':')) {
      const [inH, inM] = cleanInStr.split(':').map(Number)
      const [outH, outM] = cleanOutStr.split(':').map(Number)
      let diffMins = (outH * 60 + outM) - (inH * 60 + inM)
      if (diffMins < 0) diffMins += 24 * 60 // crossed midnight
      workHours = Number((diffMins / 60).toFixed(2))

      const expectedHours = Number(settings.workHoursPerDay || 8)
      if (workHours > expectedHours) {
        overtimeHours = Number((workHours - expectedHours).toFixed(2))
      }
    }
  }

  return {
    status,
    lateMinutes,
    overtimeHours,
    workHours,
  }
}

/**
 * Saves a batch of attendance records to Firestore.
 */
export async function saveAttendanceBatch(records, settings) {
  // Fetch existing employees to link employeeId & departmentId
  const empSnap = await getDocs(collection(db, COL.employees))
  const employees = empSnap.docs.map((d) => ({ id: d.id, ...d.data() }))

  let savedCount = 0

  for (const rec of records) {
    // Find matching employee by code or name
    const matchedEmp = employees.find(
      (e) =>
        (rec.employeeCode && e.employeeCode && e.employeeCode.trim().toLowerCase() === rec.employeeCode.trim().toLowerCase()) ||
        (rec.employeeName && e.name && e.name.trim().toLowerCase() === rec.employeeName.trim().toLowerCase()),
    )

    const metrics = calculateAttendanceMetrics(rec.checkIn, rec.checkOut, settings)

    await addDoc(collection(db, 'attendance'), {
      employeeId: matchedEmp ? matchedEmp.id : null,
      employeeCode: rec.employeeCode || (matchedEmp ? matchedEmp.employeeCode : ''),
      employeeName: rec.employeeName || (matchedEmp ? matchedEmp.name : ''),
      departmentId: matchedEmp ? matchedEmp.departmentId : null,
      date: rec.date || new Date().toISOString().split('T')[0],
      checkIn: rec.checkIn || '',
      checkOut: rec.checkOut || '',
      status: metrics.status,
      lateMinutes: metrics.lateMinutes,
      overtimeHours: metrics.overtimeHours,
      workHours: metrics.workHours,
      createdAt: new Date(),
    })

    savedCount++
  }

  return { savedCount }
}

/**
 * Generates and downloads a sample Excel template for Fingerprint Sheet uploading.
 */
export function generateAttendanceExcelTemplate() {
  const templateData = [
    {
      'كود الموظف': 'EMP-2026-0001',
      'اسم الموظف': 'أحمد محمود علي',
      'التاريخ': '2026-09-15',
      'وقت الحضور': '09:00',
      'وقت الانصراف': '17:00',
      'ملاحظات': 'حضور منتظم',
    },
    {
      'كود الموظف': 'EMP-2026-0002',
      'اسم الموظف': 'سارة أحمد حسن',
      'التاريخ': '2026-09-15',
      'وقت الحضور': '09:30',
      'وقت الانصراف': '17:15',
      'ملاحظات': 'تأخير 30 دقيقة',
    },
  ]

  const worksheet = XLSX.utils.json_to_sheet(templateData)
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, 'قالب البصمة')

  // Auto-fit column widths
  worksheet['!cols'] = [
    { wch: 18 },
    { wch: 22 },
    { wch: 15 },
    { wch: 15 },
    { wch: 15 },
    { wch: 25 },
  ]

  XLSX.writeFile(workbook, 'قالب_رفع_بيانات_البصمة.xlsx')
}
