import { config } from 'dotenv'
import { initializeApp, cert, type ServiceAccount } from 'firebase-admin/app'
import { getFirestore, type Firestore } from 'firebase-admin/firestore'

export type CliBootstrapResult = {
  db: Firestore
  emulator: boolean
}

/**
 * Shared bootstrap for CLI tools: loads .env, optionally configures
 * the Firestore emulator, initialises Firebase Admin, and returns the db handle.
 */
export function bootstrap(opts: { emulator?: boolean }): CliBootstrapResult {
  config()

  const useEmulator = opts.emulator ?? false

  if (useEmulator) {
    process.env['FIRESTORE_EMULATOR_HOST'] = process.env['FIRESTORE_EMULATOR_HOST'] || 'localhost:8080'
    console.log(`[cli] Using Firestore emulator at ${process.env['FIRESTORE_EMULATOR_HOST']}`)

    initializeApp({ projectId: process.env['GCLOUD_PROJECT'] || 'demo-project' })
  } else {
    const serviceAccountPath = process.env['GOOGLE_APPLICATION_CREDENTIALS']
    if (serviceAccountPath) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const sa = require(serviceAccountPath) as ServiceAccount
      initializeApp({ credential: cert(sa) })
    } else {
      initializeApp()
    }
  }

  const db = getFirestore()
  return { db, emulator: useEmulator }
}
