import { addDoc, collection, deleteDoc, doc, getDocs, setDoc, updateDoc } from 'firebase/firestore'
import { db } from './firebase'
import { COL } from './db'

export async function seedDemoData() {
  const result = {
    departmentsCreated: 0,
    positionsCreated: 0,
    employeesCreated: 0,
    clientsCreated: 0,
    invoicesCreated: 0,
    entriesCreated: 0,
    servicesCreated: 0,
    expensesCreated: 0,
    attendanceRecordsCreated: 0,
    allowancesCreated: 0,
    deductionsCreated: 0,
  }

  // ------------------------------------------------------------------
  // 1. Departments & Positions
  // ------------------------------------------------------------------
  const deptSnap = await getDocs(collection(db, COL.departments))
  let deptsMap = {}

  if (deptSnap.empty) {
    const defaultDepts = [
      { name: 'الموارد البشرية والشؤون الإدارية', code: 'HR', description: 'إدارة شؤون الموظفين والتوظيف والرواتب', active: true },
      { name: 'الحسابات والمالية', code: 'FIN', description: 'إدارة الحسابات، الخزينة، الميزانيات والفواتير', active: true },
      { name: 'المبيعات والتسويق', code: 'SAL', description: 'إدارة علاقات العملاء، المبيعات والحملات الإعلانية', active: true },
      { name: 'تكنولوجيا المعلومات والبرمجة', code: 'IT', description: 'تطوير ودعم التطبيقات والأنظمة والشبكات', active: true },
      { name: 'العمليات والإنتاج واللوجستيات', code: 'OPS', description: 'إدارة تشغيل المشاريع والخدمات اللوجستية', active: true },
      { name: 'الدعم الفني وخدمة العملاء', code: 'CS', description: 'إدارة استفسارات الدعم الفني وخدمات ما بعد البيع', active: true },
    ]

    for (const d of defaultDepts) {
      const docRef = await addDoc(collection(db, COL.departments), { ...d, createdAt: new Date() })
      deptsMap[d.code] = docRef.id
      result.departmentsCreated++
    }
  } else {
    deptSnap.docs.forEach((d) => {
      const data = d.data()
      if (data.code) deptsMap[data.code] = d.id
    })
  }

  const posSnap = await getDocs(collection(db, COL.positions))
  let posMap = {}

  if (posSnap.empty) {
    const defaultPositions = [
      { name: 'مدير موارد بشرية', code: 'HR-MGR', departmentId: deptsMap['HR'] || null, description: 'إدارة الموارد البشرية والسياسات', active: true },
      { name: 'أخصائي توظيف وشؤون موظفين', code: 'HR-SPEC', departmentId: deptsMap['HR'] || null, description: 'متابعة شؤون الموظفين والإجازات', active: true },
      { name: 'مدير مالي', code: 'FIN-DIR', departmentId: deptsMap['FIN'] || null, description: 'الإشراف المالي والتقارير الميزانية', active: true },
      { name: 'محاسب أول', code: 'FIN-SR', departmentId: deptsMap['FIN'] || null, description: 'مراجعة وتدقيق القيود والفواتير', active: true },
      { name: 'محاسب خزانة ومبيعات', code: 'FIN-ACC', departmentId: deptsMap['FIN'] || null, description: 'متابعة الخزينة والمقبوضات', active: true },
      { name: 'مدير مبيعات وتطوير أعمال', code: 'SAL-DIR', departmentId: deptsMap['SAL'] || null, description: 'إدارة إستراتيجية المبيعات والعملاء', active: true },
      { name: 'مسؤول مبيعات وتنفيذ', code: 'SAL-REP', departmentId: deptsMap['SAL'] || null, description: 'إدارة العروض المباشرة والمبيعات', active: true },
      { name: 'مهندس برمجيات أول (Senior Developer)', code: 'IT-SR', departmentId: deptsMap['IT'] || null, description: 'تطوير النواة الهندسية للنظام', active: true },
      { name: 'مطور واجهات وم مواقع (Web Developer)', code: 'IT-DEV', departmentId: deptsMap['IT'] || null, description: 'تطوير واجهات المستخدم والتطبيقات', active: true },
      { name: 'مدير عمليات ومشروعات', code: 'OPS-MGR', departmentId: deptsMap['OPS'] || null, description: 'إدارة المشاريع والعمليات التشغيلية', active: true },
    ]

    for (const p of defaultPositions) {
      const docRef = await addDoc(collection(db, COL.positions), { ...p, createdAt: new Date() })
      posMap[p.code] = docRef.id
      result.positionsCreated++
    }
  } else {
    posSnap.docs.forEach((d) => {
      const data = d.data()
      if (data.code) posMap[data.code] = d.id
    })
  }

  // ------------------------------------------------------------------
  // 2. 55 Employees (ضمان وجود وتحديث 55 موظفاً بكامل البيانات والرواتب)
  // ------------------------------------------------------------------
  const empSnap = await getDocs(collection(db, COL.employees))
  let existingEmps = empSnap.docs.map((d) => ({ id: d.id, ...d.data() }))

  const firstNames = ['أحمد', 'محمد', 'محمود', 'سارة', 'مريم', 'عمر', 'مصطفى', 'ياسمين', 'نورهان', 'علي', 'إبراهيم', 'حسن', 'حسين', 'طارق', 'شريف', 'خالد', 'عمرو', 'أسامة', 'هاني', 'زياد', 'رانيا', 'دينا', 'آية', 'أسماء', 'خديجة', 'فاطمة', 'عادل', 'حاتم', 'كريم', 'ماجد', 'نادر', 'وليد']
  const middleNames = ['محمود', 'أحمد', 'حسين', 'مصطفى', 'إبراهيم', 'فاروق', 'السيد', 'علي', 'حسن', 'عبدالعزيز', 'سليمان', 'فهمي', 'سعيد', 'نبيل']
  const familyNames = ['علي', 'حسن', 'خليل', 'فاروق', 'الشريف', 'منصور', 'العربي', 'السيد', 'بدوي', 'سالم', 'رضا', 'سليمان', 'زكي', 'صالح', 'جاد', 'عوف']
  const banks = ['البنك الأهلي المصري', 'بنك مصر', 'CIB البنك التجاري الدولي', 'بنك QNB الأهلي', 'بنك الإسكندرية', 'بنك القاهرة']
  const deptKeys = ['HR', 'FIN', 'SAL', 'IT', 'OPS', 'CS']
  const posKeys = ['HR-MGR', 'HR-SPEC', 'FIN-DIR', 'FIN-SR', 'FIN-ACC', 'SAL-DIR', 'SAL-REP', 'IT-SR', 'IT-DEV', 'OPS-MGR']

  // Update existing employees if they lack complete data
  for (const existingEmp of existingEmps) {
    const salary = Number(existingEmp.baseSalary || existingEmp.basicSalary || 12000)
    const empCode = existingEmp.employeeCode || `EMP-2026-${String(existingEmp.id).slice(-4)}`
    const phone = existingEmp.phone || '01012345678'

    await updateDoc(doc(db, COL.employees, existingEmp.id), {
      baseSalary: salary,
      basicSalary: salary,
      employeeCode: empCode,
      phone,
      departmentId: existingEmp.departmentId || deptsMap['HR'] || null,
      positionId: existingEmp.positionId || posMap['HR-MGR'] || null,
      status: existingEmp.status || 'active',
      nationalId: existingEmp.nationalId || '29501011234567',
      bankName: existingEmp.bankName || 'البنك الأهلي المصري',
      bankAccount: existingEmp.bankAccount || '1234567890123456',
    })
  }

  // Create additional employees up to 55
  const neededCount = 55 - existingEmps.length

  if (neededCount > 0) {
    const startIndex = existingEmps.length + 1
    for (let i = startIndex; i <= 55; i++) {
      const fName = firstNames[(i - 1) % firstNames.length]
      const mName = middleNames[(i * 3) % middleNames.length]
      const lName = familyNames[(i * 7) % familyNames.length]
      const fullName = `${fName} ${mName} ${lName}`

      const codeNum = String(i).padStart(4, '0')
      const empCode = `EMP-2026-${codeNum}`

      const dKey = deptKeys[i % deptKeys.length]
      const pKey = posKeys[i % posKeys.length]

      const salary = 9000 + (i % 12) * 2000
      const allowances = 1200 + (i % 5) * 600
      const deductions = 300 + (i % 4) * 100

      const phone = `01${(i % 4) === 0 ? '0' : (i % 4) === 1 ? '1' : (i % 4) === 2 ? '2' : '5'}${Math.floor(10000000 + Math.random() * 90000000)}`
      const email = `emp${i}@iyora.com`
      const nationalId = `29${80 + (i % 20)}${String(1000000000 + i * 123456).slice(0, 10)}`
      const status = i % 18 === 0 ? 'on_leave' : i % 25 === 0 ? 'suspended' : 'active'

      const empData = {
        name: fullName,
        employeeCode: empCode,
        departmentId: deptsMap[dKey] || null,
        positionId: posMap[pKey] || null,
        baseSalary: salary,
        basicSalary: salary,
        allowances,
        deductions,
        phone,
        email,
        nationalId,
        hireDate: `2024-0${(i % 8) + 1}-15`,
        status,
        bankName: banks[i % banks.length],
        bankAccount: `1000${String(i).padStart(4, '0')}${Math.floor(10000000 + Math.random() * 90000000)}`,
        createdAt: new Date(),
      }

      const docRef = await addDoc(collection(db, COL.employees), empData)
      existingEmps.push({ id: docRef.id, ...empData })
      result.employeesCreated++
    }
  }

  // Refetch all employees to get full list
  const fullEmpSnap = await getDocs(collection(db, COL.employees))
  const empList = fullEmpSnap.docs.map((d) => ({ id: d.id, ...d.data() }))

  // ------------------------------------------------------------------
  // 3. 30 Clients (ربط 30 عميل بالموظفين)
  // ------------------------------------------------------------------
  const clientSnap = await getDocs(collection(db, COL.clients))
  let existingClients = clientSnap.docs.map((d) => ({ id: d.id, ...d.data() }))

  const clientCompanies = [
    'شركة الأهرام للتطوير العقاري', 'مجموعة النيل للتسويق الرقمي', 'مصر للحلول البرمجية والتكنولوجية',
    'المجموعة المصرية للتجارة والمقاولات', 'شركة دبي للاستثمار والتنمية', 'فارما كير للخدمات الطبية',
    'جلوبال تيك للأنظمة التكنولوجية', 'أوراسكوم لإدارة المشاريع', 'شركة السويدي للحلول المتكاملة',
    'شركة الإسكندرية للشحن واللوجستيات', 'مجموعة الفطيم للتجزئة', 'شركة طلعت مصطفى للاستشارات',
    'كايرو براند لخدمات الدعاية', 'سينا للخدمات البترولية', 'مجموعة الشرق الأوسط للإعلام',
    'شركة القناة للتوريدات العمومية', 'المصرية للاتصالات والتكنولوجيا', 'شركة السلام للمقاولات العامة',
    'فودافون مصر لخدمات الأعمال', 'شركة راية لتكنولوجيا المعلومات', 'شركة جهينة للصناعات الغذائية',
    'مجموعة دومتي للتوزيع', 'السويدي إلكتريك للصناعات', 'شركة إعمار مصر للتطوير',
    'شركة أورنج للحلول الرقمية', 'مجموعة ماجد الفطيم العقارية', 'شركة بالم هيلز للتعمير',
    'سيراميكا كليوباترا جروب', 'شركة إيديتا للصناعات الغذائية', 'مجموعة حديد عز للصلب'
  ]

  const cities = ['القاهرة - التجمع الخامس', 'الجيزة - الدقي', 'الإسكندرية - سموحة', 'القاهرة - مدينة نصر', 'المنصورة - حي الجامعة', 'الجيزة - 6 أكتوبر']

  // Update existing clients to link employeeId
  for (let idx = 0; idx < existingClients.length; idx++) {
    const cl = existingClients[idx]
    const assignedEmp = empList[idx % empList.length]
    if (!cl.employeeId && assignedEmp) {
      await updateDoc(doc(db, COL.clients, cl.id), {
        employeeId: assignedEmp.id,
      })
    }
  }

  // Create additional clients up to 30
  const neededClients = 30 - existingClients.length
  if (neededClients > 0) {
    const startIndex = existingClients.length + 1
    for (let c = startIndex; c <= 30; c++) {
      const companyName = clientCompanies[c - 1]
      const contactPerson = `المهندس / ${['أحمد فؤاد', 'محمود سالم', 'عصام عبدالهادي', 'سامح رمزي', 'هاني فريد', 'شريف جلال'][(c - 1) % 6]}`
      const phone = `012${Math.floor(10000000 + Math.random() * 90000000)}`
      const email = `contact@client${c}.com`
      const address = cities[(c - 1) % cities.length]
      const taxNumber = `300-${c * 123}-${c * 456}`
      const commercialRegister = `CR-${100000 + c * 234}`

      const assignedEmp = empList[(c - 1) % empList.length]

      const clientData = {
        name: companyName,
        contactPerson,
        phone,
        email,
        address,
        taxNumber,
        commercialRegister,
        employeeId: assignedEmp ? assignedEmp.id : null,
        totalInvoiced: 0,
        totalPaid: 0,
        balance: 0,
        invoicesCount: 0,
        createdAt: new Date(),
      }

      const docRef = await addDoc(collection(db, COL.clients), clientData)
      existingClients.push({ id: docRef.id, ...clientData })
      result.clientsCreated++
    }
  }

  const fullClientSnap = await getDocs(collection(db, COL.clients))
  const clientList = fullClientSnap.docs.map((d) => ({ id: d.id, ...d.data() }))

  // ------------------------------------------------------------------
  // 4. 19 Invoices (ربط 19 فاتورة بالعملاء والموظفين)
  // ------------------------------------------------------------------
  const invSnap = await getDocs(collection(db, COL.invoices))
  let existingInvoices = invSnap.docs.map((d) => ({ id: d.id, ...d.data() }))

  for (let idx = 0; idx < existingInvoices.length; idx++) {
    const inv = existingInvoices[idx]
    const assignedEmp = empList[(idx * 2) % empList.length]
    if (!inv.employeeId && assignedEmp) {
      await updateDoc(doc(db, COL.invoices, inv.id), {
        employeeId: assignedEmp.id,
        employeeName: assignedEmp.name,
      })
    }
  }

  const neededInvoices = 19 - existingInvoices.length
  if (neededInvoices > 0 && clientList.length > 0 && empList.length > 0) {
    const governorates = ['محافظة القاهرة (خزينة الرئيسي)', 'محافظة الجيزة (خزينة الفرع)']
    const startIndex = existingInvoices.length + 1

    for (let i = startIndex; i <= 19; i++) {
      const client = clientList[(i - 1) % clientList.length]
      const assignedEmp = empList[(i * 2) % empList.length]
      const governorate = governorates[i % 2]
      const invNum = `INV-2026-${String(i).padStart(4, '0')}`

      const subtotal = 18000 + (i * 4500)
      const taxRate = 14
      const taxAmount = (subtotal * taxRate) / 100
      const total = subtotal + taxAmount
      const isPaidFull = i % 3 === 0
      const isPaidPartial = i % 3 === 1
      const paidAmount = isPaidFull ? total : isPaidPartial ? Math.round(total / 2) : 0
      const status = isPaidFull ? 'paid' : isPaidPartial ? 'partial' : 'sent'

      const invoiceData = {
        invoiceNumber: invNum,
        clientId: client.id,
        clientName: client.name,
        employeeId: assignedEmp ? assignedEmp.id : null,
        employeeName: assignedEmp ? assignedEmp.name : '',
        governorate,
        treasuryName: governorate,
        date: `2026-09-${String((i % 25) + 1).padStart(2, '0')}`,
        dueDate: `2026-10-${String((i % 25) + 1).padStart(2, '0')}`,
        subtotal,
        taxRate,
        taxAmount,
        total,
        paidAmount,
        balanceDue: total - paidAmount,
        status,
        items: [
          { description: 'تطوير وتصميم أنظمة برمجية وحملة إعلانية', quantity: 1, unitPrice: subtotal, total: subtotal }
        ],
        notes: `فاتورة رسمية صادرة لعميل - ${governorate}`,
        createdAt: new Date(),
      }

      const invRef = await addDoc(collection(db, COL.invoices), invoiceData)

      if (paidAmount > 0) {
        await addDoc(collection(db, `${COL.invoices}/${invRef.id}/payments`), {
          amount: paidAmount,
          date: invoiceData.date,
          method: 'تحويل بنكي / شيك خزينة',
          treasuryName: governorate,
          createdAt: new Date(),
        })
      }

      result.invoicesCreated++
    }
  }

  // ------------------------------------------------------------------
  // 5. Employee Entries (لتغذية "صافي المصروف له" لجميع الـ 55 موظف)
  // ------------------------------------------------------------------
  const entrySnap = await getDocs(collection(db, COL.employeeEntries))
  const existingEntries = entrySnap.docs.map((d) => d.data())

  for (const emp of empList) {
    const hasEntry = existingEntries.some((e) => e.employeeId === emp.id)
    if (!hasEntry) {
      const salaryAmt = Number(emp.baseSalary || emp.basicSalary || 12000)
      await addDoc(collection(db, COL.employeeEntries), {
        employeeId: emp.id,
        employeeName: emp.name,
        type: 'salary',
        amount: salaryAmt,
        paid: true,
        date: '2026-09-01',
        notes: 'صرف مرتب شهر سبتمبر 2026',
        createdAt: new Date(),
      })
      result.entriesCreated++

      if (Math.random() < 0.6) {
        const bonusAmt = 1500 + Math.floor(Math.random() * 2500)
        await addDoc(collection(db, COL.employeeEntries), {
          employeeId: emp.id,
          employeeName: emp.name,
          type: 'bonus',
          amount: bonusAmt,
          paid: true,
          date: '2026-09-10',
          notes: 'حافز أداء وتفوق',
          createdAt: new Date(),
        })
        result.entriesCreated++
      }
    }
  }

  // ------------------------------------------------------------------
  // 6. Attendance Records
  // ------------------------------------------------------------------
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

  const attSnap = await getDocs(collection(db, 'attendance'))
  if (attSnap.empty && empList.length > 0) {
    const dates = ['2026-09-11', '2026-09-12', '2026-09-13', '2026-09-14', '2026-09-15']

    for (const dtStr of dates) {
      for (const emp of empList) {
        const isLate = Math.random() < 0.2
        const isAbsent = Math.random() < 0.05
        const isOvertime = Math.random() < 0.15

        const lateMins = isLate ? Math.floor(20 + Math.random() * 40) : 0
        const otHours = isOvertime ? Number((1.5 + Math.random() * 2).toFixed(1)) : 0

        const checkIn = isAbsent ? '' : isLate ? `09:${String(15 + lateMins).padStart(2, '0')}` : '08:50'
        const checkOut = isAbsent ? '' : isOvertime ? `19:30` : '17:05'
        const status = isAbsent ? 'absent' : isLate ? 'late' : 'present'

        await addDoc(collection(db, 'attendance'), {
          employeeId: emp.id,
          employeeCode: emp.employeeCode || '',
          employeeName: emp.name || '',
          departmentId: emp.departmentId || null,
          date: dtStr,
          checkIn,
          checkOut,
          status,
          lateMinutes: lateMins,
          overtimeHours: otHours,
          workHours: isAbsent ? 0 : 8 + otHours,
          notes: isAbsent ? 'غياب بدون إذن' : isLate ? `تأخير بصمة ${lateMins} دقيقة` : 'حضور منتظم',
          createdAt: new Date(),
        })
        result.attendanceRecordsCreated++
      }
    }
  }

  return result
}

export async function clearDemoData() {
  const collectionsToDelete = [
    'employees',
    'departments',
    'positions',
    'clients',
    'invoices',
    'employeeEntries',
    'attendance',
    'employeeAllowances',
    'employeeDeductions',
    'expenses',
    'services',
    'payroll',
    'payrollRuns',
    'payrollItems',
  ]

  let deletedCount = 0

  for (const colName of collectionsToDelete) {
    try {
      const snap = await getDocs(collection(db, colName))
      for (const d of snap.docs) {
        await deleteDoc(doc(db, colName, d.id))
        deletedCount++
      }
    } catch (err) {
      console.warn(`Error clearing collection ${colName}:`, err)
    }
  }

  return { deletedCount }
}
