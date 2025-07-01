# Implementation Guide: Preventing Removal During Indexing

This guide demonstrates how to implement functionality that prevents users from removing repositories or PDF sets while they are being indexed.

## Overview

The implementation consists of three main parts:
1. **Backend validation** in Firebase Cloud Functions
2. **UI state management** to disable remove buttons
3. **Real-time status updates** using Firestore listeners

## Key Components

### 1. Data Types (`types/indexing.ts`)

```typescript
enum IndexingStatus {
  IDLE = 'idle',
  INDEXING = 'indexing',
  COMPLETED = 'completed',
  FAILED = 'failed'
}
```

### 2. Firebase Cloud Functions (`functions/src/removeHandlers.ts`)

The Firebase callable functions check the indexing status before allowing removal:

- **`removeRepo`**: Validates that the repo is not in `INDEXING` status
- **`removePdfSet`**: Validates that the PDF set is not in `INDEXING` status

Both functions return a `failed-precondition` error if the resource is currently indexing.

### 3. React Components

#### Repository List (`components/RepoList.tsx`)
- Subscribes to real-time updates of repository status
- Disables the remove button when status is `INDEXING`
- Shows progress bar during indexing
- Displays appropriate error messages

#### PDF Set List (`components/PdfSetList.tsx`)
- Similar functionality for PDF sets
- Shows file count and list
- Hides file details during indexing to show progress

## Implementation Details

### Backend Protection

The Firebase functions implement a two-layer protection:

1. **Status Check**: Before deletion, the function queries the document to check if `status === 'indexing'`
2. **Error Response**: Returns a descriptive error that the UI can display

```typescript
if (isIndexing) {
  throw new functions.https.HttpsError(
    'failed-precondition',
    'Cannot remove repository while it is being indexed. Please wait for indexing to complete.'
  );
}
```

### UI Behavior

The remove button is disabled when:
- The resource status is `INDEXING`
- A removal operation is in progress

Visual feedback includes:
- Grayed out button with `cursor-not-allowed`
- Tooltip explaining why the button is disabled
- Progress bar showing indexing progress
- Animated status badge

### Real-time Updates

Using Firestore's `onSnapshot`:
- UI automatically updates when indexing status changes
- Progress updates are reflected immediately
- No polling required

## Security Considerations

1. **Server-side validation** is critical - never rely only on UI disabled state
2. **Authentication checks** ensure users can only remove their own resources
3. **Atomic operations** using batch writes for cleanup

## Error Handling

The implementation handles several error cases:
- Resource not found
- Permission denied
- Indexing in progress
- Network errors

Each error type provides a user-friendly message that can be displayed in the UI.

## Usage Example

```typescript
// In your UI component
const handleRemove = async (resourceId: string) => {
  try {
    const removeFunc = httpsCallable(functions, 'removeRepo');
    await removeFunc({ repoId: resourceId });
    // Success - resource removed
  } catch (error) {
    if (error.code === 'failed-precondition') {
      // Resource is indexing - show appropriate message
    }
    // Handle other errors
  }
};
```

## Testing Recommendations

1. Test the Firebase functions with resources in different states
2. Verify UI updates correctly when status changes
3. Test error scenarios (network failures, permission errors)
4. Ensure cleanup operations complete successfully

## Future Enhancements

Consider adding:
- Estimated time remaining for indexing
- Option to cancel indexing operations
- Batch operations for removing multiple resources
- Webhook notifications when indexing completes