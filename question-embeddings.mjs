import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

// Fixed model/revision: neither source text nor a question can select downloads.
export const embeddingModel = 'Xenova/bge-small-en-v1.5';
export const embeddingRevision = 'ea104dacec62c0de699686887e3f920caeb4f3e3';
export const embeddingDimensions = 384;
export const embeddingIdentity = `${embeddingModel}@${embeddingRevision}:q8:cls:v1`;
export const defaultModelDirectory = fileURLToPath(new URL('./.data/question-models/', import.meta.url));

export async function createQuestionEmbedder({ directory = defaultModelDirectory, download = false } = {}) {
  const { AutoModel, AutoTokenizer, env } = await import('@huggingface/transformers');
  env.allowRemoteModels = download;
  env.allowLocalModels = true;
  const options = {
    revision: embeddingRevision, cache_dir: directory, local_files_only: !download,
    dtype: 'q8', device: 'cpu', session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 },
  };
  // Load explicit components: pipeline auto-discovery can query remote file lists even offline.
  const location = download ? embeddingModel : join(resolve(directory), embeddingModel, embeddingRevision);
  const tokenizer = await AutoTokenizer.from_pretrained(location, options);
  const model = await AutoModel.from_pretrained(location, options);
  const embed = async (texts, query = false) => {
    if (!Array.isArray(texts) || !texts.length || texts.length > 8) throw new Error('Invalid embedding batch.');
    const input = query ? texts.map(text => `Represent this sentence for searching relevant passages: ${text}`) : texts;
    // Fail rather than silently lose the end of code that exceeds the model window.
    for (const text of input) {
      if (tokenizer.encode(text).length > 512) throw new Error('Embedding passage exceeds model window.');
    }
    const inputs = tokenizer(input, { padding: true, truncation: false });
    let output, pooled, normalized;
    try {
      output = await model(inputs);
      pooled = output.last_hidden_state.slice(null, 0);
      normalized = pooled.normalize(2, -1);
      return normalized.tolist();
    } finally {
      normalized?.dispose(); pooled?.dispose();
      for (const tensor of Object.values(output ?? {})) tensor.dispose?.();
      for (const tensor of Object.values(inputs)) tensor.dispose?.();
    }
  };
  return { embed, countTokens: text => tokenizer.encode(text).length, dispose: () => model.dispose() };
}
