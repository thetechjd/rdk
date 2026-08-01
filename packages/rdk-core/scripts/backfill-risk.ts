import { LocalStore } from '../src/store/local-store.js';
import { scanChunk } from '../src/index/scan.js';

const store = new LocalStore(process.argv[2]);
const chunks = store.getAllChunks();
for (const chunk of chunks) store.setChunkRisk(chunk.id, scanChunk(chunk.content));
console.error(`[rdk] scanned ${chunks.length} existing chunk(s)`);
