import { useEffect, useState } from 'react'
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import { I18nProvider } from './i18n'
import { canAccess } from './lib/roles'
import { useCollection } from './lib/db'
import { USERS_COL } from './lib/roles'
import Layout from './components/Layout'
import Bootstrap, { NoAccess } from './components/Bootstrap'
import Accounting from './pages/Accounting'
import Assets from './pages/Assets'
import Campaigns from './pages/Campaigns'
import ClientProfile from './pages/ClientProfile'
import Clients from './pages/Clients'
import Dashboard from './pages/Dashboard'
import Departments from './pages/Departments'
import Employees from './pages/Employees'
import EmployeeMigration from './pages/EmployeeMigration'
import Expenses from './pages/Expenses'
import Invoices from './pages/Invoices'
import InvoiceView from './pages/InvoiceView'
import Login from './pages/Login'
import Payroll from './pages/Payroll'
import Positions from './pages/Positions'
import Quotations from './pages/Quotations'
import Reports from './pages/Reports'
import ReportView from './pages/ReportView'
import Services from './pages/Services'
import Settings from './pages/Settings'
import Splash from './pages/Splash'
import Treasury from './pages/Treasury'
import Users from './pages/Users'
import Vendors from './pages/Vendors'
import Vouchers from './pages/Vouchers'

const SPLASH_MS = 1900

function RequireAuth() {
  const { user } = useAuth()
  return user ? <Outlet /> : <Navigate to="/login" replace />
}

function RedirectIfAuthed() {
  const { user } = useAuth()
  return user ? <Navigate to="/" replace /> : <Outlet />
}

/** يمنع فتح قسم لا يسمح به دور المستخدم */
function RequireSection() {
  const { role } = useAuth()
  const { pathname } = useLocation()
  const path = `/${pathname.split('/')[1] ?? ''}`.replace(/\/$/, '') || '/'
  return canAccess(role, path) ? <Outlet /> : <Navigate to="/" replace />
}

/**
 * بوابة الصلاحيات: قبل أي شيء نتأكد أن للمستخدم ملفًا ودورًا.
 * أول مستخدم على الإطلاق يسجّل نفسه مديرًا، ومن بعده لا أحد يدخل بلا ملف.
 */
function Gate() {
  const { profile, profileLoading, active } = useAuth()
  const { rows: users, loading: usersLoading } = useCollection(USERS_COL, 'name', 'asc', !profile)

  if (profileLoading) return <Splash />
  if (profile) {
    if (active === false) return <NoAccess />
    return <Outlet />
  }

  if (usersLoading) return <Splash />
  return users.length === 0 ? <Bootstrap /> : <NoAccess />
}

function Shell() {
  const { ready } = useAuth()
  const [splashDone, setSplashDone] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setSplashDone(true), SPLASH_MS)
    return () => clearTimeout(timer)
  }, [])

  if (!ready || !splashDone) return <Splash />

  return (
    <Routes>
      <Route element={<RedirectIfAuthed />}>
        <Route path="/login" element={<Login />} />
      </Route>

      <Route element={<RequireAuth />}>
        <Route element={<Gate />}>
          <Route element={<RequireSection />}>
            <Route element={<Layout />}>
              <Route index element={<Dashboard />} />
              <Route path="clients" element={<Clients />} />
              <Route path="clients/:id" element={<ClientProfile />} />
              <Route path="employees" element={<Employees />} />
              <Route path="payroll" element={<Payroll />} />
              <Route path="positions" element={<Positions />} />
              <Route path="departments" element={<Departments />} />
              <Route path="employee-migration" element={<EmployeeMigration />} />
              <Route path="vendors" element={<Vendors />} />
              <Route path="assets" element={<Assets />} />
              <Route path="quotations" element={<Quotations />} />
              <Route path="invoices" element={<Invoices />} />
              <Route path="invoices/:id" element={<InvoiceView />} />
              <Route path="invoices/:id/edit" element={<InvoiceView mode="edit" />} />
              <Route path="campaigns" element={<Campaigns />} />
              <Route path="expenses" element={<Expenses />} />
              <Route path="services" element={<Services />} />
              <Route path="reports" element={<Navigate to="/reports/sales-report" replace />} />
              <Route path="reports/:id" element={<ReportView />} />
              <Route path="accounting" element={<Navigate to="/accounting/tree" replace />} />
              <Route path="accounting/:view" element={<Accounting />} />
              <Route path="vouchers" element={<Vouchers />} />
              <Route path="treasury" element={<Treasury />} />
              <Route path="users" element={<Users />} />
              <Route path="settings" element={<Navigate to="/settings/expense-categories" replace />} />
              <Route path="settings/:section" element={<Settings />} />
            </Route>
          </Route>
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default function App() {
  return (
    <I18nProvider>
      <AuthProvider>
        <BrowserRouter>
          <Shell />
        </BrowserRouter>
      </AuthProvider>
    </I18nProvider>
  )
}
