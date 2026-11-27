// 本地存储的工具层：草稿 / 缓存这类「往浏览器里存东西」的功能都从这里走。
//
// 为什么需要它：localStorage 只有几 MB，写满时 setItem 会抛 QuotaExceededError，
// 如果调用方没捕获，用户看到的现象就是「点了保存没反应」，排查起来非常费劲。
// 这里把「先估算、再写、失败给出可读原因」做成统一入口，并用 IndexedDB 兜住大内容。
//
// 注意：当前编辑器本身**不往浏览器存任何东西**（内容只存在内存里），
// 这套工具是给后续「自动草稿 / 最近工程」这类功能预留的，先把它和单测放好。

/** localStorage 的典型容量上限（不同浏览器 5MB ~ 10MB，取保守值做预警） */
export const LOCAL_STORAGE_LIMIT = 5 * 1024 * 1024

/**
 * 计算字符串按 UTF-8 编码后的字节数（localStorage 按 UTF-16 存，但按 GBK/UTF-8 估算更保守）。
 *
 * @param {string} text 文本
 * @returns {number} 字节数
 */
export function utf8ByteLength(text) {
    const str = typeof text === 'string' ? text : String(text == null ? '' : text)
    let bytes = 0
    for (let i = 0; i < str.length; i += 1) {
        const code = str.charCodeAt(i)
        if (code < 0x80) bytes += 1
        else if (code < 0x800) bytes += 2
        else if (code >= 0xd800 && code <= 0xdbff) {
            // 代理对算 4 字节，并跳过下一个码元
            bytes += 4
            i += 1
        } else bytes += 3
    }
    return bytes
}

/**
 * 判断 localStorage 是否还有空间放下这段内容。
 *
 * @param {string} key 键名
 * @param {string} text 待写入的文本
 * @param {number} [limit] 容量上限（默认 LOCAL_STORAGE_LIMIT）
 * @returns {{ok: boolean, used: number, need: number, limit: number, reason: string}}
 */
export function canStoreInLocalStorage(key, text, limit = LOCAL_STORAGE_LIMIT) {
    const need = utf8ByteLength(text)
    let used = 0
    try {
        for (let i = 0; i < window.localStorage.length; i += 1) {
            const k = window.localStorage.key(i)
            if (k === key) continue
            used += utf8ByteLength(window.localStorage.getItem(k) || '')
        }
    } catch (_) {
        return { ok: false, used: 0, need, limit, reason: '无法读取本地存储状态' }
    }
    const room = Math.max(0, limit - used)
    if (need > room) {
        return {
            ok: false,
            used,
            need,
            limit,
            reason: `本地存储不足（需要 ${Math.ceil(need / 1024)}KB，剩余约 ${Math.floor(room / 1024)}KB）`,
        }
    }
    return { ok: true, used, need, limit, reason: '' }
}

/**
 * 安全写入 localStorage：先估算容量，不够就抛出带可读 message 的错误，
 * 不把底层的 QuotaExceededError 直接甩给调用方。
 *
 * @param {string} key 键名
 * @param {string} text 文本内容
 * @returns {{ok: boolean, reason: string}}
 */
export function safeSetLocalStorage(key, text) {
    if (typeof window === 'undefined' || !window.localStorage) {
        return { ok: false, reason: '当前环境没有本地存储' }
    }
    const check = canStoreInLocalStorage(key, text)
    if (!check.ok) return { ok: false, reason: check.reason }
    try {
        window.localStorage.setItem(key, text)
        return { ok: true, reason: '' }
    } catch (e) {
        return { ok: false, reason: '写入本地存储失败：' + (e && e.message ? e.message : e) }
    }
}

/**
 * 读取 localStorage，读不到时返回 defaultValue 而不是抛错。
 *
 * @param {string} key 键名
 * @param {*} [defaultValue=null] 兜底值
 * @returns {string|null}
 */
export function safeGetLocalStorage(key, defaultValue = null) {
    try {
        const value = window.localStorage.getItem(key)
        return value === null ? defaultValue : value
    } catch (_) {
        return defaultValue
    }
}

// ---------------------------------------------------------------------------
// IndexedDB：草稿这类内容可能带 base64 图片，几十 MB 很正常，必须落在这里
// ---------------------------------------------------------------------------

export const DRAFT_DB_NAME = 'dicksonDrafts'
export const DRAFT_DB_VERSION = 1
export const DRAFT_STORE = 'drafts'

/**
 * 打开（必要时创建）草稿库，没有 IndexedDB 时返回 null。
 *
 * @returns {Promise<IDBDatabase|null>}
 */
export function openDraftDB() {
    if (typeof window === 'undefined' || !window.indexedDB) return Promise.resolve(null)
    return new Promise((resolve) => {
        let request
        try {
            request = window.indexedDB.open(DRAFT_DB_NAME, DRAFT_DB_VERSION)
        } catch (_) {
            resolve(null)
            return
        }
        request.onupgradeneeded = () => {
            const db = request.result
            if (!db.objectStoreNames.contains(DRAFT_STORE)) {
                db.createObjectStore(DRAFT_STORE, { keyPath: 'id' })
            }
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => resolve(null)
    })
}

/**
 * 写一份草稿。
 *
 * @param {{id: string, [key: string]: *}} draft 草稿对象，必须有 id
 * @returns {Promise<{ok: boolean, reason: string}>}
 */
export async function saveDraft(draft) {
    if (!draft || !draft.id) return { ok: false, reason: '草稿缺少 id' }
    const db = await openDraftDB()
    if (!db) return { ok: false, reason: '当前环境不支持 IndexedDB' }
    return new Promise((resolve) => {
        try {
            const tx = db.transaction(DRAFT_STORE, 'readwrite')
            tx.objectStore(DRAFT_STORE).put(draft)
            tx.oncomplete = () => resolve({ ok: true, reason: '' })
            tx.onerror = () =>
                resolve({ ok: false, reason: '写入草稿失败：' + (tx.error && tx.error.message) })
            tx.onabort = () => resolve({ ok: false, reason: '写入草稿被中止（可能空间不足）' })
        } catch (e) {
            resolve({ ok: false, reason: '写入草稿失败：' + (e && e.message ? e.message : e) })
        }
    })
}

/**
 * 读一份草稿。
 *
 * @param {string} id 草稿 id
 * @returns {Promise<Object|null>}
 */
export async function loadDraft(id) {
    const db = await openDraftDB()
    if (!db || !id) return null
    return new Promise((resolve) => {
        try {
            const tx = db.transaction(DRAFT_STORE, 'readonly')
            const req = tx.objectStore(DRAFT_STORE).get(id)
            req.onsuccess = () => resolve(req.result || null)
            req.onerror = () => resolve(null)
        } catch (_) {
            resolve(null)
        }
    })
}

/**
 * 查询浏览器给本页分配的存储额度（不支持时返回 null）。
 *
 * @returns {Promise<{usage: number, quota: number}|null>}
 */
export async function getStorageQuotaInfo() {
    if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.estimate) {
        return null
    }
    try {
        const info = await navigator.storage.estimate()
        return { usage: Number(info.usage) || 0, quota: Number(info.quota) || 0 }
    } catch (_) {
        return null
    }
}

export default {
    LOCAL_STORAGE_LIMIT,
    utf8ByteLength,
    canStoreInLocalStorage,
    safeSetLocalStorage,
    safeGetLocalStorage,
    openDraftDB,
    saveDraft,
    loadDraft,
    getStorageQuotaInfo,
}
