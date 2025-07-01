import React, { useState, useEffect } from 'react';
import { functions, firestore } from '../firebase/config';
import { httpsCallable } from 'firebase/functions';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { IndexingStatus, RepoIndexingState } from '../types/indexing';

interface RepoListProps {
  userId: string;
}

export const RepoList: React.FC<RepoListProps> = ({ userId }) => {
  const [repos, setRepos] = useState<RepoIndexingState[]>([]);
  const [removingRepoId, setRemovingRepoId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Subscribe to repos in real-time
  useEffect(() => {
    const q = query(
      collection(firestore, 'repos'),
      where('userId', '==', userId)
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const repoData: RepoIndexingState[] = [];
      snapshot.forEach((doc) => {
        repoData.push({
          id: doc.id,
          ...doc.data()
        } as RepoIndexingState);
      });
      setRepos(repoData);
    });

    return () => unsubscribe();
  }, [userId]);

  const handleRemoveRepo = async (repoId: string) => {
    setError(null);
    setRemovingRepoId(repoId);

    try {
      const removeRepoFunc = httpsCallable(functions, 'removeRepo');
      const result = await removeRepoFunc({ repoId });
      console.log('Repository removed:', result.data);
    } catch (error: any) {
      console.error('Error removing repository:', error);
      setError(error.message || 'Failed to remove repository');
    } finally {
      setRemovingRepoId(null);
    }
  };

  const isRemoveDisabled = (repo: RepoIndexingState): boolean => {
    return repo.status === IndexingStatus.INDEXING || removingRepoId === repo.id;
  };

  const getStatusBadge = (status: IndexingStatus) => {
    const statusStyles = {
      [IndexingStatus.IDLE]: 'bg-gray-100 text-gray-800',
      [IndexingStatus.INDEXING]: 'bg-blue-100 text-blue-800 animate-pulse',
      [IndexingStatus.COMPLETED]: 'bg-green-100 text-green-800',
      [IndexingStatus.FAILED]: 'bg-red-100 text-red-800'
    };

    return (
      <span className={`px-2 py-1 text-xs font-medium rounded-full ${statusStyles[status]}`}>
        {status}
      </span>
    );
  };

  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-bold">Your Repositories</h2>
      
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded">
          {error}
        </div>
      )}

      <div className="grid gap-4">
        {repos.map((repo) => (
          <div
            key={repo.id}
            className="bg-white border border-gray-200 rounded-lg p-4 shadow-sm"
          >
            <div className="flex items-center justify-between">
              <div className="flex-1">
                <h3 className="text-lg font-semibold">{repo.name}</h3>
                <p className="text-sm text-gray-600">{repo.url}</p>
                {repo.status === IndexingStatus.INDEXING && repo.progress !== undefined && (
                  <div className="mt-2">
                    <div className="flex items-center space-x-2">
                      <div className="flex-1 bg-gray-200 rounded-full h-2">
                        <div
                          className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                          style={{ width: `${repo.progress}%` }}
                        />
                      </div>
                      <span className="text-sm text-gray-600">{repo.progress}%</span>
                    </div>
                  </div>
                )}
              </div>
              
              <div className="flex items-center space-x-4">
                {getStatusBadge(repo.status)}
                
                <button
                  onClick={() => handleRemoveRepo(repo.id)}
                  disabled={isRemoveDisabled(repo)}
                  className={`
                    px-4 py-2 text-sm font-medium rounded-md transition-all
                    ${isRemoveDisabled(repo)
                      ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                      : 'bg-red-600 text-white hover:bg-red-700 active:bg-red-800'
                    }
                  `}
                  title={repo.status === IndexingStatus.INDEXING 
                    ? 'Cannot remove while indexing' 
                    : 'Remove repository'
                  }
                >
                  {removingRepoId === repo.id ? 'Removing...' : 'Remove'}
                </button>
              </div>
            </div>
            
            {repo.error && (
              <div className="mt-2 text-sm text-red-600">
                Error: {repo.error}
              </div>
            )}
          </div>
        ))}
      </div>

      {repos.length === 0 && (
        <div className="text-center py-8 text-gray-500">
          No repositories added yet
        </div>
      )}
    </div>
  );
};