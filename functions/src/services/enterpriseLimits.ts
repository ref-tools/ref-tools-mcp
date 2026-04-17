import type { Firestore } from "firebase-admin/firestore";
import {
  type LimitType,
  LIMIT_TYPE_TO_CONFIG_FIELD,
} from "../../../shared-common/tierLimits.js";

export interface EnterpriseAccountLimits {
  maxPlans?: number;
  maxSmallRepos?: number;
  maxLargeRepos?: number;
  maxPdfPages?: number;
  maxFileUploads?: number;
  monthlyCredits?: number;
}

export async function getEnterpriseOverride(
  db: Firestore,
  teamId: string,
  limitType: LimitType,
): Promise<number | undefined> {
  const doc = await db
    .collection("enterpriseAccounts")
    .doc(teamId)
    .get();

  if (!doc.exists) {
    return undefined;
  }

  const data = doc.data() as EnterpriseAccountLimits | undefined;
  if (!data) {
    return undefined;
  }

  const field = LIMIT_TYPE_TO_CONFIG_FIELD[limitType];
  return (data as Record<string, unknown>)[field] as number | undefined;
}
