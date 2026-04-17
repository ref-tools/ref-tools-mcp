import type { Firestore } from 'firebase-admin/firestore'

export type CreditInfo = {
  userId: string
  email: string
  tier: string
  creditBalance: number
  monthlyAllowance: number | null
  teamMemberships: Array<{ teamId: string; teamName: string; role: string }>
}

/**
 * Add credits to a user's account. Performs an atomic increment on the
 * user's credit balance and logs the transaction.
 */
export async function addCredits(
  db: Firestore,
  userId: string,
  amount: number,
  reason: string,
): Promise<{ newBalance: number }> {
  const userRef = db.collection('users').doc(userId)

  const newBalance = await db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef)
    if (!snap.exists) {
      throw new Error(`User ${userId} does not exist`)
    }

    const data = snap.data()!
    const currentBalance: number = (data['creditBalance'] as number) ?? 0
    const updated = currentBalance + amount

    tx.update(userRef, { creditBalance: updated })

    const txRef = db.collection('users').doc(userId).collection('creditTransactions').doc()
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

/**
 * Retrieve credit and profile info for a user.
 */
export async function getUserCreditInfo(db: Firestore, userId: string): Promise<CreditInfo> {
  const userSnap = await db.collection('users').doc(userId).get()
  if (!userSnap.exists) {
    throw new Error(`User ${userId} does not exist`)
  }

  const data = userSnap.data()!
  const email: string = (data['email'] as string) ?? ''
  const tier: string = (data['tier'] as string) ?? 'free'
  const creditBalance: number = (data['creditBalance'] as number) ?? 0
  const monthlyAllowance: number | null = (data['monthlyAllowance'] as number) ?? null

  const membershipsSnap = await db
    .collection('teamMembers')
    .where('userId', '==', userId)
    .get()

  const teamMemberships: CreditInfo['teamMemberships'] = []
  for (const doc of membershipsSnap.docs) {
    const m = doc.data()
    const teamSnap = await db.collection('teams').doc(m['teamId'] as string).get()
    const teamData = teamSnap.data()
    teamMemberships.push({
      teamId: m['teamId'] as string,
      teamName: (teamData?.['name'] as string) ?? '(unknown)',
      role: (m['role'] as string) ?? 'member',
    })
  }

  return { userId, email, tier, creditBalance, monthlyAllowance, teamMemberships }
}

/**
 * Look up a user by email. Returns the userId or null if not found.
 */
export async function findUserByEmail(
  db: Firestore,
  email: string,
): Promise<string | null> {
  const snap = await db.collection('users').where('email', '==', email).limit(1).get()
  if (snap.empty) return null
  return snap.docs[0]!.id
}
