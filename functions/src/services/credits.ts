import type { Firestore } from 'firebase-admin/firestore'

/**
 * Add credits to a team's account. Performs an atomic increment on the
 * team's credit balance and logs the transaction.
 */
export async function addTeamCredits(
  db: Firestore,
  teamId: string,
  amount: number,
  reason: string,
): Promise<{ newBalance: number }> {
  const teamRef = db.collection('teams').doc(teamId)

  const newBalance = await db.runTransaction(async (tx) => {
    const snap = await tx.get(teamRef)
    if (!snap.exists) {
      throw new Error(`Team ${teamId} does not exist`)
    }

    const data = snap.data()!
    const currentBalance: number = (data['creditBalance'] as number) ?? 0
    const updated = currentBalance + amount

    tx.update(teamRef, { creditBalance: updated })

    const txRef = db.collection('teams').doc(teamId).collection('creditTransactions').doc()
    tx.set(txRef, {
      amount,
      reason,
      balanceBefore: currentBalance,
      balanceAfter: updated,
      createdAt: new Date().toISOString(),
    })

    return updated
  })

  return { newBalance }
}
