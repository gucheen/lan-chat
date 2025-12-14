// server.js (优化版)
import { file } from "bun";

// --- 后端核心状态管理 ---
// 存储管理员的长期公钥 (JWK 格式)
let adminLongTermPublicKey = null;
// 存储管理员的 WebSocket 连接
let adminWs = null;

/**
 * 存储所有活跃用户会话及其与管理员的配对信息。
 * Map<UserWsId, { ws: WebSocket, peerId: AdminWsId, publicKey: JWK }>
 */
const userConnections = new Map();

/**
 * 存储管理员管理的独立会话。
 * Map<AdminWsId, { ws: WebSocket, currentUserId: UserWsId | null }>
 */
const adminConnections = new Map();

let nextWsId = 1;

/**
 * 查找消息的接收方。
 * @param {number} senderId 发送者的 ID
 * @param {string} senderRole 发送者的角色 ('admin' 或 'user')
 * @param {number} targetId 目标用户的 ID (仅管理员发送消息时需要)
 * @returns {WebSocket | null} 接收方的 WebSocket 实例
 */
function findPeer(senderId, senderRole, targetId = null) {
    if (senderRole === 'admin' && targetId) {
        // 管理员发送给指定用户
        const user = userConnections.get(targetId);
        return user ? user.ws : null;
    } else if (senderRole === 'user') {
        // 用户发送给管理员
        return adminWs;
    }
    return null;
}

const server = Bun.serve({
    port: 3000,
    async fetch(req, server) {
        const url = new URL(req.url);

        // 1. WebSocket 升级请求
        if (url.pathname === "/ws") {
            const id = nextWsId++;
            const success = server.upgrade(req, {
                data: { wsId: id }
            });
            if (success) return;
            return new Response("WebSocket Upgrade Error", { status: 400 });
        }

        // 2. 静态文件请求 (返回 chat.html 页面)
        if (url.pathname === "/") {
            const htmlFile = file("chat.html");
            return new Response(htmlFile, {
                headers: { "Content-Type": "text/html" },
            });
        }

        return new Response("Not Found", { status: 404 });
    },

    websocket: {
        message(ws, message) {
            let parsed;
            try {
                parsed = JSON.parse(message);
            } catch (e) {
                console.error("Received invalid JSON:", message);
                return;
            }

            const senderId = ws.data.wsId;
            const senderRole = ws.data.role;

            if (parsed.type === 'SET_ADMIN_KEY') {
                // 仅限第一个连接的管理员设置长期公钥
                if (senderRole === 'admin' && !adminLongTermPublicKey) {
                    adminLongTermPublicKey = parsed.key;
                    console.log(`[Admin] 长期公钥已设置.`);
                    adminWs.send(JSON.stringify({ type: 'STATUS', message: '长期公钥已存储，可用于身份验证。' }));
                    // 广播给所有用户（可选：如果有公钥验证需求）
                }
                return;
            }
            
            if (parsed.type === 'REQUEST_ADMIN_KEY' && adminLongTermPublicKey) {
                 // 用户请求管理员公钥
                ws.send(JSON.stringify({ 
                    type: 'ADMIN_KEY_RESPONSE', 
                    key: adminLongTermPublicKey 
                }));
                console.log(`[转发] ID ${senderId} 收到管理员长期公钥.`);
                return;
            }
            
            // 核心消息转发逻辑
            if (parsed.type === 'PUBLIC_KEY' || parsed.type === 'MESSAGE') {
                const targetId = parsed.targetId; // 管理员发送消息时需要指定用户ID

                const peerWs = findPeer(senderId, senderRole, targetId);

                if (peerWs) {
                    // 在转发消息中加入发送者ID，以便接收方知道是谁发送的
                    parsed.senderId = senderId;
                    peerWs.send(JSON.stringify(parsed));
                    console.log(`[转发] ID ${senderId} -> ID ${peerWs.data.wsId}, Type: ${parsed.type}`);
                } else {
                    ws.send(JSON.stringify({ type: 'ERROR', message: `未找到目标会话 ID: ${targetId || '管理员'}` }));
                }
            }
        },
        
        open(ws) {
            ws.data.role = adminWs ? 'user' : 'admin';
            console.log(`[连接] 新连接 ID: ${ws.data.wsId}, Role: ${ws.data.role}`);

            if (ws.data.role === 'admin') {
                // 仅允许一个管理员连接
                if (adminWs) { ws.close(1000, "Admin already connected"); return; } 
                adminWs = ws;
                ws.send(JSON.stringify({ type: 'STATUS', role: 'admin' }));
                adminConnections.set(ws.data.wsId, { ws: ws, currentUserId: null });
            } else {
                userConnections.set(ws.data.wsId, { ws: ws });
                ws.send(JSON.stringify({ type: 'STATUS', role: 'user' }));

                // 通知管理员有新用户连接
                if (adminWs) {
                    adminWs.send(JSON.stringify({ 
                        type: 'NEW_USER', 
                        userId: ws.data.wsId, 
                        message: `新用户 (ID: ${ws.data.wsId}) 已连接。` 
                    }));
                }
            }
        },

        close(ws, code, reason) {
            console.log(`[断开] ID ${ws.data.wsId} 断开。代码: ${code}`);

            if (ws === adminWs) {
                console.log("[会话] 管理员断开，清空所有连接。");
                userConnections.forEach(user => {
                    user.ws.send(JSON.stringify({ type: 'STATUS', message: "管理员已离线，会话结束。" }));
                    user.ws.close();
                });
                adminWs = null;
                adminConnections.delete(ws.data.wsId);
                userConnections.clear();
            } else {
                userConnections.delete(ws.data.wsId);
                if (adminWs) {
                    adminWs.send(JSON.stringify({ 
                        type: 'USER_LEFT', 
                        userId: ws.data.wsId, 
                        message: `用户 (ID: ${ws.data.wsId}) 已断开。` 
                    }));
                }
            }
        },
        
        drain() {},
    },
});

console.log(`Bun E2EE Chat 服务运行在 http://localhost:${server.port}`);
console.log("------------------------------------------");
