import fs from 'node:fs';
import path from 'node:path';
import vectra from 'vectra';
import sanitize from 'sanitize-filename';
import { getConfigValue } from '../../src/util.js';
import { getOpenAIVector } from '../../src/vectors/openai-vectors.js';
import { getTransformersVector } from '../../src/vectors/embedding.js';
import { getCohereVector } from '../../src/vectors/cohere-vectors.js';
import { getNomicAIVector } from '../../src/vectors/nomicai-vectors.js';
import { getOllamaVector } from '../../src/vectors/ollama-vectors.js';
import { getLlamaCppVector } from '../../src/vectors/llamacpp-vectors.js';
import { getVllmVector } from '../../src/vectors/vllm-vectors.js';

export const info = {
    id: 'chat-search',
    name: 'Chat Search',
    description: 'Global full-text search across all chats',
};

// Serialize vectorize jobs — new request waits for previous to finish
let jobQueue = Promise.resolve();

export async function init(router) {
    // ==================== Keyword Search ====================
    router.post('/search', async (req, res) => {
        try {
            const { query, scope = 'all', characterName, onePerChat = true } = req.body;

            if (!query || !query.trim()) {
                return res.status(400).json({ error: 'Query required' });
            }

            const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
            if (keywords.length === 0) {
                return res.status(400).json({ error: 'Query required' });
            }

            const chatsDir = req.user.directories.chats;
            const results = [];
            const charDirs = getCharDirs(chatsDir, scope, characterName);

            for (const charName of charDirs) {
                const charPath = path.join(chatsDir, charName);
                if (!fs.existsSync(charPath)) continue;

                const files = safeReaddirSync(charPath).filter(f => f.endsWith('.jsonl'));

                for (const file of files) {
                    const { meta, messages } = readChat(path.join(charPath, file));
                    if (!meta) continue;

                    const chatCreateDate = meta.create_date || file.replace('.jsonl', '');

                    for (const msg of messages) {
                        if (!msg.mes) continue;
                        const lower = msg.mes.toLowerCase();
                        if (keywords.every(kw => lower.includes(kw))) {
                            results.push({
                                character: charName,
                                file: file.replace('.jsonl', ''),
                                chatCreateDate,
                                messageIndex: msg._lineIndex,
                                name: msg.name,
                                is_user: !!msg.is_user,
                                mes: msg.mes,
                                send_date: msg.send_date,
                            });
                            if (onePerChat) break;
                        }
                    }
                }
            }

            results.sort((a, b) => b.chatCreateDate.localeCompare(a.chatCreateDate));
            res.json({ results, count: results.length });
        } catch (error) {
            console.error('Chat search error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // ==================== Vectorize All (SSE) ====================
    router.get('/vectorize-all', async (req, res) => {
        const { scope = 'all', characterName, source, model } = req.query;
        const chunkSize = Number(req.query.chunkSize) || 400;

        if (!source) {
            return res.status(400).json({ error: 'source required' });
        }

        // Wait for any previous job to finish
        await jobQueue;

        // Disable compression for SSE
        req.headers['accept-encoding'] = 'identity';

        // SSE headers
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
            'Content-Encoding': 'identity',
        });

        let jobResolve;
        jobQueue = new Promise(r => { jobResolve = r; });

        let aborted = false;
        req.on('close', () => { aborted = true; });

        const send = (event, data) => {
            if (aborted) return;
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            if (typeof res.flush === 'function') res.flush();
        };

        try {
            const chatsDir = req.user.directories.chats;
            const vectorsDir = req.user.directories.vectors;
            const sourceStr = sanitize(source);
            const modelStr = sanitize(model || '');
            const charDirs = getCharDirs(chatsDir, scope, characterName);
            const delimiters = ['\n\n', '\n', ' ', ''];

            // Step 1: List all chats
            const allChats = [];
            for (const charName of charDirs) {
                const charPath = path.join(chatsDir, charName);
                if (!fs.existsSync(charPath)) continue;

                const files = safeReaddirSync(charPath).filter(f => f.endsWith('.jsonl'));
                for (const file of files) {
                    const collectionId = file.replace('.jsonl', '');
                    allChats.push({ character: charName, file: collectionId });
                }
            }

            // Step 2: Check which chats need vectorization
            const needsWork = [];
            const readyIds = [];

            for (const chat of allChats) {
                const indexPath = path.join(vectorsDir, sourceStr, sanitize(chat.file), modelStr, 'index.json');
                if (fs.existsSync(indexPath)) {
                    try {
                        const data = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
                        if (data.items && data.items.length > 0) {
                            readyIds.push(chat.file);
                            continue;
                        }
                    } catch { /* treat as needing work */ }
                }
                needsWork.push(chat);
            }

            if (needsWork.length === 0) {
                send('complete', { collectionIds: allChats.map(c => c.file) });
                res.end();
                return;
            }

            // Step 3: Build hash→vector cache from already-vectorized collections
            send('progress', { phase: 'cache', done: 0, total: needsWork.length, message: 'Building vector cache...' });
            const cache = buildVectorCache(vectorsDir, sourceStr, modelStr, readyIds);
            console.log(`[chat-search] Vector cache built: ${cache.size} unique hashes from ${readyIds.length} collections`);

            // Step 4: Process each chat
            const port = getConfigValue('port', 8000, 'number');
            let done = 0;

            for (const chat of needsWork) {
                if (aborted) {
                    console.log('[chat-search] Aborted');
                    break;
                }
                done++;
                send('progress', { phase: 'vectorize', done, total: needsWork.length, message: `${chat.character}/${chat.file}` });

                try {
                    const stats = await vectorizeChat(chat, chatsDir, vectorsDir, sourceStr, modelStr, source, model || '', chunkSize, delimiters, cache, port, req, () => aborted);
                    console.log(`[chat-search] ${chat.file}: total=${stats.totalChunks}, cached=${stats.cached}, uncached=${stats.uncached}, API requests=${stats.apiRequests}`);
                } catch (err) {
                    console.warn(`[chat-search] Failed to vectorize ${chat.file}:`, err.message);
                }
            }

            send('complete', { collectionIds: allChats.map(c => c.file) });
        } catch (error) {
            console.error('Vectorize-all error:', error);
            send('error', { message: error.message });
        }

        jobResolve();
        res.end();
    });

    // ==================== List Chats (still needed for query) ====================
    router.post('/list-chats', async (req, res) => {
        try {
            const { scope = 'all', characterName } = req.body;
            const chatsDir = req.user.directories.chats;
            const charDirs = getCharDirs(chatsDir, scope, characterName);
            const chats = [];

            for (const charName of charDirs) {
                const charPath = path.join(chatsDir, charName);
                if (!fs.existsSync(charPath)) continue;

                const files = safeReaddirSync(charPath).filter(f => f.endsWith('.jsonl'));
                for (const file of files) {
                    chats.push({ character: charName, file: file.replace('.jsonl', '') });
                }
            }

            res.json(chats);
        } catch (error) {
            console.error('List chats error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // ==================== Vector Query with Scores ====================
    router.post('/query-with-scores', async (req, res) => {
        try {
            const { collectionIds, searchText, source, model, threshold = 0.25, topK = 1 } = req.body;
            if (!Array.isArray(collectionIds) || !searchText || !source) {
                return res.status(400).json({ error: 'collectionIds, searchText, and source required' });
            }

            const vectorsDir = req.user.directories.vectors;
            const sourceStr = sanitize(source);
            const modelStr = sanitize(model || '');

            // Get query vector via embedding provider
            const queryVector = await getQueryVector(source, searchText, req.user.directories, model);

            // Query each collection, get best match with score
            const results = [];

            for (const colId of collectionIds) {
                const indexPath = path.join(vectorsDir, sourceStr, sanitize(colId), modelStr);
                const store = new vectra.LocalIndex(indexPath);

                if (!await store.isIndexCreated()) continue;

                const matches = await store.queryItems(queryVector, topK);
                for (const match of matches) {
                    if (match.score < threshold) continue;
                    results.push({
                        collectionId: colId,
                        score: Math.round(match.score * 1000) / 1000,
                        text: match.item.metadata.text,
                        hash: match.item.metadata.hash,
                        index: match.item.metadata.index,
                    });
                }
            }

            // Sort by score descending
            results.sort((a, b) => b.score - a.score);

            res.json(results);
        } catch (error) {
            console.error('Query with scores error:', error);
            res.status(500).json({ error: error.message });
        }
    });
}

async function getQueryVector(source, text, directories, model) {
    switch (source) {
        case 'togetherai':
        case 'mistral':
        case 'openai':
        case 'electronhub':
        case 'openrouter':
        case 'chutes':
        case 'nanogpt':
        case 'siliconflow':
            return getOpenAIVector(text, source, directories, model || '');
        case 'transformers':
            return getTransformersVector(text);
        case 'cohere':
            return getCohereVector(text, true, directories, model || '');
        case 'nomicai':
            return getNomicAIVector(text, source, directories);
        case 'ollama':
            return getOllamaVector(text, '', model || '', false, directories);
        case 'llamacpp':
            return getLlamaCppVector(text, '', directories);
        case 'vllm':
            return getVllmVector(text, '', model || '', directories);
        default:
            throw new Error(`Unsupported vector source: ${source}`);
    }
}

// ==================== Vectorize a single chat ====================

async function vectorizeChat(chat, chatsDir, vectorsDir, source, model, rawSource, rawModel, chunkSize, delimiters, cache, port, req, isAborted) {
    // Read messages
    const filePath = path.join(chatsDir, chat.character, chat.file + '.jsonl');
    const { messages } = readChat(filePath);
    const validMessages = messages.filter(m => m.mes && !m.is_system);

    if (validMessages.length === 0) {
        return { totalChunks: 0, cached: 0, uncached: 0, apiRequests: 0 };
    }

    // Chunk and hash
    const items = [];
    for (const m of validMessages) {
        const hash = getStringHash(m.mes);
        if (chunkSize > 0 && m.mes.length > chunkSize) {
            const chunks = splitRecursive(m.mes, chunkSize, delimiters);
            for (const chunk of chunks) {
                items.push({ hash, text: chunk, index: m._lineIndex });
            }
        } else {
            items.push({ hash, text: m.mes, index: m._lineIndex });
        }
    }

    // Check cache
    const cachedItems = [];
    const uncachedItems = [];

    for (const item of items) {
        if (cache.has(item.hash)) {
            cachedItems.push({ ...item, cachedVectors: cache.get(item.hash) });
        } else {
            uncachedItems.push(item);
        }
    }

    // Insert cached items directly via vectra
    if (cachedItems.length > 0) {
        const indexPath = path.join(vectorsDir, source, sanitize(chat.file), model);
        const store = new vectra.LocalIndex(indexPath);
        if (!await store.isIndexCreated()) {
            await store.createIndex();
        }

        await store.beginUpdate();
        for (const item of cachedItems) {
            for (const cv of item.cachedVectors) {
                await store.upsertItem({
                    vector: cv.vector,
                    metadata: { hash: item.hash, text: cv.text, index: item.index },
                });
            }
        }
        await store.endUpdate();
    }

    // Call embedding API for uncached items
    let apiRequests = 0;
    if (uncachedItems.length > 0) {
        const batchSize = 10;
        const headers = {
            'Content-Type': 'application/json',
            'Cookie': req.headers.cookie || '',
            'X-CSRF-Token': req.headers['x-csrf-token'] || '',
        };

        for (let i = 0; i < uncachedItems.length; i += batchSize) {
            if (isAborted()) break;
            const batch = uncachedItems.slice(i, i + batchSize);
            apiRequests++;

            const resp = await fetch(`http://127.0.0.1:${port}/api/vector/insert`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    collectionId: chat.file,
                    source: rawSource,
                    model: rawModel,
                    items: batch,
                }),
            });

            if (!resp.ok) {
                throw new Error(`Vector insert API returned ${resp.status}`);
            }

            // Add newly embedded vectors to cache
            try {
                const indexPath = path.join(vectorsDir, source, sanitize(chat.file), model, 'index.json');
                if (fs.existsSync(indexPath)) {
                    const data = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
                    for (const vecItem of (data.items || [])) {
                        const h = Number(vecItem.metadata?.hash);
                        if (!h || !vecItem.vector) continue;
                        if (!cache.has(h)) cache.set(h, []);
                        const arr = cache.get(h);
                        if (!arr.some(e => e.text === vecItem.metadata.text)) {
                            arr.push({ vector: vecItem.vector, text: vecItem.metadata.text });
                        }
                    }
                }
            } catch { /* ignore cache update errors */ }
        }
    }

    return {
        totalChunks: items.length,
        cached: cachedItems.length,
        uncached: uncachedItems.length,
        apiRequests,
    };
}

// ==================== Vector Cache ====================

function buildVectorCache(vectorsDir, source, model, collectionIds) {
    const cache = new Map();
    const sourcePath = path.join(vectorsDir, source);

    if (!fs.existsSync(sourcePath)) return cache;

    let collections;
    if (Array.isArray(collectionIds) && collectionIds.length > 0) {
        collections = collectionIds.map(id => sanitize(id));
    } else {
        collections = safeReaddirSync(sourcePath).filter(f => {
            try { return fs.statSync(path.join(sourcePath, f)).isDirectory(); }
            catch { return false; }
        });
    }

    for (const col of collections) {
        const indexFile = path.join(sourcePath, col, model, 'index.json');
        if (!fs.existsSync(indexFile)) continue;

        try {
            const data = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
            if (!data.items) continue;

            for (const item of data.items) {
                const hash = Number(item.metadata?.hash);
                if (!hash || !item.vector) continue;

                if (!cache.has(hash)) cache.set(hash, []);
                const existing = cache.get(hash);
                if (!existing.some(e => e.text === item.metadata.text)) {
                    existing.push({ vector: item.vector, text: item.metadata.text });
                }
            }
        } catch { /* skip corrupted */ }
    }

    return cache;
}

// ==================== Utilities ====================

function getStringHash(str, seed = 0) {
    if (typeof str !== 'string') return 0;
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0, ch; i < str.length; i++) {
        ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

function splitRecursive(input, length, delimiters = ['\n\n', '\n', ' ', '']) {
    if (length <= 0) return [input];
    const delim = delimiters[0] ?? '';
    const parts = input.split(delim);
    const flatParts = parts.flatMap(p => {
        if (p.length < length) return p;
        return splitRecursive(p, length, delimiters.slice(1));
    });
    const result = [];
    let currentChunk = '';
    for (let i = 0; i < flatParts.length;) {
        currentChunk = flatParts[i];
        let j = i + 1;
        while (j < flatParts.length) {
            const nextChunk = flatParts[j];
            if (currentChunk.length + nextChunk.length + delim.length <= length) {
                currentChunk += delim + nextChunk;
            } else break;
            j++;
        }
        i = j;
        result.push(currentChunk);
    }
    return result;
}

function getCharDirs(chatsDir, scope, characterName) {
    if (scope === 'current_character') {
        if (!characterName) return [];
        return [characterName];
    }
    return safeReaddirSync(chatsDir).filter(f => {
        try { return fs.statSync(path.join(chatsDir, f)).isDirectory(); }
        catch { return false; }
    });
}

function readChat(filePath) {
    let content;
    try { content = fs.readFileSync(filePath, 'utf-8'); }
    catch { return { meta: null, messages: [] }; }

    const lines = content.split('\n').filter(Boolean);
    if (lines.length < 2) return { meta: null, messages: [] };

    let meta;
    try { meta = JSON.parse(lines[0]); } catch { return { meta: null, messages: [] }; }

    const messages = [];
    for (let i = 1; i < lines.length; i++) {
        try {
            const msg = JSON.parse(lines[i]);
            msg._lineIndex = i;
            messages.push(msg);
        } catch { /* skip */ }
    }

    return { meta, messages };
}

function safeReaddirSync(dirPath) {
    try { return fs.readdirSync(dirPath); }
    catch { return []; }
}
