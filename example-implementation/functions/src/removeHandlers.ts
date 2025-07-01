import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { IndexingStatus } from '../../types/indexing';

const db = admin.firestore();

// Helper function to check if a resource is currently indexing
async function isResourceIndexing(resourceId: string, resourceType: 'repo' | 'pdfSet'): Promise<boolean> {
  const collection = resourceType === 'repo' ? 'repos' : 'pdfSets';
  const doc = await db.collection(collection).doc(resourceId).get();
  
  if (!doc.exists) {
    return false;
  }
  
  const data = doc.data();
  return data?.status === IndexingStatus.INDEXING;
}

// Firebase callable function to remove a repository
export const removeRepo = functions.https.onCall(async (data, context) => {
  // Check authentication
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated');
  }

  const { repoId } = data;
  
  if (!repoId) {
    throw new functions.https.HttpsError('invalid-argument', 'Repository ID is required');
  }

  try {
    // Check if the repo is currently indexing
    const isIndexing = await isResourceIndexing(repoId, 'repo');
    
    if (isIndexing) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'Cannot remove repository while it is being indexed. Please wait for indexing to complete.'
      );
    }

    // Check ownership
    const repoDoc = await db.collection('repos').doc(repoId).get();
    if (!repoDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Repository not found');
    }

    const repoData = repoDoc.data();
    if (repoData?.userId !== context.auth.uid) {
      throw new functions.https.HttpsError('permission-denied', 'You do not have permission to remove this repository');
    }

    // Perform the deletion
    await db.collection('repos').doc(repoId).delete();
    
    // Clean up any associated data (e.g., indexed documents)
    const batch = db.batch();
    const indexedDocs = await db.collection('indexedDocuments')
      .where('repoId', '==', repoId)
      .get();
    
    indexedDocs.forEach(doc => {
      batch.delete(doc.ref);
    });
    
    await batch.commit();

    return { success: true, message: 'Repository removed successfully' };
  } catch (error) {
    if (error instanceof functions.https.HttpsError) {
      throw error;
    }
    console.error('Error removing repository:', error);
    throw new functions.https.HttpsError('internal', 'An error occurred while removing the repository');
  }
});

// Firebase callable function to remove a PDF set
export const removePdfSet = functions.https.onCall(async (data, context) => {
  // Check authentication
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated');
  }

  const { pdfSetId } = data;
  
  if (!pdfSetId) {
    throw new functions.https.HttpsError('invalid-argument', 'PDF set ID is required');
  }

  try {
    // Check if the PDF set is currently indexing
    const isIndexing = await isResourceIndexing(pdfSetId, 'pdfSet');
    
    if (isIndexing) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'Cannot remove PDF set while it is being indexed. Please wait for indexing to complete.'
      );
    }

    // Check ownership
    const pdfSetDoc = await db.collection('pdfSets').doc(pdfSetId).get();
    if (!pdfSetDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'PDF set not found');
    }

    const pdfSetData = pdfSetDoc.data();
    if (pdfSetData?.userId !== context.auth.uid) {
      throw new functions.https.HttpsError('permission-denied', 'You do not have permission to remove this PDF set');
    }

    // Perform the deletion
    await db.collection('pdfSets').doc(pdfSetId).delete();
    
    // Clean up any associated data (e.g., indexed documents, stored files)
    const batch = db.batch();
    const indexedDocs = await db.collection('indexedDocuments')
      .where('pdfSetId', '==', pdfSetId)
      .get();
    
    indexedDocs.forEach(doc => {
      batch.delete(doc.ref);
    });
    
    await batch.commit();

    // Delete associated files from storage
    const storage = admin.storage().bucket();
    const filesToDelete = pdfSetData?.files || [];
    await Promise.all(
      filesToDelete.map(async (filePath: string) => {
        try {
          await storage.file(filePath).delete();
        } catch (error) {
          console.error(`Failed to delete file ${filePath}:`, error);
        }
      })
    );

    return { success: true, message: 'PDF set removed successfully' };
  } catch (error) {
    if (error instanceof functions.https.HttpsError) {
      throw error;
    }
    console.error('Error removing PDF set:', error);
    throw new functions.https.HttpsError('internal', 'An error occurred while removing the PDF set');
  }
});

// Export functions
export const removeHandlers = {
  removeRepo,
  removePdfSet
};