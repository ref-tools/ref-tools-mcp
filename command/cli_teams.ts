#!/usr/bin/env node
/**
 * CLI for team-scoped admin operations (limit overrides, credit grants, team info).
 *
 * Usage:
 *   npx tsx command/cli_teams.ts [--emulator] <command> [options]
 *
 * Commands:
 *   set-overrides <teamId>    Set limit overrides for a team
 *   clear-overrides <teamId>  Clear all limit overrides for a team
 *   grant-credits <teamId>    Grant credits to a team
 *   info <teamId>             Show team info including overrides
 */

import { Command, InvalidArgumentError } from 'commander'
import { bootstrap } from './cli_common.js'
import {
  setTeamLimitOverrides,
  clearTeamLimitOverrides,
  getTeamLimitOverrides,
  type TeamLimitOverrides,
} from '../functions/src/services/teamLimitOverrides.js'
import { addTeamCredits } from '../functions/src/services/credits.js'

const ADMIN_USER_ID = 'cli-admin'

function parseIntOrUnlimited(value: string): number {
  if (value === 'unlimited') {
    return -1
  }
  const n = parseInt(value, 10)
  if (isNaN(n) || !Number.isInteger(n)) {
    throw new InvalidArgumentError('Must be an integer or "unlimited"')
  }
  return n
}

function parsePositiveInt(value: string): number {
  const n = parseInt(value, 10)
  if (isNaN(n) || n <= 0 || !Number.isInteger(n)) {
    throw new InvalidArgumentError('Must be a positive integer')
  }
  return n
}

function formatLimitValue(value: number): string {
  return value === -1 ? 'unlimited' : String(value)
}

async function getTeamName(db: FirebaseFirestore.Firestore, teamId: string): Promise<string> {
  const snap = await db.collection('teams').doc(teamId).get()
  if (!snap.exists) {
    return '(unknown)'
  }
  const data = snap.data()
  return (data?.['name'] as string) ?? '(unknown)'
}

const program = new Command()

program
  .name('cli_teams')
  .description('Team-scoped admin CLI for Ref')
  .version('1.0.0')
  .option('--emulator', 'Connect to the Firestore emulator instead of production')

// ── set-overrides ──────────────────────────────────────────────────────────

program
  .command('set-overrides <teamId>')
  .description('Set limit overrides for a team (partial — only writes provided fields)')
  .option('--max-plans <n>', 'Max plans (integer or "unlimited")', parseIntOrUnlimited)
  .option('--max-small-repos <n>', 'Max small repos (integer or "unlimited")', parseIntOrUnlimited)
  .option('--max-large-repos <n>', 'Max large repos (integer or "unlimited")', parseIntOrUnlimited)
  .option('--max-pdf-pages <n>', 'Max PDF pages (integer or "unlimited")', parseIntOrUnlimited)
  .option('--max-file-uploads <n>', 'Max file uploads (integer or "unlimited")', parseIntOrUnlimited)
  .option('--monthly-credits <n>', 'Monthly credits (integer)', parsePositiveInt)
  .option('--notes <string>', 'Reason / notes for the override (recommended for paper trail)')
  .action(
    async (
      teamId: string,
      opts: {
        maxPlans?: number
        maxSmallRepos?: number
        maxLargeRepos?: number
        maxPdfPages?: number
        maxFileUploads?: number
        monthlyCredits?: number
        notes?: string
      },
    ) => {
      const { db, emulator } = bootstrap({ emulator: program.opts()['emulator'] as boolean | undefined })
      const env = emulator ? '(emulator)' : '(production)'

      const limits: Omit<TeamLimitOverrides, 'updatedAt' | 'updatedBy'> = {}
      if (opts.maxPlans !== undefined) limits.maxPlans = opts.maxPlans
      if (opts.maxSmallRepos !== undefined) limits.maxSmallRepos = opts.maxSmallRepos
      if (opts.maxLargeRepos !== undefined) limits.maxLargeRepos = opts.maxLargeRepos
      if (opts.maxPdfPages !== undefined) limits.maxPdfPages = opts.maxPdfPages
      if (opts.maxFileUploads !== undefined) limits.maxFileUploads = opts.maxFileUploads
      if (opts.monthlyCredits !== undefined) limits.monthlyCredits = opts.monthlyCredits
      if (opts.notes !== undefined) limits.notes = opts.notes

      const fieldCount = Object.keys(limits).filter((k) => k !== 'notes').length
      if (fieldCount === 0) {
        console.error('\n✗ At least one limit flag must be provided.')
        console.error(
          '  Available: --max-plans, --max-small-repos, --max-large-repos, --max-pdf-pages, --max-file-uploads, --monthly-credits',
        )
        process.exit(1)
      }

      if (opts.notes === undefined) {
        console.warn('\n⚠️  WARNING: --notes was not provided. Please include notes for a paper trail!')
        console.warn('   Example: --notes "Approved by Jane for Q3 trial extension"\n')
      }

      const teamName = await getTeamName(db, teamId)

      console.log(`\n[set-overrides] ${env}`)
      console.log(`  Team:     ${teamName} (${teamId})`)
      console.log(`  Doc path: teamLimitOverrides/${teamId}`)
      console.log()

      await setTeamLimitOverrides(db, teamId, limits, ADMIN_USER_ID)

      console.log('  Fields set:')
      if (limits.maxPlans !== undefined) console.log(`    maxPlans:       ${formatLimitValue(limits.maxPlans)}`)
      if (limits.maxSmallRepos !== undefined)
        console.log(`    maxSmallRepos:  ${formatLimitValue(limits.maxSmallRepos)}`)
      if (limits.maxLargeRepos !== undefined)
        console.log(`    maxLargeRepos:  ${formatLimitValue(limits.maxLargeRepos)}`)
      if (limits.maxPdfPages !== undefined) console.log(`    maxPdfPages:    ${formatLimitValue(limits.maxPdfPages)}`)
      if (limits.maxFileUploads !== undefined)
        console.log(`    maxFileUploads: ${formatLimitValue(limits.maxFileUploads)}`)
      if (limits.monthlyCredits !== undefined) console.log(`    monthlyCredits: ${limits.monthlyCredits}`)
      if (limits.notes !== undefined) console.log(`    notes:          "${limits.notes}"`)
      console.log()
      console.log(`✓ Overrides written to teamLimitOverrides/${teamId}`)
      console.log()

      process.exit(0)
    },
  )

// ── clear-overrides ────────────────────────────────────────────────────────

program
  .command('clear-overrides <teamId>')
  .description('Clear all limit overrides for a team')
  .action(async (teamId: string) => {
    const { db, emulator } = bootstrap({ emulator: program.opts()['emulator'] as boolean | undefined })
    const env = emulator ? '(emulator)' : '(production)'

    const teamName = await getTeamName(db, teamId)

    console.log(`\n[clear-overrides] ${env}`)
    console.log(`  Team:     ${teamName} (${teamId})`)
    console.log(`  Doc path: teamLimitOverrides/${teamId}`)
    console.log()

    await clearTeamLimitOverrides(db, teamId)

    console.log(`✓ Overrides cleared for team ${teamName} (${teamId})`)
    console.log(`  Document teamLimitOverrides/${teamId} deleted.`)
    console.log()

    process.exit(0)
  })

// ── grant-credits ──────────────────────────────────────────────────────────

program
  .command('grant-credits <teamId>')
  .description('Grant credits to a team')
  .requiredOption('--credits <n>', 'Number of credits to grant (positive integer)', parsePositiveInt)
  .requiredOption('--reason <string>', 'Reason for the credit grant')
  .action(async (teamId: string, opts: { credits: number; reason: string }) => {
    const { db, emulator } = bootstrap({ emulator: program.opts()['emulator'] as boolean | undefined })
    const env = emulator ? '(emulator)' : '(production)'

    const teamName = await getTeamName(db, teamId)

    console.log(`\n[grant-credits] ${env}`)
    console.log(`  Team:     ${teamName} (${teamId})`)
    console.log(`  Firestore path: teams/${teamId}`)
    console.log(`  Granting: +${opts.credits} credits`)
    console.log(`  Reason:   "${opts.reason}"`)
    console.log()

    const { newBalance } = await addTeamCredits(db, teamId, opts.credits, opts.reason)

    console.log(`✓ Granted ${opts.credits} credits to ${teamName} (${teamId})`)
    console.log(`  New balance: ${newBalance}`)
    console.log(`  Transaction log: teams/${teamId}/creditTransactions/<new>`)
    console.log()

    process.exit(0)
  })

// ── info ───────────────────────────────────────────────────────────────────

program
  .command('info <teamId>')
  .description('Print team info including limit overrides')
  .action(async (teamId: string) => {
    const { db, emulator } = bootstrap({ emulator: program.opts()['emulator'] as boolean | undefined })
    const env = emulator ? '(emulator)' : '(production)'

    const teamSnap = await db.collection('teams').doc(teamId).get()
    if (!teamSnap.exists) {
      console.error(`\n✗ Team "${teamId}" does not exist in Firestore.`)
      process.exit(1)
    }

    const teamData = teamSnap.data()!
    const teamName: string = (teamData['name'] as string) ?? '(unknown)'
    const tier: string = (teamData['tier'] as string) ?? 'free'
    const creditBalance: number = (teamData['creditBalance'] as number) ?? 0
    const memberCount: number = (teamData['memberCount'] as number) ?? 0

    console.log(`\n[info] ${env}`)
    console.log(`  Firestore path: teams/${teamId}`)
    console.log(`  Name:           ${teamName}`)
    console.log(`  Tier:           ${tier}`)
    console.log(`  Credit balance: ${creditBalance}`)
    console.log(`  Members:        ${memberCount}`)

    // Overrides section
    const overrides = await getTeamLimitOverrides(db, teamId)
    if (overrides) {
      console.log()
      console.log('  Overrides (teamLimitOverrides/' + teamId + '):')
      if (overrides.maxPlans !== undefined) console.log(`    maxPlans:       ${formatLimitValue(overrides.maxPlans)}`)
      if (overrides.maxSmallRepos !== undefined)
        console.log(`    maxSmallRepos:  ${formatLimitValue(overrides.maxSmallRepos)}`)
      if (overrides.maxLargeRepos !== undefined)
        console.log(`    maxLargeRepos:  ${formatLimitValue(overrides.maxLargeRepos)}`)
      if (overrides.maxPdfPages !== undefined)
        console.log(`    maxPdfPages:    ${formatLimitValue(overrides.maxPdfPages)}`)
      if (overrides.maxFileUploads !== undefined)
        console.log(`    maxFileUploads: ${formatLimitValue(overrides.maxFileUploads)}`)
      if (overrides.monthlyCredits !== undefined) console.log(`    monthlyCredits: ${overrides.monthlyCredits}`)
      if (overrides.notes) console.log(`    notes:          "${overrides.notes}"`)
      if (overrides.updatedAt) console.log(`    updatedAt:      ${overrides.updatedAt.toDate().toISOString()}`)
      if (overrides.updatedBy) console.log(`    updatedBy:      ${overrides.updatedBy}`)
    }

    console.log()

    process.exit(0)
  })

program.parse()
