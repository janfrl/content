import { disposeDatabaseAdapter } from '../internal/database.server'
import type { NitroApp } from 'nitropack/types'
// @ts-expect-error - typecheck does not detect defineNitroPlugin in imports
import { defineNitroPlugin } from '#imports'

export default defineNitroPlugin((nitroApp: NitroApp) => {
  nitroApp.hooks.hook('close', disposeDatabaseAdapter)
})
