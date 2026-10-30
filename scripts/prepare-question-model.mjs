// Explicit setup only. Runtime questions never download models or call an embedding API.
import { createQuestionEmbedder, defaultModelDirectory, embeddingIdentity } from '../question-embeddings.mjs';

const directory = process.argv.find(value => value.startsWith('--directory='))?.slice(12) ?? defaultModelDirectory;
const embedder = await createQuestionEmbedder({ directory, download: true });
try {
  const [vector] = await embedder.embed(['Nations rules and Python implementation.']);
  console.log(JSON.stringify({ model: embeddingIdentity, dimensions: vector.length, directory }));
} finally { await embedder.dispose(); }
