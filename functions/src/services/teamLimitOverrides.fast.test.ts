import { describe, it, expect, beforeEach } from "vitest";
import { LimitType } from "../../../shared-common/tierLimits.js";
import {
  getTeamLimitOverrides,
  setTeamLimitOverrides,
  clearTeamLimitOverrides,
  getTeamLimitOverride,
  resolveLimitOverride,
} from "./teamLimitOverrides.js";
import type { Firestore } from "firebase-admin/firestore";

/**
 * Minimal in-memory Firestore mock that supports the collection/doc/get/set/delete
 * operations used by the teamLimitOverrides service.
 */
function createMockFirestore(): Firestore {
  const store: Record<string, Record<string, Record<string, unknown>>> = {};

  const mockDoc = (collectionPath: string, docId: string) => ({
    get: async () => {
      const data = store[collectionPath]?.[docId];
      return {
        exists: data !== undefined,
        data: () => (data !== undefined ? { ...data } : undefined),
      };
    },
    set: async (value: Record<string, unknown>, options?: { merge?: boolean }) => {
      if (!store[collectionPath]) {
        store[collectionPath] = {};
      }
      if (options?.merge && store[collectionPath][docId]) {
        store[collectionPath][docId] = {
          ...store[collectionPath][docId],
          ...value,
        };
      } else {
        store[collectionPath][docId] = { ...value };
      }
    },
    delete: async () => {
      if (store[collectionPath]) {
        delete store[collectionPath][docId];
      }
    },
  });

  const mockCollection = (path: string) => ({
    doc: (id: string) => mockDoc(path, id),
  });

  return {
    collection: (path: string) => mockCollection(path),
  } as unknown as Firestore;
}

describe("teamLimitOverrides", () => {
  let db: Firestore;

  beforeEach(() => {
    db = createMockFirestore();
  });

  describe("setTeamLimitOverrides + getTeamLimitOverrides round-trip", () => {
    it("should set and read back all fields", async () => {
      const teamId = "team-123";
      const limits = {
        maxPlans: 10,
        maxSmallRepos: 20,
        maxLargeRepos: 5,
        maxPdfPages: 1000,
        maxFileUploads: 50,
        monthlyCredits: 500,
        notes: "Trial extension for team-123",
      };

      await setTeamLimitOverrides(db, teamId, limits, "admin-user-1");
      const result = await getTeamLimitOverrides(db, teamId);

      expect(result).not.toBeNull();
      expect(result!.maxPlans).toBe(10);
      expect(result!.maxSmallRepos).toBe(20);
      expect(result!.maxLargeRepos).toBe(5);
      expect(result!.maxPdfPages).toBe(1000);
      expect(result!.maxFileUploads).toBe(50);
      expect(result!.monthlyCredits).toBe(500);
      expect(result!.notes).toBe("Trial extension for team-123");
      expect(result!.updatedBy).toBe("admin-user-1");
    });

    it("should return null for a non-existent team", async () => {
      const result = await getTeamLimitOverrides(db, "non-existent-team");
      expect(result).toBeNull();
    });

    it("should merge-write when updating existing overrides", async () => {
      const teamId = "team-merge";

      await setTeamLimitOverrides(db, teamId, { maxPlans: 5 }, "admin-1");
      await setTeamLimitOverrides(db, teamId, { maxSmallRepos: 15 }, "admin-2");

      const result = await getTeamLimitOverrides(db, teamId);

      expect(result).not.toBeNull();
      expect(result!.maxPlans).toBe(5);
      expect(result!.maxSmallRepos).toBe(15);
      expect(result!.updatedBy).toBe("admin-2");
    });
  });

  describe("getTeamLimitOverride", () => {
    it("should return the correct value for each LimitType", async () => {
      const teamId = "team-limits";
      const limits = {
        maxPlans: 10,
        maxSmallRepos: 20,
        maxLargeRepos: 5,
        maxPdfPages: 1000,
        maxFileUploads: 50,
        monthlyCredits: 500,
      };

      await setTeamLimitOverrides(db, teamId, limits, "admin-1");

      expect(await getTeamLimitOverride(db, teamId, LimitType.MaxPlans)).toBe(10);
      expect(await getTeamLimitOverride(db, teamId, LimitType.MaxSmallRepos)).toBe(20);
      expect(await getTeamLimitOverride(db, teamId, LimitType.MaxLargeRepos)).toBe(5);
      expect(await getTeamLimitOverride(db, teamId, LimitType.MaxPdfPages)).toBe(1000);
      expect(await getTeamLimitOverride(db, teamId, LimitType.MaxFileUploads)).toBe(50);
      expect(await getTeamLimitOverride(db, teamId, LimitType.MonthlyCredits)).toBe(500);
    });

    it("should return undefined for a non-existent team", async () => {
      const result = await getTeamLimitOverride(db, "no-team", LimitType.MaxPlans);
      expect(result).toBeUndefined();
    });

    it("should return undefined for a field that was not set", async () => {
      const teamId = "team-partial";
      await setTeamLimitOverrides(db, teamId, { maxPlans: 10 }, "admin-1");

      const result = await getTeamLimitOverride(db, teamId, LimitType.MonthlyCredits);
      expect(result).toBeUndefined();
    });
  });

  describe("clearTeamLimitOverrides", () => {
    it("should delete the doc so subsequent reads return null", async () => {
      const teamId = "team-clear";
      await setTeamLimitOverrides(db, teamId, { maxPlans: 10 }, "admin-1");

      const before = await getTeamLimitOverrides(db, teamId);
      expect(before).not.toBeNull();

      await clearTeamLimitOverrides(db, teamId);

      const after = await getTeamLimitOverrides(db, teamId);
      expect(after).toBeNull();
    });

    it("should not throw when clearing a non-existent team", async () => {
      await expect(
        clearTeamLimitOverrides(db, "non-existent-team"),
      ).resolves.toBeUndefined();
    });
  });

  describe("partial overrides", () => {
    it("should only set provided fields, leaving others undefined", async () => {
      const teamId = "team-partial-set";
      await setTeamLimitOverrides(db, teamId, { maxPlans: 5, notes: "Trial" }, "admin-1");

      const result = await getTeamLimitOverrides(db, teamId);

      expect(result).not.toBeNull();
      expect(result!.maxPlans).toBe(5);
      expect(result!.notes).toBe("Trial");
      expect(result!.maxSmallRepos).toBeUndefined();
      expect(result!.maxLargeRepos).toBeUndefined();
      expect(result!.maxPdfPages).toBeUndefined();
      expect(result!.maxFileUploads).toBeUndefined();
      expect(result!.monthlyCredits).toBeUndefined();
    });
  });

  describe("resolveLimitOverride", () => {
    function seedEnterprise(
      firestoreDb: Firestore,
      teamId: string,
      data: Record<string, unknown>,
    ) {
      return (firestoreDb as unknown as {
        collection: (p: string) => {
          doc: (id: string) => { set: (v: Record<string, unknown>, o?: { merge?: boolean }) => Promise<void> };
        };
      })
        .collection("enterpriseAccounts")
        .doc(teamId)
        .set(data, { merge: true });
    }

    it("free-tier team with team override returns the override value", async () => {
      const teamId = "free-team-1";
      await setTeamLimitOverrides(db, teamId, { maxLargeRepos: 5 }, "admin-1");

      const result = await resolveLimitOverride(db, "free", LimitType.MaxLargeRepos, teamId);
      expect(result).toBe(5);
    });

    it("free-tier team with no override returns undefined", async () => {
      const result = await resolveLimitOverride(
        db,
        "free",
        LimitType.MaxLargeRepos,
        "free-team-no-override",
      );
      expect(result).toBeUndefined();
    });

    it("enterprise team with both overrides — team override wins", async () => {
      const teamId = "enterprise-team-both";
      await seedEnterprise(db, teamId, { maxLargeRepos: 20 });
      await setTeamLimitOverrides(db, teamId, { maxLargeRepos: 50 }, "admin-1");

      const result = await resolveLimitOverride(
        db,
        "enterprise",
        LimitType.MaxLargeRepos,
        teamId,
      );
      expect(result).toBe(50);
    });

    it("enterprise team with no team override — enterprise override returned", async () => {
      const teamId = "enterprise-team-ent-only";
      await seedEnterprise(db, teamId, { maxLargeRepos: 20 });

      const result = await resolveLimitOverride(
        db,
        "enterprise",
        LimitType.MaxLargeRepos,
        teamId,
      );
      expect(result).toBe(20);
    });

    it("team override for one limit doesn't affect a different limit", async () => {
      const teamId = "team-cross-limit";
      await setTeamLimitOverrides(db, teamId, { maxPlans: 10 }, "admin-1");

      const plansResult = await resolveLimitOverride(
        db,
        "free",
        LimitType.MaxPlans,
        teamId,
      );
      expect(plansResult).toBe(10);

      const reposResult = await resolveLimitOverride(
        db,
        "free",
        LimitType.MaxLargeRepos,
        teamId,
      );
      expect(reposResult).toBeUndefined();
    });
  });
});
