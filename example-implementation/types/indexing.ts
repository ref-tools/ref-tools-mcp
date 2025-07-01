// Types for repo and PDF set indexing status
export enum IndexingStatus {
  IDLE = 'idle',
  INDEXING = 'indexing',
  COMPLETED = 'completed',
  FAILED = 'failed'
}

export interface RepoIndexingState {
  id: string;
  name: string;
  url: string;
  status: IndexingStatus;
  progress?: number;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
}

export interface PdfSetIndexingState {
  id: string;
  name: string;
  files: string[];
  status: IndexingStatus;
  progress?: number;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
}