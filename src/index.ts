import {
  Plugin,
  getFrontend,
  showMessage,
  confirm,
} from "siyuan";
import * as siyuan from "siyuan";
import "@/index.scss";
import PluginInfoString from '@/../plugin.json'
import { destroy, init } from '@/main'
import { setupListChildDocs, destroyListChildDocs } from '@/listChildDocs'
import { setupDocLock, destroyDocLock, scanAllLocks } from '@/docLock'
import { setupDocTreeLock, destroyDocTreeLock } from '@/docTreeLock'

let PluginInfo = {
  version: '',
}
try {
  PluginInfo = PluginInfoString
} catch (err) {
  console.warn('Plugin info parse error: ', err)
}
const {
  version,
} = PluginInfo

// ============================================================
// 设置
// ============================================================

const SETTINGS_KEY = 'settings'

interface PluginSettings {
  /** 文档树显示已锁定文档 */
  showLockedDocs: boolean
  /** 非当天日记自动锁定 */
  lockNonTodayDaily: boolean
  /** 父级空白文档自动列出子文档（需挂件「列出子文档」） */
  listChildDocsInEmptyParent: boolean
  /** 父级空白文档自动锁定（独立功能，天然覆盖年、月文档） */
  lockEmptyParentDoc: boolean
}

const DEFAULT_SETTINGS: PluginSettings = {
  showLockedDocs: false,
  lockNonTodayDaily: false,
  listChildDocsInEmptyParent: false,
  lockEmptyParentDoc: false,
}

export default class PluginSample extends Plugin {
  // Run as mobile
  public isMobile: boolean
  // Run in browser
  public isBrowser: boolean
  // Run as local
  public isLocal: boolean
  // Run in Electron
  public isElectron: boolean
  // Run in window
  public isInWindow: boolean
  public platform: SyFrontendTypes
  public readonly version = version

  // 插件设置（后续功能实现时从此读取）
  public settings: PluginSettings = { ...DEFAULT_SETTINGS }

  async onload() {
    const frontEnd = getFrontend();
    this.platform = frontEnd as SyFrontendTypes
    this.isMobile = frontEnd === "mobile" || frontEnd === "browser-mobile"
    this.isBrowser = frontEnd.includes('browser')
    this.isLocal =
      location.href.includes('127.0.0.1')
      || location.href.includes('localhost')
    this.isInWindow = location.href.includes('window.html')

    try {
      require("@electron/remote")
        .require("@electron/remote/main")
      this.isElectron = true
    } catch (err) {
      this.isElectron = false
    }

    // ★ 加载设置
    try {
      const saved = await this.loadData(SETTINGS_KEY)
      if (saved && typeof saved === 'object') {
        this.settings = { ...DEFAULT_SETTINGS, ...saved }
      }
      // 兼容旧设置：移除已废弃的 lockDailyYearMonthDay 字段（清理残留）
      delete (this.settings as any).lockDailyYearMonthDay
    } catch (err) {
      console.warn('⚠️ 加载设置失败:', err)
    }

    // ★ 创建设置面板
    this.initSetting()

    init(this)

    // ★ 启动各功能（由各自开关控制）
    setupDocLock(this)
    setupListChildDocs(this)
    setupDocTreeLock(this)
  }

  onunload() {
    destroyListChildDocs()
    destroyDocLock()
    destroyDocTreeLock()
    destroy()
  }

  /**
   * 创建设置面板。
   * 分组：
   *   - 锁定管理：文档树显示已锁定文档 / 非当天日记自动锁定 / 父级空白文档自动锁定 + 全库扫描按钮
   *   - 列出子文档：父级空白文档自动列出子文档
   * 生效时机：
   *   - 点「保存」→ 保存并生效
   *   - 点「取消」→ 回滚到更改前，直接关闭不弹框
   *   - 点框外关闭，且有未保存更改 → 弹确认框（保留设置窗口）：
   *     「是」→ 保存生效；「否」→ 回滚到更改前显示并关闭
   *   - 「全库扫描」按钮 → 只对锁定管理已开启的功能执行全库扫描；
   *     若点击时已有未保存更改，先弹「是否保存」确认再扫描；
   *     扫描本身不算设置变更、不触发保存
   */
  private initSetting() {
    const Setting = (siyuan as any).Setting
    if (!Setting) {
      console.warn('⚠️ 当前环境不支持 Setting API，跳过设置面板创建')
      return
    }

    // 分组开关行定义
    type ItemDef = { key: keyof PluginSettings; title: string; description?: string }
    // 锁定管理分组
    const lockItems: ItemDef[] = [
      { key: 'showLockedDocs', title: '文档树显示已锁定文档' },
      { key: 'lockNonTodayDaily', title: '非当天日记自动锁定', description: '打开文档时生效' },
      { key: 'lockEmptyParentDoc', title: '父级空白文档自动锁定', description: '打开文档时生效' },
    ]
    // 列出子文档分组
    const widgetItems: ItemDef[] = [
      { key: 'listChildDocsInEmptyParent', title: '父级空白文档自动列出子文档', description: '打开文档时生效，需要安装挂件「列出子文档」' },
    ]
    // 所有行（回滚时遍历）
    const allItems: ItemDef[] = [...lockItems, ...widgetItems]

    // 各行 label 引用
    const rowEls = new Map<keyof PluginSettings, HTMLElement>()

    // 记录面板打开时的已保存设置（用于回滚）
    let savedSnapshot: PluginSettings = { ...this.settings }
    // 是否有未保存的更改
    let dirty = false

    // 保存并生效
    const applyAndSave = () => {
      this.saveData(SETTINGS_KEY, this.settings).catch((e: any) => {
        showMessage(`保存设置失败: ${e}`, 5000, 'error')
      })
      // 重新初始化各功能（读取最新设置）
      destroyListChildDocs()
      destroyDocLock()
      destroyDocTreeLock()
      setupDocLock(this)
      setupListChildDocs(this)
      setupDocTreeLock(this)
      savedSnapshot = { ...this.settings }
      dirty = false
    }

    // 回滚到更改前（设置内存 + 界面显示）
    const rollback = () => {
      this.settings = { ...savedSnapshot }
      for (const item of allItems) {
        const row = rowEls.get(item.key)
        const input = row?.querySelector('input') as HTMLInputElement | null
        if (input) {
          input.checked = !!this.settings[item.key]
        }
      }
      dirty = false
    }

    // 将回滚函数挂到实例，供 openSetting 的取消按钮调用
    ;(this as any)._settingRollback = rollback

    this.setting = new Setting({
      confirmCallback: () => {
        // 点「保存」：保存并生效（标记为按钮关闭，销毁时不弹框）
        ;(this as any)._settingClosedByButton = true
        applyAndSave()
      },
      destroyCallback: () => {
        // 若通过「保存」关闭，直接返回不弹框
        if ((this as any)._settingClosedByButton) {
          ;(this as any)._settingClosedByButton = false
          return
        }
        // 若通过「取消」按钮关闭：回滚到更改前，不弹框
        if ((this as any)._settingCancelClicked) {
          ;(this as any)._settingCancelClicked = false
          rollback()
          return
        }
        // 点框外关闭：若有未保存更改，弹确认框
        if (dirty) {
          confirm('⚠️', '设置已更改，是否保存？', () => {
            // 是 → 保存生效
            applyAndSave()
          }, () => {
            // 否 → 回滚
            rollback()
          })
        }
      },
    })

    // 创建分组容器（带边框 + 灰色背景）
    const createGroup = (): { wrap: HTMLElement; group: HTMLElement } => {
      const wrap = document.createElement('div')
      wrap.className = 'fn__block'
      const group = document.createElement('div')
      group.style.cssText = `
          border: 1px solid var(--b3-border-color);
          background: var(--b3-theme-surface-light);
          border-radius: var(--b3-border-radius);
          padding: 8px 12px;
          box-sizing: border-box;
      `
      wrap.appendChild(group)
      return { wrap, group }
    }

    // 渲染一组开关行
    const renderItems = (groupItems: ItemDef[], group: HTMLElement) => {
      groupItems.forEach((item) => {
        // 外层行容器：控制垂直间距
        const row = document.createElement('div')
        row.style.cssText = `padding: 5px 0; box-sizing: border-box;`
        group.appendChild(row)
        rowEls.set(item.key, row)

        // 内层 label：flex 水平布局，标题 + 弹性空白 + 开关
        const label = document.createElement('label')
        label.style.cssText = `
            display: flex;
            align-items: center;
            cursor: pointer;
            margin: 0;
            padding: 0;
            box-sizing: border-box;
            min-height: 0;
        `
        row.appendChild(label)

        const titleBlock = document.createElement('div')
        titleBlock.style.cssText = 'flex: 1 1 auto; min-width: 0;'
        const nameDiv = document.createElement('div')
        nameDiv.style.cssText = 'margin: 0; color: var(--b3-theme-on-surface); font-size: 14px; line-height: 1.5;'
        nameDiv.textContent = item.title
        titleBlock.appendChild(nameDiv)
        if (item.description) {
          const descDiv = document.createElement('div')
          descDiv.style.cssText = 'margin: 1px 0 0 0; font-size: 12px; opacity: 0.6; color: var(--b3-theme-on-surface);'
          descDiv.textContent = item.description
          titleBlock.appendChild(descDiv)
        }
        label.appendChild(titleBlock)

        // 弹性空白：把开关推到右侧（内联，不依赖 fn__space 类）
        const spacer = document.createElement('span')
        spacer.style.cssText = 'flex: 1 1 auto;'
        label.appendChild(spacer)

        const input = document.createElement('input')
        input.type = 'checkbox'
        input.className = 'b3-switch fn__flex-center'
        input.style.cssText = 'flex-shrink: 0; margin-left: 8px;'
        input.checked = !!this.settings[item.key]
        input.addEventListener('change', () => {
          // 只更新内存中的设置
          this.settings[item.key] = input.checked
          dirty = true
        })
        label.appendChild(input)
      })
    }

    // ★ 分组 1：锁定管理（含全库扫描按钮）
    this.setting.addItem({
      title: '<strong>锁定管理</strong>',
      direction: 'row',
      createActionElement: () => {
        const { wrap, group } = createGroup()
        renderItems(lockItems, group)

        // 全库扫描按钮：只对锁定管理已开启的功能生效
        const hr = document.createElement('div')
        hr.style.cssText = 'border-top: 1px solid var(--b3-border-color); margin: 6px 0;'
        group.appendChild(hr)

        const scanRow = document.createElement('div')
        scanRow.style.cssText = 'padding: 6px 0; box-sizing: border-box; display: flex; align-items: center; gap: 8px;'
        group.appendChild(scanRow)

        const scanLabel = document.createElement('div')
        scanLabel.style.cssText = 'flex: 1 1 auto; color: var(--b3-theme-on-surface); font-size: 13px; line-height: 1.5;'
        scanLabel.textContent = '全库扫描'
        scanRow.appendChild(scanLabel)

        const scanDesc = document.createElement('div')
        scanDesc.style.cssText = 'font-size: 11px; opacity: 0.5;'
        scanDesc.textContent = '对全部文档进行扫描，应用以上已开启的锁定功能'
        scanLabel.appendChild(scanDesc)

        const scanBtn = document.createElement('button')
        scanBtn.className = 'b3-button b3-button--outline fn__flex-center'
        scanBtn.style.cssText = 'flex-shrink: 0; font-size: 12px; padding: 4px 12px; cursor: pointer;'
        scanBtn.textContent = '扫描'
        scanBtn.addEventListener('click', () => {
          // 扫描执行体
          const doScan = async () => {
            scanBtn.disabled = true
            scanBtn.textContent = '扫描中...'
            try {
              // 只扫描锁定功能（传入当前设置）
              const lockCount = await scanAllLocks(this.settings)
              showMessage(lockCount > 0 ? `全库扫描完成：锁定 ${lockCount} 个` : '全库扫描完成，无变更', 3000)
            } catch (e: any) {
              showMessage(`全库扫描失败: ${e}`, 5000, 'error')
            } finally {
              scanBtn.disabled = false
              scanBtn.textContent = '扫描'
            }
          }
          // 若已有未保存更改，先弹「是否保存」确认再扫描
          if (dirty) {
            confirm('⚠️', '设置已更改，是否保存？', () => {
              // 是 → 保存生效后再扫描
              applyAndSave()
              doScan()
            }, () => {
              // 否 → 回滚到更改前再扫描
              rollback()
              doScan()
            })
          } else {
            doScan()
          }
        })
        scanRow.appendChild(scanBtn)

        return wrap
      },
    })

    // ★ 分组 2：列出子文档
    this.setting.addItem({
      title: '<strong>列出子文档</strong>',
      direction: 'row',
      createActionElement: () => {
        const { wrap, group } = createGroup()
        renderItems(widgetItems, group)
        return wrap
      },
    })
  }

  /**
   * 覆盖基类 openSetting：打开设置面板后，
   * 给「取消」按钮补监听，置标志 + 触发回滚，
   * 使 destroyCallback 能区分「取消按钮关闭」「保存关闭」「框外关闭」。
   */
  openSetting() {
    if (!this.setting) return
    this.setting.open(this.displayName || this.name)
    // 给取消按钮补监听：点取消 = 回滚 + 关闭（不弹确认框）
    const dialog = (this.setting as any).dialog
    if (dialog) {
      const cancelBtn = dialog.element.querySelector('.b3-dialog__action .b3-button--cancel')
      if (cancelBtn) {
        cancelBtn.addEventListener('click', () => {
          ;(this as any)._settingCancelClicked = true
        })
      }
    }
  }
}
