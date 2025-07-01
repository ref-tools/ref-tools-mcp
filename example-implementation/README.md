# Preventing Removal During Indexing - Implementation Example

This example implementation demonstrates how to prevent users from removing repositories or PDF sets while they are being indexed in a Firebase-based application.

## 📁 File Structure

```
example-implementation/
├── types/
│   └── indexing.ts              # TypeScript types for indexing status
├── functions/
│   └── src/
│       └── removeHandlers.ts    # Firebase Cloud Functions
├── components/
│   ├── RepoList.tsx            # React component for repository list
│   └── PdfSetList.tsx          # React component for PDF set list
├── IMPLEMENTATION_GUIDE.md      # Detailed implementation guide
└── README.md                    # This file
```

## 🔑 Key Features

1. **Server-side Protection**: Firebase callable functions validate indexing status before allowing deletion
2. **UI State Management**: Remove buttons are automatically disabled during indexing
3. **Real-time Updates**: Status changes are reflected immediately in the UI
4. **User Feedback**: Clear error messages and visual indicators

## 🛡️ How It Works

### Backend (Firebase Functions)
- `removeRepo` and `removePdfSet` functions check if the resource is currently indexing
- Returns a `failed-precondition` error if removal is attempted during indexing
- Includes authentication and ownership checks

### Frontend (React Components)
- Subscribes to Firestore for real-time status updates
- Disables remove buttons when status is `INDEXING`
- Shows progress bars and appropriate status badges
- Handles errors gracefully with user-friendly messages

## 🚀 Implementation Steps

1. **Add the types** from `types/indexing.ts` to your project
2. **Deploy the Firebase functions** from `functions/src/removeHandlers.ts`
3. **Update your Firestore schema** to include the `status` field
4. **Integrate the UI components** into your application
5. **Update your indexing process** to set the appropriate status

## 📝 Example Usage

```typescript
// Start indexing
await updateDoc(doc(firestore, 'repos', repoId), {
  status: IndexingStatus.INDEXING,
  startedAt: new Date()
});

// During indexing - removal will be blocked

// Complete indexing
await updateDoc(doc(firestore, 'repos', repoId), {
  status: IndexingStatus.COMPLETED,
  completedAt: new Date()
});

// Now removal is allowed again
```

## ⚠️ Important Notes

- Always validate on the server side - never trust client-side validation alone
- Use Firestore transactions when updating multiple related documents
- Consider implementing a cleanup job for stuck indexing operations
- Test thoroughly with different network conditions and edge cases

## 📚 Further Reading

See `IMPLEMENTATION_GUIDE.md` for detailed implementation instructions and best practices.