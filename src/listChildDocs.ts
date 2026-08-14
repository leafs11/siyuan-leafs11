import { fetchSyncPost } from "siyuan";
import { applyDocLock } from "./docLock";

// ============================================================
// 功能：父级空白文档自动列出子文档 + 文档锁定（非当天日记 / 父级空白文档）
// 触发时机：打开文档时检查（loaded-protyle-static）；设置面板「全库扫描」时执行
// 执行顺序：列出子文档 → 之后再执行文档锁定（docLock.applyDocLock）
// 只针对当前打开的文档，不处理父文档
//
// 关键机制：
//   - 文档父子关系由 path 决定（文档块 parent_id 为空）；内容块归属由 parent_id 决定
//   - 挂件块 type = 'widget'（NodeWidget），DOM 直接构造完整结构（class="iframe" +
//     iframe-content + protyle-attr），与思源 /widget 命令插入的完全一致；
//     不依赖前端 protyle / 内核 API 转换（那些在无 protyle 的扫描路径下会产生空壳挂件）
//   - 挂件配置（WIDGET 模式）存于挂件块自身的 custom-* 属性，属性名见 ConfigManager.js
//     CONFIG_MANAGER_CONSTANTS：
//       custom-list-child-docs → 独立配置（含 listColumn 分列等，defaultConfig）
//       custom-lcd-cache      → 缓存 HTML
//     读不到时回退全局配置（data/storage/listChildDocs/global.json）。
//     新挂件必须【复制已有挂件的配置属性】，否则会用默认配置（不分列、按钮显示异常等）
//   - SQL 索引刷新有延迟：appendBlock 后必须【轮询确认挂件块可被 SQL 查到】再继续，
//     否则 has_widget 查不到 → 重复插入；挂件 iframe 首次加载也查不到自己 → getPathFailed
//   - 锁定文档：custom-sy-readonly=true 时 appendBlock 会被拒绝，必须先临时解锁，
//     插入完成后再恢复锁定（仅当原本就是锁定时恢复）
//   - 防重复：内存 Set（insertedDocs）+ SQL has_widget 双重保护
//   - 覆盖空行：插入挂件 → 等待索引就绪 → 循环删除空段落（前端可能自动补行，
//     需多轮清理直到干净；循环上限 3 轮）
//   - 块菜单按钮（protyle-icons）：appendBlock 经事务插入时前端不会重新生成图标区，
//     导致新挂件块没有块菜单（重开页签才正常）。插入成功后需在前端 DOM 层
//     手动补齐 data-readonly + protyle-icons（只补运行时 UI，不写入持久化数据）
//   - 优化：仅在任一相关开关开启时注册监听；并发保护防止重复插入
//   - 注意：内核 /api/query/sql 对无 LIMIT 的 SELECT 自动加 LIMIT 64，全表查询必须显式 LIMIT
// ============================================================

const WIDGET_SRC = '/widgets/listChildDocs/'

// 挂件块的配置属性名（见挂件 ConfigManager.js 的 CONFIG_MANAGER_CONSTANTS：
// ATTR_NAME_CONFIG = "custom-list-child-docs"、ATTR_NAME_CACHE = "custom-lcd-cache"）
const CONFIG_ATTRS = ['custom-list-child-docs', 'custom-lcd-cache']

let plugin: any = null
let enabled: boolean = false
let loadedHandler: ((e: any) => void) | null = null
let widgetInstalled: boolean | null = null
// 正在处理中的文档 ID（并发保护）
const processingDocs = new Set<string>()
// 已成功插入挂件的文档 ID（内存防重——SQL 索引刷新有延迟，不能只依赖 has_widget）
const insertedDocs = new Set<string>()

/** 强制 SQLite 索引落地（保证后续 SQL 能查到最新块） */
async function flushTx() {
    try {
        await fetchSyncPost('/api/sqlite/flushTransaction', {})
    } catch (e) {
        // ignore
    }
}

/** 轮询确认某个块已被 SQL 索引（最多 3 秒），返回是否就绪 */
async function waitBlockIndexed(blockID: string): Promise<boolean> {
    for (let i = 0; i < 15; i++) {
        await flushTx()
        try {
            const resp: any = await fetchSyncPost('/api/query/sql', {
                stmt: `SELECT id FROM blocks WHERE id = '${blockID}'`,
            })
            if (resp && resp.code === 0 && resp.data && resp.data.length > 0) {
                return true
            }
        } catch (e) {
            // ignore
        }
        await new Promise(r => setTimeout(r, 200))
    }
    return false
}

/** 检查挂件是否已安装（缓存结果） */
async function isWidgetInstalled(): Promise<boolean> {
    if (widgetInstalled !== null) {
        return widgetInstalled
    }
    try {
        const resp: any = await fetchSyncPost('/api/file/readDir', {
            path: '/data/widgets/listChildDocs',
        })
        widgetInstalled = !!(resp && resp.code === 0)
    } catch (e) {
        widgetInstalled = false
    }
    if (!widgetInstalled) {
        console.warn('📄 未检测到挂件「列出子文档」（data/widgets/listChildDocs），功能跳过')
    }
    return widgetInstalled
}

/**
 * 判断文档是否满足条件：有子文档（按 path 前缀）、内容为空（忽略空行）、且尚未添加该挂件
 * 注意：内存 Set 优先（索引刷新有延迟），SQL 查询作为补充。
 */
async function isEligible(docID: string): Promise<boolean> {
    // 内存防重：本次会话已插入过挂件的文档，直接跳过（不受索引延迟影响）
    if (insertedDocs.has(docID)) {
        return false
    }
    try {
        await flushTx()
        // 1. 获取文档的 path（如 /a/20260623132809-wr4ulmn.sy）
        const pathResp: any = await fetchSyncPost('/api/query/sql', {
            stmt: `SELECT path FROM blocks WHERE id = '${docID}' AND type = 'd'`,
        })
        if (!pathResp || pathResp.code !== 0 || !pathResp.data || pathResp.data.length === 0) {
            return false
        }
        const docPath: string = pathResp.data[0].path
        if (!docPath || !docPath.endsWith('.sy')) {
            return false
        }
        // 父文档目录前缀：去掉 .sy → /a/20260623132809-wr4ulmn
        const dirPrefix = docPath.slice(0, -3)

        // 2. 一次性查询：
        //    - child_docs：子文档数（path 前缀）
        //    - non_empty_blocks：非空内容块数（空段落 TRIM 后为空不算内容，含零宽空格）
        //    - has_widget：已有挂件数
        const stmt = `SELECT
            (SELECT COUNT(1) FROM blocks WHERE type = 'd' AND path LIKE '${dirPrefix}/%') AS child_docs,
            (SELECT COUNT(1) FROM blocks WHERE parent_id = '${docID}' AND type != 'd' AND TRIM(REPLACE(COALESCE(content, ''), char(8203), '')) != '') AS non_empty_blocks,
            (SELECT COUNT(1) FROM blocks WHERE root_id = '${docID}' AND type = 'widget' AND (content LIKE '%listChildDocs%' OR markdown LIKE '%listChildDocs%')) AS has_widget`
        const resp: any = await fetchSyncPost('/api/query/sql', { stmt })
        if (!resp || resp.code !== 0 || !resp.data || resp.data.length === 0) {
            return false
        }
        const row = resp.data[0]
        const childDocs = parseInt(row.child_docs, 10) || 0
        const nonEmptyBlocks = parseInt(row.non_empty_blocks, 10) || 0
        const hasWidget = parseInt(row.has_widget, 10) || 0
        return childDocs > 0 && nonEmptyBlocks === 0 && hasWidget === 0
    } catch (e) {
        console.warn('⚠️ 查询文档条件失败:', docID, e)
        return false
    }
}

/**
 * 检查文档是否已锁定（custom-sy-readonly=true）。
 * 若锁定则临时解锁（设为 false），返回 true；否则返回 false。
 * 调用方必须在完成写入后恢复锁定（见 ensureWidget）。
 */
async function unlockIfLocked(docID: string): Promise<boolean> {
    try {
        const resp: any = await fetchSyncPost('/api/attr/getBlockAttrs', { id: docID })
        if (resp && resp.code === 0 && resp.data && resp.data['custom-sy-readonly'] === 'true') {
            await fetchSyncPost('/api/attr/setBlockAttrs', {
                id: docID,
                attrs: { 'custom-sy-readonly': 'false' },
            })
            return true
        }
    } catch (e) {
        console.warn('⚠️ 检查/解锁文档失败:', docID, e)
    }
    return false
}

/**
 * 删除文档中的空段落块（空行），循环多轮直到删干净。
 * 必须在【插入挂件之后】调用：先删空段落 → 文档变空 → 编辑器自动补新空段落，
 * 导致空行残留。先插挂件再删，文档仍有内容块，编辑器不应补行；
 * 但前端/事务可能仍有延迟补行，因此循环检查（上限 3 轮）。
 */
async function removeEmptyParagraphs(docID: string) {
    for (let round = 0; round < 3; round++) {
        try {
            await flushTx()
            const resp: any = await fetchSyncPost('/api/query/sql', {
                stmt: `SELECT id FROM blocks WHERE parent_id = '${docID}' AND type = 'p' AND TRIM(REPLACE(COALESCE(content, ''), char(8203), '')) = ''`,
            })
            const rows = resp?.code === 0 && resp.data ? resp.data : []
            if (rows.length === 0) {
                return // 没有空段落了，完成
            }
            for (const row of rows) {
                await fetchSyncPost('/api/block/deleteBlock', { id: row.id })
            }
            // 等待事务落地 + 前端响应，再检查下一轮
            await new Promise(r => setTimeout(r, 400))
        } catch (e) {
            console.warn('⚠️ 删除空段落失败:', docID, e)
            return
        }
    }
}

/**
 * 生成挂件块 DOM（NodeWidget）。
 * 直接构造与思源 /widget 命令完全一致的完整结构：
 *   <div data-type="NodeWidget" class="iframe" data-subtype="widget">
 *     <div class="iframe-content"><iframe .../></div>
 *     <div class="protyle-attr"></div>
 *   </div>
 * 不依赖前端 protyle / 内核 API 转换——那些在无 protyle 的扫描路径下会失败，
 * 导致生成缺少 iframe 的空壳挂件（挂件不渲染、格式混乱）。
 */
function genWidgetDOM(): string {
    const iframeHTML = genWidgetIframeHTML()
    return `<div data-type="NodeWidget" data-subtype="widget" class="iframe"><div class="iframe-content">${iframeHTML}<span class="protyle-action__drag" contenteditable="false"></span></div><div class="protyle-attr" contenteditable="false">​</div></div>`
}

/** iframe 原始 HTML */
function genWidgetIframeHTML(): string {
    return `<iframe src="${WIDGET_SRC}" data-subtype="widget" border="0" frameborder="no" framespacing="0" allowfullscreen="true"></iframe>`
}

/**
 * 前端 DOM 补丁：为新插入的挂件块补上块菜单按钮（protyle-icons）和 data-readonly。
 * 思源正常渲染文档时会给每个块生成 protyle-icons（依赖 data-readonly 属性）；
 * 但 appendBlock 经事务插入时前端直接插入我们提供的 DOM，不重新生成图标区，
 * 导致刚插入的挂件块没有块菜单按钮（重开页签才正常）。这里在前端 DOM 层补齐，
 * 只补运行时 UI，不写入持久化数据。
 * @param widgetID 新挂件块的 data-node-id
 * @param readonly 文档最终是否锁定（锁定则隐藏"编辑"按钮）
 */
function patchWidgetIcons(widgetID: string, readonly: boolean) {
    try {
        const el = document.querySelector(`[data-node-id="${widgetID}"]`)
        if (!el) {
            return
        }
        if (!el.hasAttribute('data-readonly')) {
            el.setAttribute('data-readonly', readonly ? 'true' : 'false')
        }
        if (!el.querySelector('.protyle-icons')) {
            const editCls = readonly ? ' fn__none' : ''
            const moreCls = readonly ? ' protyle-icon--first' : ''
            const editLabel = window.siyuan?.languages?.edit || '编辑'
            const moreLabel = window.siyuan?.languages?.more || '更多'
            el.insertAdjacentHTML('afterbegin', `<div class="protyle-icons"><span aria-label="${editLabel}" data-position="4north" class="ariaLabel protyle-icon protyle-icon--first protyle-action__edit${editCls}"><svg><use xlink:href="#iconEdit"></use></svg></span><span aria-label="${moreLabel}" data-position="4north" class="ariaLabel protyle-icon protyle-action__menu protyle-icon--last${moreCls}"><svg><use xlink:href="#iconMore"></use></svg></span></div>`)
        }
    } catch (e) {
        // 忽略：文档可能未在前端打开（全库扫描路径）或元素尚未渲染
    }
}

/**
 * 轮询等待前端渲染出新块（ws 事务有延迟），然后调用 patchWidgetIcons 补块菜单。
 * 最多等待 3 秒；全库扫描时文档未打开（无前端 DOM），超时后自动放弃。
 */
function patchWidgetIconsWithRetry(widgetID: string, readonly: boolean) {
    if (!widgetID || typeof document === 'undefined') {
        return
    }
    let tries = 0
    const timer = window.setInterval(() => {
        tries++
        const el = document.querySelector(`[data-node-id="${widgetID}"]`)
        if (el || tries > 30) {
            window.clearInterval(timer)
            if (el) {
                patchWidgetIcons(widgetID, readonly)
            }
        }
    }, 100)
}

/** 复制已有 listChildDocs 挂件块的配置属性 */
async function copyWidgetConfig(widgetBlockID: string): Promise<Record<string, string>> {
    const attrs: Record<string, string> = {}
    try {
        const resp: any = await fetchSyncPost('/api/attr/getBlockAttrs', { id: widgetBlockID })
        if (resp && resp.code === 0 && resp.data) {
            for (const key of CONFIG_ATTRS) {
                if (resp.data[key]) {
                    attrs[key] = resp.data[key]
                }
            }
        }
    } catch (e) {
        console.warn('⚠️ 读取挂件配置失败:', widgetBlockID, e)
    }
    return attrs
}

/**
 * 查找可作为配置模板的 listChildDocs 挂件块。
 * 优先选择【已保存独立配置】（有 custom-list-child-docs 属性）的挂件，
 * 这样新挂件能沿用用户设置的分列等配置；都没有时退回任意一个。
 */
async function findTemplateWidgetID(): Promise<string | null> {
    try {
        const resp: any = await fetchSyncPost('/api/query/sql', {
            stmt: `SELECT id FROM blocks WHERE type = 'widget' AND (content LIKE '%listChildDocs%' OR markdown LIKE '%listChildDocs%') LIMIT 50`,
        })
        if (resp && resp.code === 0 && resp.data && resp.data.length > 0) {
            const widgets = resp.data
            // 优先找有独立配置的挂件
            for (const w of widgets) {
                try {
                    const attrResp: any = await fetchSyncPost('/api/attr/getBlockAttrs', { id: w.id })
                    if (attrResp?.code === 0 && attrResp.data?.['custom-list-child-docs']) {
                        return w.id
                    }
                } catch (e) {
                    // ignore
                }
            }
            // 都没有配置则退回第一个
            return widgets[0].id
        }
    } catch (e) {
        console.warn('⚠️ 查找模板挂件失败:', e)
    }
    return null
}

/** 为单个文档追加挂件块（并发保护 + 内存防重：同一文档同时只处理一次；已插入过则跳过） */
async function ensureWidget(docID: string) {
    if (!enabled || !docID) return
    if (processingDocs.has(docID)) return // 并发保护：正在处理中，跳过
    if (insertedDocs.has(docID)) return // 内存防重：本会话已插入过，跳过（不依赖 SQL 索引）
    processingDocs.add(docID)
    let newWidgetID: string | null = null
    let wasLocked = false
    try {
        if (!(await isWidgetInstalled())) return
        if (await isEligible(docID)) {
            // 锁定文档无法 appendBlock，先临时解锁（返回是否原本已锁定）
            wasLocked = await unlockIfLocked(docID)
            try {
                // ① 先插入挂件（此时文档里还有空段落，挂件追加到末尾 → [空段落, 挂件]）
                const widgetDOM = genWidgetDOM()
                const resp: any = await fetchSyncPost('/api/block/appendBlock', {
                    dataType: 'dom',
                    data: widgetDOM,
                    parentID: docID,
                })
                if (!resp || resp.code !== 0) {
                    console.warn('⚠️ 追加挂件失败:', docID, resp?.code, resp?.msg)
                    return
                }
                newWidgetID = resp?.data?.[0]?.doOperations?.[0]?.id
                // 记录内存防重（无论索引是否刷新，本会话都不再插入）
                insertedDocs.add(docID)
                // ② 轮询确认挂件块已被 SQL 索引（索引刷新有延迟：
                //    查不到 → has_widget 误判 0 → 重复插入；挂件 iframe 加载也查不到 → getPathFailed）
                if (newWidgetID) {
                    await waitBlockIndexed(newWidgetID)
                } else {
                    await flushTx()
                    await new Promise(r => setTimeout(r, 600))
                }
                // ③ 再删除所有空段落（循环删除，确保干净）→ [挂件]
                await removeEmptyParagraphs(docID)
                // ④ 复制已有挂件的配置到新挂件块（沿用已保存的配置：分列、排序等）
                const templateID = await findTemplateWidgetID()
                if (templateID && newWidgetID) {
                    const configAttrs = await copyWidgetConfig(templateID)
                    if (Object.keys(configAttrs).length > 0) {
                        await fetchSyncPost('/api/attr/setBlockAttrs', {
                            id: newWidgetID,
                            attrs: configAttrs,
                        })
                    }
                }
            } finally {
                // 原本已锁定的文档，插入完成后恢复锁定
                if (wasLocked) {
                    await fetchSyncPost('/api/attr/setBlockAttrs', {
                        id: docID,
                        attrs: { 'custom-sy-readonly': 'true' },
                    })
                }
            }
        }
    } catch (e) {
        console.warn('⚠️ 添加挂件失败:', docID, e)
    } finally {
        // ⑤ 补块菜单按钮（前端 DOM 层；恢复锁定后再补，readonly 状态才准确）
        if (newWidgetID) {
            patchWidgetIconsWithRetry(newWidgetID, wasLocked)
        }
        processingDocs.delete(docID)
    }
}

/**
 * 全库扫描：对所有空白父文档添加「列出子文档」挂件。
 * 由设置面板「全库扫描」按钮触发。
 * @param s 当前设置（传入插件实例的 this.settings，不依赖模块内部 settings）
 * @returns 添加挂件的文档数量
 */
export async function scanAllEmptyParents(s: any): Promise<number> {
    if (!s?.listChildDocsInEmptyParent) return 0
    if (!(await isWidgetInstalled())) return 0
    let addedCount = 0

    // 一次查询所有文档：id, path（必须显式 LIMIT，否则内核默认截断 64 条）
    const resp: any = await fetchSyncPost('/api/query/sql', {
        stmt: `SELECT id, path FROM blocks WHERE type = 'd' LIMIT 100000`,
    })
    if (resp?.code !== 0 || !resp.data) return 0
    const docs = resp.data

    for (const doc of docs) {
        const docID = doc.id
        if (!docID) continue
        const docPath: string = doc.path || ''
        if (!docPath.endsWith('.sy')) continue

        try {
            // 内存防重：已插入过则跳过
            if (insertedDocs.has(docID)) continue
            const dirPrefix = docPath.slice(0, -3)
            // 查询：子文档数 / 非空内容块数 / 已有挂件数
            const stmt = `SELECT
                (SELECT COUNT(1) FROM blocks WHERE type = 'd' AND path LIKE '${dirPrefix}/%') AS child_docs,
                (SELECT COUNT(1) FROM blocks WHERE parent_id = '${docID}' AND type != 'd' AND TRIM(REPLACE(COALESCE(content, ''), char(8203), '')) != '') AS non_empty_blocks,
                (SELECT COUNT(1) FROM blocks WHERE root_id = '${docID}' AND type = 'widget' AND (content LIKE '%listChildDocs%' OR markdown LIKE '%listChildDocs%')) AS has_widget`
            const q: any = await fetchSyncPost('/api/query/sql', { stmt })
            if (q?.code !== 0 || !q.data || q.data.length === 0) continue
            const row = q.data[0]
            const childDocs = parseInt(row.child_docs, 10) || 0
            const nonEmptyBlocks = parseInt(row.non_empty_blocks, 10) || 0
            const hasWidget = parseInt(row.has_widget, 10) || 0
            if (childDocs > 0 && nonEmptyBlocks === 0 && hasWidget === 0) {
                await ensureWidget(docID)
                addedCount++
            }
        } catch (e) {
            console.warn('⚠️ 全库扫描添加挂件失败:', docID, e)
        }
    }
    return addedCount
}

/**
 * 初始化功能。
 * 仅当任一相关开关开启时才注册「打开文档」监听，全关时零开销。
 * @param p 插件实例（需含 settings 与 eventBus）
 */
export function setupListChildDocs(p: any) {
    plugin = p
    enabled = !!(plugin?.settings?.listChildDocsInEmptyParent)

    const s = plugin?.settings || {}
    // 相关开关：列出子文档 + 两种锁定（非当天日记 / 父级空白文档）
    const anyRelevant = !!(s.listChildDocsInEmptyParent
        || s.lockNonTodayDaily
        || s.lockEmptyParentDoc)

    if (!anyRelevant) {
        // 全关：移除监听，零开销
        if (loadedHandler && plugin) {
            plugin.eventBus?.off('loaded-protyle-static', loadedHandler)
        }
        loadedHandler = null
        return
    }

    if (!loadedHandler) {
        loadedHandler = (event: any) => {
            const protyle = event?.detail?.protyle
            const rootID = protyle?.block?.rootID
            if (!rootID) return
            setTimeout(async () => {
                // ① 先执行：列出子文档（只针对当前文档；内部按开关判断是否执行）
                await ensureWidget(rootID)
                // ② 后执行：文档锁定（只针对当前文档；按各自开关判断）
                await applyDocLock(rootID)
            }, 800)
        }
        plugin.eventBus?.on('loaded-protyle-static', loadedHandler)
    }
}

/** 清理功能 */
export function destroyListChildDocs() {
    enabled = false
    if (plugin) {
        if (loadedHandler) {
            plugin.eventBus?.off('loaded-protyle-static', loadedHandler)
        }
    }
    loadedHandler = null
    plugin = null
    processingDocs.clear()
    insertedDocs.clear()
}
