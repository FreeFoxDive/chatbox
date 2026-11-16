import { useEffect } from 'react'
import { startServerBackupScheduler } from '@/server-backup/scheduler'

export function ServerBackupScheduler() {
  useEffect(() => startServerBackupScheduler(), [])
  return null
}
