import fs from 'node:fs';
import path from 'node:path';

export const info = {
    id: 'chat-search',
    name: 'Chat Search',
    description: 'Global full-text search across all chats',
};

export async function init(router) {
    router.post('/search', async (req, res) => {
        try {
            const {
                query,
                scope = 'all',           // 'current_chat' | 'current_character' | 'all'
                characterName,            // required for current_chat / current_character
                chatFile,                 // required for current_chat
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

            // Determine which character directories to scan
            let charDirs;
            if (scope === 'current_chat' || scope === 'current_character') {
                if (!characterName) {
                    return res.status(400).json({ error: 'characterName required for this scope' });
                }
                charDirs = [characterName];
            } else {
                charDirs = safeReaddirSync(chatsDir).filter(f => {
                    try { return fs.statSync(path.join(chatsDir, f)).isDirectory(); }
                    catch { return false; }
                });
            }

            for (const charName of charDirs) {
                const charPath = path.join(chatsDir, charName);
                if (!fs.existsSync(charPath)) continue;

                let files = safeReaddirSync(charPath).filter(f => f.endsWith('.jsonl'));

                // For current_chat scope, only scan the specific file
                if (scope === 'current_chat' && chatFile) {
                    const target = chatFile.endsWith('.jsonl') ? chatFile : chatFile + '.jsonl';
                    files = files.filter(f => f === target);
                }

                for (const file of files) {
                    const filePath = path.join(charPath, file);
                    let content;
                    try {
                        content = fs.readFileSync(filePath, 'utf-8');
                    } catch {
                        continue;
                    }

                    const lines = content.split('\n').filter(Boolean);
                    if (lines.length < 2) continue;

                    // First line is metadata
                    let chatMeta;
                    try {
                        chatMeta = JSON.parse(lines[0]);
                    } catch {
                        continue;
                    }

                    const chatCreateDate = chatMeta.create_date || file.replace('.jsonl', '');

                    // Find the first matching message in this chat
                    for (let i = 1; i < lines.length; i++) {
                        let msg;
                        try {
                            msg = JSON.parse(lines[i]);
                        } catch {
                            continue;
                        }
                        if (!msg.mes) continue;

                        const lower = msg.mes.toLowerCase();
                        if (keywords.every(kw => lower.includes(kw))) {
                            results.push({
                                character: charName,
                                file: file.replace('.jsonl', ''),
                                chatCreateDate,
                                messageIndex: i,
                                name: msg.name,
                                is_user: !!msg.is_user,
                                mes: msg.mes,
                                send_date: msg.send_date,
                            });
                            break; // Only first match per chat
                        }
                    }
                }
            }

            // Sort by chat create date descending (newest first)
            results.sort((a, b) => {
                return b.chatCreateDate.localeCompare(a.chatCreateDate);
            });

            res.json({ results, count: results.length });
        } catch (error) {
            console.error('Chat search error:', error);
            res.status(500).json({ error: error.message });
        }
    });
}

function safeReaddirSync(dirPath) {
    try {
        return fs.readdirSync(dirPath);
    } catch {
        return [];
    }
}
