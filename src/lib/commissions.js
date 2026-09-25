import { COL, createDoc, updateDocById } from './db'
import { toNumber, round2, formatMoney } from './format'
import { resolveCommissionConfig, invoiceFees, commissionFor } from './costing'

// Create a custom sales period
// إنشاء فترة مبيعات جديدة
export async function createSalesPeriod({ name, startDate, endDate }) {
  if (!name) throw new Error("Name is required");
  if (startDate >= endDate) throw new Error("Start date must be before end date");
  
  return createDoc(COL.salesPeriods || 'salesPeriods', { 
    name, 
    startDate, 
    endDate, 
    closed: false 
  });
}

// Toggle period open/closed
// فتح/إغلاق فترة المبيعات
export async function toggleSalesPeriodStatus(id, closed) {
  return updateDocById(COL.salesPeriods || 'salesPeriods', id, { closed: Boolean(closed) });
}

// Calculate commission summary for all employees in a date range
// حساب ملخص العمولات لجميع الموظفين في فترة محددة
export function calculatePeriodCommissions({ employees, departments, invoices, jobCosts, startDate, endDate }) {
  // Filter invoices in date range and not cancelled
  const validInvoices = invoices.filter(inv => {
    return inv.date >= startDate && inv.date <= endDate && !inv.cancelled;
  });

  const employeeStats = {};

  // Group by employeeId
  validInvoices.forEach(inv => {
    const empId = inv.employeeId;
    if (!empId) return;

    if (!employeeStats[empId]) {
      employeeStats[empId] = {
        employeeId: empId,
        invoices: []
      };
    }
    employeeStats[empId].invoices.push(inv);
  });

  const results = [];

  for (const empId in employeeStats) {
    const empData = employeeStats[empId];
    const employee = employees.find(e => e.id === empId);
    if (!employee) continue;

    const config = resolveCommissionConfig(employee, departments);
    
    let totalSales = 0;
    let paidSales = 0;

    // Calculate total and paid sales based on fees
    empData.invoices.forEach(inv => {
      const fees = invoiceFees(inv);
      const total = toNumber(inv.total);
      const paidAmount = toNumber(inv.paidAmount);
      const paid = Math.min(paidAmount, total);
      
      totalSales += fees;
      
      const paidRatio = total > 0 ? paid / total : 0;
      paidSales += fees * paidRatio;
    });

    totalSales = round2(totalSales);
    paidSales = round2(paidSales);

    let commissionEarned = 0;
    
    // Tiered calculation based on PAID amount
    const target = toNumber(config.targetAmount);
    const rate = toNumber(config.commissionRate);
    
    if (target > 0 && config.overTargetCommissionEnabled) {
       if (config.requireTargetForCommission && paidSales < target) {
          commissionEarned = 0;
       } else {
          const baseSales = Math.min(paidSales, target);
          const overSales = Math.max(0, paidSales - target);
          
          const baseComm = baseSales * (rate / 100);
          const overComm = overSales * (toNumber(config.overTargetCommissionRate) / 100);
          
          commissionEarned = round2(baseComm + overComm);
       }
    } else {
       if (config.requireTargetForCommission && paidSales < target) {
          commissionEarned = 0;
       } else {
          commissionEarned = round2(paidSales * (rate / 100));
       }
    }

    // Commission Paid from jobCosts
    let commissionPaid = 0;
    const empInvoiceIds = empData.invoices.map(i => i.id);
    const relevantJobCosts = jobCosts.filter(jc => 
      jc.type === 'commission' && 
      jc.employeeId === empId && 
      empInvoiceIds.includes(jc.invoiceId || jc.entityId)
    );
    
    relevantJobCosts.forEach(jc => {
      if (jc.paid) {
        commissionPaid += toNumber(jc.amount);
      }
    });

    commissionPaid = round2(commissionPaid);
    const commissionDue = round2(commissionEarned - commissionPaid);

    results.push({
      employeeId: empId,
      employeeName: employee.name,
      departmentId: employee.departmentId,
      totalSales,
      paidSales,
      commissionRate: rate,
      commissionEarned,
      commissionPaid,
      commissionDue,
      invoiceCount: empData.invoices.length
    });
  }

  return results;
}

// Detailed breakdown for a single employee in a period
// تفاصيل عمولات موظف واحد في فترة محددة
export function employeePeriodDetail({ employee, departments, invoices, jobCosts, startDate, endDate }) {
  const validInvoices = invoices.filter(inv => {
    return inv.employeeId === employee.id && 
           inv.date >= startDate && 
           inv.date <= endDate && 
           !inv.cancelled;
  });

  const config = resolveCommissionConfig(employee, departments);
  const rate = toNumber(config.commissionRate);
  
  let totalSales = 0;
  let paidSales = 0;

  const invoiceDetails = validInvoices.map(inv => {
    const fees = invoiceFees(inv);
    const total = toNumber(inv.total);
    const paidAmount = Math.min(toNumber(inv.paidAmount), total);
    const paidRatio = total > 0 ? paidAmount / total : 0;
    
    const invPaidSales = fees * paidRatio;
    const invCommission = round2(invPaidSales * (rate / 100));

    totalSales += fees;
    paidSales += invPaidSales;

    return {
      invoiceId: inv.id,
      invoiceNumber: inv.number || inv.id,
      clientName: inv.clientName || '',
      date: inv.date,
      total,
      paidAmount,
      commissionRate: rate,
      commissionAmount: invCommission, // Basic rate calculation per invoice
      fees,
      paidSales: invPaidSales
    };
  });

  totalSales = round2(totalSales);
  paidSales = round2(paidSales);

  let commissionEarned = 0;
  const target = toNumber(config.targetAmount);
  
  if (target > 0 && config.overTargetCommissionEnabled) {
     if (config.requireTargetForCommission && paidSales < target) {
        commissionEarned = 0;
     } else {
        const baseSales = Math.min(paidSales, target);
        const overSales = Math.max(0, paidSales - target);
        const baseComm = baseSales * (rate / 100);
        const overComm = overSales * (toNumber(config.overTargetCommissionRate) / 100);
        commissionEarned = round2(baseComm + overComm);
     }
  } else {
     if (config.requireTargetForCommission && paidSales < target) {
        commissionEarned = 0;
     } else {
        commissionEarned = round2(paidSales * (rate / 100));
     }
  }

  const empInvoiceIds = validInvoices.map(i => i.id);
  const relevantJobCosts = jobCosts.filter(jc => 
    jc.type === 'commission' && 
    jc.employeeId === employee.id && 
    empInvoiceIds.includes(jc.invoiceId || jc.entityId)
  );

  let commissionPaid = 0;
  relevantJobCosts.forEach(jc => {
    if (jc.paid) {
      commissionPaid += toNumber(jc.amount);
    }
  });

  commissionPaid = round2(commissionPaid);
  const commissionDue = round2(commissionEarned - commissionPaid);

  return {
    summary: {
      totalSales,
      paidSales,
      commissionEarned,
      commissionPaid,
      commissionDue,
      invoiceCount: validInvoices.length
    },
    invoices: invoiceDetails,
    targetInfo: {
      targetAmount: target,
      requireTargetForCommission: config.requireTargetForCommission,
      overTargetCommissionEnabled: config.overTargetCommissionEnabled,
      overTargetCommissionRate: toNumber(config.overTargetCommissionRate),
      achievedPercentage: target > 0 ? round2((paidSales / target) * 100) : 0
    }
  };
}

// Mark specific jobCost commission records as paid
// صرف العمولات بتحديث سجلات التكلفة
export async function disburseCommissions({ jobCostIds, date }) {
  for (const id of jobCostIds) {
    await updateDocById(COL.jobCosts || 'jobCosts', id, { paid: true, paidDate: date });
  }
}
