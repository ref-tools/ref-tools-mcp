import type { Firestore, Timestamp } from "firebase-admin/firestore";
import { FieldValue } from "firebase-admin/firestore";
import {
  type LimitType,
  LIMIT_TYPE_TO_CONFIG_FIELD,
} from "../../../shared-common/tierLimits.js";

export interface TeamLimitOverrides {
  maxPlans?: number;
  maxSmallRepos?: number;
  maxLargeRepos?: number;
  maxPdfPages?: number;
  maxFileUploads?: number;
  monthlyCredits?: number;
  notes?: string;
  updatedAt?: Timestamp;
  updatedBy?: string;
}

const COLLECTION = "teamLimitOverrides";

export async function getTeamLimitOverrides(
  db: Firestore,
  teamId: string,
): Promise<TeamLimitOverrides | null> {
  const doc = await db.collection(COLLECTION).doc(teamId).get();

  if (!doc.exists) {
    return null;
  }

  return (doc.data() as TeamLimitOverrides) ?? null;
}

export async function setTeamLimitOverrides(
  db: Firestore,
  teamId: string,
  limits: Omit<TeamLimitOverrides, "updatedAt" | "updatedBy">,
  adminUserId: string,
): Promise<void> {
  await db
    .collection(COLLECTION)
    .doc(teamId)
    .set(
      {
        ...limits,
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: adminUserId,
      },
      { merge: true },
    );
}

export async function clearTeamLimitOverrides(
  db: Firestore,
  teamId: string,
): Promise<void> {
  await db.collection(COLLECTION).doc(teamId).delete();
}

export async function getTeamLimitOverride(
  db: Firestore,
  teamId: string,
  limitType: LimitType,
): Promise<number | undefined> {
  const overrides = await getTeamLimitOverrides(db, teamId);

  if (!overrides) {
    return undefined;
  }

  const field = LIMIT_TYPE_TO_CONFIG_FIELD[limitType];
  return (overrides as Record<string, unknown>)[field] as number | undefined;
}
