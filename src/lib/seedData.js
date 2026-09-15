import { addDoc, collection, doc, getDocs, setDoc } from 'firebase/firestore'
import { db } from './firebase'
import { COL } from './db'

export async function seedDemoData() {
  const result = {
    departmentsCreated: 0,
    positionsCreated: 0,
    employeesCreated: 0,
    attendanceSettingsCreated: false,
    attendanceRecordsCreated: 0,
    allowancesCreated: 0,
    deductionsCreated: 0,
  }

  // 1. Seed Departments if empty or create defaults
  const deptSnap = await getDocs(collection(db, COL.departments))
  let deptsMap = {}

  if (deptSnap.empty) {
    const defaultDepts = [
      { name: 'الموارد البشرية', code: 'HR', description: 'إدارة الشؤون الإدارية وشؤون الموظفين', active: true },
      { name: 'الحسابات والمالية', code: 'FIN', description: 'إدارة المعاملات المالية والإيرادات والمصروفات', active: true },
      { name: 'المبيعات والتسويق', code: 'SAL', description: 'إدارة المبيعات والتسويق والعلاقات العامة', active: true },
      { name: 'تكنولوجيا المعلومات والبرمجة', code: 'IT', description: 'تطوير ودعم الأنظمة والبرمجيات', active: true },
      { name: 'العمليات والإنتاج', code: 'OPS', description: 'إدارة المشاريع والخدمات اللوجستية والإنتاج', active: true },
    ]

    for (const d of defaultDepts) {
      const docRef = await addDoc(collection(db, COL.departments), {
        ...d,
        createdAt: new Date(),
      })
      deptsMap[d.code] = docRef.id
      result.departmentsCreated++
    }
  } else {
    deptSnap.docs.forEach((doc) => {
      const data = doc.data()
      if (data.code) deptsMap[data.code] = doc.id
    })
  }

  // 2. Seed Positions if empty
  const posSnap = await getDocs(collection(db, COL.positions))
  let posMap = {}

  if (posSnap.empty) {
    const defaultPositions = [
      { name: 'مدير موارد بشرية', code: 'HR-MGR', departmentId: deptsMap['HR'] || null, description: 'إدارة عمليات الموارد البشرية والتوظيف', active: true },
      { name: 'محاسب أول', code: 'FIN-ACC', departmentId: deptsMap['FIN'] || null, description: 'مراجعة وتسجيل القيود المحاسبية ومسيرات الراتب', active: true },
      { name: 'مهندس برمجيات', code: 'IT-DEV', departmentId: deptsMap['IT'] || null, description: 'تطوير وتحديث التطبيقات والأنظمة البرمجية', active: true },
      { name: 'مسؤول مبيعات', code: 'SAL-REP', departmentId: deptsMap['SAL'] || null, description: 'إدارة العملاء والعروض والمبيعات', active: true },
      { name: 'مشرف عمليات', code: 'OPS-SUP', departmentId: deptsMap['OPS'] || null, description: 'إشراف وتنسيق تنفيذ الخدمات والمشاريع', active: true },
    ]

    for (const p of defaultPositions) {
      const docRef = await addDoc(collection(db, COL.positions), {
        ...p,
        createdAt: new Date(),
      })
      posMap[p.code] = docRef.id
      result.positionsCreated++
    }
  } else {
    posSnap.docs.forEach((doc) => {
      const data = doc.data()
      if (data.code) posMap[data.code] = doc.id
    })
  }

  // 3. Seed Employees if empty
  const empSnap = await getDocs(collection(db, COL.employees))
  let empList = []

  if (empSnap.empty) {
    const defaultEmployees = [
      {
        name: 'أحمد محمود علي',
        employeeCode: 'EMP-2026-0001',
        departmentId: deptsMap['IT'] || null,
        positionId: posMap['IT-DEV'] || null,
        basicSalary: 15000,
        allowances: 2500,
        deductions: 500,
        phone: '01012345678',
        email: 'ahmed.ali@iyora.com',
        nationalId: '29501011234567',
        hireDate: '2024-01-15',
        status: 'active',
        bankName: 'البنك الأهلي المصري',
        bankAccount: '1234567890123456',
      },
      {
        name: 'سارة أحمد حسن',
        employeeCode: 'EMP-2026-0002',
        departmentId: deptsMap['HR'] || null,
        positionId: posMap['HR-MGR'] || null,
        basicSalary: 12000,
        allowances: 2000,
        deductions: 300,
        phone: '01123456789',
        email: 'sara.hassan@iyora.com',
        nationalId: '29602022345678',
        hireDate: '2024-03-01',
        status: 'active',
        bankName: 'بنك مصر',
        bankAccount: '2345678901234567',
      },
      {
        name: 'محمد إبراهيم خليل',
        employeeCode: 'EMP-2026-0003',
        departmentId: deptsMap['FIN'] || null,
        positionId: posMap['FIN-ACC'] || null,
        basicSalary: 14000,
        allowances: 2000,
        deductions: 400,
        phone: '01234567890',
        email: 'mohamed.khalil@iyora.com',
        nationalId: '29403033456789',
        hireDate: '2023-11-10',
        status: 'active',
        bankName: 'CIB بنك التجاري الدولي',
        bankAccount: '3456789012345678',
      },
      {
        name: 'مريم مصطفى السيد',
        employeeCode: 'EMP-2026-0004',
        departmentId: deptsMap['SAL'] || null,
        positionId: posMap['SAL-REP'] || null,
        basicSalary: 9000,
        allowances: 3500,
        deductions: 200,
        phone: '01545678901',
        email: 'maryam.elsayed@iyora.com',
        nationalId: '29704044567890',
        hireDate: '2024-05-20',
        status: 'active',
        bankName: 'بنك QNB الأهلي',
        bankAccount: '4567890123456789',
      },
      {
        name: 'عمر خالد فاروق',
        employeeCode: 'EMP-2026-0005',
        departmentId: deptsMap['OPS'] || null,
        positionId: posMap['OPS-SUP'] || null,
        basicSalary: 11000,
        allowances: 1500,
        deductions: 300,
        phone: '01098765432',
        email: 'omar.farouk@iyora.com',
        nationalId: '29305055678901',
        hireDate: '2024-02-01',
        status: 'active',
        bankName: 'البنك الأهلي المصري',
        bankAccount: '5678901234567890',
      },
    ]

    for (const emp of defaultEmployees) {
      const docRef = await addDoc(collection(db, COL.employees), {
        ...emp,
        createdAt: new Date(),
      })
      empList.push({ id: docRef.id, ...emp })
      result.employeesCreated++
    }
  } else {
    empList = empSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
  }

  // 4. Seed Attendance Settings
  const settingsRef = doc(db, 'attendanceSettings', 'default')
  await setDoc(
    settingsRef,
    {
      shiftStartTime: '09:00',
      shiftEndTime: '17:00',
      workHoursPerDay: 8,
      gracePeriodMinutes: 15,
      overtimeRate: 1.5,
      lateDeductionRate: 1.0,
      absenceDeductionDays: 1.0,
      updatedAt: new Date(),
    },
    { merge: true },
  )
  result.attendanceSettingsCreated = true

  // 5. Seed Attendance Logs for the past 3 days if empty
  const attSnap = await getDocs(collection(db, 'attendance'))
  if (attSnap.empty && empList.length > 0) {
    const today = new Date()
    const days = [0, 1, 2]

    for (const d of days) {
      const dt = new Date(today)
      dt.setDate(dt.getDate() - d)
      const dateStr = dt.toISOString().split('T')[0]

      for (const emp of empList) {
        const lateMins = d === 1 ? 25 : 0
        const checkIn = lateMins > 0 ? '09:25' : '08:55'
        const checkOut = '17:05'
        const status = lateMins > 0 ? 'late' : 'present'

        await addDoc(collection(db, 'attendance'), {
          employeeId: emp.id,
          employeeCode: emp.employeeCode || '',
          employeeName: emp.name || '',
          departmentId: emp.departmentId || null,
          date: dateStr,
          checkIn,
          checkOut,
          status,
          lateMinutes: lateMins,
          overtimeHours: 0,
          workHours: 8,
          notes: lateMins > 0 ? 'تأخير بصمة شيت تجريبي' : 'حضور منتظم',
          createdAt: new Date(),
        })
        result.attendanceRecordsCreated++
      }
    }
  }

  // 6. Seed Allowances & Deductions Definitions
  const allowSnap = await getDocs(collection(db, 'employeeAllowances'))
  if (allowSnap.empty) {
    const defaultAllowances = [
      { name: 'بدل انتقالات', code: 'TRANS', type: 'fixed', defaultAmount: 1000, description: 'بدل مواصلات وانتقالات داخلية' },
      { name: 'بدل سكن', code: 'HOUS', type: 'fixed', defaultAmount: 1500, description: 'بدل سكن وإقامة' },
      { name: 'حافز إنجاز وتفوق', code: 'PERF', type: 'percentage', defaultAmount: 10, description: 'حافز أداء شهري مرن' },
    ]
    for (const item of defaultAllowances) {
      await addDoc(collection(db, 'employeeAllowances'), { ...item, createdAt: new Date() })
      result.allowancesCreated++
    }
  }

  const dedSnap = await getDocs(collection(db, 'employeeDeductions'))
  if (dedSnap.empty) {
    const defaultDeductions = [
      { name: 'تأمين اجتماعي', code: 'SOC_INS', type: 'percentage', defaultAmount: 11, description: 'خصم حصة الموظف في التأمينات الاجتماعية' },
      { name: 'ضريبة كسب عمل', code: 'TAX_INC', type: 'percentage', defaultAmount: 5, description: 'ضريبة المرتبات وكسب العمل' },
      { name: 'خصم تاخير وغياب', code: 'LATE_ABS', type: 'hourly', defaultAmount: 1, description: 'خصم أوقات التأخير عن البصمة' },
    ]
    for (const item of defaultDeductions) {
      await addDoc(collection(db, 'employeeDeductions'), { ...item, createdAt: new Date() })
      result.deductionsCreated++
    }
  }

  return result
}
