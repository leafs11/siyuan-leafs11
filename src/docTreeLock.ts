import { fetchSyncPost } from "siyuan";

// ============================================================
// 功能：文档树显示已锁定文档
// 开启后，文档树中已锁定（custom-sy-readonly: true）的文档
// 在行的最右侧显示一个锁标记（#iconLock）
//
// 机制（监听锁定动作，零轮询、零全扫）：
//   - 锁定状态存于文档块属性 custom-sy-readonly
//   - 监听 ws-main 的 transactions / updateAttrs 操作：
//     锁定/解锁文档时（手动或自动），operation.id 即文档 ID → 刷新该文档锁标记
//   - 文档树渲染/展开时（MutationObserver）补扫：只查缓存未命中的项
//   - 缓存永久有效（仅锁定/解锁时刷新）
//   - 锁标记插到行末尾（最右侧）
// ============================================================

let enabled: boolean = false
let observer: MutationObserver | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let wsHandler: ((e: any) => void) | null = null
let plugin: any = null
// 文档ID -> 锁定状态（永久缓存，锁定动作时主动刷新）
const lockCache = new Map<string, boolean>()

/** 查询文档是否锁定（缓存命中直接返回，不重复查询） */
async function isDocLocked(docID: string): Promise<boolean> {
    if (lockCache.has(docID)) {
        return lockCache.get(docID)!
    }
    try {
        const resp: any = await fetchSyncPost('/api/attr/getBlockAttrs', { id: docID })
        const locked = resp?.code === 0 && resp.data?.['custom-sy-readonly'] === 'true'
        lockCache.set(docID, locked)
        return locked
    } catch (e) {
        return false
    }
}

/** 为单个文档树项添加/移除锁标记（插到行最右侧） */
async function applyLockMark(li: HTMLElement) {
    const docID = li.getAttribute('data-node-id')
    if (!docID) return
    const locked = await isDocLocked(docID)
    const existing = li.querySelector('.plugin-doc-lock')
    if (locked) {
        if (!existing) {
            const lock = document.createElement('span')
            lock.className = 'plugin-doc-lock'
            lock.style.cssText = `
                display: inline-flex;
                align-items: center;
                justify-content: center;
                margin-left: 4px;
                margin-right: 4px;
                flex-shrink: 0;
                color: var(--b3-theme-on-surface);
                opacity: 0.6;
            `
            lock.title = '已锁定'
            lock.innerHTML = `<svg style="width:12px;height:12px;"><use href="#iconLock"></use></svg>`
            // 插到 li 末尾（最右侧，在操作按钮之后）
            li.appendChild(lock)
        }
    } else {
        if (existing) {
            existing.remove()
        }
    }
}

/** 刷新某个文档的锁标记。清除缓存重新查询，更新文档树对应项。 */
async function refreshDocLock(docID: string) {
    if (!enabled || !docID) return
    lockCache.delete(docID)
    const li = document.querySelector(`.b3-list-item[data-node-id="${docID}"][data-type="navigation-file"]`) as HTMLElement | null
    if (li) {
        await applyLockMark(li)
    }
}

/** 补扫：文档树渲染/展开时，处理缓存未命中的项 */
async function scanUncached() {
    if (!enabled) return
    const items = document.querySelectorAll('.b3-list-item[data-type="navigation-file"]')
    for (const item of items) {
        const li = item as HTMLElement
        const docID = li.getAttribute('data-node-id')
        if (!docID) continue
        // 缓存已命中且标记状态一致 → 跳过
        if (lockCache.has(docID)) {
            const hasMark = !!li.querySelector('.plugin-doc-lock')
            const cached = lockCache.get(docID)
            if ((cached ? hasMark : !hasMark)) {
                continue
            }
        }
        await applyLockMark(li)
    }
}

/** 初始化功能 */
export function setupDocTreeLock(p: any) {
    plugin = p
    enabled = !!(p?.settings?.showLockedDocs)
    lockCache.clear()

    if (!enabled) {
        // 关闭时移除所有锁标记，并解绑事件
        document.querySelectorAll('.plugin-doc-lock').forEach(el => el.remove())
        if (wsHandler && plugin) {
            plugin.eventBus?.off('ws-main', wsHandler)
        }
        wsHandler = null
        return
    }

    // 监听锁定/解锁动作：ws-main 的 transactions / updateAttrs 操作
    // 锁定/解锁文档时（手动或自动锁定），operation.id 即被改属性的文档 ID
    if (!wsHandler) {
        wsHandler = (event: any) => {
            if (!enabled) return
            const data = event?.detail
            if (!data || data.cmd !== 'transactions' || !data.data) return
            try {
                const ops = data.data[0]?.doOperations || []
                for (const op of ops) {
                    if (op.action === 'updateAttrs' && op.id) {
                        // 延迟刷新，等待事务落地
                        setTimeout(() => {
                            refreshDocLock(op.id)
                        }, 300)
                    }
                }
            } catch (e) {
                // ignore
            }
        }
        plugin?.eventBus?.on('ws-main', wsHandler)
    }

    // 监听 body 变化（文档树展开/新建），补扫缓存未命中的项（防抖 200ms）
    if (observer) {
        observer.disconnect()
    }
    observer = new MutationObserver(() => {
        if (timer) {
            clearTimeout(timer)
        }
        timer = setTimeout(() => {
            timer = null
            scanUncached()
        }, 200)
    })
    observer.observe(document.body, { childList: true, subtree: true })

    // 初始补扫
    scanUncached()
}

/** 清理功能 */
export function destroyDocTreeLock() {
    enabled = false
    if (observer) {
        observer.disconnect()
        observer = null
    }
    if (timer) {
        clearTimeout(timer)
        timer = null
    }
    if (wsHandler && plugin) {
        plugin.eventBus?.off('ws-main', wsHandler)
    }
    wsHandler = null
    document.querySelectorAll('.plugin-doc-lock').forEach(el => el.remove())
    lockCache.clear()
}

