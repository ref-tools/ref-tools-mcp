import React, { useState, useEffect } from 'react';
import { functions, firestore } from '../firebase/config';
import { httpsCallable } from 'firebase/functions';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { IndexingStatus, PdfSetIndexingState } from '../types/indexing';

interface PdfSetListProps {
  userId: string;
}

export const PdfSetList: React.FC<PdfSetListProps> = ({ userId }) => {
  const [pdfSets, setPdfSets] = useState<PdfSetIndexingState[]>([]);
  const [removingPdfSetId, setRemovingPdfSetId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Subscribe to PDF sets in real-time
  useEffect(() => {
    const q = query(
      collection(firestore, 'pdfSets'),
      where('userId', '==', userId)
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const pdfSetData: PdfSetIndexingState[] = [];
      snapshot.forEach((doc) => {
        pdfSetData.push({
          id: doc.id,
          ...doc.data()
        } as PdfSetIndexingState);
      });
      setPdfSets(pdfSetData);
    });

    return () => unsubscribe();
  }, [userId]);

  const handleRemovePdfSet = async (pdfSetId: string) => {
    setError(null);
    setRemovingPdfSetId(pdfSetId);

    try {
      const removePdfSetFunc = httpsCallable(functions, 'removePdfSet');
      const result = await removePdfSetFunc({ pdfSetId });
      console.log('PDF set removed:', result.data);
    } catch (error: any) {
      console.error('Error removing PDF set:', error);
      setError(error.message || 'Failed to remove PDF set');
    } finally {
      setRemovingPdfSetId(null);
    }
  };

  const isRemoveDisabled = (pdfSet: PdfSetIndexingState): boolean => {
    return pdfSet.status === IndexingStatus.INDEXING || removingPdfSetId === pdfSet.id;
  };

  const getStatusBadge = (status: IndexingStatus) => {
    const statusStyles = {
      [IndexingStatus.IDLE]: 'bg-gray-100 text-gray-800',
      [IndexingStatus.INDEXING]: 'bg-blue-100 text-blue-800 animate-pulse',
      [IndexingStatus.COMPLETED]: 'bg-green-100 text-green-800',
      [IndexingStatus.FAILED]: 'bg-red-100 text-red-800'
    };

    const statusLabels = {
      [IndexingStatus.IDLE]: 'Ready',
      [IndexingStatus.INDEXING]: 'Indexing...',
      [IndexingStatus.COMPLETED]: 'Indexed',
      [IndexingStatus.FAILED]: 'Failed'
    };

    return (
      <span className={`px-2 py-1 text-xs font-medium rounded-full ${statusStyles[status]}`}>
        {statusLabels[status]}
      </span>
    );
  };

  const formatFileSize = (bytes: number): string => {
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    if (bytes === 0) return '0 Bytes';
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
  };

  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-bold">Your PDF Sets</h2>
      
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded">
          {error}
        </div>
      )}

      <div className="grid gap-4">
        {pdfSets.map((pdfSet) => (
          <div
            key={pdfSet.id}
            className="bg-white border border-gray-200 rounded-lg p-4 shadow-sm"
          >
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <h3 className="text-lg font-semibold">{pdfSet.name}</h3>
                <div className="mt-1 space-y-1">
                  <p className="text-sm text-gray-600">
                    {pdfSet.files.length} file{pdfSet.files.length !== 1 ? 's' : ''}
                  </p>
                  
                  {/* Show file list when not indexing */}
                  {pdfSet.status !== IndexingStatus.INDEXING && (
                    <div className="mt-2 space-y-1">
                      {pdfSet.files.slice(0, 3).map((file, index) => (
                        <p key={index} className="text-xs text-gray-500 truncate">
                          • {file}
                        </p>
                      ))}
                      {pdfSet.files.length > 3 && (
                        <p className="text-xs text-gray-400">
                          and {pdfSet.files.length - 3} more...
                        </p>
                      )}
                    </div>
                  )}
                  
                  {/* Show progress bar when indexing */}
                  {pdfSet.status === IndexingStatus.INDEXING && pdfSet.progress !== undefined && (
                    <div className="mt-3">
                      <div className="flex items-center space-x-2">
                        <div className="flex-1 bg-gray-200 rounded-full h-2">
                          <div
                            className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                            style={{ width: `${pdfSet.progress}%` }}
                          />
                        </div>
                        <span className="text-sm text-gray-600">{pdfSet.progress}%</span>
                      </div>
                      <p className="text-xs text-gray-500 mt-1">
                        Processing documents...
                      </p>
                    </div>
                  )}
                </div>
              </div>
              
              <div className="flex items-center space-x-4 ml-4">
                {getStatusBadge(pdfSet.status)}
                
                <button
                  onClick={() => handleRemovePdfSet(pdfSet.id)}
                  disabled={isRemoveDisabled(pdfSet)}
                  className={`
                    px-4 py-2 text-sm font-medium rounded-md transition-all
                    ${isRemoveDisabled(pdfSet)
                      ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                      : 'bg-red-600 text-white hover:bg-red-700 active:bg-red-800'
                    }
                  `}
                  title={pdfSet.status === IndexingStatus.INDEXING 
                    ? 'Cannot remove while indexing' 
                    : 'Remove PDF set'
                  }
                >
                  {removingPdfSetId === pdfSet.id ? 'Removing...' : 'Remove'}
                </button>
              </div>
            </div>
            
            {pdfSet.error && (
              <div className="mt-3 text-sm text-red-600 bg-red-50 p-2 rounded">
                Error: {pdfSet.error}
              </div>
            )}
          </div>
        ))}
      </div>

      {pdfSets.length === 0 && (
        <div className="text-center py-8 text-gray-500">
          No PDF sets uploaded yet
        </div>
      )}
    </div>
  );
};