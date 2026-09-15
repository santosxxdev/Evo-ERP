import { useState } from 'react'
import { useI18n } from '../i18n'
import { useAuth } from '../context/AuthContext'
import { deleteDocById, useCollection } from '../lib/db'
import { ROLES, USERS_COL, createAuthUser, saveUserProfile } from '../lib/roles'
import { usernameToEmail } from '../context/AuthContext'
import { formatDate } from '../lib/format'
import {
  Badge,
  Button,
  ConfirmDialog,
  Field,
  Input,
  Loading,
  Modal,
  PageHeader,
  Select,
  TableWrap,
  Td,
  Th,
} from '../components/ui'

const ROLE_TONES = { admin: 'brand', accountant: 'sky', sales: 'green', viewer: 'slate' }

export default function Users() {
  const { t, locale } = useI18n()
  const { user } = useAuth()

  const { rows: users, loading } = useCollection(USERS_COL, 'name', 'asc')

  const [editing, setEditing] = useState(null)
  const [removing, setRemoving] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function save(values) {
    setBusy(true)
    setError(null)

    try {
      if (editing?.id) {
        await saveUserProfile(editing.id, {
          name: values.name,
          role: values.role,
          active: values.active,
        })
      } else {
        const email = usernameToEmail(values.username)
        const uid = await createAuthUser(email, values.password)
        await saveUserProfile(uid, {
          username: values.username.trim().toLowerCase(),
          email,
          name: values.name,
          role: values.role,
          active: true,
          createdAt: new Date().toISOString().slice(0, 10),
        })
      }
      setEditing(null)
    } catch (creationError) {
      const code = creationError?.code ?? ''
      setError(
        code === 'auth/email-already-in-use'
          ? 'users.err.exists'
          : code === 'auth/weak-password'
            ? 'users.err.weak'
            : 'users.err.generic',
      )
    }

    setBusy(false)
  }

  async function remove() {
    setBusy(true)
    await deleteDocById(USERS_COL, removing.id)
    setBusy(false)
    setRemoving(null)
  }

  if (loading) return <Loading />

  return (
    <div>
      <PageHeader title={t('users.title')} subtitle={t('users.subtitle')}>
        <Button onClick={() => setEditing({})}>+ {t('users.add')}</Button>
      </PageHeader>

      <div className="card mb-5 p-4">
        <h3 className="mb-2 text-sm font-bold text-slate-900">{t('users.rolesTitle')}</h3>
        <div className="grid gap-2 sm:grid-cols-2">
          {ROLES.map((role) => (
            <div key={role} className="flex items-start gap-2 rounded-xl bg-slate-50 px-3 py-2">
              <Badge tone={ROLE_TONES[role]}>{t(`users.role.${role}`)}</Badge>
              <span className="text-xs leading-relaxed text-slate-600">{t(`users.roleDesc.${role}`)}</span>
            </div>
          ))}
        </div>
      </div>

      <TableWrap>
        <thead>
          <tr>
            <Th>{t('common.name')}</Th>
            <Th>{t('login.username')}</Th>
            <Th>{t('users.role')}</Th>
            <Th>{t('common.status')}</Th>
            <Th>{t('users.since')}</Th>
            <Th className="w-px">{t('common.actions')}</Th>
          </tr>
        </thead>
        <tbody>
          {users.map((row) => (
            <tr key={row.id}>
              <Td className="font-semibold text-slate-800">
                {row.name}
                {row.id === user?.uid && (
                  <span className="ms-2">
                    <Badge tone="green">{t('users.you')}</Badge>
                  </span>
                )}
              </Td>
              <Td>
                <span className="num text-slate-600" dir="ltr">
                  {row.username}
                </span>
              </Td>
              <Td>
                <Badge tone={ROLE_TONES[row.role]}>{t(`users.role.${row.role}`)}</Badge>
              </Td>
              <Td>
                <Badge tone={row.active === false ? 'red' : 'green'}>
                  {t(row.active === false ? 'users.inactive' : 'users.activeState')}
                </Badge>
              </Td>
              <Td className="text-slate-600">{row.createdAt ? formatDate(row.createdAt, locale) : '—'}</Td>
              <Td>
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => setEditing(row)}
                    className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100"
                  >
                    {t('common.edit')}
                  </button>
                  {row.id !== user?.uid && (
                    <button
                      type="button"
                      onClick={() => setRemoving(row)}
                      className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50"
                    >
                      {t('common.delete')}
                    </button>
                  )}
                </div>
              </Td>
            </tr>
          ))}
        </tbody>
      </TableWrap>

      <UserForm
        open={Boolean(editing)}
        row={editing}
        busy={busy}
        errorKey={error}
        onClose={() => {
          setEditing(null)
          setError(null)
        }}
        onSave={save}
      />

      <ConfirmDialog
        open={Boolean(removing)}
        busy={busy}
        onClose={() => setRemoving(null)}
        onConfirm={remove}
        title={t('common.deleteTitle')}
        message={t('users.deleteMsg', { name: removing?.name ?? '' })}
      />
    </div>
  )
}

function UserForm({ open, row, busy, errorKey, onClose, onSave }) {
  const { t } = useI18n()
  const [form, setForm] = useState({})
  const [touched, setTouched] = useState(false)

  const isNew = !row?.id
  const key = row?.id ?? 'new'
  const [lastKey, setLastKey] = useState(null)
  if (open && lastKey !== key) {
    setLastKey(key)
    setForm({
      name: row?.name ?? '',
      username: row?.username ?? '',
      password: '',
      role: row?.role ?? 'sales',
      active: row?.active !== false,
    })
    setTouched(false)
  }
  if (!open && lastKey !== null) setLastKey(null)

  const set = (field, value) => setForm((current) => ({ ...current, [field]: value }))

  const invalid =
    !form.name?.trim() ||
    (isNew && (!form.username?.trim() || String(form.password ?? '').length < 6))

  function submit() {
    setTouched(true)
    if (invalid) return
    onSave({
      name: form.name.trim(),
      username: form.username?.trim() ?? '',
      password: form.password ?? '',
      role: form.role,
      active: Boolean(form.active),
    })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isNew ? t('users.add') : t('users.edit')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? t('common.saving') : t('common.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t('common.name')} error={touched && !form.name?.trim() ? t('common.required') : null}>
          <Input value={form.name ?? ''} onChange={(event) => set('name', event.target.value)} />
        </Field>

        {isNew && (
          <>
            <Field
              label={t('login.username')}
              hint={t('users.usernameHint')}
              error={touched && !form.username?.trim() ? t('common.required') : null}
            >
              <Input
                dir="ltr"
                autoCapitalize="none"
                value={form.username ?? ''}
                onChange={(event) => set('username', event.target.value)}
              />
            </Field>

            <Field
              label={t('users.initialPassword')}
              hint={t('users.passwordHint')}
              error={touched && String(form.password ?? '').length < 6 ? t('users.err.weak') : null}
            >
              <Input
                dir="ltr"
                type="password"
                autoComplete="new-password"
                value={form.password ?? ''}
                onChange={(event) => set('password', event.target.value)}
              />
            </Field>
          </>
        )}

        <Field label={t('users.role')} hint={t(`users.roleDesc.${form.role}`)}>
          <Select value={form.role} onChange={(event) => set('role', event.target.value)}>
            {ROLES.map((role) => (
              <option key={role} value={role}>
                {t(`users.role.${role}`)}
              </option>
            ))}
          </Select>
        </Field>

        {!isNew && (
          <label className="flex items-center gap-3 rounded-xl border border-slate-200 px-4 py-3">
            <input
              type="checkbox"
              checked={Boolean(form.active)}
              onChange={(event) => set('active', event.target.checked)}
              className="h-4 w-4 accent-brand-600"
            />
            <span className="text-sm font-semibold text-slate-700">{t('users.activeLabel')}</span>
          </label>
        )}

        {errorKey && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
            {t(errorKey)}
          </div>
        )}
      </div>
    </Modal>
  )
}
