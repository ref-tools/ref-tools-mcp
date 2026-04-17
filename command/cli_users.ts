#!/usr/bin/env node
/**
 * CLI for user-scoped admin operations (credit grants, user info, etc.).
 *
 * Usage:
 *   npx tsx command/cli_users.ts [--emulator] <command> [options]
 *
 * Commands:
 *   grant-credits <userId>  Grant credits to a user
 *   info <userId>           Show user info (email, tier, credits, teams)
 */

import { Command, InvalidArgumentError } from 'commander'
import { bootstrap } from './cli_common.js'
import {
  addCredits,
  getUserCreditInfo,
  findUserByEmail,
} from '../functions/src/services/credits.js'

const program = new Command()

program
  .name('cli_users')
  .description('User-scoped admin CLI for Ref')
  .version('1.0.0')
  .option('--emulator', 'Connect to the Firestore emulator instead of production')

// ── grant-credits ──────────────────────────────────────────────────────────

program
  .command('grant-credits <userId>')
  .description('Grant credits to a user')
  .requiredOption('--credits <n>', 'Number of credits to grant (positive integer)', (v) => {
    const n = parseInt(v, 10)
    if (isNaN(n) || n <= 0 || !Number.isInteger(n)) {
      throw new InvalidArgumentError('--credits must be a positive integer')
    }
    return n
  })
  .requiredOption('--reason <string>', 'Reason for the credit grant')
  .action(async (userId: string, opts: { credits: number; reason: string }) => {
    const { db, emulator } = bootstrap({ emulator: program.opts()['emulator'] as boolean | undefined })
    const env = emulator ? '(emulator)' : '(production)'

    console.log(`\n[grant-credits] ${env}`)
    console.log(`  Target user: ${userId}`)
    console.log(`  Firestore path: users/${userId}`)

    // Validate user exists and print identifying info
    let info
    try {
      info = await getUserCreditInfo(db, userId)
    } catch {
      console.error(`\n✗ User "${userId}" does not exist in Firestore. No writes performed.`)
      process.exit(1)
    }

    console.log(`  Email: ${info.email}`)
    if (info.teamMemberships.length > 0) {
      console.log(`  Teams: ${info.teamMemberships.map((t) => `${t.teamName} (${t.role})`).join(', ')}`)
    }
    console.log(`  Current balance: ${info.creditBalance}`)
    console.log(`  Granting: +${opts.credits} credits`)
    console.log(`  Reason: "${opts.reason}"`)
    console.log()

    const { newBalance } = await addCredits(db, userId, opts.credits, opts.reason)

    console.log(`✓ Granted ${opts.credits} credits to ${info.email || userId}`)
    console.log(`  New balance: ${newBalance}`)
    console.log(`  Transaction log: users/${userId}/creditTransactions/<new>`)
    console.log()

    process.exit(0)
  })

// ── info ───────────────────────────────────────────────────────────────────

program
  .command('info <userId>')
  .description('Print user info: email, tier, credits, team memberships, monthly allowance')
  .action(async (userId: string) => {
    const { db, emulator } = bootstrap({ emulator: program.opts()['emulator'] as boolean | undefined })
    const env = emulator ? '(emulator)' : '(production)'

    // If the argument looks like an email, resolve it to a userId first
    let resolvedUserId = userId
    if (userId.includes('@')) {
      console.log(`\n[info] ${env} — looking up user by email: ${userId}`)
      const found = await findUserByEmail(db, userId)
      if (!found) {
        console.error(`\n✗ No user found with email "${userId}"`)
        process.exit(1)
      }
      resolvedUserId = found
      console.log(`  Resolved to userId: ${resolvedUserId}`)
    }

    let info
    try {
      info = await getUserCreditInfo(db, resolvedUserId)
    } catch {
      console.error(`\n✗ User "${resolvedUserId}" does not exist in Firestore.`)
      process.exit(1)
    }

    console.log(`\n[info] ${env}`)
    console.log(`  Firestore path: users/${info.userId}`)
    console.log(`  Email:           ${info.email || '(not set)'}`)
    console.log(`  Tier:            ${info.tier}`)
    console.log(`  Credit balance:  ${info.creditBalance}`)
    console.log(`  Monthly allow.:  ${info.monthlyAllowance ?? 'none'}`)

    if (info.teamMemberships.length > 0) {
      console.log(`  Teams:`)
      for (const t of info.teamMemberships) {
        console.log(`    - ${t.teamName} (${t.role}) [teams/${t.teamId}]`)
      }
    } else {
      console.log(`  Teams:           (none)`)
    }
    console.log()

    process.exit(0)
  })

program.parse()
