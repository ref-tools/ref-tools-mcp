export enum LimitType {
  MaxPlans = "maxPlans",
  MaxSmallRepos = "maxSmallRepos",
  MaxLargeRepos = "maxLargeRepos",
  MaxPdfPages = "maxPdfPages",
  MaxFileUploads = "maxFileUploads",
  MonthlyCredits = "monthlyCredits",
}

export const LIMIT_TYPE_TO_CONFIG_FIELD: Record<LimitType, string> = {
  [LimitType.MaxPlans]: "maxPlans",
  [LimitType.MaxSmallRepos]: "maxSmallRepos",
  [LimitType.MaxLargeRepos]: "maxLargeRepos",
  [LimitType.MaxPdfPages]: "maxPdfPages",
  [LimitType.MaxFileUploads]: "maxFileUploads",
  [LimitType.MonthlyCredits]: "monthlyCredits",
};
