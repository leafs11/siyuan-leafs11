import { Plugin, fetchSyncPost, Dialog, showMessage } from "siyuan";

const fs = require('fs');
const path = require('path');

// ============================================================
// 类型定义
// ============================================================

interface ArchiveNode {
    name: string;      // 当前层级名称，如 'b'
    path: string;      // 完整标签路径，如 'a/b'
    archived: boolean; // 自身是否被归档
    children: ArchiveNode[];
}

// ============================================================
// 状态
// ============================================================

let pluginInstance: Plugin | null = null;
let archivedTags: string[] = [];
let archiveCollapsed: boolean = false;      // 归档栏整体折叠
let collapsedPaths: string[] = [];          // 树中已折叠的标签路径
let draggingTag: string | null = null;      // 正在拖拽的标签路径
let tagCounts: Record<string, number> = {}; // 标签路径 -> 引用块数量
let lastTagSortMode: number | null = null;  // 上次使用的全局标签排序模式（检测变化重渲染）

// 编辑器标签补全状态（过滤思源原生标签联想栏，剔除已归档标签）
let tagCompleteAllTags: string[] = [];              // 所有未归档标签（完整路径）
let nativeHintObserver: MutationObserver | null = null; // 同步过滤（无闪烁）
let hintPollTimer: ReturnType<typeof setInterval> | null = null; // 轮询兜底

// 自动获取的工作空间路径缓存（workspace 根目录，如 D:\leafs11）
let workspacePath: string | null = null;
let dataLoaded: boolean = false;

// ============================================================
// 工具函数
// ============================================================

function escapeHtml(str: string): string {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 判断光标前是否为未闭合的 # 前缀输入
function isTagPrefixContext(before: string): boolean {
    return /(?:^|[^a-zA-Z0-9_\u4e00-\u9fa5])#([^#\s]*)$/.test(before);
}

// ============================================================
// 标签排序（效仿标签栏：跟随全局设置 window.siyuan.config.tag.sort）
// 取值：0 名称字母升序 / 1 名称字母降序 / 4 名称自然升序 / 5 名称自然降序 / 7 引用数升序 / 8 引用数降序
// ============================================================

/** 读取全局标签排序模式 */
function getTagSortMode(): number {
    try {
        const win = window as any;
        const sort = win.siyuan?.config?.tag?.sort;
        return typeof sort === 'number' ? sort : 0;
    } catch (_) {
        return 0;
    }
}

/** 名称拼音比较（近似内核 PinYinCompare） */
function comparePinYin(a: string, b: string): number {
    return a.localeCompare(b, 'zh-Hans-CN');
}

/** 名称自然比较（近似内核 NaturalCompare，数字感知） */
function compareNatural(a: string, b: string): number {
    const re = /(\d+)|(\D+)/g;
    const aParts = a.match(re) || [];
    const bParts = b.match(re) || [];
    const len = Math.min(aParts.length, bParts.length);
    for (let i = 0; i < len; i++) {
        const pa = aParts[i];
        const pb = bParts[i];
        const aNum = /^\d+$/.test(pa);
        const bNum = /^\d+$/.test(pb);
        if (aNum && bNum) {
            const diff = parseInt(pa, 10) - parseInt(pb, 10);
            if (diff !== 0) return diff;
        } else if (aNum) {
            return -1;
        } else if (bNum) {
            return 1;
        } else {
            const diff = pa.localeCompare(pb, 'zh-Hans-CN');
            if (diff !== 0) return diff;
        }
    }
    return aParts.length - bParts.length;
}

/** 按全局标签排序模式对同级节点排序 */
function sortNodes(nodes: ArchiveNode[]) {
    const mode = getTagSortMode();
    nodes.sort((a, b) => {
        switch (mode) {
            case 1: return comparePinYin(b.name, a.name);
            case 4: return compareNatural(a.name, b.name);
            case 5: return compareNatural(b.name, a.name);
            case 7: return (tagCounts[a.path] ?? 0) - (tagCounts[b.path] ?? 0);
            case 8: return (tagCounts[b.path] ?? 0) - (tagCounts[a.path] ?? 0);
            default: return comparePinYin(a.name, b.name);
        }
    });
}

// ============================================================
// 工作空间路径获取
// ============================================================

/**
 * 方案A（同步，官方标准）：window.siyuan.config.system.workspaceDir
 * 该字段由内核启动时推送到前端，包含工作空间根目录绝对路径。
 */
function getWorkspaceFromConfig(): string | null {
    try {
        const win = window as any;
        const system = win.siyuan?.config?.system;
        if (system?.workspaceDir) {
            console.log('🗂️ 从 config.system.workspaceDir 获取工作空间:', system.workspaceDir);
            return system.workspaceDir as string;
        }
        // 备选：dataDir（工作空间/data），取其上级
        if (system?.dataDir) {
            const ws = path.dirname(system.dataDir as string);
            console.log('🗂️ 从 config.system.dataDir 推导工作空间:', ws);
            return ws;
        }
    } catch (_) {}
    return null;
}

/**
 * 方案B（异步兜底）：通过内核 API 获取
 * /api/system/getSystemInfo 返回 ISystem.dataDir
 */
async function getWorkspaceFromSystemInfo(): Promise<string | null> {
    try {
        const resp: any = await fetchSyncPost('/api/system/getSystemInfo', {});
        if (resp && resp.code === 0 && resp.data && resp.data.dataDir) {
            const ws = path.dirname(resp.data.dataDir);
            console.log('🗂️ 从 getSystemInfo 获取工作空间:', ws);
            return ws;
        }
        console.warn('⚠️ getSystemInfo 响应异常:', resp);
    } catch (e) {
        console.warn('⚠️ getSystemInfo 获取工作空间失败:', e);
    }
    return null;
}

/** 同步快速获取（可能为空） */
function getWorkspacePath(): string | null {
    if (workspacePath) {
        return workspacePath;
    }
    const ws = getWorkspaceFromConfig();
    if (ws) {
        workspacePath = ws;
    }
    return workspacePath;
}

function getDataFilePath(): string {
    const workspace = getWorkspacePath();
    if (!workspace) {
        return '';
    }
    return path.join(workspace, 'data', 'plugins', 'siyuan-leafs11', 'data.json');
}

// ============================================================
// 数据读写
// ============================================================

function loadData(): boolean {
    if (dataLoaded) {
        return true;
    }
    const filePath = getDataFilePath();
    if (!filePath) {
        console.warn('⚠️ 工作空间路径未知，数据稍后加载');
        return false;
    }
    dataLoaded = true;
    try {
        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf-8');
            const data = JSON.parse(content);
            if (Array.isArray(data.tags)) {
                archivedTags = data.tags;
            }
            if (typeof data.archiveCollapsed === 'boolean') {
                archiveCollapsed = data.archiveCollapsed;
            }
            if (Array.isArray(data.collapsedPaths)) {
                collapsedPaths = data.collapsedPaths;
            }
            console.log('📂 加载数据成功:', filePath, '共', archivedTags.length, '个归档标签');
        } else {
            console.log('📂 数据文件不存在，使用默认值');
        }
    } catch (e) {
        console.warn('加载数据失败:', e);
    }
    return true;
}

function saveData(): void {
    // ★ 守卫：路径未知或数据未加载完成时禁止写入，防止空数据覆盖真实数据
    if (!workspacePath || !dataLoaded) {
        console.warn('⚠️ 工作空间路径未知或数据未加载，跳过保存（防止覆盖）');
        return;
    }
    const filePath = getDataFilePath();
    if (!filePath) {
        return;
    }
    try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const data = {
            tags: archivedTags,
            archiveCollapsed: archiveCollapsed,
            collapsedPaths: collapsedPaths
        };
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
        console.log('💾 数据已保存:', filePath);
    } catch (e) {
        console.warn('保存数据失败:', e);
    }
}

// ============================================================
// 标签引用计数
// ============================================================

/**
 * 刷新标签引用计数。
 * 从主标签栏 DOM 读取（最可靠，不依赖 API）：
 * 主标签栏每个 .b3-list-item[data-treetype="tag"] 带 data-label（完整路径），
 * 计数元素类名为 .counter（见 siyuan app/src/util/Tree.ts）：
 *   countHTML = `<span class="counter">${item.count}</span>`
 * 注意：count 为 0 时思源不渲染 .counter 元素。
 */
function refreshTagCounts(): void {
    const newCounts: Record<string, number> = {};
    const items = document.querySelectorAll('.dockPanel.sy__tag .b3-list-item[data-treetype="tag"]');
    for (const el of items) {
        const label = (el as HTMLElement).dataset.label;
        if (!label) continue;
        const counterEl = el.querySelector('.counter');
        if (counterEl && counterEl.textContent) {
            const n = parseInt(counterEl.textContent.trim().replace(/[^\d]/g, ''), 10);
            if (!isNaN(n)) {
                newCounts[label] = n;
            }
        }
    }

    // 兜底：DOM 读取不到时（面板未渲染），尝试 getTag API
    if (Object.keys(newCounts).length === 0) {
        fetchSyncPost('/api/tag/getTag', {}).then((resp: any) => {
            if (resp && resp.code === 0) {
                const counts: Record<string, number> = {};
                const tags = (resp.data && resp.data.tags) || [];
                flattenTagCounts(tags, '', counts);
                if (Object.keys(counts).length > 0) {
                    tagCounts = counts;
                    console.log('🔢 标签计数已从 getTag 刷新，共', Object.keys(counts).length, '个');
                    updateTagCountDisplay();
                }
            }
        }).catch(() => {});
        return;
    }

    tagCounts = newCounts;
    console.log('🔢 标签计数已从主标签栏刷新，共', Object.keys(newCounts).length, '个');
    updateTagCountDisplay();
}

/** 递归展平 getTag 返回的标签树（count 版） */
function flattenTagCounts(tags: any[], prefix: string, out: Record<string, number>) {
    for (const t of tags) {
        if (!t || typeof t.name !== 'string') continue;
        const full = prefix ? prefix + '/' + t.name : t.name;
        if (typeof t.count === 'number') {
            out[full] = t.count;
        }
        if (Array.isArray(t.children)) {
            flattenTagCounts(t.children, full, out);
        }
    }
}

/** 更新 DOM 中已渲染的计数显示（不重新渲染整棵树；无引用数时留空占位，保持按钮列对齐） */
function updateTagCountDisplay() {
    const items = document.querySelectorAll('.plugin-archive-list li[data-tagpath]');
    for (const li of items) {
        const path = (li as HTMLElement).dataset.tagpath || '';
        const el = li.querySelector('.plugin-tag-count');
        if (el) {
            const count = tagCounts[path] ?? 0;
            el.textContent = count > 0 ? String(count) : '';
        }
    }
}

// --- 右键焦点 ---

function setupContextMenuFocus() {
    document.addEventListener('contextmenu', (e) => {
        const target = e.target as HTMLElement;
        const tagItem = target.closest('.b3-list-item[data-treetype="tag"]');
        if (tagItem) {
            document.querySelectorAll('.b3-list-item--focus[data-treetype="tag"]').forEach(el => {
                el.classList.remove('b3-list-item--focus');
            });
            tagItem.classList.add('b3-list-item--focus');
        }
    }, true);
}

// --- 拖动归档 ---

/**
 * 文档级监听拖拽开始/结束：
 * - 从主标签栏拖拽标签时记录路径并写入 dataTransfer（不阻止默认行为，
 *   保留思源原有的"拖到编辑器插入标签"功能）
 * - 拖拽结束时清空记录
 */
function setupTagDrag() {
    document.addEventListener('dragstart', (e) => {
        const target = e.target as HTMLElement;
        const tagItem = target.closest('.b3-list-item[data-treetype="tag"]') as HTMLElement | null;
        if (tagItem?.dataset.label) {
            const label = tagItem.dataset.label;
            draggingTag = label;
            try {
                const dt = e.dataTransfer;
                if (dt) {
                    dt.setData('text/plain', label);
                    dt.effectAllowed = 'move';
                }
            } catch (_) {}
        }
    }, true);

    document.addEventListener('dragend', () => {
        draggingTag = null;
    }, true);
}

function getRightClickedTag(): string | null {
    const focus = document.querySelector('.b3-list-item--focus[data-treetype="tag"]');
    if (focus) {
        return (focus as HTMLElement).dataset.label || null;
    }
    return null;
}

// --- 归档操作 ---

/**
 * 收集当前标签面板中所有标签路径
 * 从 DOM 的 data-label 属性获取（包括折叠中的子级）
 */
function getAllTagPaths(): string[] {
    const items = document.querySelectorAll('.dockPanel.sy__tag .b3-list-item[data-treetype="tag"]');
    const paths: string[] = [];
    for (const el of items) {
        const label = (el as HTMLElement).dataset.label;
        if (label) {
            paths.push(label);
        }
    }
    return paths;
}

/** 计算 tagPath 自身 + 所有子标签（后代）的路径集合 */
function collectWithDescendants(tagPath: string, pool: string[]): string[] {
    const result: string[] = [];
    for (const p of pool) {
        if (p === tagPath || p.startsWith(tagPath + '/')) {
            if (!result.includes(p)) {
                result.push(p);
            }
        }
    }
    return result;
}

/** 计算 tagPath 所有已归档祖先（父、祖父…）的路径集合（不含自身） */
function collectWithAncestors(tagPath: string, pool: string[]): string[] {
    const parts = tagPath.split('/').filter(p => p.length > 0);
    const result: string[] = [];
    let current = '';
    for (let i = 0; i < parts.length - 1; i++) {
        current = current ? current + '/' + parts[i] : parts[i];
        if (pool.includes(current) && !result.includes(current)) {
            result.push(current);
        }
    }
    return result;
}

/**
 * 归档标签。归档父标签时，其所有子标签也一并归档。
 */
function archiveTag(tagPath: string) {
    if (!tagPath) return;

    const allTags = getAllTagPaths();
    // DOM 中可能没有渲染全部标签，用已归档列表补充
    const pool = [...new Set([...allTags, ...archivedTags])];
    const toArchive = collectWithDescendants(tagPath, pool);

    let changed = false;
    for (const p of toArchive) {
        if (!archivedTags.includes(p)) {
            archivedTags.push(p);
            changed = true;
        }
    }
    if (!changed) {
        return;
    }

    saveData();
    // 隐藏主标签栏中归档标签及其子树
    for (const p of toArchive) {
        hideTagInMain(p);
    }
    renderArchiveList();
    if (archiveCollapsed) {
        archiveCollapsed = false;
        saveData();
        updateArchiveHeader();
    }
    refreshTagCounts();
    refreshCompleteTags();
}

/**
 * 仅取消指定标签自身的归档（子标签保持归档）；
 * 同时取消其所有已归档的父标签（父、祖父…）。
 */
function unarchiveTagOnly(tagPath: string) {
    // 自身 + 已归档祖先（子标签保持归档，不级联后代）
    const toUnarchive = [tagPath, ...collectWithAncestors(tagPath, archivedTags)];

    let changed = false;
    for (const p of toUnarchive) {
        const idx = archivedTags.indexOf(p);
        if (idx !== -1) {
            archivedTags.splice(idx, 1);
            changed = true;
        }
    }
    if (!changed) {
        return;
    }

    saveData();
    showAllTags();
    hideAllArchived();
    renderArchiveList();
    refreshCompleteTags();
}

/**
 * 取消归档标签（级联）。取消父标签时，其所有子标签也一并取消归档；
 * 取消子标签时，其所有已归档的父标签也一并取消归档。
 */
function unarchiveTag(tagPath: string) {
    // 级联取消：自身 + 所有已归档的后代 + 所有已归档的祖先
    const toUnarchive = [
        ...collectWithDescendants(tagPath, archivedTags),
        ...collectWithAncestors(tagPath, archivedTags),
    ];
    if (toUnarchive.length === 0) {
        return;
    }

    let changed = false;
    for (const p of toUnarchive) {
        const idx = archivedTags.indexOf(p);
        if (idx !== -1) {
            archivedTags.splice(idx, 1);
            changed = true;
        }
    }
    if (!changed) {
        return;
    }

    saveData();
    // 先全部恢复，再重新应用隐藏状态（防止父级取消归档时误恢复仍归档的子树）
    showAllTags();
    hideAllArchived();
    renderArchiveList();
    refreshCompleteTags();
}

/**
 * 取消归档入口：有已归档子标签时弹窗选择"仅此标签"或"连同子级"；
 * 无子标签时直接取消归档。
 */
function unarchiveTagWithChoice(tagPath: string) {
    const children = archivedTags.filter(p => p.startsWith(tagPath + '/'));
    if (children.length === 0) {
        unarchiveTag(tagPath);
        return;
    }

    const dialog = new Dialog({
        title: '取消归档',
        content: `<div class="b3-dialog__content">
            <div style="font-size:13px;line-height:1.7;">
                标签 <strong>${escapeHtml(tagPath)}</strong> 下有 <strong>${children.length}</strong> 个已归档子标签。<br>
                是否同时取消这些子标签的归档？
            </div>
        </div>
        <div class="b3-dialog__action">
            <button class="b3-button b3-button--cancel">取消</button>
            <div class="fn__space"></div>
            <button class="b3-button b3-button--outline" data-choice="self">仅此标签</button>
            <button class="b3-button b3-button--text" data-choice="all">连同子级</button>
        </div>`,
        width: '440px',
    });

    const btns = dialog.element.querySelectorAll('.b3-button') as NodeListOf<HTMLButtonElement>;
    btns[0].addEventListener('click', () => dialog.destroy());
    btns[1].addEventListener('click', () => {
        unarchiveTagOnly(tagPath);
        dialog.destroy();
    });
    btns[2].addEventListener('click', () => {
        unarchiveTag(tagPath);
        dialog.destroy();
    });
}

// --- 与标签栏一致的功能：点击搜索 / 重命名 ---

/**
 * 点击归档标签时，触发主标签栏中对应标签的点击事件，
 * 完全复用思源自身的搜索逻辑（打开搜索页签列出所有所在文档）。
 */
function searchTagInMain(tagPath: string) {
    const items = document.querySelectorAll('.dockPanel.sy__tag .b3-list-item[data-treetype="tag"]');
    for (const el of items) {
        const label = (el as HTMLElement).dataset.label;
        if (label === tagPath) {
            const item = el as HTMLElement;
            item.dispatchEvent(new MouseEvent('click', {
                bubbles: true,
                cancelable: true,
                view: window
            }));
            console.log('🔍 点击归档标签触发搜索:', tagPath);
            return;
        }
    }
    // 主标签栏未渲染出该标签（罕见），退化为直接搜索
    try {
        fetchSyncPost('/api/search/fulltextSearch', {
            query: tagPath,
            method: 0,
            path: ''
        });
    } catch (_) {}
}

/**
 * 重命名归档标签：弹出输入框，调用内核 renameTag API。
 * 重命名会修改所有包含该标签的块，并更新归档数据中的路径前缀。
 */
function renameTagDialog(tagPath: string) {
    const dialog = new Dialog({
        title: '重命名标签',
        content: `<div class="b3-dialog__content">
            <div class="fn__flex-1" style="margin-bottom:12px;font-size:13px;">
                将标签 <strong>${escapeHtml(tagPath)}</strong> 重命名为：<br>
                <span style="opacity:0.6;font-size:12px;">重命名会修改所有文档中的该标签，其子标签也会一并更新。</span>
            </div>
            <input class="b3-text-field fn__block" value="${escapeHtml(tagPath)}"/>
        </div>
        <div class="b3-dialog__action">
            <button class="b3-button b3-button--cancel">取消</button>
            <div class="fn__space"></div>
            <button class="b3-button b3-button--text">确定</button>
        </div>`,
        width: '480px',
    });

    const input = dialog.element.querySelector('input') as HTMLInputElement;
    const btns = dialog.element.querySelectorAll('.b3-button') as NodeListOf<HTMLButtonElement>;
    input.focus();
    input.select();

    const doRename = async () => {
        const newLabel = input.value.trim();
        if (!newLabel) {
            showMessage('新名称不能为空', 3000, 'error');
            return;
        }
        if (newLabel === tagPath) {
            dialog.destroy();
            return;
        }
        try {
            const resp: any = await fetchSyncPost('/api/tag/renameTag', {
                oldLabel: tagPath,
                newLabel: newLabel
            });
            if (resp && resp.code === 0) {
                // 更新归档数据：自身 + 子路径前缀替换
                archivedTags = archivedTags.map(p =>
                    p === tagPath ? newLabel
                        : p.startsWith(tagPath + '/') ? newLabel + p.slice(tagPath.length)
                        : p
                );
                archivedTags = [...new Set(archivedTags)];
                saveData();
                // 通知前端重载标签树，主标签栏自动更新
                try {
                    await fetchSyncPost('/api/ui/reloadTag', {});
                } catch (_) {}
                showAllTags();
                hideAllArchived();
                renderArchiveList();
                refreshTagCounts();
                refreshCompleteTags();
                showMessage('重命名成功', 2000);
            } else {
                showMessage('重命名失败：' + ((resp && resp.msg) || '未知错误'), 5000, 'error');
            }
        } catch (e: any) {
            showMessage('重命名失败：' + e, 5000, 'error');
        }
        dialog.destroy();
    };

    btns[0].addEventListener('click', () => dialog.destroy());
    btns[1].addEventListener('click', doRename);
    dialog.bindInput(input, doRename);
}

// ============================================================
// 编辑器标签补全（过滤思源原生标签联想栏，剔除已归档标签）
// ============================================================

/** 递归展平 getTag 返回的标签树（路径版） */
function flattenTagNames(tags: any[], prefix: string, out: string[]) {
    for (const t of tags) {
        if (!t || typeof t.name !== 'string') continue;
        const full = prefix ? prefix + '/' + t.name : t.name;
        out.push(full);
        if (Array.isArray(t.children)) {
            flattenTagNames(t.children, full, out);
        }
    }
}

/** 刷新未归档标签列表（补全过滤用） */
function refreshCompleteTags(): void {
    const all = getAllTagPaths();
    if (all.length > 0) {
        tagCompleteAllTags = all.filter(p => !archivedTags.includes(p));
        return;
    }
    // 兜底：getTag API
    fetchSyncPost('/api/tag/getTag', {}).then((resp: any) => {
        if (resp && resp.code === 0) {
            const paths: string[] = [];
            flattenTagNames((resp.data && resp.data.tags) || [], '', paths);
            tagCompleteAllTags = paths.filter(p => !archivedTags.includes(p));
        }
    }).catch(() => {});
}

/** 获取光标所在编辑块及光标前的文本（去除零宽空格） */
function getCaretContext(): { block: HTMLElement; before: string } | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    const container = range.startContainer;
    const el = container.nodeType === 3 ? container.parentElement : container as HTMLElement;
    if (!el) return null;
    const block = el.closest('[contenteditable="true"]');
    if (!block) return null;
    // 代码块 / HTML 块 / 行内代码内不触发补全
    if (el.closest('.code-block, [data-type="NodeCodeBlock"], [data-type="NodeHTMLBlock"], [data-type="code"]')) {
        return null;
    }
    const preRange = range.cloneRange();
    preRange.selectNodeContents(block);
    preRange.setEnd(range.startContainer, range.startOffset);
    return {
        block: block as HTMLElement,
        before: preRange.toString().replace(/\u200b/g, '')
    };
}

/**
 * 过滤原生标签联想栏：移除已归档的标签项。
 * 原生 hint 结构：
 *   <button class="b3-list-item b3-list-item--two" data-value="%3Cspan%20data-type%3D%22tag%22%3E标签路径%3C%2Fspan%3E">
 *     <div class="b3-list-item__text">标签路径</div>
 *   </button>
 * 幂等：每次调用重新检查，思源重新渲染 innerHTML 后已归档项再次出现时会被再次移除。
 */
function filterNativeTagHint(hintEl: HTMLElement) {
    const items = hintEl.querySelectorAll('.b3-list-item');
    let removedCount = 0;
    let focusRemoved = false;

    for (const item of items) {
        const btn = item as HTMLElement;
        const dv = btn.getAttribute('data-value') || '';
        // 仅处理标签项（data-value 里是 <span data-type="tag">…</span> 的 URL 编码）
        if (!dv.includes('data-type') || !dv.includes('tag')) continue;
        const textEl = btn.querySelector('.b3-list-item__text');
        const label = textEl ? (textEl.textContent || '').trim() : '';
        if (label && archivedTags.includes(label)) {
            if (btn.classList.contains('b3-list-item--focus')) {
                focusRemoved = true;
            }
            btn.remove();
            removedCount++;
        }
    }

    if (removedCount === 0) return;

    // 当前高亮项被移除时，把高亮移到第一个剩余项（保持键盘导航可用）
    if (focusRemoved) {
        hintEl.querySelectorAll('.b3-list-item--focus').forEach(el => el.classList.remove('b3-list-item--focus'));
        const first = hintEl.querySelector('.b3-list-item');
        if (first) {
            first.classList.add('b3-list-item--focus');
        }
    }

    // 全部过滤完则隐藏整个 hint（无可选项）
    if (hintEl.querySelectorAll('.b3-list-item').length === 0) {
        hintEl.classList.add('fn__none');
    }
}

/**
 * 同步过滤所有可见的、处于 # 前缀上下文中的原生标签联想栏。
 * 在 MutationObserver 回调（DOM 变更后的微任务，浏览器绘制前）中调用，
 * 归档标签在第一次绘制前就被移除，无闪烁。
 */
function filterVisibleTagHints() {
    if (archivedTags.length === 0) return;
    const hints = document.querySelectorAll('.protyle-hint');
    for (const hint of hints) {
        const h = hint as HTMLElement;
        if (h.classList.contains('fn__none')) continue;
        const ctx = getCaretContext();
        if (!ctx || !isTagPrefixContext(ctx.before)) continue;
        filterNativeTagHint(h);
    }
}

/**
 * 轮询兜底：防止 MutationObserver 偶发漏掉（如 hint 由其它机制更新）。
 */
function pollNativeHint() {
    filterVisibleTagHints();
}

/**
 * 初始化标签补全：
 * 1. MutationObserver 监听 body 的 childList（捕获 hint 内部按钮的新增/更新），
 *    回调在浏览器绘制前同步过滤 → 无闪烁。
 * 2. 轮询 300ms 兜底。
 */
function setupTagComplete() {
    // MutationObserver：hint 内容任何变化（按钮增删）都触发同步过滤
    if (nativeHintObserver) {
        nativeHintObserver.disconnect();
    }
    nativeHintObserver = new MutationObserver(() => {
        filterVisibleTagHints();
    });
    nativeHintObserver.observe(document.body, { childList: true, subtree: true });

    // 轮询兜底
    if (hintPollTimer !== null) {
        clearInterval(hintPollTimer);
    }
    hintPollTimer = setInterval(pollNativeHint, 300);

    refreshCompleteTags();
}

/** 清理标签补全 */
function destroyTagComplete() {
    if (nativeHintObserver) {
        nativeHintObserver.disconnect();
        nativeHintObserver = null;
    }
    if (hintPollTimer !== null) {
        clearInterval(hintPollTimer);
        hintPollTimer = null;
    }
}

// --- 显示/隐藏主标签 ---

function hideTagInMain(tagPath: string) {
    const items = document.querySelectorAll(`.dockPanel.sy__tag .b3-list-item[data-treetype="tag"]`);
    for (const el of items) {
        const label = (el as HTMLElement).dataset.label;
        if (label === tagPath || label?.startsWith(tagPath + '/')) {
            (el as HTMLElement).style.display = 'none';
        }
    }
}

function showTagInMain(tagPath: string) {
    const items = document.querySelectorAll(`.dockPanel.sy__tag .b3-list-item[data-treetype="tag"]`);
    for (const el of items) {
        const label = (el as HTMLElement).dataset.label;
        if (label === tagPath || label?.startsWith(tagPath + '/')) {
            (el as HTMLElement).style.display = '';
        }
    }
}

function showAllTags() {
    const items = document.querySelectorAll(`.dockPanel.sy__tag .b3-list-item[data-treetype="tag"]`);
    for (const el of items) {
        (el as HTMLElement).style.display = '';
    }
}

function hideAllArchived() {
    for (const tag of archivedTags) {
        hideTagInMain(tag);
    }
}

// --- 更新归档栏标题 ---

function updateArchiveHeader() {
    const header = document.querySelector('.plugin-archive-header') as HTMLElement;
    if (!header) return;

    const arrow = header.querySelector('.plugin-archive-arrow') as HTMLElement;
    if (arrow) {
        arrow.innerHTML = archiveCollapsed
            ? `<svg class="b3-list-item__arrow" style="width:12px;height:12px;"><use xlink:href="#iconRight"></use></svg>`
            : `<svg class="b3-list-item__arrow b3-list-item__arrow--open" style="width:12px;height:12px;"><use xlink:href="#iconRight"></use></svg>`;
    }

    const list = document.querySelector('.plugin-archive-list') as HTMLElement;
    if (list) {
        list.style.display = archiveCollapsed ? 'none' : '';
    }

    const section = document.querySelector('.plugin-archive-section') as HTMLElement;
    if (section) {
        if (archiveCollapsed) {
            section.style.height = 'auto';
            section.style.minHeight = 'auto';
        } else {
            section.style.height = '';
            section.style.minHeight = '60px';
        }
    }

    const divider = document.querySelector('.plugin-archive-divider') as HTMLElement;
    if (divider) {
        if (archiveCollapsed) {
            divider.style.opacity = '0.1';
            divider.style.cursor = 'default';
        } else {
            divider.style.opacity = '0.3';
            divider.style.cursor = 'ns-resize';
        }
    }

    const countEl = header.querySelector('.plugin-archive-count') as HTMLElement;
    if (countEl) {
        countEl.textContent = `(${archivedTags.length})`;
    }
}

function toggleArchive() {
    archiveCollapsed = !archiveCollapsed;
    saveData();
    updateArchiveHeader();
}

// ============================================================
// 树状归档列表
// ============================================================

/**
 * 将归档标签路径列表构建为树
 * 例：['a', 'a/b', 'c/d'] →
 *   a(archived, 子: b(archived))
 *   c(未归档, 子: d(archived))
 */
function buildArchiveTree(tags: string[]): ArchiveNode[] {
    const root: ArchiveNode = { name: '', path: '', archived: false, children: [] };
    for (const tagPath of tags) {
        const parts = tagPath.split('/').filter(p => p.length > 0);
        let node = root;
        let current = '';
        for (const part of parts) {
            current = current ? current + '/' + part : part;
            let child = node.children.find(c => c.name === part);
            if (!child) {
                child = { name: part, path: current, archived: false, children: [] };
                node.children.push(child);
            }
            node = child;
        }
        node.archived = true;
    }
    return root.children;
}

function isPathCollapsed(tagPath: string): boolean {
    return collapsedPaths.includes(tagPath);
}

function toggleCollapse(tagPath: string) {
    const idx = collapsedPaths.indexOf(tagPath);
    if (idx === -1) {
        collapsedPaths.push(tagPath);
    } else {
        collapsedPaths.splice(idx, 1);
    }
    saveData();
    renderArchiveList();
}

/** 全部展开归档树 */
function expandAllArchived() {
    collapsedPaths = [];
    saveData();
    renderArchiveList();
}

/** 全部折叠归档树（所有有子节点的标签都折叠） */
function collapseAllArchived() {
    const tree = buildArchiveTree(archivedTags);
    collapsedPaths = [];
    const collect = (nodes: ArchiveNode[]) => {
        for (const n of nodes) {
            if (n.children.length > 0) {
                collapsedPaths.push(n.path);
                collect(n.children);
            }
        }
    };
    collect(tree);
    saveData();
    renderArchiveList();
}

/**
 * 递归渲染树节点（扁平 li + 缩进，与标签栏一致）
 * 显示规则：
 * - 自身归档：正常显示，有归档子节点时带展开箭头；点击搜索；可重命名/取消归档
 * - 自身未归档但有归档后代：半透明显示（分组标题），可展开
 * - 未归档叶节点：不显示
 * 节点布局：箭头(b3-list-item__toggle) 图标 名称 [✏️ ×] 计数（无引用数时计数留空占位）
 * 排序跟随全局设置；折叠/展开为归档栏独立状态。
 */
function renderNodes(nodes: ArchiveNode[], container: HTMLElement, level: number) {
    sortNodes(nodes);

    for (const node of nodes) {
        // 过滤：自身未归档且无归档后代 → 不显示
        if (!node.archived && node.children.length === 0) continue;

        const isGroup = !node.archived; // 半透明分组节点
        const collapsed = isPathCollapsed(node.path);
        const hasChildren = node.children.length > 0;

        const li = document.createElement('li');
        li.setAttribute('class', 'b3-list-item' + (isGroup ? ' plugin-archive-node-group' : ''));
        li.setAttribute('data-tagpath', node.path);
        li.style.cssText = `display:flex;align-items:center;padding:4px 8px 4px ${8 + level * 16}px;`
            + (isGroup ? 'opacity:0.45;cursor:default;' : 'cursor:pointer;');

        // 已归档节点：点击触发搜索（复用标签栏行为）
        if (node.archived) {
            li.addEventListener('click', (e) => {
                // 排除点按操作按钮/箭头的情况（它们已 stopPropagation）
                searchTagInMain(node.path);
            });
        }

        // 箭头（有子节点才显示；样式效仿标签栏 b3-list-item__toggle + b3-list-item__arrow）
        if (hasChildren) {
            const arrow = document.createElement('span');
            arrow.setAttribute('class', 'b3-list-item__toggle' + (collapsed ? '' : ' b3-list-item__toggle--hl'));
            arrow.style.cssText = `
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 12px;
                height: 16px;
                flex-shrink: 0;
                cursor: pointer;
            `;
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('class', 'b3-list-item__arrow' + (collapsed ? '' : ' b3-list-item__arrow--open'));
            svg.style.cssText = 'width:12px;height:12px;';
            const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
            use.setAttribute('href', '#iconRight');
            svg.appendChild(use);
            arrow.appendChild(svg);
            arrow.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleCollapse(node.path);
            });
            li.appendChild(arrow);
        } else {
            const spacer = document.createElement('span');
            spacer.style.cssText = 'width:12px;flex-shrink:0;';
            li.appendChild(spacer);
        }

        // 图标
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.setAttribute('class', 'b3-list-item__graphic');
        icon.style.cssText = 'width:14px;height:14px;margin-right:6px;flex-shrink:0;';
        const useIcon = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        useIcon.setAttribute('href', isGroup ? '#iconFolder' : '#iconTag');
        icon.appendChild(useIcon);
        li.appendChild(icon);

        // 文字（显示层级名称，hover 显示完整路径）
        const text = document.createElement('span');
        text.setAttribute('class', 'b3-list-item__text');
        text.textContent = node.name;
        text.title = node.path;
        text.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;';
        li.appendChild(text);

        // 已归档节点操作区：重命名 + 取消归档（紧凑排列）
        if (node.archived) {
            const renameBtn = document.createElement('span');
            renameBtn.setAttribute('class', 'b3-list-item__action');
            renameBtn.style.cssText = 'cursor:pointer;flex-shrink:0;margin-left:4px;opacity:0.5;display:inline-flex;align-items:center;';
            renameBtn.innerHTML = `<svg style="width:13px;height:13px;"><use href="#iconEdit"/></svg>`;
            renameBtn.title = '重命名';
            renameBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                renameTagDialog(node.path);
            });
            li.appendChild(renameBtn);

            const del = document.createElement('span');
            del.setAttribute('class', 'b3-list-item__action');
            del.style.cssText = 'cursor:pointer;flex-shrink:0;margin-left:2px;opacity:0.5;display:inline-flex;align-items:center;';
            del.innerHTML = `<svg style="width:13px;height:13px;"><use href="#iconClose"/></svg>`;
            del.title = '取消归档';
            del.addEventListener('click', (e) => {
                e.stopPropagation();
                unarchiveTagWithChoice(node.path);
            });
            li.appendChild(del);
        }

        // ★ 引用计数（放在操作按钮之后；紧贴按钮，无引用数时留空占位）
        const countSpan = document.createElement('span');
        countSpan.setAttribute('class', 'b3-list-item__meta plugin-tag-count');
        countSpan.style.cssText = 'font-size:11px;opacity:0.5;margin-left:3px;flex-shrink:0;min-width:1.2em;';
        const initCount = tagCounts[node.path] ?? 0;
        countSpan.textContent = initCount > 0 ? String(initCount) : '';
        li.appendChild(countSpan);

        container.appendChild(li);

        // 递归渲染子节点
        if (hasChildren && !collapsed) {
            renderNodes(node.children, container, level + 1);
        }
    }
}

function renderArchiveList() {
    const container = document.querySelector('.plugin-archive-list') as HTMLElement;
    if (!container) return;

    container.innerHTML = '';

    const tree = buildArchiveTree(archivedTags);

    if (tree.length === 0) {
        const empty = document.createElement('li');
        empty.setAttribute('class', 'b3-list-item');
        empty.textContent = '暂无归档';
        empty.style.cssText = 'color:var(--b3-theme-on-surface);opacity:0.5;font-size:12px;justify-content:center;display:flex;padding:8px;';
        container.appendChild(empty);
        updateArchiveHeader();
        return;
    }

    renderNodes(tree, container, 0);
    updateArchiveHeader();
}

// --- 注入归档UI ---

/**
 * 找到归档栏的插入锚点（标签列表所在容器），多级回退：
 * 1. 带底部间距的列表容器（原逻辑）
 * 2. 标签列表 .b3-list 的父容器
 * 3. 面板内第一个可伸缩列
 */
function findTagListAnchor(panel: HTMLElement): HTMLElement | null {
    const anchor = panel.querySelector('.fn__flex-1[style*="margin-bottom"]');
    if (anchor) {
        return anchor as HTMLElement;
    }

    const list = panel.querySelector('.b3-list[data-treetype="tag"]')
        || panel.querySelector('.b3-list');
    if (list && list.parentElement) {
        return list.parentElement as HTMLElement;
    }

    const col = panel.querySelector('.fn__flex-1.fn__flex-column');
    if (col) {
        return col as HTMLElement;
    }

    return null;
}

function injectArchiveUI(): boolean {
    const panel = document.querySelector('.dockPanel.sy__tag') as HTMLElement;
    if (!panel) return false;

    const oldSection = panel.querySelector('.plugin-archive-section') as HTMLElement;
    if (oldSection) oldSection.remove();

    const anchor = findTagListAnchor(panel);
    if (!anchor) {
        console.warn('📌 归档栏注入失败：未找到标签列表容器');
        return false;
    }

    const section = document.createElement('div');
    section.setAttribute('class', 'plugin-archive-section');
    section.style.cssText = `
        border-top: 1px solid var(--b3-theme-surface-light);
        padding-top: 2px;
        flex-shrink: 0;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        min-height: 60px;
        max-height: 60vh;
        background: var(--b3-theme-surface);
        transition: outline 0.15s, background 0.15s;
    `;

    // ★ 拖动归档：接受从主标签栏拖入的标签
    section.addEventListener('dragover', (e) => {
        const hasTag = draggingTag || (e.dataTransfer?.types || []).includes('text/plain');
        if (!hasTag) return;
        e.preventDefault();
        if (e.dataTransfer) {
            e.dataTransfer.dropEffect = 'move';
        }
        section.style.outline = '2px solid var(--b3-theme-primary)';
        section.style.outlineOffset = '-2px';
        section.style.background = 'var(--b3-theme-primary-lightest, rgba(0,0,0,0.05))';
    });
    section.addEventListener('dragleave', () => {
        section.style.outline = '';
        section.style.outlineOffset = '';
        section.style.background = '';
    });
    section.addEventListener('drop', (e) => {
        e.preventDefault();
        section.style.outline = '';
        section.style.outlineOffset = '';
        section.style.background = '';
        const tag = draggingTag || (e.dataTransfer?.getData('text/plain') || '');
        if (tag) {
            console.log('📥 拖入归档栏:', tag);
            archiveTag(tag);
        }
    });

    const divider = document.createElement('div');
    divider.setAttribute('class', 'plugin-archive-divider');
    divider.style.cssText = `
        height: 3px;
        cursor: ns-resize;
        background: var(--b3-theme-surface-light);
        border-radius: 2px;
        margin: 0 8px 1px 8px;
        opacity: 0.3;
        transition: opacity 0.2s;
        flex-shrink: 0;
    `;

    let isDragging = false;
    let startY = 0;
    let startH = 0;

    const startDrag = (e: MouseEvent) => {
        if (archiveCollapsed) return;
        isDragging = true;
        startY = e.clientY;
        startH = section.offsetHeight;
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        e.preventDefault();
    };

    divider.addEventListener('mousedown', startDrag);
    divider.addEventListener('mouseenter', () => {
        if (!archiveCollapsed) divider.style.opacity = '0.7';
    });
    divider.addEventListener('mouseleave', () => {
        if (!archiveCollapsed) divider.style.opacity = '0.3';
    });

    function onMove(ev: MouseEvent) {
        if (!isDragging) return;
        const h = startH + (startY - ev.clientY);
        const maxH = window.innerHeight * 0.6;
        if (h > 60 && h < maxH) {
            section.style.height = h + 'px';
            section.style.minHeight = h + 'px';
        }
    }

    function onUp() {
        isDragging = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
    }

    const header = document.createElement('div');
    header.setAttribute('class', 'plugin-archive-header');
    header.style.cssText = `
        display: flex;
        align-items: center;
        cursor: default;
        font-size: 12px;
        padding: 1px 8px 3px 8px;
        color: var(--b3-theme-on-surface);
        background: var(--b3-theme-surface);
        opacity: 0.7;
        user-select: none;
        gap: 4px;
        flex-shrink: 0;
    `;

    const titleClick = document.createElement('span');
    titleClick.style.cssText = 'display:flex;align-items:center;gap:4px;cursor:pointer;flex:1;';
    titleClick.addEventListener('click', toggleArchive);

    const arrow = document.createElement('span');
    arrow.setAttribute('class', 'plugin-archive-arrow');
    arrow.style.cssText = `
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
    `;
    arrow.innerHTML = archiveCollapsed
        ? `<svg class="b3-list-item__arrow" style="width:12px;height:12px;"><use xlink:href="#iconRight"></use></svg>`
        : `<svg class="b3-list-item__arrow b3-list-item__arrow--open" style="width:12px;height:12px;"><use xlink:href="#iconRight"></use></svg>`;

    const titleText = document.createElement('span');
    titleText.textContent = '归档';
    titleText.style.cssText = 'font-size:12px;';

    const count = document.createElement('span');
    count.setAttribute('class', 'plugin-archive-count');
    count.textContent = `(${archivedTags.length})`;
    count.style.cssText = 'font-size:11px;opacity:0.5;margin-left:4px;';

    titleClick.appendChild(arrow);
    titleClick.appendChild(titleText);
    titleClick.appendChild(count);

    header.appendChild(titleClick);

    // ★ 全部展开 / 全部折叠按钮（效仿标签栏顶栏 #iconExpand / #iconContract）
    const expandAllBtn = document.createElement('span');
    expandAllBtn.className = 'block__icon ariaLabel';
    expandAllBtn.setAttribute('data-position', 'north');
    expandAllBtn.setAttribute('aria-label', '全部展开');
    expandAllBtn.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:2px 4px;border-radius:3px;opacity:0.5;flex-shrink:0;';
    expandAllBtn.innerHTML = `<svg style="width:14px;height:14px;"><use href="#iconExpand"/></svg>`;
    expandAllBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        expandAllArchived();
    });
    header.appendChild(expandAllBtn);

    const collapseAllBtn = document.createElement('span');
    collapseAllBtn.className = 'block__icon ariaLabel';
    collapseAllBtn.setAttribute('data-position', 'north');
    collapseAllBtn.setAttribute('aria-label', '全部折叠');
    collapseAllBtn.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:2px 4px;border-radius:3px;opacity:0.5;flex-shrink:0;';
    collapseAllBtn.innerHTML = `<svg style="width:14px;height:14px;"><use href="#iconContract"/></svg>`;
    collapseAllBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        collapseAllArchived();
    });
    header.appendChild(collapseAllBtn);

    const list = document.createElement('ul');
    list.setAttribute('class', 'b3-list b3-list--background plugin-archive-list');
    list.style.cssText = `
        overflow-y: auto;
        flex: 1;
        min-height: 30px;
        max-height: 300px;
        padding: 0;
        margin: 0 0 2px 0;
        list-style: none;
        background: var(--b3-theme-surface);
        display: ${archiveCollapsed ? 'none' : ''};
    `;

    section.appendChild(divider);
    section.appendChild(header);
    section.appendChild(list);

    // 插入位置：如果锚点是列容器则追加到列末尾，否则插入到锚点之后
    if (anchor.classList.contains('fn__flex-column')) {
        anchor.appendChild(section);
    } else {
        anchor.parentNode?.insertBefore(section, anchor.nextSibling);
    }

    renderArchiveList();
    console.log('📌 归档栏已注入');
    return true;
}

// --- 右键菜单 ---

function patchMenu() {
    menuObserver = new MutationObserver(() => {
        const menu = document.getElementById('commonMenu') as HTMLElement;
        if (!menu) return;
        if (menu.dataset.name !== 'tagMenu') return;
        if (menu.querySelector('.plugin-archive-menu-item')) return;

        const items = menu.querySelector('.b3-menu__items') as HTMLElement;
        if (!items) return;

        const btn = document.createElement('button');
        btn.setAttribute('class', 'b3-menu__item plugin-archive-menu-item');
        btn.innerHTML = `
            <svg class="b3-menu__icon"><use href="#iconFolder"/></svg>
            <span class="b3-menu__label">归档</span>
        `;

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const tagPath = getRightClickedTag();
            if (tagPath) {
                archiveTag(tagPath);
            }
            const escEvent = new KeyboardEvent('keydown', {
                key: 'Escape',
                code: 'Escape',
                keyCode: 27,
                which: 27,
                bubbles: true,
                cancelable: true
            });
            document.dispatchEvent(escEvent);
        });

        const rename = items.querySelector('.b3-menu__item--current') as HTMLElement;
        if (rename) {
            items.insertBefore(btn, rename.nextSibling);
        } else {
            items.appendChild(btn);
        }
    });

    menuObserver.observe(document.body, { childList: true, subtree: true });
}

// ============================================================
// 插件生命周期
// ============================================================

// 归档栏守护：轮询 + 全局观察，保证标签面板任何时候（启动、切面板、睡眠唤醒、DOM 重建）出现后都能恢复
let archiveGuardTimer: ReturnType<typeof setInterval> | null = null;
let menuObserver: MutationObserver | null = null;
let tagPanelObserver: MutationObserver | null = null;
let bodyObserver: MutationObserver | null = null;
let ensureTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleEnsure(delay = 150) {
    if (ensureTimer !== null) {
        clearTimeout(ensureTimer);
    }
    ensureTimer = setTimeout(() => {
        ensureTimer = null;
        ensureArchiveUI();
    }, delay);
}

function ensureArchiveUI() {
    const panel = document.querySelector('.dockPanel.sy__tag') as HTMLElement;
    if (!panel) return;

    // 数据未加载时先尝试补加载
    if (!dataLoaded) {
        if (loadData()) {
            console.log('📌 数据已补加载');
        }
    }

    // ★ 检测全局标签排序模式是否变化，变化则重渲染（跟随标签栏排序设置）
    const mode = getTagSortMode();
    if (lastTagSortMode === null) {
        lastTagSortMode = mode;
    } else if (lastTagSortMode !== mode) {
        lastTagSortMode = mode;
        const section = panel.querySelector('.plugin-archive-section') as HTMLElement;
        if (section) {
            renderArchiveList();
        }
    }

    // 确保主标签栏标签项可拖拽（不改变思源原有拖拽行为）
    const tagItems = panel.querySelectorAll('.b3-list-item[data-treetype="tag"]');
    for (const el of tagItems) {
        if (!el.hasAttribute('draggable')) {
            el.setAttribute('draggable', 'true');
        }
    }

    // 面板被重建/重渲染时归档 section 会丢失，检测到就重新注入
    const section = panel.querySelector('.plugin-archive-section') as HTMLElement;
    if (!section) {
        injectArchiveUI();
    }

    hideAllArchived();
}

/**
 * 全局监听 body 的 DOM 变化：
 * - 标签面板被创建/销毁（点击 dock 图标时懒加载）
 * - 面板重渲染导致归档栏被移除
 * 触发后**同步**（微任务，浏览器绘制前）隐藏归档标签 → 打开面板不闪烁；
 * 面板子项可能是分批渲染的，延迟再补一次。
 */
function setupBodyObserver() {
    bodyObserver = new MutationObserver((mutations) => {
        let tagTouched = false;
        for (const mutation of mutations) {
            if (mutation.type !== 'childList') continue;
            for (const node of mutation.addedNodes) {
                if (!(node instanceof HTMLElement)) continue;
                // 面板节点本身 / 面板内出现 / 面板内新增标签项 / 归档栏被移除
                if (node.classList.contains('sy__tag')
                    || node.querySelector?.('.dockPanel.sy__tag')
                    || (node.classList.contains('dockPanel') && node.querySelector?.('.sy__tag'))
                    || node.querySelector?.('.plugin-archive-section')
                    || node.querySelector?.('.b3-list-item[data-treetype="tag"]')) {
                    tagTouched = true;
                }
            }
        }
        if (tagTouched) {
            // 同步执行（绘制前），无闪烁
            ensureArchiveUI();
            // 面板子项可能分批渲染，补一次
            scheduleEnsure(80);
        }
    });
    bodyObserver.observe(document.body, { childList: true, subtree: true });
}

export function init(plugin: Plugin) {
    pluginInstance = plugin;
    setupContextMenuFocus();
    setupTagDrag();
    setupTagComplete();

    // ★ 监听三个点按钮点击，焦点移动到对应标签
    document.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const actionBtn = target.closest('.b3-list-item__action');
        if (actionBtn) {
            const tagItem = actionBtn.closest('.b3-list-item[data-treetype="tag"]');
            if (tagItem) {
                document.querySelectorAll('.b3-list-item--focus[data-treetype="tag"]').forEach(el => {
                    el.classList.remove('b3-list-item--focus');
                });
                tagItem.classList.add('b3-list-item--focus');
                console.log('🖱️ 点击三个点，焦点移动到:', (tagItem as HTMLElement).dataset.label);
            }
        }
    }, true);

    // ★ 路径初始化：config.system 是内核推送的同步字段，最可靠；失败再用 API 兜底
    const syncWs = getWorkspaceFromConfig();
    if (syncWs) {
        workspacePath = syncWs;
        loadData();
    } else {
        console.warn('⚠️ config.system 未获取到工作空间，尝试异步 API...');
        getWorkspaceFromSystemInfo().then((ws) => {
            if (ws) {
                workspacePath = ws;
                if (!dataLoaded) {
                    loadData();
                }
                ensureArchiveUI();
            } else {
                console.error('❌ 无法获取工作空间路径，归档数据将无法读写');
            }
        });
    }

    // ★ 立即尝试注入 + 全局观察 + 每秒轮询（轮询内会补加载数据）
    ensureArchiveUI();
    setupBodyObserver();
    if (archiveGuardTimer !== null) {
        clearInterval(archiveGuardTimer);
    }
    archiveGuardTimer = setInterval(ensureArchiveUI, 1000);

    // ★ 加载标签引用计数（从主标签栏 DOM 读取 .counter，最可靠）
    setTimeout(() => {
        refreshTagCounts();
        refreshCompleteTags();
    }, 500);

    patchMenu();

    const panel = document.querySelector('.dockPanel.sy__tag') as HTMLElement;
    if (panel) {
        tagPanelObserver = new MutationObserver(() => {
            hideAllArchived();
        });
        tagPanelObserver.observe(panel, { childList: true, subtree: true });
    }
}

export function destroy() {
    // 清理标签补全
    destroyTagComplete();

    // 停止轮询、延迟任务与所有观察器
    if (archiveGuardTimer !== null) {
        clearInterval(archiveGuardTimer);
        archiveGuardTimer = null;
    }
    if (ensureTimer !== null) {
        clearTimeout(ensureTimer);
        ensureTimer = null;
    }
    if (menuObserver !== null) {
        menuObserver.disconnect();
        menuObserver = null;
    }
    if (tagPanelObserver !== null) {
        tagPanelObserver.disconnect();
        tagPanelObserver = null;
    }
    if (bodyObserver !== null) {
        bodyObserver.disconnect();
        bodyObserver = null;
    }

    const section = document.querySelector('.plugin-archive-section') as HTMLElement;
    if (section) section.remove();

    showAllTags();

    pluginInstance = null;
}
