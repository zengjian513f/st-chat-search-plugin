import fs from 'node:fs';
import path from 'node:path';
import vectra from 'vectra';
import sanitize from 'sanitize-filename';

export const info = {
    id: 'chat-search',
    name: 'Chat Search',
    description: 'Global full-text search across all chats',
};

// Per-user vector cache, built once per search session
// key: userHandle, value: { source, model, cache: Map<hash, [{vector, text}]>, ts }
const userCaches = new Map();
const CACHE_TTL = 60_000; // 1 minute

export async function init(router) {
    // Keyword search
    router.post('/search', async (req, res) => {
        try {
            const { query, scope = 'all', characterName } = req.body;

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
                            break;
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

    // List all chat collection IDs in scope (for vector search)
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
                    const collectionId = file.replace('.jsonl', '');
                    const { messages } = readChat(path.join(charPath, file));
                    const messageCount = messages.filter(m => m.mes && !m.is_system).length;
                    chats.push({ character: charName, file: collectionId, messageCount });
                }
            }

            res.json(chats);
        } catch (error) {
            console.error('List chats error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // Extract messages from a chat for vectorization
    router.post('/chat-messages', async (req, res) => {
        try {
            const { character, file } = req.body;
            if (!character || !file) {
                return res.status(400).json({ error: 'character and file required' });
            }

            const chatsDir = req.user.directories.chats;
            const filePath = path.join(chatsDir, character, file + '.jsonl');
            const { messages } = readChat(filePath);

            const items = messages
                .filter(m => m.mes && !m.is_system)
                .map(m => ({
                    text: m.mes,
                    index: m._lineIndex,
                    name: m.name,
                    is_user: !!m.is_user,
                    send_date: m.send_date,
                }));

            res.json(items);
        } catch (error) {
            console.error('Chat messages error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // Build vector cache once per search session (called before vectorizing multiple chats)
    router.post('/build-vector-cache', async (req, res) => {
        try {
            const { source, model } = req.body;
            if (!source) {
                return res.status(400).json({ error: 'source required' });
            }

            const vectorsDir = req.user.directories.vectors;
            const sourceStr = sanitize(source);
            const modelStr = sanitize(model || '');
            const userHandle = req.user.profile.handle;

            const cache = buildVectorCache(vectorsDir, sourceStr, modelStr);
            userCaches.set(userHandle, { source: sourceStr, model: modelStr, cache, ts: Date.now() });

            res.json({ cacheSize: cache.size });
        } catch (error) {
            console.error('Build vector cache error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // Insert items using cached vectors where possible
    router.post('/vector-insert-cached', async (req, res) => {
        try {
            const { collectionId, source, model, items } = req.body;
            if (!collectionId || !source || !Array.isArray(items)) {
                return res.status(400).json({ error: 'collectionId, source, and items required' });
            }

            const vectorsDir = req.user.directories.vectors;
            const modelStr = sanitize(model || '');
            const sourceStr = sanitize(source);
            const userHandle = req.user.profile.handle;

            // Use pre-built cache if available and fresh, otherwise build on-the-fly
            let cache;
            const cached = userCaches.get(userHandle);
            if (cached && cached.source === sourceStr && cached.model === modelStr && (Date.now() - cached.ts) < CACHE_TTL) {
                cache = cached.cache;
            } else {
                cache = buildVectorCache(vectorsDir, sourceStr, modelStr);
                userCaches.set(userHandle, { source: sourceStr, model: modelStr, cache, ts: Date.now() });
            }

            // Split items into cached (have vectors) and uncached (need API call)
            const cachedItems = [];
            const uncachedItems = [];

            for (const item of items) {
                const key = Number(item.hash);
                if (cache.has(key)) {
                    cachedItems.push({ ...item, cachedVectors: cache.get(key) });
                } else {
                    uncachedItems.push(item);
                }
            }

            // Insert cached items directly into vectra
            if (cachedItems.length > 0) {
                const indexPath = path.join(vectorsDir, sourceStr, sanitize(collectionId), modelStr);
                const store = new vectra.LocalIndex(indexPath);
                if (!await store.isIndexCreated()) {
                    await store.createIndex();
                }

                await store.beginUpdate();
                for (const item of cachedItems) {
                    for (const cv of item.cachedVectors) {
                        await store.upsertItem({
                            vector: cv.vector,
                            metadata: {
                                hash: Number(item.hash),
                                text: cv.text,
                                index: item.index,
                            },
                        });
                    }
                }
                await store.endUpdate();

                // Add newly inserted vectors to cache so subsequent chats can reuse them
                for (const item of cachedItems) {
                    const key = Number(item.hash);
                    if (!cache.has(key)) {
                        cache.set(key, item.cachedVectors);
                    }
                }
            }

            res.json({
                cachedCount: cachedItems.length,
                uncachedItems,
            });
        } catch (error) {
            console.error('Vector insert cached error:', error);
            res.status(500).json({ error: error.message });
        }
    });
}

/**
 * Builds a hash→vector[] map from all existing vectra indexes for a given source/model.
 */
function buildVectorCache(vectorsDir, source, model) {
    const cache = new Map();
    const sourcePath = path.join(vectorsDir, source);

    if (!fs.existsSync(sourcePath)) return cache;

    const collections = safeReaddirSync(sourcePath).filter(f => {
        try { return fs.statSync(path.join(sourcePath, f)).isDirectory(); }
        catch { return false; }
    });

    for (const col of collections) {
        const indexFile = path.join(sourcePath, col, model, 'index.json');
        if (!fs.existsSync(indexFile)) continue;

        try {
            const data = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
            if (!data.items) continue;

            for (const item of data.items) {
                const hash = Number(item.metadata?.hash);
                if (!hash || !item.vector) continue;

                if (!cache.has(hash)) {
                    cache.set(hash, []);
                }
                const existing = cache.get(hash);
                if (!existing.some(e => e.text === item.metadata.text)) {
                    existing.push({ vector: item.vector, text: item.metadata.text });
                }
            }
        } catch {
            // Skip corrupted indexes
        }
    }

    return cache;
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
    try {
        content = fs.readFileSync(filePath, 'utf-8');
    } catch {
        return { meta: null, messages: [] };
    }

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
