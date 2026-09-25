import { useMemo, useState, useEffect } from 'react'
import { useI18n } from '../i18n'
import { useAuth } from '../context/AuthContext'
import { COL, useCollection } from '../lib/db'
import { clearDemoData, seedDemoData } from '../lib/seedData'
import {
  DEFAULT_ATTENDANCE_SETTINGS,
  generateAttendanceExcelTemplate,
  getAttendanceSettings,
  parseBiometricExcelFile,
  saveAttendanceBatch,
  saveAttendanceSettings,
} from '../lib/attendance'
import {
  Badge,
  Button,
  Field,
  Input,
  Loading,
  PageHeader,
  SearchInput,
  Select,
  StatCard,
  TableWrap,
  Td,
  Th,
} from '../components/ui'

export default function Attendance() {
  const { t } = useI18n()
  const { role } = useAuth()
  const canModify = role === 'admin' || role === 'accountant'

  // Tabs: 'logs', 'import', 'settings', 'deductions'
  const [activeTab, setActiveTab] = useState('logs')

  // Collection subscriptions
  const { rows: attendanceLogs, loading: loadingLogs } = useCollection('attendance', 'date', 'desc')
  const { rows: employees } = useCollection(COL.employees, 'name', 'asc')
  const { rows: departments } = useCollection(COL.departments, 'name', 'asc')
  const { rows: allowances } = useCollection('employeeAllowances', 'name', 'asc')
  const { rows: deductions } = useCollection('employeeDeductions', 'name', 'asc')

  // Attendance Settings state
  const [settings, setSettings] = useState(DEFAULT_ATTENDANCE_SETTINGS)
  const [loadingSettings, setLoadingSettings] = useState(true)
  const [settingsBusy, setSettingsBusy] = useState(false)

  // Excel Import state
  const [parsedRecords, setParsedRecords] = useState([])
  const [importingFile, setImportingFile] = useState(false)
  const [importSuccessMsg, setImportSuccessMsg] = useState('')
  const [seedMsg, setSeedMsg] = useState('')
  const [seeding, setSeeding] = useState(false)

  // Logs Filter state
  const [search, setSearch] = useState('')
  const [filterDate, setFilterDate] = useState('')
  const [filterDept, setFilterDept] = useState('')

  useEffect(() => {
    getAttendanceSettings().then((s) => {
      setSettings(s)
      setLoadingSettings(false)
    })
  }, [])

  // Filter attendance logs
  const filteredLogs = useMemo(() => {
    return attendanceLogs.filter((log) => {
      const matchSearch =
        !search.trim() ||
        (log.employeeName && log.employeeName.toLowerCase().includes(search.toLowerCase())) ||
        (log.employeeCode && log.employeeCode.toLowerCase().includes(search.toLowerCase()))
      const matchDate = !filterDate || log.date === filterDate
      const matchDept = !filterDept || log.departmentId === filterDept
      return matchSearch && matchDate && matchDept
    })
  }, [attendanceLogs, search, filterDate, filterDept])

  // Stat metrics
  const totalCount = attendanceLogs.length
  const lateCount = useMemo(() => attendanceLogs.filter((l) => l.status === 'late').length, [attendanceLogs])
  const presentCount = useMemo(() => attendanceLogs.filter((l) => l.status === 'present').length, [attendanceLogs])
  const totalOvertime = useMemo(() => attendanceLogs.reduce((sum, l) => sum + (Number(l.overtimeHours) || 0), 0), [attendanceLogs])

  // Handle Demo Seed
  async function handleSeedDemoData() {
    if (!canModify) return
    setSeeding(true)
    setSeedMsg('')
    try {
      const res = await seedDemoData()
      setSeedMsg(`(${res.departmentsCreated}) - (${res.employeesCreated}) - (${res.attendanceRecordsCreated})`)
    } catch (err) {
      console.error('Failed to seed demo data:', err)
    } finally {
      setSeeding(false)
    }
  }

  const [clearing, setClearing] = useState(false)

  // Handle Clear Demo Data
  async function handleClearDemoData() {
    if (!canModify) return
    if (!window.confirm('هل أنت تأكد من حذف كافة البيانات التجريبية نهائياً؟')) return
    setClearing(true)
    setSeedMsg('')
    try {
      const res = await clearDemoData()
      setSeedMsg(`تم حذف ${res.deletedCount} سجل تجريبي بنجاح!`)
    } catch (err) {
      console.error('Failed to clear demo data:', err)
    } finally {
      setClearing(false)
    }
  }

  // Handle File Upload
  async function handleFileUpload(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setImportingFile(true)
    setImportSuccessMsg('')
    try {
      const records = await parseBiometricExcelFile(file)
      setParsedRecords(records)
      setActiveTab('import')
    } catch (err) {
      console.error('Error parsing Excel file:', err)
      alert(err.message || 'Error reading Excel file')
    } finally {
      setImportingFile(false)
    }
  }

  // Save imported records to Firestore
  async function handleConfirmImport() {
    if (parsedRecords.length === 0 || !canModify) return
    setImportingFile(true)
    try {
      const res = await saveAttendanceBatch(parsedRecords, settings)
      setImportSuccessMsg(`${res.savedCount}`)
      setParsedRecords([])
      setActiveTab('logs')
    } catch (err) {
      console.error('Failed to save attendance batch:', err)
    } finally {
      setImportingFile(false)
    }
  }

  // Save settings
  async function handleSaveSettings(e) {
    if (e) e.preventDefault()
    if (!canModify) return
    setSettingsBusy(true)
    try {
      await saveAttendanceSettings(settings)
    } catch (err) {
      console.error('Failed to save attendance settings:', err)
    } finally {
      setSettingsBusy(false)
    }
  }

  if (loadingLogs || loadingSettings) {
    return <Loading />
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('attendance.title')}
        subtitle={t('attendance.subtitle')}
        action={
          <div className="flex flex-wrap gap-2">
            <Button onClick={generateAttendanceExcelTemplate} variant="ghost">
              {t('attendance.downloadTemplate')}
            </Button>
            {canModify && (
              <label className="cursor-pointer">
                <span className="inline-flex items-center justify-center rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white shadow-xs hover:bg-brand-700 transition">
                  {t('attendance.uploadExcel')}
                </span>
                <input
                  type="file"
                  accept=".xlsx, .xls, .csv"
                  onChange={handleFileUpload}
                  className="hidden"
                />
              </label>
            )}
          </div>
        }
      />

      {seedMsg && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-semibold text-emerald-800">
          {seedMsg}
        </div>
      )}

      {/* Metric Cards */}
      <div className="grid gap-4 sm:grid-cols-4">
        <StatCard label={t('attendance.statTotal')} value={totalCount} subtext={t('attendance.statTotalSub')} />
        <StatCard label={t('attendance.statPresent')} value={presentCount} subtext={t('attendance.statPresentSub')} />
        <StatCard label={t('attendance.statLate')} value={lateCount} subtext={t('attendance.statLateSub')} />
        <StatCard label={t('attendance.statOvertime')} value={`${totalOvertime}`} subtext={t('attendance.statOvertimeSub')} />
      </div>

      {/* Tabs */}
      <div className="border-b border-slate-200">
        <nav className="-mb-px flex space-x-8 rtl:space-x-reverse">
          <button
            type="button"
            onClick={() => setActiveTab('logs')}
            className={`pb-4 text-sm font-bold border-b-2 transition ${
              activeTab === 'logs'
                ? 'border-brand-600 text-brand-600'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {t('attendance.tabLogs')} ({filteredLogs.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('import')}
            className={`pb-4 text-sm font-bold border-b-2 transition ${
              activeTab === 'import'
                ? 'border-brand-600 text-brand-600'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {t('attendance.tabImport')} {parsedRecords.length > 0 && `(${parsedRecords.length})`}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('settings')}
            className={`pb-4 text-sm font-bold border-b-2 transition ${
              activeTab === 'settings'
                ? 'border-brand-600 text-brand-600'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {t('attendance.tabSettings')}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('deductions')}
            className={`pb-4 text-sm font-bold border-b-2 transition ${
              activeTab === 'deductions'
                ? 'border-brand-600 text-brand-600'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {t('attendance.tabDeductions')}
          </button>
        </nav>
      </div>

      {/* Tab 1: Attendance Logs */}
      {activeTab === 'logs' && (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <SearchInput
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('attendance.searchPlaceholder')}
            />
            <Input
              type="date"
              value={filterDate}
              onChange={(e) => setFilterDate(e.target.value)}
            />
            <Select
              value={filterDept}
              onChange={(e) => setFilterDept(e.target.value)}
            >
              <option value="">{t('attendance.allDepts')}</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </Select>
          </div>

          <TableWrap>
            <table className="w-full text-start text-sm">
              <thead className="bg-slate-50 text-xs font-semibold uppercase text-slate-500">
                <tr>
                  <Th>{t('attendance.colCode')}</Th>
                  <Th>{t('attendance.colName')}</Th>
                  <Th>{t('attendance.colDate')}</Th>
                  <Th>{t('attendance.colIn')}</Th>
                  <Th>{t('attendance.colOut')}</Th>
                  <Th>{t('attendance.colWorkHours')}</Th>
                  <Th>{t('attendance.colLate')}</Th>
                  <Th>{t('attendance.colOvertime')}</Th>
                  <Th>{t('attendance.colStatus')}</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredLogs.length === 0 ? (
                  <tr>
                    <Td colSpan={9} className="p-8 text-center text-slate-500">
                      {t('attendance.emptyLogs')}
                    </Td>
                  </tr>
                ) : (
                  filteredLogs.map((log) => (
                    <tr key={log.id} className="hover:bg-slate-50/50 transition-colors">
                      <Td className="font-mono text-xs text-slate-700">{log.employeeCode || '-'}</Td>
                      <Td className="font-bold text-slate-900">{log.employeeName || '-'}</Td>
                      <Td className="text-xs text-slate-600">{log.date}</Td>
                      <Td className="font-mono text-xs text-slate-700">{log.checkIn || '-'}</Td>
                      <Td className="font-mono text-xs text-slate-700">{log.checkOut || '-'}</Td>
                      <Td className="text-xs text-slate-600">{log.workHours ? `${log.workHours}` : '-'}</Td>
                      <Td className="text-xs text-amber-700 font-semibold">{log.lateMinutes ? `${log.lateMinutes}` : '0'}</Td>
                      <Td className="text-xs text-emerald-700 font-semibold">{log.overtimeHours ? `${log.overtimeHours}` : '0'}</Td>
                      <Td>
                        <Badge variant={log.status === 'present' ? 'emerald' : log.status === 'late' ? 'amber' : 'neutral'}>
                          {log.status === 'present' ? t('attendance.statusPresent') : log.status === 'late' ? t('attendance.statusLate') : t('attendance.statusAbsent')}
                        </Badge>
                      </Td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </TableWrap>
        </div>
      )}

      {/* Tab 2: Biometric Excel Import Preview */}
      {activeTab === 'import' && (
        <div className="space-y-4">
          {importSuccessMsg && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-semibold text-emerald-800">
              {importSuccessMsg}
            </div>
          )}

          {parsedRecords.length === 0 ? (
            <div className="rounded-2xl border-2 border-dashed border-slate-300 bg-slate-50 p-12 text-center space-y-4">
              <h3 className="text-base font-bold text-slate-800">{t('attendance.dropzoneTitle')}</h3>
              <p className="text-xs text-slate-500 max-w-md mx-auto">
                {t('attendance.dropzoneSub')}
              </p>
              <div className="flex justify-center gap-3 pt-2">
                <Button onClick={generateAttendanceExcelTemplate} variant="ghost">
                  {t('attendance.downloadTemplate')}
                </Button>
                <label className="cursor-pointer">
                  <span className="inline-flex items-center justify-center rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white shadow-xs hover:bg-brand-700 transition">
                    {t('attendance.selectFile')}
                  </span>
                  <input
                    type="file"
                    accept=".xlsx, .xls, .csv"
                    onChange={handleFileUpload}
                    className="hidden"
                  />
                </label>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-base font-bold text-slate-900">{t('attendance.previewTitle')}</h3>
                  <p className="text-xs text-slate-500">{t('attendance.previewSub')}</p>
                </div>
                <div className="flex gap-2">
                  <Button onClick={() => setParsedRecords([])} variant="ghost">
                    {t('attendance.cancelImport')}
                  </Button>
                  <Button onClick={handleConfirmImport} disabled={importingFile} className="bg-emerald-600 hover:bg-emerald-700 text-white">
                    {importingFile ? t('attendance.saving') : `${t('attendance.confirmImport')} (${parsedRecords.length})`}
                  </Button>
                </div>
              </div>

              <TableWrap>
                <table className="w-full text-start text-sm">
                  <thead className="bg-slate-50 text-xs font-semibold uppercase text-slate-500">
                    <tr>
                      <Th>{t('attendance.colRowNo')}</Th>
                      <Th>{t('attendance.colCode')}</Th>
                      <Th>{t('attendance.colName')}</Th>
                      <Th>{t('attendance.colDate')}</Th>
                      <Th>{t('attendance.colIn')}</Th>
                      <Th>{t('attendance.colOut')}</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {parsedRecords.map((rec, idx) => (
                      <tr key={idx} className="hover:bg-slate-50/50">
                        <Td className="text-xs text-slate-400">{rec.rowNumber}</Td>
                        <Td className="font-mono text-xs text-slate-700">{rec.employeeCode || '-'}</Td>
                        <Td className="font-bold text-slate-900">{rec.employeeName || '-'}</Td>
                        <Td className="text-xs text-slate-600">{rec.date || '-'}</Td>
                        <Td className="font-mono text-xs text-emerald-700">{rec.checkIn || '-'}</Td>
                        <Td className="font-mono text-xs text-amber-700">{rec.checkOut || '-'}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            </div>
          )}
        </div>
      )}

      {/* Tab 3: Attendance Settings */}
      {activeTab === 'settings' && (
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs max-w-3xl space-y-6">
          <div>
            <h3 className="text-base font-bold text-slate-900">{t('attendance.settingsTitle')}</h3>
            <p className="text-xs text-slate-500">{t('attendance.settingsSub')}</p>
          </div>

          <form onSubmit={handleSaveSettings} className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('attendance.shiftStart')}>
                <Input
                  type="time"
                  value={settings.shiftStartTime}
                  onChange={(e) => setSettings({ ...settings, shiftStartTime: e.target.value })}
                  required
                />
              </Field>

              <Field label={t('attendance.shiftEnd')}>
                <Input
                  type="time"
                  value={settings.shiftEndTime}
                  onChange={(e) => setSettings({ ...settings, shiftEndTime: e.target.value })}
                  required
                />
              </Field>

              <Field label={t('attendance.gracePeriod')}>
                <Input
                  type="number"
                  value={settings.gracePeriodMinutes}
                  onChange={(e) => setSettings({ ...settings, gracePeriodMinutes: Number(e.target.value) })}
                  required
                />
              </Field>

              <Field label={t('attendance.workHoursPerDay')}>
                <Input
                  type="number"
                  value={settings.workHoursPerDay}
                  onChange={(e) => setSettings({ ...settings, workHoursPerDay: Number(e.target.value) })}
                  required
                />
              </Field>

              <Field label={t('attendance.overtimeRate')}>
                <Input
                  type="number"
                  step="0.1"
                  value={settings.overtimeRate}
                  onChange={(e) => setSettings({ ...settings, overtimeRate: Number(e.target.value) })}
                  required
                />
              </Field>

              <Field label={t('attendance.lateRate')}>
                <Input
                  type="number"
                  step="0.1"
                  value={settings.lateDeductionRate}
                  onChange={(e) => setSettings({ ...settings, lateDeductionRate: Number(e.target.value) })}
                  required
                />
              </Field>
            </div>

            {canModify && (
              <div className="pt-2">
                <Button type="submit" disabled={settingsBusy} className="w-full sm:w-auto">
                  {settingsBusy ? t('attendance.saving') : t('attendance.saveSettings')}
                </Button>
              </div>
            )}
          </form>
        </div>
      )}

      {/* Tab 4: Allowances & Deductions Definitions */}
      {activeTab === 'deductions' && (
        <div className="grid gap-6 md:grid-cols-2">
          {/* Allowances section */}
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs space-y-4">
            <h3 className="text-base font-bold text-slate-900">{t('attendance.allowancesTitle')}</h3>
            <TableWrap>
              <table className="w-full text-start text-sm">
                <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase">
                  <tr>
                    <Th>{t('attendance.colAllowance')}</Th>
                    <Th>{t('attendance.colCode')}</Th>
                    <Th>{t('attendance.colType')}</Th>
                    <Th>{t('attendance.colDefaultVal')}</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {allowances.length === 0 ? (
                    <tr>
                      <Td colSpan={4} className="p-4 text-center text-slate-500 text-xs">
                        -
                      </Td>
                    </tr>
                  ) : (
                    allowances.map((a) => (
                      <tr key={a.id}>
                        <Td className="font-bold text-slate-900">{a.name}</Td>
                        <Td className="font-mono text-xs text-slate-600">{a.code || '-'}</Td>
                        <Td className="text-xs text-slate-500">{a.type === 'fixed' ? t('attendance.fixedAmount') : t('attendance.percentage')}</Td>
                        <Td className="font-semibold text-emerald-700">{a.defaultAmount} {a.type === 'percentage' ? '%' : ''}</Td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </TableWrap>
          </div>

          {/* Deductions section */}
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs space-y-4">
            <h3 className="text-base font-bold text-slate-900">{t('attendance.deductionsTitle')}</h3>
            <TableWrap>
              <table className="w-full text-start text-sm">
                <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase">
                  <tr>
                    <Th>{t('attendance.colDeduction')}</Th>
                    <Th>{t('attendance.colCode')}</Th>
                    <Th>{t('attendance.colType')}</Th>
                    <Th>{t('attendance.colDefaultVal')}</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {deductions.length === 0 ? (
                    <tr>
                      <Td colSpan={4} className="p-4 text-center text-slate-500 text-xs">
                        -
                      </Td>
                    </tr>
                  ) : (
                    deductions.map((d) => (
                      <tr key={d.id}>
                        <Td className="font-bold text-slate-900">{d.name}</Td>
                        <Td className="font-mono text-xs text-slate-600">{d.code || '-'}</Td>
                        <Td className="text-xs text-slate-500">{d.type === 'hourly' ? t('attendance.hourly') : d.type === 'percentage' ? t('attendance.percentage') : t('attendance.fixedAmount')}</Td>
                        <Td className="font-semibold text-amber-700">{d.defaultAmount} {d.type === 'percentage' ? '%' : ''}</Td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </TableWrap>
          </div>
        </div>
      )}
    </div>
  )
}
