import { fetchSyncPost } from "siyuan";

// ============================================================
// 功能：非当天日记自动锁定 + 父级空白文档自动锁定
// 触发时机：打开文档时（在「列出子文档」之后执行）；设置面板「全库扫描」时执行
// 只针对当前打开的文档，不处理父文档
//
// 判定规则：
//   - 日记文档：标题形如 YYYY-MM-DD（如 2026-08-10）→ 非当天则锁定
//   - 父级空白文档：有子文档、且无正文内容（挂件块不算正文）→ 锁定
//     （此规则天然覆盖「年、月文档」——年/月文档就是有子文档且无正文的空白父文档）
// 单篇文档锁定 = 文档块属性 custom-sy-readonly: "true"
//
// 注意：内核 /api/query/sql 对无 LIMIT 的 SELECT 自动加 LIMIT 64（Conf.Search.Limit），
//       全表查询必须显式加 LIMIT 100000，否则结果被截断。
// ============================================================

let settings: any = null

export function setupDocLock(p: any) {
    settings = p?.settings ?? null
}

export function destroyDocLock() {
    settings = null
}

/** 获取文档标题（content 字段） */
async function getDocTitle(docID: string): Promise<string | null> {
    try {
        const resp: any = await fetchSyncPost('/api/query/sql', {
            stmt: `SELECT content FROM blocks WHERE id = '${docID}' AND type = 'd'`,
        })
        return resp?.code === 0 && resp.data && resp.data.length > 0 ? resp.data[0].content : null
    } catch (e) {
        return null
    }
}

/** 获取文档块的 path（如 /xxx/yyy.sy） */
async function getDocPath(docID: string): Promise<string | null> {
    try {
        const resp: any = await fetchSyncPost('/api/query/sql', {
            stmt: `SELECT path FROM blocks WHERE id = '${docID}' AND type = 'd'`,
        })
        return resp?.code === 0 && resp.data && resp.data.length > 0 ? resp.data[0].path : null
    } catch (e) {
        return null
    }
}

/**
 * 判断文档是否为「父级空白文档」：有子文档（path 前缀）+ 无正文内容（排除挂件块）
 * @param docID 文档 ID
 * @param docPath 文档 path（如 /xxx/yyy.sy）
 */
async function isEmptyParent(docID: string, docPath: string): Promise<boolean> {
    try {
        if (!docID || !docPath || !docPath.endsWith('.sy')) return false
        const dirPrefix = docPath.slice(0, -3)

        const resp: any = await fetchSyncPost('/api/query/sql', {
            stmt: `SELECT
                (SELECT COUNT(1) FROM blocks WHERE type = 'd' AND path LIKE '${dirPrefix}/%') AS child_docs,
                (SELECT COUNT(1) FROM blocks WHERE parent_id = '${docID}' AND type != 'd' AND type != 'widget' AND TRIM(REPLACE(COALESCE(content, ''), char(8203), '')) != '') AS content_blocks`,
        })
        if (resp?.code !== 0 || !resp.data || resp.data.length === 0) return false
        const row = resp.data[0]
        const childDocs = parseInt(row.child_docs, 10) || 0
        const contentBlocks = parseInt(row.content_blocks, 10) || 0
        return childDocs > 0 && contentBlocks === 0
    } catch (e) {
        return false
    }
}

/** 判断当前文档是否为「父级空白文档」（ID 版，兼容） */
async function isEmptyParentDoc(docID: string): Promise<boolean> {
    const docPath = await getDocPath(docID)
    if (!docPath) return false
    return isEmptyParent(docID, docPath)
}

/** 文档是否已锁定 */
async function isLocked(docID: string): Promise<boolean> {
    try {
        const resp: any = await fetchSyncPost('/api/attr/getBlockAttrs', { id: docID })
        return resp?.code === 0 && resp.data?.['custom-sy-readonly'] === 'true'
    } catch (e) {
        return false
    }
}

/** 锁定单个文档 */
async function lockDoc(docID: string, reason: string) {
    try {
        await fetchSyncPost('/api/attr/setBlockAttrs', {
            id: docID,
            attrs: { 'custom-sy-readonly': 'true' },
        })
    } catch (e) {
        console.warn('⚠️ 锁定失败:', docID, e)
    }
}

/** 今日日期 yyyy-mm-dd（思源日记标题格式） */
function todayStr(): string {
    const t = new Date()
    const y = String(t.getFullYear())
    const m = String(t.getMonth() + 1).padStart(2, '0')
    const d = String(t.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
}

/**
 * 打开文档后执行锁定逻辑（只针对当前文档；必须在「列出子文档」之后调用）。
 * @param docID 当前打开的文档 ID
 */
export async function applyDocLock(docID: string) {
    if (!settings || !docID) return

    // ① 非当天日记自动锁定：标题是 YYYY-MM-DD 格式，且不等于今天
    if (settings.lockNonTodayDaily) {
        const title = await getDocTitle(docID)
        if (title && /^\d{4}-\d{2}-\d{2}$/.test(title) && title !== todayStr()) {
            if (!(await isLocked(docID))) {
                await lockDoc(docID, `非当天日记（${title}）`)
            }
        }
    }

    // ② 父级空白文档自动锁定：独立功能（不依赖「列出子文档」开关）
    //    年、月文档天然满足此条件，无需单独的「年、月文档」开关
    if (settings.lockEmptyParentDoc) {
        if (await isEmptyParentDoc(docID)) {
            if (!(await isLocked(docID))) {
                const title = await getDocTitle(docID)
                await lockDoc(docID, `父级空白文档（${title || docID}）`)
            }
        }
    }
}

/**
 * 全库扫描：对所有已开启的锁定功能执行全库锁定。
 * 由设置面板「全库扫描」按钮触发。
 * @param s 当前设置（传入插件实例的 this.settings，不依赖模块内部 settings）
 * @returns 锁定的文档数量
 */
export async function scanAllLocks(s: any): Promise<number> {
    if (!s) return 0
    let lockedCount = 0

    // 一次查询所有文档：id, content(标题), path（必须显式 LIMIT，否则内核默认截断 64 条）
    const resp: any = await fetchSyncPost('/api/query/sql', {
        stmt: `SELECT id, content, path FROM blocks WHERE type = 'd' LIMIT 100000`,
    })
    if (resp?.code !== 0 || !resp.data) return 0
    const docs = resp.data

    for (const doc of docs) {
        const docID = doc.id
        if (!docID) continue
        const title: string = doc.content || ''
        const docPath: string = doc.path || ''

        try {
            // ① 非当天日记
            if (s.lockNonTodayDaily
                && /^\d{4}-\d{2}-\d{2}$/.test(title) && title !== todayStr()) {
                if (!(await isLocked(docID))) {
                    await lockDoc(docID, `非当天日记（${title}）`)
                    lockedCount++
                }
            }

            // ② 父级空白文档（独立功能，天然覆盖年、月文档）
            if (s.lockEmptyParentDoc
                && await isEmptyParent(docID, docPath)) {
                if (!(await isLocked(docID))) {
                    await lockDoc(docID, `父级空白文档（${title || docID}）`)
                    lockedCount++
                }
            }
        } catch (e) {
            // 单个文档失败不中断
            console.warn('⚠️ 全库扫描锁定失败:', docID, e)
        }
    }
    return lockedCount
}
