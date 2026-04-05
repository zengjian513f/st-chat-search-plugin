import fs from 'node:fs';
import path from 'node:path';

export const info = {
    id: 'chat-search',
    name: 'Chat Search',
    description: 'Global full-text search across all chats',
};

export async function init(router) {
    // Keyword search
    router.post('/search', async (req, res) => {
        try {
            const {
                query,
                scope = 'all',
                characterName,
            } = req.body;

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
