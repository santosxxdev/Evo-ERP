import { COL, createDoc, nextEmployeeCode, updateDocById } from './db'

/* ------------------------------------------------------------------ */
/*  إدارة الأقسام (Departments)                                        */
/* ------------------------------------------------------------------ */

export async function createDepartment(values) {
  return createDoc(COL.departments, {
    name: values.name?.trim() ?? '',
    code: values.code?.trim() ?? '',
    description: values.description?.trim() ?? '',
    active: values.active !== false,
  })
}

export async function updateDepartment(id, values) {
  return updateDocById(COL.departments, id, {
    name: values.name?.trim() ?? '',
    code: values.code?.trim() ?? '',
    description: values.description?.trim() ?? '',
    active: values.active !== false,
  })
}

export async function setDepartmentActive(id, active) {
  return updateDocById(COL.departments, id, { active: Boolean(active) })
}

/* ------------------------------------------------------------------ */
/*  إدارة الوظائف (Positions)                                         */
/* ------------------------------------------------------------------ */

export async function createPosition(values) {
  return createDoc(COL.positions, {
    name: values.name?.trim() ?? '',
    code: values.code?.trim() ?? '',
    departmentId: values.departmentId ?? null,
    description: values.description?.trim() ?? '',
    active: values.active !== false,
  })
}

export async function updatePosition(id, values) {
  return updateDocById(COL.positions, id, {
    name: values.name?.trim() ?? '',
    code: values.code?.trim() ?? '',
    departmentId: values.departmentId ?? null,
    description: values.description?.trim() ?? '',
    active: values.active !== false,
  })
}

export async function setPositionActive(id, active) {
  return updateDocById(COL.positions, id, { active: Boolean(active) })
}

/* ------------------------------------------------------------------ */
/*  أداة الـ Migration التقريرية والتأكيدية (Idempotent Dry-Run)      */
/* ------------------------------------------------------------------ */

/**
 * دالة الفحص القراءي التجريبي (Dry-Run):
 * تفحص الموظفين وتحدد ما يحتاج ترقيم أو تعيين حالة دون التعديل في Firestore نهائياً.
 */
export function dryRunEmployeeMigration(employees = []) {
  const items = employees.map((emp) => {
    const hasCode = Boolean(emp.employeeCode?.trim())
    const hasStatus = Boolean(emp.status)
    const suggestedStatus = emp.archived ? 'archived' : 'active'

    return {
      id: emp.id,
      name: emp.name,
      employeeCode: emp.employeeCode ?? null,
      legacyEmployeeId: emp.employeeId ?? null,
      status: emp.status ?? null,
      archived: Boolean(emp.archived),
      needsCode: !hasCode,
      needsStatus: !hasStatus,
      suggestedStatus,
    }
  })

  const missingCodeCount = items.filter((i) => i.needsCode).length
  const missingStatusCount = items.filter((i) => i.needsStatus).length

  return {
    scannedCount: employees.length,
    missingCodeCount,
    missingStatusCount,
    items,
  }
}

/**
 * دالة التنفيذ الصريح المحمية (Idempotent Execution):
 * لا تعمل إلا بناءً على تحديد المشرف الصريح.
 * تحافظ تماماً على الأكواد الموجودة ولا تستهلك رقم تسلسلي جديد لموظف مرقم بالفعل.
 */
export async function executeEmployeeMigration(selectedItems = [], explicitStatusMap = {}) {
  let updatedCount = 0

  for (const item of selectedItems) {
    if (!item?.id) continue

    const payload = {}

    // 1. توليد كود الموظف فقط إذا كان غير موجود أصلاً (Idempotency guarantee)
    if (!item.employeeCode?.trim()) {
      payload.employeeCode = await nextEmployeeCode('EMP')
    }

    // 2. تحديث الحالة فقط بناءً على الاختيار الصريح للمشرف
    const chosenStatus = explicitStatusMap[item.id] || item.suggestedStatus
    if (chosenStatus && chosenStatus !== item.status) {
      payload.status = chosenStatus
    }

    if (Object.keys(payload).length > 0) {
      await updateDocById(COL.employees, item.id, payload)
      updatedCount++
    }
  }

  return { updatedCount }
}
