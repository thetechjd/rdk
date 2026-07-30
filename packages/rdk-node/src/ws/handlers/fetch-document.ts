// Return the authoritative complete document. Search chunks are deliberately
// not reassembled: they overlap, may omit low-density text, and are not the
// user-facing content unit.

interface FetchDocumentResult {
  documentHash: string;
  title?: string;
  isPublic?: boolean;
  content?: string;
  available: boolean;
}

let storePromise: Promise<import('@rdk/core').LocalStore> | null = null;

async function sharedStore(): Promise<import('@rdk/core').LocalStore> {
  if (!storePromise) {
    storePromise = import('@rdk/core')
      .then(({ LocalStore }) => new LocalStore())
      .catch((error) => {
        storePromise = null;
        throw error;
      });
  }
  return storePromise;
}

export async function fetchDocumentHandler(
  data: unknown,
): Promise<{ documents: FetchDocumentResult[] }> {
  const { documentHashes } = data as { documentHashes?: string[] };
  const store = await sharedStore();
  const documents = (documentHashes ?? []).map((documentHash) => {
    const document = store.getDocument(documentHash);
    if (!document) return { documentHash, available: false };
    return {
      documentHash,
      title: document.title,
      isPublic: document.isPublic,
      content: document.content,
      available: true,
    };
  });
  return { documents };
}
