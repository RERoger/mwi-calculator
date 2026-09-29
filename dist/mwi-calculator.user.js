// ==UserScript==
// @name         [银河奶牛]生产制作计算器
// @version      0.1.1
// @namespace    http://tampermonkey.net/
// @description  银河奶牛计算器，自动计算需求缺口，一键跳转到制作、购买。Calculator for MilkyWayIdle，Automatically calculate supply-demand gaps and navigate to production or purchasing with a single click.
// @author       RERoger
// @match        https://www.milkywayidle.com/*
// @match        https://test.milkywayidle.com/*
// @match        https://www.milkywayidlecn.com/*
// @match        https://test.milkywayidlecn.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=milkywayidle.com
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-body
// @license      MIT
// @require      https://cdn.jsdelivr.net/npm/lz-string@1.5.0/libs/lz-string.min.js

// @downloadURL https://raw.githubusercontent.com/RERoger/mwi-calculator/main/dist/mwi-calculator.user.js
// @updateURL https://raw.githubusercontent.com/RERoger/mwi-calculator/main/dist/mwi-calculator.meta.js
// @homepageURL https://github.com/RERoger/mwi-calculator
// @supportURL https://github.com/RERoger/mwi-calculator/issues
// ==/UserScript==
(function () {
    'use strict';
    //#region UI theme / state / components
    // 颜色唯一入口：布局样式、状态判断、业务数据分别管理。
    const MWI_Calculator_UITheme = Object.freeze({
        surface: '#2c2e45',          // 默认列表、已完成条目：44,46,69
        heading: '#393a5b',          // 已完成标题：57,58,91
        activeHeading: '#147147',    // 已启用、未全部完成标题：20,113,71
        pending: '#0E4F32',          // 有效且未完成条目：14,79,50
        disabledSurface: '#636363',  // 未勾选/零目标/分类禁用：99,99,99
        disabledHeading: '#969696',  // 未勾选标题：150,150,150
        danger: '#eb3f3f',
        onAction: '#FFFFFF'
    });
    const MWI_Calculator_UIStyles = Object.freeze({
        // 房屋等级、大类数量与目标条目数量统一宽度，避免 flex 挤压造成不一致。
        quantityInput: Object.freeze({ width: '60px', flex: '0 0 60px' }),
        // 公用物品行：上下无外边距、无圆角，背景连续；保留左右及行内留白。
        itemRow: Object.freeze({ border: 'none', borderRadius: '0', padding: '1px',
            margin: '0 2px', display: 'flex', alignItems: 'center' }),
        category: Object.freeze({ background: MWI_Calculator_UITheme.surface,
            borderRadius: '4px', margin: '2px 0px', padding: '2px 0px' }),
        summary: Object.freeze({ background: MWI_Calculator_UITheme.heading,
            borderRadius: '4px', fontSize: '14px', padding: '2px 6px',
            textAlign: 'left', cursor: 'pointer' }),
        summaryWithAction: Object.freeze({ position: 'relative', paddingRight: '4em', minHeight: '28px' }),
        dangerButton: Object.freeze({ background: MWI_Calculator_UITheme.danger,
            border: 'none', borderRadius: '4px', padding: '4px', margin: '2px', cursor: 'pointer' }),
        // 标题专用紧凑按钮：覆盖通用按钮尺寸，不影响全局清空和单条删除。
        cornerAction: Object.freeze({ position: 'absolute', top: '50%', right: '2px', transform: 'translateY(-50%)',
            whiteSpace: 'nowrap', boxSizing: 'border-box', height: '20px',
            maxHeight: 'calc(100% - 4px)', minHeight: '0', padding: '0 5px',
            margin: '0', fontSize: '12px', lineHeight: '16px',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' })
    });
    class MWI_Calculator_UI {
        // 仅目标行使用此布局：名称先收缩，操作区不参与 flex 压缩。
        static attachTargetLayout(row, nameGroup, controls, owned, input, removeButton) {
            row.classList.add('mwi-target-row');
            nameGroup.classList.add('mwi-target-name');
            nameGroup.querySelector('span')?.classList.add('mwi-target-label');
            controls.classList.add('mwi-target-controls');
            owned.classList.add('mwi-target-owned');
            input.classList.add('mwi-target-input');
            removeButton.classList.add('mwi-target-remove');
            this.targetLayouts ||= new WeakMap();
            this.targetLayouts.set(row, { controls, input, checkbox: row.querySelector('input[type="checkbox"]') });
            if (!this.targetLayoutObserver && typeof ResizeObserver !== 'undefined') {
                this.targetLayoutObserver = new ResizeObserver(entries => {
                    for (const entry of entries) this.scheduleTargetLayout(entry.target);
                });
            }
            this.targetLayoutObserver?.observe(row);
            this.scheduleTargetLayout(row);
        }
        static scheduleTargetLayout(row) {
            if (!row || !this.targetLayouts?.has(row)) return;
            this.pendingTargetLayouts ||= new Set();
            this.pendingTargetLayouts.add(row);
            if (this.targetLayoutFrame) return;
            this.targetLayoutFrame = requestAnimationFrame(() => {
                this.targetLayoutFrame = null;
                const rows = [...this.pendingTargetLayouts];
                this.pendingTargetLayouts.clear();
                for (const element of rows) if (element.isConnected) this.fitTargetLayout(element);
            });
        }
        static fitTargetLayout(row) {
            const layout = this.targetLayouts?.get(row);
            if (!layout || row.clientWidth === 0) return; // 折叠状态等待 ResizeObserver 重新触发。
            const outerWidth = element => {
                if (!element) return 0;
                const style = getComputedStyle(element);
                return element.getBoundingClientRect().width + (parseFloat(style.marginLeft) || 0) + (parseFloat(style.marginRight) || 0);
            };
            const style = getComputedStyle(row);
            const available = row.clientWidth - (parseFloat(style.paddingLeft) || 0)
                - (parseFloat(style.paddingRight) || 0) - outerWidth(layout.checkbox);
            this.targetTextCanvas ||= document.createElement('canvas');
            const context = this.targetTextCanvas.getContext('2d');
            const fits = () => {
                const inputStyle = getComputedStyle(layout.input);
                if (context) context.font = inputStyle.font;
                const textWidth = context ? context.measureText(layout.input.value || layout.input.placeholder).width : 0;
                const inputSpace = layout.input.clientWidth - (parseFloat(inputStyle.paddingLeft) || 0) - (parseFloat(inputStyle.paddingRight) || 0);
                return outerWidth(layout.controls) <= available + 0.5 && textWidth <= inputSpace + 0.5;
            };
            // 先允许名称缩至零，再缩字号；不会缩小60px输入框和26px删除按钮。
            for (let size = 14; size >= 8; size--) {
                row.style.setProperty('--mwi-target-font-size', size + 'px');
                if (fits()) break;
            }
            // 极端窄屏保留横向访问，不以隐藏数量/按钮换取表面上的“适配”。
            const overflow = outerWidth(layout.controls) > available + 0.5;
            if (row.style.overflowX !== (overflow ? 'auto' : '')) row.style.overflowX = overflow ? 'auto' : '';
        }
        static detachTargetLayout(row) {
            if (!row) return;
            this.targetLayoutObserver?.unobserve(row);
            this.targetLayouts?.delete(row);
            this.pendingTargetLayouts?.delete(row);
        }
        // 状态函数只读取数据，不修改勾选值、库存、目标数量或 DOM。
        static getTargetState(item, categoryEnabled = true) {
            if (!item.needCalc || !categoryEnabled || item.count <= 0) return 'inactive';
            return item.getOwnedCount() < item.count ? 'pending' : 'completed';
        }
        static getCategoryState(category, items) {
            if (!category.needCalc) return 'inactive';
            let hasActiveTarget = false;
            for (const item of items) {
                if (item.categoryHrid !== category.categoryHrid || !item.needCalc || !(item.count > 0)) continue;
                hasActiveTarget = true;
                if (!(item.getOwnedCount() >= item.count)) return 'pending';
            }
            // 空分类、全未勾选或全零目标均不判定为“全部完成”。
            return hasActiveTarget ? 'completed' : 'pending';
        }
        static renderTargetState(element, state) {
            const colors = MWI_Calculator_UITheme;
            element.style.background = state === 'inactive' ? colors.disabledSurface
                : state === 'pending' ? colors.pending : colors.surface;
        }
        static renderCategoryState(details, summary, state) {
            const colors = MWI_Calculator_UITheme;
            details.style.background = state === 'inactive' ? colors.disabledSurface : colors.surface;
            summary.style.background = state === 'inactive' ? colors.disabledHeading
                : state === 'pending' ? colors.activeHeading : colors.heading;
        }
        static styleDangerButton(button, hasText = false) {
            button.type = 'button';
            Object.assign(button.style, MWI_Calculator_UIStyles.dangerButton);
            if (hasText) button.style.color = MWI_Calculator_UITheme.onAction;
        }
        // 分类组件负责 DOM、布局和交互隔离，调用方只传标题与业务回调。
        static createCategory(name, onToggle, onClear = null) {
            const details = document.createElement('details');
            Object.assign(details.style, MWI_Calculator_UIStyles.category);
            details.open = true;
            details.addEventListener('toggle', onToggle);
            const summary = document.createElement('summary');
            summary.textContent = name;
            Object.assign(summary.style, MWI_Calculator_UIStyles.summary);
            if (onClear) {
                Object.assign(summary.style, MWI_Calculator_UIStyles.summaryWithAction);
                const button = document.createElement('button');
                button.className = 'mwi-calculator-remove-category';
                button.textContent = '清空';
                button.title = `清空“${name}”中的所有目标（含未勾选项）`;
                button.setAttribute('aria-label', button.title);
                this.styleDangerButton(button, true);
                Object.assign(button.style, MWI_Calculator_UIStyles.cornerAction);
                button.addEventListener('click', event => {
                    event.preventDefault();
                    event.stopPropagation();
                    onClear();
                });
                summary.appendChild(button);
            }
            details.appendChild(summary);
            return { details, summary };
        }
    }
    //#endregion
    //#region Calculator
    class TargetItemCategory {
        constructor(categoryHrid, needCalc = true) {
            this.needCalc = true;
            this.categoryDetailsElement = null;
            this.categorySummaryElement = null;
            this.needCalcCheckbox = null;
            this.categoryHrid = categoryHrid;
            this.needCalc = needCalc;
        }
        updateDisplayElement() {
            const state = MWI_Calculator_UI.getCategoryState(this, MWI_Calculator_Calculator.targetItemsMap.values());
            MWI_Calculator_UI.renderCategoryState(this.categoryDetailsElement, this.categorySummaryElement, state);
            this.needCalcCheckbox.checked = this.needCalc;
        }
    }
    class DisplayItem {
        constructor(itemHrid, count) {
            this.itemHrid = itemHrid;
            this.count = count;
            this.initDisplayProperties();
        }
        initDisplayProperties() {
            if ([...MWI_Calculator_ActionDetailPlus.processableItemMap.values()].includes(this.itemHrid)) {
                this.categoryHrid = '/item_categories/materials';
            }
            else if (this.itemHrid.endsWith('_tea')) {
                this.categoryHrid = '/item_categories/tea';
            }
            else if (this.itemHrid.endsWith('_coffee')) {
                this.categoryHrid = '/item_categories/coffee';
            }
            else {
                this.categoryHrid = MWI_Calculator.initClientData?.itemDetailMap?.[this.itemHrid].categoryHrid;
            }
            this.displayName = MWI_Calculator_I18n.getItemName(this.itemHrid);
            this.iconHref = MWI_Calculator_Utils.getIconHrefByItemHrid(this.itemHrid);
            this.sortIndex = MWI_Calculator_Utils.getSortIndexByItemHrid(this.itemHrid);
        }
        getOwnedCount() {
            return MWI_Calculator_ItemsMap.getCount(this.itemHrid);
        }
    }
    class TargetItem extends DisplayItem {
        constructor(itemHrid, count, needCalc = true) {
            super(itemHrid, count);
            this.needCalc = true;
            this.displayElement = null;
            this.needCalcCheckbox = null;
            this.ownedSpan = null;
            this.targetInput = null;
            this.needCalc = needCalc;
        }
        updateDisplayElement() {
            if (this.needCalcCheckbox) {
                this.needCalcCheckbox.checked = this.needCalc;
                const categoryEnabled = MWI_Calculator_Calculator.targetItemCategoryMap.get(this.categoryHrid)?.needCalc !== false;
                const state = MWI_Calculator_UI.getTargetState(this, categoryEnabled);
                MWI_Calculator_UI.renderTargetState(this.displayElement, state);
            }
            if (this.ownedSpan) {
                const newText = MWI_Calculator_Utils.formatNumber(this.getOwnedCount());
                if (this.ownedSpan.textContent !== newText) {
                    this.ownedSpan.textContent = newText;
                }
            }
            if (this.targetInput) {
                const newText = this.count.toString();
                if (this.targetInput.value.trim() != newText) {
                    this.targetInput.value = newText;
                }
            }
            MWI_Calculator_UI.scheduleTargetLayout(this.displayElement);
        }
        removeDisplayElement() {
            MWI_Calculator_UI.detachTargetLayout(this.displayElement);
            this.displayElement?.remove();
        }
    }
    class TargetHouseRoom extends TargetItem {
        constructor(houseRoomHrid, level, needCalc = true) {
            super(houseRoomHrid, level, needCalc);
        }
        initDisplayProperties() {
            this.categoryHrid = '/item_categories/house_rooms';
            this.displayName = MWI_Calculator_I18n.getName(this.itemHrid, 'houseRoomNames');
            this.iconHref = MWI_Calculator_Utils.getIconHrefByHouseRoomHrid(this.itemHrid);
            this.sortIndex = MWI_Calculator_Utils.getSortIndexByHouseRoomHrid(this.itemHrid);
        }
        getOwnedCount() {
            return MWI_Calculator.gameObject?.state?.characterHouseRoomDict?.[this.itemHrid]?.level || 0;
        }
    }
    class RequiredItem extends DisplayItem {
        constructor(itemHrid, count, shortageCount, overflowCount) {
            super(itemHrid, count);
            this.shortageCount = 0;
            this.overflowCount = 0;
            this.shortageDisplayElement = null;
            this.requiredDisplayElement = null;
            this.shortageSpan = null;
            this.overflowSpan = null;
            this.requiredSpan = null;
            this.displayNameSpan = null;
            this.shortageCount = shortageCount;
            this.overflowCount = overflowCount;
        }
        updateDisplayElement() {
            const netCount = this.shortageCount > 0 ? -this.shortageCount : this.overflowCount;
            if (this.shortageSpan) {
                const newText = MWI_Calculator_Utils.formatNumber(this.shortageCount);
                if (this.shortageSpan.textContent !== newText) {
                    this.shortageSpan.textContent = newText;
                }
                if (this.shortageCount > 0) {
                    let inputShortageCount = 0;
                    MWI_Calculator_ActionDetailPlus.tryGetRecipe(this.itemHrid)?.inputs?.forEach(input => {
                        inputShortageCount += MWI_Calculator_Calculator.requiredItemsMap.get(input.itemHrid)?.shortageCount || 0;
                    });
                    this.shortageDisplayElement.style.background = (inputShortageCount === 0 ? MWI_Calculator_UITheme.activeHeading : '');
                    this.shortageDisplayElement.style.display = 'flex';
                }
                else {
                    this.shortageDisplayElement.style.display = 'none';
                }
            }
            if (this.overflowSpan) {
                const newText = MWI_Calculator_Utils.formatNumber(netCount);
                if (this.overflowSpan.textContent !== newText) {
                    this.overflowSpan.textContent = newText;
                }
                this.overflowSpan.style.color = this.shortageCount > 0 ? MWI_Calculator_UITheme.danger : '';
            }
            if (this.requiredSpan) {
                const newText = MWI_Calculator_Utils.formatNumber(this.count);
                if (this.requiredSpan.textContent !== newText) {
                    this.requiredSpan.textContent = newText;
                }
            }
            if (this.displayNameSpan) {
                this.displayNameSpan.textContent = Math.floor(netCount / this.count * 100) + '%';
                if (netCount < 0) {
                    this.displayNameSpan.style.color = MWI_Calculator_UITheme.danger;
                }
                else if (netCount < this.count) {
                    this.displayNameSpan.style.color = '#faa21e';
                }
                else if (netCount < 2 * this.count) {
                    this.displayNameSpan.style.color = '';
                }
                else if (netCount < 4 * this.count) {
                    this.displayNameSpan.style.color = '#59d0b9';
                }
                else {
                    this.displayNameSpan.style.color = '#4aa3e6';
                }
            }
        }
        removeDisplayElement() {
            this.shortageDisplayElement?.remove();
            this.requiredDisplayElement?.remove();
        }
    }
    class MWI_Calculator_Calculator {
        // 清单与已加载角色绑定；禁止使用 undefined/null 存储键。
        static normalizeCharacterID(id) {
            if (typeof id !== 'string' && typeof id !== 'number') return null;
            const value = String(id).trim();
            return /^[1-9]\d*$/.test(value) ? value : null;
        }
        static getLiveCharacterID() {
            return this.normalizeCharacterID(MWI_Calculator.gameObject?.state?.character?.id);
        }
        static getSessionCharacterID() {
            return MWI_Calculator.hasCharacterSession
                ? this.normalizeCharacterID(MWI_Calculator.characterID) : this.getLiveCharacterID();
        }
        static canUseCharacterData() {
            return !this.loadingCharacterData && this.characterDataLoaded === true
                && this.activeCharacterID != null
                && this.activeCharacterID === this.getSessionCharacterID()
                && this.activeCharacterID === this.getLiveCharacterID();
        }
        static getStorageKey(characterID = null) {
            const id = this.normalizeCharacterID(characterID ?? this.activeCharacterID ?? this.getSessionCharacterID());
            return id == null ? null : `${this.resolveStorageKeyPrefix(id)}${id}`;
        }
        // 只清理内存与 DOM，绝不在角色切换/加载过程中保存空清单。
        static resetCharacterView() {
            clearTimeout(this.renderTimeout);
            this.renderTimeout = null;
            clearInterval(this.marketAutoFillTimer);
            this.marketAutoFillTimer = null;
            this.marketAutoFillTarget = null;
            this.targetItemsMap.forEach(item => item.removeDisplayElement());
            this.requiredItemsMap.forEach(item => item.removeDisplayElement());
            this.targetItemsMap.clear();
            this.requiredItemsMap.clear();
            this.targetItemCategoryMap.forEach(category => { category.needCalc = true; });
            for (const map of [this.targetItemDetailsMap, this.shortageItemDetailsMap, this.requiredItemDetailsMap]) {
                map.forEach(details => { details.open = true; details.hidden = true; });
            }
        }
        static prepareCharacterSession(characterID) {
            const id = this.normalizeCharacterID(characterID);
            if (id != null && this.pendingCharacterID === id) return;
            this.characterGeneration = (this.characterGeneration || 0) + 1;
            this.pendingCharacterID = id;
            this.activeCharacterID = null;
            this.characterDataLoaded = false;
            this.resetCharacterView();
        }
        static tryLoadActiveCharacter() {
            if (this.loadingCharacterData || !this.tabPanel || this.pendingCharacterID == null) return false;
            if (this.canUseCharacterData()) return true;
            const game = MWI_Calculator.getGameObject();
            if (game) MWI_Calculator.gameObject = game;
            if (this.pendingCharacterID !== this.getLiveCharacterID()
                || this.pendingCharacterID !== this.getSessionCharacterID()) return false;
            return this.loadCalculatorData(this.pendingCharacterID);
        }
        /**
         * 始终使用本脚本前缀。自己的任一关联键有数据时不覆盖；
         * 否则将当前角色的 Toolkit 目标、分类、折叠状态复制到本脚本存储。
         * 保留 Toolkit 原数据；成功后按角色缓存，避免重复导入。
         */
        static resolveStorageKeyPrefix(characterID) {
            const ownPrefix = 'MWI_Calculator_Calculator_TargetItems_';
            const toolkitPrefix = 'MWI_Toolkit_Calculator_TargetItems_';
            if (characterID == null) return ownPrefix;
            const cacheID = String(characterID);
            this.storagePrefixCache ||= new Map();
            if (this.storagePrefixCache.has(cacheID)) return ownPrefix;
            try {
                // 空字符串、空数组、空对象和 null 不视为已有数据。
                // 非空但损坏的自身数据也保留，避免静默覆盖。
                const hasData = raw => {
                    if (raw == null) return false;
                    let value = raw;
                    if (typeof raw === 'string') {
                        if (!raw.trim()) return false;
                        try { value = JSON.parse(raw); }
                        catch { return true; }
                    }
                    if (value == null || value === '') return false;
                    if (typeof value === 'object') return Object.keys(value).length > 0;
                    return true;
                };
                const fields = [
                    ['DetailsOpenState', '{}'],
                    ['TargetItemCategories', '[]'],
                    ['TargetItems', '[]']
                ];
                const records = fields.map(([field, empty]) => {
                    const ownKey = ownPrefix.replace('TargetItems', field) + cacheID;
                    const toolkitKey = toolkitPrefix.replace('TargetItems', field) + cacheID;
                    return { ownKey, toolkitKey, empty, own: GM_getValue(ownKey, empty) };
                });
                if (!records.some(record => hasData(record.own))) {
                    records.forEach(record => {
                        record.source = GM_getValue(record.toolkitKey, record.empty);
                    });
                    if (records.some(record => hasData(record.source))) {
                        const written = [];
                        try {
                            for (const record of records) {
                                // 记录后再写，以便写入过程中抛错时也尝试恢复。
                                written.push(record);
                                GM_setValue(record.ownKey, record.source);
                                if (JSON.stringify(GM_getValue(record.ownKey)) !== JSON.stringify(record.source)) {
                                    throw new Error('存储写入校验失败: ' + record.ownKey);
                                }
                            }
                        }
                        catch (error) {
                            for (const record of written.reverse()) {
                                try { GM_setValue(record.ownKey, record.own); }
                                catch (restoreError) {
                                    console.error('[MWI_Calculator] 恢复存储失败', restoreError);
                                }
                            }
                            throw error;
                        }
                        console.log(`[MWI_Calculator] 已复制 Toolkit 数据到自身前缀（角色ID: ${cacheID}）`);
                    }
                }
                this.storagePrefixCache.set(cacheID, ownPrefix);
            }
            catch (error) {
                // 失败时不缓存；保持自身前缀，后续调用可重试。
                console.warn('[MWI_Calculator] 旧键名兼容处理失败', error);
            }
            return ownPrefix;
        }
        // 保存所有 details 元素的 open 状态
        static saveDetailsOpenState() {
            if (!this.canUseCharacterData()) return false;
            const storageKey = MWI_Calculator_Calculator.getStorageKey();
            const storageKey_Details = storageKey.replace('TargetItems', 'DetailsOpenState');
            const detailsState = {};
            // 保存 targetItemDetailsMap
            MWI_Calculator_Calculator.targetItemDetailsMap.forEach((details, key) => {
                detailsState[`target_${key}`] = details.open;
            });
            // 保存 shortageItemDetailsMap
            MWI_Calculator_Calculator.shortageItemDetailsMap.forEach((details, key) => {
                detailsState[`shortage_${key}`] = details.open;
            });
            // 保存 requiredItemDetailsMap
            MWI_Calculator_Calculator.requiredItemDetailsMap.forEach((details, key) => {
                detailsState[`required_${key}`] = details.open;
            });
            try {
                GM_setValue(storageKey_Details, JSON.stringify(detailsState));
            }
            catch (error) {
                console.error('[MWI_Calculator] 保存Details open状态失败', error);
            }
        }
        // 恢复所有 details 元素的 open 状态
        static restoreDetailsOpenState(storageKey_Details) {
            try {
                const saved = GM_getValue(storageKey_Details, '{}');
                const detailsState = JSON.parse(saved);
                // 恢复 targetItemDetailsMap
                MWI_Calculator_Calculator.targetItemDetailsMap.forEach((details, key) => {
                    if (typeof detailsState[`target_${key}`] === 'boolean') {
                        details.open = detailsState[`target_${key}`];
                    }
                });
                // 恢复 shortageItemDetailsMap
                MWI_Calculator_Calculator.shortageItemDetailsMap.forEach((details, key) => {
                    if (typeof detailsState[`shortage_${key}`] === 'boolean') {
                        details.open = detailsState[`shortage_${key}`];
                    }
                });
                // 恢复 requiredItemDetailsMap
                MWI_Calculator_Calculator.requiredItemDetailsMap.forEach((details, key) => {
                    if (typeof detailsState[`required_${key}`] === 'boolean') {
                        details.open = detailsState[`required_${key}`];
                    }
                });
            }
            catch (error) {
                console.error('[MWI_Calculator] 恢复Details open状态失败', error);
            }
        }
        // 保存数据
        static saveCalculatorData() {
            if (!this.canUseCharacterData()) return false;
            const storageKey = MWI_Calculator_Calculator.getStorageKey();
            const storageKey_Category = storageKey.replace('TargetItems', 'TargetItemCategories');
            const storageKey_Details = storageKey.replace('TargetItems', 'DetailsOpenState');
            MWI_Calculator_Calculator.saveDetailsOpenState();
            const dataToSave = [...MWI_Calculator_Calculator.targetItemsMap.values()].map(item => ({
                itemHrid: item.itemHrid,
                count: item.count,
                needCalc: item.needCalc
            }));
            const dataToSave_Category = [...MWI_Calculator_Calculator.targetItemCategoryMap.values()].map(category => ({
                categoryHrid: category.categoryHrid,
                needCalc: category.needCalc
            }));
            try {
                GM_setValue(storageKey, JSON.stringify(dataToSave));
                GM_setValue(storageKey_Category, JSON.stringify(dataToSave_Category));
                return true;
            }
            catch (error) {
                console.error('[MWI_Calculator]' + error);
                return false;
            }
        }
        // 读取与渲染分离，不调用 clearAllTargetItems，不在加载后自动回写。
        static loadCalculatorData(characterID = null, { importToCurrent = false } = {}) {
            const destinationID = this.getSessionCharacterID();
            const sourceID = this.normalizeCharacterID(characterID ?? destinationID);
            if (destinationID == null || sourceID == null || destinationID !== this.getLiveCharacterID()) return false;
            if (sourceID !== destinationID && !importToCurrent) return false;
            const storageKey = this.getStorageKey(sourceID);
            this.loadingCharacterData = true;
            this.characterDataLoaded = false;
            try {
                const loadedItems = JSON.parse(GM_getValue(storageKey, '[]'));
                const loadedCategories = JSON.parse(GM_getValue(storageKey.replace('TargetItems', 'TargetItemCategories'), '[]'));
                if (!Array.isArray(loadedItems) || !Array.isArray(loadedCategories)) throw new Error('清单格式无效');
                const validItemsMap = new Map();
                for (const item of loadedItems) {
                    if (!item || typeof item.itemHrid !== 'string' || !Number.isFinite(item.count)) throw new Error('目标格式无效');
                    const enabled = typeof item.needCalc === 'boolean' ? item.needCalc : true;
                    let target;
                    if (item.itemHrid.startsWith('/items/')) target = new TargetItem(item.itemHrid, item.count, enabled);
                    else if (item.itemHrid.startsWith('/house_rooms/')) target = new TargetHouseRoom(item.itemHrid, item.count, enabled);
                    else throw new Error('未知目标类型');
                    validItemsMap.set(item.itemHrid, target);
                }
                for (const category of loadedCategories) {
                    if (!category || typeof category.categoryHrid !== 'string') throw new Error('分类格式无效');
                }
                this.resetCharacterView();
                this.activeCharacterID = destinationID;
                this.targetItemsMap = validItemsMap; // 空清单也必须替换，避免旧角色残留。
                for (const category of loadedCategories) {
                    const enabled = typeof category.needCalc === 'boolean' ? category.needCalc : true;
                    if (this.targetItemCategoryMap.has(category.categoryHrid)) this.targetItemCategoryMap.get(category.categoryHrid).needCalc = enabled;
                    else this.targetItemCategoryMap.set(category.categoryHrid, new TargetItemCategory(category.categoryHrid, enabled));
                }
                this.restoreDetailsOpenState(storageKey.replace('TargetItems', 'DetailsOpenState'));
                this.renderItemsDisplay();
                this.characterDataLoaded = true;
                return true;
            }
            catch (error) {
                console.error('[MWI_Calculator] 加载失败，保留原存储并暂停写入', error);
                return false;
            }
            finally { this.loadingCharacterData = false; }
        }
        static importCalculatorData(characterID) {
            if (!this.canUseCharacterData()) return false;
            const sourceID = this.normalizeCharacterID(characterID);
            if (sourceID == null) return false;
            if (sourceID === this.activeCharacterID) return this.loadCalculatorData();
            // 三选一弹窗：合并导入 / 覆盖替换 / 取消（原为 confirm 二选一）
            void this.chooseImportMode(sourceID);
            return true;
        }
        // 导入方式选择弹窗，resolve('merge' | 'overwrite' | null)
        static showImportModeDialog(sourceID) {
            return new Promise(resolve => {
                const finish = value => { overlay.remove(); resolve(value); };
                const overlay = document.createElement('div');
                overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center';
                const box = document.createElement('div');
                box.style.cssText = 'position:relative;width:min(380px,90vw);padding:16px;border-radius:12px;'
                    + 'background:linear-gradient(145deg,#152447,#1d3566);color:#eef3ff;border:1px solid #6f9bd8;'
                    + 'box-shadow:0 10px 28px rgba(3,10,26,.55);font:13px/1.6 system-ui,sans-serif';
                const text = document.createElement('div');
                text.style.cssText = 'margin-bottom:12px';
                text.textContent = `将角色 ${sourceID} 的清单导入到当前角色 ${this.activeCharacterID}：`;
                const btnRow = document.createElement('div');
                btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap';
                const mkBtn = (label, bg, title, value) => {
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.textContent = label;
                    btn.title = title;
                    btn.style.cssText = `border:0;border-radius:7px;padding:6px 10px;background:${bg};color:#fff;cursor:pointer;font:600 12px/1.4 system-ui,sans-serif`;
                    btn.addEventListener('click', () => finish(value));
                    return btn;
                };
                btnRow.append(
                    mkBtn('合并导入', '#2e7d32', '只新增当前清单缺少的物品，已有的物品保持不变', 'merge'),
                    mkBtn('覆盖替换', '#c05621', '用源角色清单整体替换当前清单（原有物品会被清除）', 'overwrite'),
                    mkBtn('取消', '#344879', '不做任何改动', null),
                );
                box.append(text, btnRow);
                overlay.appendChild(box);
                overlay.addEventListener('click', ev => { if (ev.target === overlay) finish(null); });
                document.body.appendChild(overlay);
            });
        }
        // 导入前备份当前清单三件套（TargetItems/TargetItemCategories/DetailsOpenState），失败返回 false
        static backupCurrentListBeforeImport() {
            const destinationKey = this.getStorageKey(this.activeCharacterID);
            try {
                const backup = {};
                for (const field of ['TargetItems', 'TargetItemCategories', 'DetailsOpenState']) {
                    const key = destinationKey.replace('TargetItems', field);
                    backup[key] = GM_getValue(key, field === 'DetailsOpenState' ? '{}' : '[]');
                }
                GM_setValue(destinationKey + '_BackupBeforeImport', JSON.stringify(backup));
                return true;
            }
            catch (error) {
                console.error('[MWI_Calculator] 导入备份失败，已取消导入', error);
                return false;
            }
        }
        // 合并导入：只新增当前清单缺少的物品（数量/勾选用源角色的值），已有物品保持不变
        static mergeItemsFromCharacter(sourceID) {
            try {
                const loadedItems = JSON.parse(GM_getValue(this.getStorageKey(sourceID), '[]'));
                if (!Array.isArray(loadedItems)) throw new Error('清单格式无效');
                let added = 0, kept = 0;
                for (const item of loadedItems) {
                    if (!item || typeof item.itemHrid !== 'string' || !Number.isFinite(item.count)) continue;
                    if (this.targetItemsMap.has(item.itemHrid)) { kept++; continue; }
                    const enabled = typeof item.needCalc === 'boolean' ? item.needCalc : true;
                    if (item.itemHrid.startsWith('/items/')) this.targetItemsMap.set(item.itemHrid, new TargetItem(item.itemHrid, item.count, enabled));
                    else if (item.itemHrid.startsWith('/house_rooms/')) this.targetItemsMap.set(item.itemHrid, new TargetHouseRoom(item.itemHrid, item.count, enabled));
                    else continue;
                    added++;
                }
                this.saveCalculatorData();
                this.renderItemsDisplay();
                console.log(`[MWI_Calculator] 合并导入完成：新增 ${added} 项，已存在保留 ${kept} 项`);
                return { added, kept };
            }
            catch (error) {
                console.error('[MWI_Calculator] 合并导入失败，保留原存储', error);
                return null;
            }
        }
        static async chooseImportMode(sourceID) {
            const mode = await this.showImportModeDialog(sourceID);
            if (!mode) return;
            if (!this.backupCurrentListBeforeImport()) return;
            if (mode === 'overwrite') {
                if (this.loadCalculatorData(sourceID, { importToCurrent: true })) {
                    alert(`已用角色 ${sourceID} 的清单覆盖当前清单`);
                }
            }
            else {
                const res = this.mergeItemsFromCharacter(sourceID);
                if (res) alert(`合并导入完成：新增 ${res.added} 项，已存在 ${res.kept} 项保持不变`);
            }
        }
        // 更新目标物品
        static updateTargetItem(itemHrid, count = 1) {
            if (!this.canUseCharacterData()) return;
            if (!itemHrid)
                return;
            const item = MWI_Calculator_Calculator.targetItemsMap.get(itemHrid);
            if (item) {
                item.count = count;
                item.updateDisplayElement();
            }
            else {
                // 添加新物品
                if (itemHrid.includes('/items/')) {
                    MWI_Calculator_Calculator.targetItemsMap.set(itemHrid, new TargetItem(itemHrid, count));
                }
                if (itemHrid.includes('/house_rooms/')) {
                    MWI_Calculator_Calculator.targetItemsMap.set(itemHrid, new TargetHouseRoom(itemHrid, count));
                }
            }
            MWI_Calculator_Calculator.saveAndScheduleRender();
        }
        // 添加目标物品
        static addTargetItem(itemHrid, count = 1) {
            if (!this.canUseCharacterData()) return;
            if (!itemHrid)
                return;
            const item = MWI_Calculator_Calculator.targetItemsMap.get(itemHrid);
            if (item) {
                item.count += count;
                item.updateDisplayElement();
            }
            else {
                // 添加新物品
                if (itemHrid.includes('/items/')) {
                    MWI_Calculator_Calculator.targetItemsMap.set(itemHrid, new TargetItem(itemHrid, count));
                }
                if (itemHrid.includes('/house_rooms/')) {
                    MWI_Calculator_Calculator.targetItemsMap.set(itemHrid, new TargetHouseRoom(itemHrid, count));
                }
            }
            MWI_Calculator_Calculator.saveAndScheduleRender();
        }
        // 删除目标物品
        static removeTargetItem(itemHrid) {
            if (!this.canUseCharacterData()) return;
            if (!itemHrid)
                return;
            MWI_Calculator_Calculator.targetItemsMap.get(itemHrid)?.removeDisplayElement();
            MWI_Calculator_Calculator.targetItemsMap.delete(itemHrid);
            MWI_Calculator_Calculator.saveAndScheduleRender();
        }
        // 清空指定大类中的所有目标（包括未勾选目标），只保存和刷新一次。
        static removeTargetItemsByCategory(categoryHrid) {
            if (!this.canUseCharacterData()) return;
            let removed = false;
            for (const [itemHrid, item] of this.targetItemsMap) {
                if (item.categoryHrid !== categoryHrid) continue;
                item.removeDisplayElement();
                this.targetItemsMap.delete(itemHrid);
                removed = true;
            }
            if (removed) this.saveAndScheduleRender();
        }
        // 清空目标物品
        static clearAllTargetItems() {
            if (!this.canUseCharacterData()) return;
            MWI_Calculator_Calculator.targetItemsMap.forEach(item => item.removeDisplayElement());
            MWI_Calculator_Calculator.targetItemsMap.clear();
            MWI_Calculator_Calculator.saveAndScheduleRender();
        }
        // 保存数据并计划渲染
        static saveAndScheduleRender() {
            // 保存数据到存储
            MWI_Calculator_Calculator.saveCalculatorData();
            MWI_Calculator_Calculator.scheduleRender();
        }
        // 定时任务绑定角色和会话代数，切角色后旧回调不会刷新新清单。
        static scheduleRender() {
            clearTimeout(this.renderTimeout);
            this.renderTimeout = null;
            if (!this.canUseCharacterData()) return;
            const id = this.activeCharacterID;
            const generation = this.characterGeneration;
            this.renderTimeout = setTimeout(() => {
                if (!this.canUseCharacterData() || id !== this.activeCharacterID || generation !== this.characterGeneration) return;
                this.renderTimeout = null;
                this.renderItemsDisplay();
            }, 300);
        }
        // 计算所有所需材料
        static calculateAllRequiredItems(inventoryMap) {
            const result = new Map();
            const queueMap = new Map();
            MWI_Calculator_Calculator.targetItemsMap.forEach(targetItem => {
                if (targetItem.needCalc && this.targetItemCategoryMap.get(targetItem.categoryHrid)?.needCalc) {
                    if (targetItem.itemHrid.includes('/house_rooms/')) {
                        // 处理房屋建造成本
                        const characterHouseRoomLevel = MWI_Calculator.gameObject.state.characterHouseRoomDict?.[targetItem.itemHrid]?.level || 0;
                        const upgradeCostsMap = MWI_Calculator.initClientData?.houseRoomDetailMap?.[targetItem.itemHrid]?.upgradeCostsMap;
                        for (let i = characterHouseRoomLevel + 1; i <= targetItem.count && i <= 8; i++) {
                            upgradeCostsMap[i].forEach(costItem => {
                                queueMap.set(costItem.itemHrid, (queueMap.get(costItem.itemHrid) || 0) + costItem.count);
                            });
                        }
                    }
                    else if (targetItem.count < 0) {
                        inventoryMap.set(targetItem.itemHrid, (inventoryMap.get(targetItem.itemHrid) || 0) - targetItem.count);
                    }
                    else {
                        queueMap.set(targetItem.itemHrid, (queueMap.get(targetItem.itemHrid) || 0) + targetItem.count);
                    }
                }
            });
            while (queueMap.size > 0) {
                const [itemHrid, need] = queueMap.entries().next().value;
                queueMap.delete(itemHrid);
                const have = inventoryMap.get(itemHrid) || 0;
                const use = Math.min(have, need);
                if (use > 0) {
                    inventoryMap.set(itemHrid, have - use);
                }
                const remain = need - use;
                if (remain > 0) {
                    result.set(itemHrid, (result.get(itemHrid) || 0) + remain);
                    const recipe = MWI_Calculator_ActionDetailPlus.tryGetRecipe(itemHrid);
                    if (!recipe)
                        continue;
                    const redundant = MWI_Calculator_Calculator.materialPlanningMode === 'redundant';
                    // 冗余模式与跳转制作使用相同的产出修正，再逐层展开材料。
                    const times = MWI_Calculator_Calculator.getProductionActionCount(recipe, remain);
                    for (const input of recipe.inputs) {
                        const amount = redundant
                            ? MWI_Calculator_Calculator.getMaterialBudget(input.count, times, input.consumptionVariance || 0)
                            : input.count * times;
                        queueMap.set(input.itemHrid, (queueMap.get(input.itemHrid) || 0) + amount);
                    }
                }
            }
            return result;
        }
        // 初始化计算器逻辑
        static initialize() {
            MWI_Calculator_ItemsMap.itemsUpdatedCallbacks.push((enditemsMap) => {
                MWI_Calculator_Calculator.scheduleRender();
            });
        }
        // 单实例面板随可见角色页签栏迁移，覆盖桌面右栏和窄屏“我的物品”。
        static initializeCalculatorUI() {
            if (this.mountObserver) return;
            this.installCalculatorStyles();
            const schedule = () => {
                if (this.mountFrame) return;
                this.mountFrame = requestAnimationFrame(() => {
                    this.mountFrame = null;
                    this.createCalculatorUI();
                });
            };
            this.mountObserver = new MutationObserver(records => {
                // 兜底：游戏通过键盘/程序化方式切换了页签（不触发 click 捕获）时主动交还控制权，
                // 避免游戏面板被我们写过的 inline display 压住 → 该显示的面板空白。
                // ⚠️ 只认 class 里"出现" Mui-selected 的记录：
                //    ① 不看 aria-selected——我们激活时不清游戏按钮的 aria-selected，残留的
                //       "true" 会在自己激活的同一批 records 里误触发 → 刚点开就被交还（点了没反应）。
                //    ② 必须是 record 后仍有 Mui-selected——我们激活时移除游戏按钮的
                //       Mui-selected 也会产生 class 记录，此时已不含该类，不应触发。
                if (this.calculatorActive && records.some(record =>
                    record.type === 'attributes'
                    && record.attributeName === 'class'
                    && record.target instanceof Element
                    && record.target !== this.tabButton
                    && this.calculatorMount?.navigation?.contains(record.target)
                    && record.target.classList.contains('Mui-selected')
                )) {
                    this.setCalculatorActive(false);
                    return;
                }
                const relevant = records.some(record => {
                    // 监测面板本身被外部页签隐藏/清空；内部数据更新仍忽略。
                    if (record.target === this.tabPanel || record.target === this.calculatorContent) return true;
                    if (record.type === 'childList' && this.calculatorContent
                        && [...record.removedNodes].some(node => node === this.calculatorContent || node.contains?.(this.calculatorContent))) return true;
                    return !record.target.closest?.('#mwi-calculator-panel, #mwi-calculator-tab');
                });
                if (relevant) schedule();
            });
            this.mountObserver.observe(document.body, {
                childList: true, subtree: true, attributes: true,
                attributeFilter: ['class', 'hidden', 'aria-selected', 'style']
            });
            window.addEventListener('resize', schedule);
            if (typeof ResizeObserver !== 'undefined') {
                this.calculatorSizeObserver = new ResizeObserver(schedule);
            }
            window.visualViewport?.addEventListener('resize', schedule);
            window.visualViewport?.addEventListener('scroll', schedule);
            document.addEventListener('click', event => {
                const mount = this.calculatorMount;
                const button = event.target.closest?.('button, [role="tab"]');
                if (mount && button && button !== this.tabButton && mount.navigation.contains(button)) {
                    this.setCalculatorActive(false);
                }
            }, true);
            this.createCalculatorUI();
        }
        static installCalculatorStyles() {
            if (document.getElementById('mwi-calculator-responsive-style')) return;
            const style = document.createElement('style');
            style.id = 'mwi-calculator-responsive-style';
            style.textContent = `
                :has(> #mwi-calculator-tab) { overflow-x:auto; max-width:100%; min-width:0; }
                #mwi-calculator-tab { flex-shrink:0; white-space:nowrap; }
                #mwi-calculator-tab[aria-selected="true"] { color:#00c6ff; font-weight:bold; }
                #mwi-calculator-panel { width:100%; min-width:0; box-sizing:border-box;
                    overflow:auto; overscroll-behavior:contain; container-type:inline-size;
                    min-height:0; flex-shrink:0; padding-bottom:env(safe-area-inset-bottom, 0px); -webkit-overflow-scrolling:touch; }
                #mwi-calculator-panel[hidden] { display:none !important; }
                #mwi-calculator-panel .mwi-calculator-layout { min-width:0; }
                #mwi-calculator-panel .mwi-calculator-layout > div { min-width:0; box-sizing:border-box; }
                #mwi-calculator-panel input, #mwi-calculator-panel select { min-width:0; max-width:100%; box-sizing:border-box; }
                /* 窄屏仍保留60/40双列，允许控件收缩，文本省略而非撑宽列。 */
                #mwi-calculator-panel .mwi-calculator-layout { flex-direction:row; flex-wrap:nowrap; }
                #mwi-calculator-panel .mwi-calculator-layout > div { flex-shrink:1; }
                @container (max-width:560px) {
                    #mwi-calculator-panel .mwi-calculator-layout div { min-width:0 !important; max-width:100%; box-sizing:border-box; }
                    #mwi-calculator-panel .mwi-calculator-layout button,
                    #mwi-calculator-panel .mwi-calculator-layout summary,
                    #mwi-calculator-panel .mwi-calculator-layout span {
                        min-width:0 !important; max-width:100%; overflow:hidden;
                        text-overflow:ellipsis; white-space:nowrap; box-sizing:border-box;
                    }
                    #mwi-calculator-panel .mwi-calculator-layout button { font-size:12px; }
                    #mwi-calculator-panel .mwi-planning-label { flex:0 1 auto !important; max-width:40% !important; margin-right:2px !important; }
                    #mwi-calculator-panel .mwi-planning-selector { padding:2px !important; }
                    #mwi-calculator-panel .mwi-planning-selector button { padding:3px 1px !important; margin:1px !important; }
                }
                /* 仅大类数量框隐藏原生步进按钮，保留 number 校验与键盘步进。 */
                #mwi-calculator-panel input.mwi-category-quantity {
                    -moz-appearance:textfield; appearance:textfield;
                }
                #mwi-calculator-panel input.mwi-category-quantity::-webkit-inner-spin-button,
                #mwi-calculator-panel input.mwi-category-quantity::-webkit-outer-spin-button {
                    -webkit-appearance:none; margin:0;
                }
                /* 目标清单行：数量完整，操作区固定，只有名称占用剩余空间。 */
                #mwi-calculator-panel .mwi-target-row {
                    flex-wrap:nowrap; align-items:center !important; min-width:0; box-sizing:border-box;
                }
                #mwi-calculator-panel .mwi-target-row > input[type="checkbox"] {
                    flex:0 0 auto; align-self:center; margin-top:0; margin-bottom:0;
                }
                #mwi-calculator-panel .mwi-target-row .mwi-target-name {
                    flex:1 1 0; min-width:0 !important; overflow:hidden; align-self:center;
                    justify-content:flex-start; align-items:center !important; text-align:left;
                }
                #mwi-calculator-panel .mwi-target-name > div { flex:0 0 auto; display:flex; align-items:center; }
                #mwi-calculator-panel .mwi-target-name > div > svg { display:block; }
                #mwi-calculator-panel .mwi-target-row .mwi-target-label {
                    flex:1 1 0; min-width:0 !important; overflow:hidden; text-overflow:ellipsis;
                    white-space:nowrap; font-size:var(--mwi-target-font-size,14px); line-height:18px;
                    text-align:left; align-self:center;
                }
                #mwi-calculator-panel .mwi-target-row .mwi-target-controls {
                    flex:0 0 auto; width:max-content; max-width:none !important; min-width:max-content !important;
                    margin-left:auto; align-self:center; align-items:center; white-space:nowrap;
                }
                #mwi-calculator-panel .mwi-target-controls > span {
                    flex:0 0 auto; max-width:none !important; overflow:visible !important; text-overflow:clip !important;
                    white-space:nowrap; font-size:var(--mwi-target-font-size,14px); line-height:18px;
                    font-variant-numeric:tabular-nums;
                }
                #mwi-calculator-panel .mwi-target-controls .mwi-target-input {
                    box-sizing:border-box; width:60px !important; min-width:60px !important; max-width:60px !important;
                    flex:0 0 60px !important; font-size:var(--mwi-target-font-size,14px); line-height:18px;
                }
                #mwi-calculator-panel .mwi-target-controls .mwi-target-remove {
                    box-sizing:border-box; width:26px !important; min-width:26px !important; max-width:26px !important;
                    height:26px; flex:0 0 26px; display:flex; align-items:center; justify-content:center;
                }
            `;
            document.head.appendChild(style);
        }
        static findCalculatorMount() {
            const groups = new Set();
            document.querySelectorAll('[class*="CharacterManagement_"] [class*="TabsComponent_tabsContainer"] button, button[role="tab"]')
                .forEach(button => { if (button.id !== 'mwi-calculator-tab') groups.add(button.parentElement); });
            const candidates = [];
            for (const navigation of groups) {
                const buttons = [...navigation.children].filter(el => el.matches('button') && el.id !== 'mwi-calculator-tab');
                const native = buttons.filter(el => !el.dataset.mwitoolsCharacterTab && !el.id.startsWith('mwi-'));
                const labels = buttons.map(el => el.textContent.trim().toLowerCase());
                const character = navigation.closest('[class*="CharacterManagement_"]');
                const semantic = labels.some(s => /^(库存|物品|inventory)$/.test(s))
                    && labels.filter(s => /^(装备|技能|房屋|配装|equipment|skills?|abilities|house|loadouts?)$/.test(s)).length >= 2;
                if (!(character && native.length >= 3) && !semantic) continue;
                const rect = navigation.getBoundingClientRect();
                if (!navigation.isConnected || rect.width <= 0 || rect.height <= 0 || getComputedStyle(navigation).visibility === 'hidden') continue;
                let branch = navigation, found = null;
                for (let depth = 0; branch.parentElement && depth < 7; depth++) {
                    const shell = branch.parentElement;
                    const siblings = [...shell.children].filter(el => el !== branch && el.id !== 'mwi-calculator-panel');
                    const content = siblings.find(el => el.matches('[class*="TabsComponent_tabPanelsContainer"]'));
                    // 独立挂载到原生内容容器旁，避免随原生子页签一起隐藏或清空。
                    if (content) { found = { shell, navigation, branch, buttons }; break; }
                    if (siblings.some(el => el.matches('[class*="TabPanel_"], [class*="Inventory_"], [class*="Equipment_"], [class*="CharacterManagement_content"]')
                        || el.querySelector('[class*="Inventory_"], [class*="TabPanel_"], [class*="Equipment_"]'))) {
                        found = { shell, navigation, branch, buttons }; break;
                    }
                    branch = shell;
                }
                if (found) candidates.push(found);
            }
            // 保持当前可见挂载点，避免同时存在多个可见容器时来回迁移。
            return candidates.find(candidate => candidate.navigation === this.calculatorMount?.navigation) || candidates[0];
        }
        static createCalculatorUI() {
            const found = this.findCalculatorMount();
            if (!found) return;
            if (this.tabPanel) this.tryLoadActiveCharacter();
            if (!this.tabPanel) {
                this.tabPanel = document.createElement('section');
                this.tabPanel.id = 'mwi-calculator-panel';
                this.tabPanel.setAttribute('role', 'tabpanel');
                this.tabPanel.setAttribute('aria-labelledby', 'mwi-calculator-tab');
                this.tabPanel.hidden = true;
                this.calculatorContent = this.createCalculatorPanel();
                this.tabPanel.appendChild(this.calculatorContent);
                this.tryLoadActiveCharacter();
                this.ensureMarketAutoFillObserver();
            }
            const same = this.calculatorMount?.navigation === found.navigation
                && this.tabButton?.parentElement === found.navigation && this.tabPanel.parentElement === found.shell;
            if (!same) {
                const active = !!this.calculatorActive;
                this.setCalculatorActive(false);
                this.tabButton?.remove();
                this.calculatorMount = found;
                this.tabButton = (found.buttons[1] || found.buttons[0]).cloneNode(true);
                this.tabButton.id = 'mwi-calculator-tab';
                this.tabButton.textContent = MWI_Calculator_I18n.isChinese() ? 'MWI计算器' : 'MWI_Calculator';
                this.tabButton.type = 'button';
                this.tabButton.setAttribute('role', 'tab');
                this.tabButton.setAttribute('aria-controls', 'mwi-calculator-panel');
                this.tabButton.dataset.mwitoolsCharacterTab = 'true'; // 与MWITools自定义页签识别兼容
                this.tabButton.classList.remove('Mui-selected');
                this.tabButton.setAttribute('aria-selected', 'false');
                this.tabButton.tabIndex = 0;
                this.tabButton.addEventListener('click', event => {
                    event.preventDefault();
                    event.stopPropagation();
                    this.setCalculatorActive(true);
                });
                found.navigation.appendChild(this.tabButton);
                found.shell.appendChild(this.tabPanel);
                this.calculatorSizeObserver?.disconnect();
                this.calculatorSizeObserver?.observe(found.navigation);
                this.calculatorSizeObserver?.observe(found.shell);
                this.calculatorSizeObserver?.observe(this.tabPanel);
                this.calculatorSizeObserver?.observe(this.calculatorContent);
                this.setCalculatorActive(active);
            }
            this.repairCalculatorPanel();
            if (this.calculatorActive) {
                this.hideCalculatorSiblings();
                this.syncCalculatorViewport();
            }
        }
        // 窄屏空列表也占满剩余可视高度，避免下拉框被内容自适应的小面板裁剪。
        static setCalculatorSizingStyle(node, property, value) {
            if (!node) return;
            this.calculatorSizingStyles ||= new Map();
            if (!this.calculatorSizingStyles.has(node)) this.calculatorSizingStyles.set(node, new Map());
            const saved = this.calculatorSizingStyles.get(node);
            if (!saved.has(property)) saved.set(property, {
                value: node.style.getPropertyValue(property), priority: node.style.getPropertyPriority(property)
            });
            if (node.style.getPropertyValue(property) !== value || node.style.getPropertyPriority(property) !== 'important') {
                node.style.setProperty(property, value, 'important');
            }
        }
        static restoreCalculatorSizing() {
            this.calculatorSizingStyles?.forEach((properties, node) => properties.forEach((saved, property) => {
                if (saved.value) node.style.setProperty(property, saved.value, saved.priority);
                else node.style.removeProperty(property);
            }));
            this.calculatorSizingStyles?.clear();
        }
        static syncCalculatorViewport() {
            const panel = this.tabPanel;
            if (!panel || !this.calculatorActive || !panel.isConnected) return;
            const viewport = window.visualViewport;
            const bottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
            const rect = panel.getBoundingClientRect();
            // 所有布局都占满可视区域，不因桌面模式、缩放或宽度跨断点而撤销高度。
            const available = Math.max(0, Math.floor(bottom - rect.top));
            const height = available + 'px';
            for (const property of ['height', 'min-height', 'max-height']) this.setCalculatorSizingStyle(panel, property, height);
            this.setCalculatorSizingStyle(panel, 'flex', '0 0 auto');
            this.setCalculatorSizingStyle(panel, 'box-sizing', 'border-box');
            const padding = parseFloat(getComputedStyle(panel).paddingBottom) || 0;
            this.setCalculatorSizingStyle(this.calculatorContent, 'min-height', Math.max(0, available - padding) + 'px');
            this.setCalculatorSizingStyle(this.calculatorContent, 'height', 'auto');
            this.setCalculatorSizingStyle(this.calculatorContent, 'max-height', 'none');
            this.setCalculatorSizingStyle(this.calculatorContent, 'flex', '0 0 auto');
            // 只解除当前角色面板链上的约束；离开计算器时原样恢复。
            const root = panel.closest('[class*="CharacterManagement_characterManagement"]') || this.calculatorMount?.shell;
            if (root) {
                for (let node = panel.parentElement; node && root.contains(node); node = node.parentElement) {
                    const nodeHeight = Math.max(0, Math.ceil(bottom - node.getBoundingClientRect().top));
                    this.setCalculatorSizingStyle(node, 'min-height', nodeHeight + 'px');
                    this.setCalculatorSizingStyle(node, 'max-height', 'none');
                    this.setCalculatorSizingStyle(node, 'height', 'auto');
                    this.setCalculatorSizingStyle(node, 'flex-shrink', '0');
                    if (node === root) break;
                }
            }
        }
        static repairCalculatorPanel() {
            const panel = this.tabPanel;
            if (!panel) return;
            // 保留原DOM实例及输入/事件/计算引用，不重建、不重新加载数据。
            if (this.calculatorContent && this.calculatorContent.parentElement !== panel) {
                panel.appendChild(this.calculatorContent);
            }
            const hidden = !this.calculatorActive;
            if (panel.hidden !== hidden) panel.hidden = hidden;
            if (this.calculatorActive) {
                // 其他扩展可能留下display:none；仅修复本脚本节点。
                if (panel.style.getPropertyValue('display') !== 'block'
                    || panel.style.getPropertyPriority('display') !== 'important') {
                    panel.style.setProperty('display', 'block', 'important');
                }
                if (panel.style.getPropertyValue('visibility') !== 'visible') panel.style.visibility = 'visible';
            } else if (panel.style.getPropertyValue('display') !== 'none'
                || panel.style.getPropertyPriority('display') !== 'important') {
                // 与激活时的内联!important对称，避免覆盖[hidden]规则。
                panel.style.setProperty('display', 'none', 'important');
            }
        }
        static hideCalculatorSiblings() {
            const mount = this.calculatorMount;
            if (!mount) return;
            this.hiddenCalculatorSiblings ||= new Map();
            for (const element of mount.shell.children) {
                if (element === this.tabPanel || element === mount.branch || element.contains(mount.navigation)) continue;
                if (!this.hiddenCalculatorSiblings.has(element)) this.hiddenCalculatorSiblings.set(element, {
                    display: element.style.getPropertyValue('display'), priority: element.style.getPropertyPriority('display')
                });
                if (element.style.getPropertyValue('display') !== 'none') element.style.setProperty('display', 'none', 'important');
            }
        }
        static setCalculatorActive(active) {
            this.calculatorActive = active;
            if (!active) {
                this.closeCalculatorDropdowns();
                this.restoreCalculatorSizing();
            }
            if (!this.tabPanel || !this.tabButton) return;
            this.repairCalculatorPanel();
            // ⚠️ 游戏页签是 React 管理的"全渲染 + hidden 类"结构：
            //    手改游戏按钮的 class/aria-selected，React 只跟自己的上一次 vDOM 比，
            //    改动不会回写 → 永久残留 → 多个面板同时显示 / 该显示的空白。
            //    所以：aria-selected 只写自己的按钮；游戏按钮仅移除 Mui-selected 做视觉让位，
            //    不做任何"保存/恢复"——切回游戏页签时由 React 自己的点击处理回写状态。
            this.tabButton.setAttribute('aria-selected', String(active));
            this.tabButton.classList.toggle('Mui-selected', active);
            this.calculatorMount?.navigation.querySelectorAll('button').forEach(button => {
                if (button !== this.tabButton) button.classList.remove('Mui-selected');
            });
            if (active) {
                this.hideCalculatorSiblings();
                this.syncCalculatorViewport();
            } else {
                this.hiddenCalculatorSiblings?.forEach((saved, element) => {
                    if (saved.display) element.style.setProperty('display', saved.display, saved.priority);
                    else element.style.removeProperty('display');
                });
                this.hiddenCalculatorSiblings?.clear();
            }
        }
        // 创建计算器面板
        static createCalculatorPanel() {
            const calculatorPanel = document.createElement('div');
            calculatorPanel.className = 'Toolkit_Calculator_Container mwi-calculator-layout';
            calculatorPanel.style.display = 'flex';
            calculatorPanel.style.alignItems = 'flex-start';
            calculatorPanel.style.width = '100%';
            // 左列：建筑、物品、物品清单
            const leftDiv = document.createElement('div');
            leftDiv.style.display = 'flex';
            leftDiv.style.flexDirection = 'column';
            leftDiv.style.width = '60%';
            leftDiv.style.padding = '0px 2px';
            leftDiv.appendChild(MWI_Calculator_Calculator.createHouseRoomSelectionComponent());
            leftDiv.appendChild(MWI_Calculator_Calculator.createCategoryAddComponent());
            leftDiv.appendChild(MWI_Calculator_Calculator.createItemSearchComponent());
            MWI_Calculator_Calculator.createItemDetailsMap(leftDiv, MWI_Calculator_Calculator.targetItemDetailsMap);
            calculatorPanel.appendChild(leftDiv);
            MWI_Calculator_Calculator.targetItemDetailsMap.forEach((details, categoryHrid) => {
                const summary = details.querySelector('summary');
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.style.verticalAlign = 'middle';
                if (!MWI_Calculator_Calculator.targetItemCategoryMap.has(categoryHrid)) {
                    MWI_Calculator_Calculator.targetItemCategoryMap.set(categoryHrid, new TargetItemCategory(categoryHrid));
                }
                MWI_Calculator_Calculator.targetItemCategoryMap.get(categoryHrid).categoryDetailsElement = details;
                MWI_Calculator_Calculator.targetItemCategoryMap.get(categoryHrid).categorySummaryElement = summary;
                MWI_Calculator_Calculator.targetItemCategoryMap.get(categoryHrid).needCalcCheckbox = checkbox;
                checkbox.checked = MWI_Calculator_Calculator.targetItemCategoryMap.get(categoryHrid).needCalc;
                checkbox.addEventListener('change', () => {
                    MWI_Calculator_Calculator.targetItemCategoryMap.get(categoryHrid).needCalc = checkbox.checked;
                    MWI_Calculator_Calculator.saveAndScheduleRender();
                });
                summary.prepend(checkbox);
            });
            // 右列：制作/购买枚举、缺口、详情
            const rightDiv = document.createElement('div');
            rightDiv.style.display = 'flex';
            rightDiv.style.flexDirection = 'column';
            rightDiv.style.width = '40%';
            rightDiv.style.padding = '0px 2px';
            rightDiv.appendChild(MWI_Calculator_Calculator.createMaterialPlanningModeSelector());
            rightDiv.appendChild(MWI_Calculator_Calculator.createHouseAcquisitionModeSelector());
            const shortageItemDetails = document.createElement('details');
            shortageItemDetails.style.background = '#902f10';
            shortageItemDetails.style.borderRadius = '4px';
            shortageItemDetails.style.padding = '2px';
            shortageItemDetails.open = true;
            const shortageSummary = document.createElement('summary');
            shortageSummary.textContent = MWI_Calculator_I18n.isChinese() ? '缺口' : 'Shortages';
            shortageSummary.style.background = '#af3914';
            shortageSummary.style.borderRadius = '4px';
            shortageSummary.style.fontSize = '14px';
            shortageSummary.style.padding = '2px 6px';
            shortageSummary.style.textAlign = 'left';
            shortageSummary.style.cursor = 'pointer';
            shortageItemDetails.appendChild(shortageSummary);
            MWI_Calculator_Calculator.createItemDetailsMap(shortageItemDetails, MWI_Calculator_Calculator.shortageItemDetailsMap);
            rightDiv.appendChild(shortageItemDetails);
            const requiredItemDetails = document.createElement('details');
            requiredItemDetails.style.background = '#0c385a';
            requiredItemDetails.style.borderRadius = '4px';
            requiredItemDetails.style.padding = '2px';
            const requiredSummary = document.createElement('summary');
            requiredSummary.textContent = MWI_Calculator_I18n.isChinese() ? '详情（余量/需求）' : 'Status(Remaining/Required)';
            requiredSummary.style.background = '#1770b3';
            requiredSummary.style.borderRadius = '4px';
            requiredSummary.style.fontSize = '14px';
            requiredSummary.style.padding = '2px 6px';
            requiredSummary.style.textAlign = 'left';
            requiredSummary.style.cursor = 'pointer';
            requiredItemDetails.appendChild(requiredSummary);
            MWI_Calculator_Calculator.createItemDetailsMap(requiredItemDetails, MWI_Calculator_Calculator.requiredItemDetailsMap);
            rightDiv.appendChild(requiredItemDetails);
            calculatorPanel.appendChild(rightDiv);
            return calculatorPanel;
        }
        // 创建物品分类区域
        static createItemDetailsMap(container, ItemDetailsMap) {
            MWI_Calculator_Calculator.itemCategoryList.forEach(categoryHrid => {
                const categoryName = MWI_Calculator_I18n.getName(categoryHrid, 'itemCategoryNames');
                const onClear = ItemDetailsMap === this.targetItemDetailsMap
                    ? () => this.removeTargetItemsByCategory(categoryHrid) : null;
                const { details } = MWI_Calculator_UI.createCategory(
                    categoryName, () => this.saveDetailsOpenState(), onClear
                );
                container.appendChild(details);
                ItemDetailsMap.set(categoryHrid, details);
            });
        }
        // 创建添加物品区域
        static createAddItemSection() {
            const addItemSection = document.createElement('div');
            addItemSection.style.display = 'flex';
            addItemSection.style.flexDirection = 'column';
            addItemSection.style.width = '100%';
            // 建筑添加区域置于物品搜索区域上方
            const houseSection = document.createElement('div');
            houseSection.style.width = '100%';
            houseSection.appendChild(MWI_Calculator_Calculator.createHouseRoomSelectionComponent());
            addItemSection.appendChild(houseSection);
            addItemSection.appendChild(MWI_Calculator_Calculator.createCategoryAddComponent());
            // 物品搜索区域
            const itemSection = document.createElement('div');
            itemSection.style.width = '100%';
            const searchContainer = MWI_Calculator_Calculator.createItemSearchComponent();
            itemSection.appendChild(searchContainer);
            addItemSection.appendChild(itemSection);
            return addItemSection;
        }
        // 创建大类添加框：选择物品大类后一次性加入该类全部物品
        // 与物品添加栏使用相同的自然行高、4px 内边距和 2px 外边距。
        static compactSelectionControls(controls) {
            Object.assign(controls.style, {
                alignItems: 'stretch', flexWrap: 'nowrap', minWidth: '0'
            });
            const [dropdown, input, button] = controls.children;
            Object.assign(dropdown.style, {
                flex: '1 1 0', minWidth: '0', height: 'auto'
            });
            Object.assign(dropdown.firstElementChild.style, {
                minWidth: '0', whiteSpace: 'nowrap', overflow: 'hidden'
            });
            Object.assign(input.style, MWI_Calculator_UIStyles.quantityInput, {
                height: 'auto',
                padding: '4px', margin: '2px'
            });
            Object.assign(button.style, {
                height: 'auto', width: 'auto', flex: '0 0 auto',
                whiteSpace: 'nowrap', padding: '4px', margin: '2px'
            });
        }
        static createCategoryAddComponent() {
            const section = document.createElement('div');
            section.style.background = MWI_Calculator_UITheme.surface;
            section.style.border = 'none';
            section.style.borderRadius = '4px';
            section.style.padding = '4px';
            section.style.margin = '2px';
            section.style.display = 'flex';
            section.style.flexDirection = 'column';
            const controls = document.createElement('div');
            controls.style.display = 'flex';
            controls.style.width = '100%';
            const dropdown = document.createElement('div');
            dropdown.style.display = 'flex';
            dropdown.style.minWidth = '20px';
            dropdown.style.flex = '1';
            dropdown.style.position = 'relative';
            const selected = document.createElement('div');
            selected.style.background = MWI_Calculator_UITheme.heading;
            selected.style.color = MWI_Calculator_UITheme.onAction;
            selected.style.borderRadius = '4px';
            selected.style.paddingLeft = '4px';
            selected.style.margin = '2px';
            selected.style.minWidth = '40px';
            selected.style.flex = '1';
            selected.style.cursor = 'pointer';
            selected.style.display = 'flex';
            selected.style.alignItems = 'center';
            selected.style.whiteSpace = 'nowrap';
            selected.textContent = MWI_Calculator_I18n.isChinese() ? '选择大类' : 'Select item category';
            const list = document.createElement('div');
            list.style.background = MWI_Calculator_UITheme.surface;
            list.style.borderRadius = '4px';
            list.style.padding = '4px';
            list.style.margin = '2px';
            list.style.width = '150px';
            list.style.maxHeight = '335px';
            list.style.overflowY = 'auto';
            list.style.zIndex = '1000';
            list.style.display = 'none';
            list.style.position = 'absolute';
            list.style.left = '0px';
            list.style.top = '32px';
            const hiddenCategoryOptions = new Set([
                '/item_categories/house_rooms',
                '/item_categories/ability_book',
                '/item_categories/equipment',
                '/item_categories/materials',
                '/item_categories/resource',
                '/item_categories/loot',
                '/item_categories/currency',
                '/item_categories/key',
                '/item_categories/drink'
            ]);
            const categoryOptions = MWI_Calculator_Calculator.itemCategoryList
                .filter(categoryHrid => !hiddenCategoryOptions.has(categoryHrid))
                .map(categoryHrid => {
                    const option = document.createElement('div');
                    option.style.borderBottom = '1px solid #98a7e9';
                    option.style.borderRadius = '4px';
                    option.style.padding = '4px';
                    option.style.alignItems = 'center';
                    option.style.display = 'flex';
                    option.style.cursor = 'pointer';
                    option.textContent = MWI_Calculator_I18n.getName(categoryHrid, 'itemCategoryNames') || categoryHrid;
                    option.dataset.categoryHrid = categoryHrid;
                    option.addEventListener('mouseenter', () => { option.style.background = '#4a4c6a'; });
                    option.addEventListener('mouseleave', () => { option.style.background = 'transparent'; });
                    option.addEventListener('click', (event) => {
                        event.stopPropagation();
                        selected.textContent = option.textContent;
                        dropdown.dataset.categoryHrid = categoryHrid;
                        list.style.display = 'none';
                    });
                    return option;
                });
            categoryOptions.forEach(option => list.appendChild(option));
            selected.addEventListener('click', (event) => {
                event.stopPropagation();
                MWI_Calculator_Calculator.toggleCalculatorDropdown(list);
            });
            MWI_Calculator_Calculator.registerCalculatorDropdown(dropdown, list);
            dropdown.appendChild(selected);
            dropdown.appendChild(list);
            const countInput = document.createElement('input');
            countInput.type = 'number';
            countInput.min = '0';
            countInput.step = '1';
            countInput.value = '0';
            countInput.title = MWI_Calculator_I18n.isChinese() ? '每个物品添加数量' : 'Quantity per item';
            countInput.classList.add('mwi-category-quantity');
            countInput.style.background = '#dde2f8';
            countInput.style.color = '#000000';
            countInput.style.border = 'none';
            countInput.style.borderRadius = '4px';
            countInput.style.padding = '4px';
            countInput.style.margin = '2px';
            Object.assign(countInput.style, MWI_Calculator_UIStyles.quantityInput);
            const addButton = document.createElement('button');
            addButton.type = 'button';
            addButton.textContent = MWI_Calculator_I18n.isChinese() ? '添加' : 'Add';
            addButton.style.background = '#4CAF50';
            addButton.style.color = MWI_Calculator_UITheme.onAction;
            addButton.style.border = 'none';
            addButton.style.borderRadius = '4px';
            addButton.style.padding = '4px';
            addButton.style.margin = '2px';
            addButton.style.cursor = 'pointer';
            addButton.addEventListener('click', () => {
                const count = Math.max(0, parseInt(countInput.value, 10) || 0);
                MWI_Calculator_Calculator.addAllItemsByCategory(dropdown.dataset.categoryHrid, count);
            });
            addButton.style.width = '35px';
            controls.appendChild(dropdown);
            controls.appendChild(countInput);
            controls.appendChild(addButton);
            MWI_Calculator_Calculator.compactSelectionControls(controls);
            section.appendChild(controls);
            return section;
        }
        static addAllItemsByCategory(categoryHrid, count = 1) {
            if (!this.canUseCharacterData()) return;
            if (!categoryHrid) return;
            const itemDetailMap = MWI_Calculator.initClientData?.itemDetailMap;
            if (!itemDetailMap) return;
            let addedCount = 0;
            Object.entries(itemDetailMap).forEach(([itemHrid, detail]) => {
                if (!itemHrid.startsWith('/items/')) return;
                // 与 DisplayItem 保持一致：加工产物、茶和咖啡可能需要特殊归类
                let itemCategoryHrid = detail?.categoryHrid;
                if ([...(MWI_Calculator_ActionDetailPlus.processableItemMap ?? new Map()).values()].includes(itemHrid)) {
                    itemCategoryHrid = '/item_categories/materials';
                }
                else if (itemHrid.endsWith('_tea')) {
                    itemCategoryHrid = '/item_categories/tea';
                }
                else if (itemHrid.endsWith('_coffee')) {
                    itemCategoryHrid = '/item_categories/coffee';
                }
                if (itemCategoryHrid !== categoryHrid) return;
                const item = MWI_Calculator_Calculator.targetItemsMap.get(itemHrid);
                if (item) {
                    item.count += count;
                    item.updateDisplayElement();
                }
                else {
                    MWI_Calculator_Calculator.targetItemsMap.set(itemHrid, new TargetItem(itemHrid, count));
                }
                addedCount++;
            });
            if (addedCount > 0) MWI_Calculator_Calculator.saveAndScheduleRender();
        }
        // 三个下拉框共享互斥管理；捕获阶段处理，不受选项stopPropagation影响。
        static registerCalculatorDropdown(root, menu) {
            this.calculatorDropdowns ||= new Map();
            this.calculatorDropdowns.set(menu, root);
            menu.dataset.calculatorDropdown = 'true';
            if (this.dropdownEventsBound) return;
            this.dropdownEventsBound = true;
            const closeOutside = event => {
                let inside = null;
                this.calculatorDropdowns.forEach((owner, list) => {
                    if (owner.contains(event.target)) inside = list;
                });
                this.closeCalculatorDropdowns(inside);
            };
            document.addEventListener('pointerdown', closeOutside, true);
            document.addEventListener('click', closeOutside, true);
            document.addEventListener('focusin', closeOutside, true);
            document.addEventListener('keydown', event => {
                if (event.key === 'Escape') this.closeCalculatorDropdowns();
            }, true);
        }
        static closeCalculatorDropdowns(except = null) {
            this.calculatorDropdowns?.forEach((root, menu) => {
                if (menu !== except) menu.style.display = 'none';
            });
        }
        static openCalculatorDropdown(menu) {
            this.closeCalculatorDropdowns(menu);
            menu.style.display = 'block';
        }
        static toggleCalculatorDropdown(menu) {
            if (menu.style.display === 'block') menu.style.display = 'none';
            else this.openCalculatorDropdown(menu);
        }
        // 创建物品搜索组件
        static createItemSearchComponent() {
            const itemSearchComponent = document.createElement('div');
            itemSearchComponent.style.background = MWI_Calculator_UITheme.surface;
            itemSearchComponent.style.border = 'none';
            itemSearchComponent.style.borderRadius = '4px';
            itemSearchComponent.style.padding = '4px';
            itemSearchComponent.style.margin = '2px';
            itemSearchComponent.style.display = 'flex';
            itemSearchComponent.style.position = 'relative';
            // 物品搜索输入框
            const itemSearchInput = document.createElement('input');
            itemSearchInput.type = 'text';
            itemSearchInput.placeholder = (MWI_Calculator_I18n.isChinese()) ? '搜索物品名称...' : 'Search item name...';
            itemSearchInput.style.background = '#dde2f8';
            itemSearchInput.style.color = '#000000';
            itemSearchInput.style.border = 'none';
            itemSearchInput.style.borderRadius = '4px';
            itemSearchInput.style.padding = '4px';
            itemSearchInput.style.margin = '2px';
            itemSearchInput.style.minWidth = '40px';
            itemSearchInput.style.flex = '1';
            // 搜索结果下拉列表
            const searchResults = document.createElement('div');
            searchResults.style.background = MWI_Calculator_UITheme.surface;
            searchResults.style.border = 'none';
            searchResults.style.borderRadius = '4px';
            searchResults.style.padding = '4px';
            searchResults.style.margin = '2px';
            searchResults.style.width = '200px';
            searchResults.style.maxHeight = '335px';
            searchResults.style.overflowY = 'auto';
            searchResults.style.zIndex = '1000';
            searchResults.style.display = 'none';
            searchResults.style.position = 'absolute';
            searchResults.style.left = '4px';
            searchResults.style.top = '32px';
            // 数量输入框
            const countInput = document.createElement('input');
            countInput.type = 'text';
            countInput.value = '1';
            countInput.placeholder = (MWI_Calculator_I18n.isChinese()) ? '数量' : 'Count';
            countInput.style.background = '#dde2f8';
            countInput.style.color = '#000000';
            countInput.style.border = 'none';
            countInput.style.borderRadius = '4px';
            countInput.style.padding = '4px';
            countInput.style.margin = '2px';
            countInput.style.width = '60px';
            // 添加按钮
            const addButton = document.createElement('button');
            addButton.textContent = (MWI_Calculator_I18n.isChinese()) ? '添加' : 'Add';
            addButton.style.background = '#4CAF50';
            addButton.style.color = MWI_Calculator_UITheme.onAction;
            addButton.style.border = 'none';
            addButton.style.borderRadius = '4px';
            addButton.style.padding = '4px';
            addButton.style.margin = '2px';
            addButton.style.cursor = 'pointer';
            // 清空按钮
            const clearAllButton = document.createElement('button');
            clearAllButton.textContent = (MWI_Calculator_I18n.isChinese()) ? '清空' : 'Clear';
            MWI_Calculator_UI.styleDangerButton(clearAllButton, true);
            MWI_Calculator_Calculator.registerCalculatorDropdown(itemSearchComponent, searchResults);
            // 绑定搜索事件
            MWI_Calculator_Calculator.bindItemSearchComponentEvents(itemSearchInput, countInput, searchResults, addButton, clearAllButton);
            itemSearchComponent.appendChild(itemSearchInput);
            itemSearchComponent.appendChild(countInput);
            itemSearchComponent.appendChild(addButton);
            itemSearchComponent.appendChild(clearAllButton);
            itemSearchComponent.appendChild(searchResults);
            return itemSearchComponent;
        }
        // 绑定搜索相关事件
        static bindItemSearchComponentEvents(itemSearchInput, countInput, searchResults, addButton, clearAllButton) {
            // 输入框获得焦点时全选内容
            itemSearchInput.addEventListener('focus', () => {
                setTimeout(() => {
                    itemSearchInput.select();
                }, 0);
            });
            // 搜索功能
            itemSearchInput.addEventListener('input', () => {
                // 支持多关键词（空格隔开）：物品名称需同时包含全部关键词（AND 语义）
                const searchTerms = itemSearchInput.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
                if (searchTerms.length < 1) {
                    searchResults.style.display = 'none';
                    return;
                }
                // 获取并过滤物品
                const itemDetailMap = MWI_Calculator?.initClientData?.itemDetailMap;
                if (!itemDetailMap)
                    return;
                const filteredItems = Object.keys(itemDetailMap)
                    .filter(itemHrid => {
                    const name = MWI_Calculator_I18n.getItemName(itemHrid).toLowerCase();
                    return searchTerms.every(term => name.includes(term));
                })
                    .sort((a, b) => {
                    const sortIndexA = MWI_Calculator_Utils.getSortIndexByItemHrid(a);
                    const sortIndexB = MWI_Calculator_Utils.getSortIndexByItemHrid(b);
                    return sortIndexA - sortIndexB;
                });
                if (filteredItems.length === 0) {
                    searchResults.style.display = 'none';
                    return;
                }
                MWI_Calculator_Calculator.populateSearchResults(searchResults, filteredItems, (itemHrid) => {
                    itemSearchInput.value = MWI_Calculator_I18n.getItemName(itemHrid);
                    searchResults.style.display = 'none';
                });
                MWI_Calculator_Calculator.openCalculatorDropdown(searchResults);
            });
            // 键盘操作
            itemSearchInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    MWI_Calculator_Calculator.addItemAndResetItemSearchComponent(itemSearchInput, countInput, searchResults);
                }
                else if (e.key === 'Escape') {
                    searchResults.style.display = 'none';
                }
            });
            // 输入框获得焦点时全选内容
            countInput.addEventListener('focus', () => {
                setTimeout(() => {
                    countInput.select();
                }, 0);
            });
            // 仅允许输入数字
            countInput.addEventListener('input', () => {
                // 只允许负号在首位，其余为数字
                countInput.value = countInput.value.replace(/(?!^)-|[^\d-]/g, '');
            });
            // 键盘操作
            countInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    MWI_Calculator_Calculator.addItemAndResetItemSearchComponent(itemSearchInput, countInput, searchResults);
                }
                else if (e.key === 'Escape') {
                    searchResults.style.display = 'none';
                }
            });
            // 添加按钮事件
            addButton.addEventListener('click', () => {
                MWI_Calculator_Calculator.addItemAndResetItemSearchComponent(itemSearchInput, countInput, searchResults);
            });
            // 清空按钮事件
            clearAllButton.addEventListener('click', () => {
                if (confirm((MWI_Calculator_I18n.isChinese()) ? '确定要清空所有目标物品吗？' : 'Are you sure you want to clear all target items?')) {
                    // 通过事件处理器清空
                    MWI_Calculator_Calculator.clearAllTargetItems();
                }
            });
            // 保留搜索词，再次点击输入框时重新显示匹配结果。
            itemSearchInput.addEventListener('click', () => {
                itemSearchInput.dispatchEvent(new Event('input', { bubbles: true }));
            });
        }
        // 填充搜索结果
        static populateSearchResults(searchResults, filteredItems, onItemSelect) {
            searchResults.innerHTML = '';
            filteredItems.forEach((itemHrid, index) => {
                const resultItem = document.createElement('div');
                resultItem.style.borderBottom = '1px solid #98a7e9';
                resultItem.style.borderRadius = '4px';
                resultItem.style.padding = '4px';
                resultItem.style.alignItems = 'center';
                resultItem.style.display = 'flex';
                resultItem.style.cursor = 'pointer';
                if (index === 0) {
                    resultItem.style.background = '#4a4c6a';
                }
                // 物品图标
                const itemIcon = document.createElement('div');
                const iconHref = MWI_Calculator_Utils.getIconHrefByItemHrid(itemHrid);
                const svg = MWI_Calculator_Utils.createIconSvg(iconHref);
                itemIcon.appendChild(svg);
                // 物品名称
                const itemName = document.createElement('span');
                itemName.textContent = MWI_Calculator_I18n.getItemName(itemHrid);
                itemName.style.marginLeft = '2px';
                resultItem.appendChild(itemIcon);
                resultItem.appendChild(itemName);
                // 悬停高亮
                resultItem.addEventListener('mouseenter', () => {
                    resultItem.style.background = '#4a4c6a';
                });
                resultItem.addEventListener('mouseleave', () => {
                    resultItem.style.background = 'transparent';
                });
                resultItem.addEventListener('click', () => onItemSelect(itemHrid));
                searchResults.appendChild(resultItem);
            });
        }
        // 添加物品并重置搜索组件（包含itemHrid获取和判空）
        static addItemAndResetItemSearchComponent(itemSearchInput, countInput, searchResults) {
            const InputValue = itemSearchInput.value.trim();
            // 如果InputValue是纯数字，则视为从特定角色加载数据
            if (/^\d+$/.test(InputValue)) {
                const characterID = parseInt(InputValue, 10);
                MWI_Calculator_Calculator.importCalculatorData(characterID);
                return;
            }
            const itemHrid = MWI_Calculator_I18n.getItemHridByName(InputValue);
            if (!itemHrid)
                return;
            const count = parseInt(countInput.value, 10) || 1;
            MWI_Calculator_Calculator.addTargetItem(itemHrid, count);
            itemSearchInput.value = '';
            countInput.value = '1';
            searchResults.style.display = 'none';
        }
        // 相邻整数随机取整模型：整数消耗无随机余量，非整数按单侧99.9%上界备料。
        static getMaterialBudget(mean, times, variance = 0) {
            if (times <= 0 || mean <= 0) return 0;
            const expected = mean * times;
            if (variance <= 0) return expected;
            return Math.min(times * Math.ceil(mean),
                Math.ceil(expected + 3.090232306167813 * Math.sqrt(times * variance)));
        }
        static setMaterialPlanningMode(mode) {
            if (!['redundant', 'limit'].includes(mode) || mode === this.materialPlanningMode) return;
            this.materialPlanningMode = mode;
            // 丢弃旧模式购买跳转缓存，后续按新缺口填入。
            this.marketAutoFillTarget = null;
            if (this.renderTimeout) {
                clearTimeout(this.renderTimeout);
                this.renderTimeout = null;
            }
            this.renderItemsDisplay();
        }
        static createMaterialPlanningModeSelector() {
            const selector = document.createElement('div');
            selector.style.cssText = 'display:flex;align-items:center;background:#2c2e45;border-radius:4px;padding:4px;margin:2px';
            const label = document.createElement('span');
            selector.className = 'mwi-planning-selector';
            label.className = 'mwi-planning-label';
            label.textContent = MWI_Calculator_I18n.isChinese() ? '备料计算' : 'Material planning';
            label.title = label.textContent;
            label.style.cssText = 'flex:0 0 auto;white-space:nowrap;color:#fff;margin:0 6px 0 2px';
            selector.appendChild(label);
            const buttons = {};
            const update = () => Object.entries(buttons).forEach(([mode, button]) => {
                const selected = this.materialPlanningMode === mode;
                button.style.background = selected ? '#1976D2' : '#6B7280';
                button.setAttribute('aria-pressed', String(selected));
            });
            [['redundant', '冗余', 'Buffered'], ['limit', '极限', 'Lean']].forEach(([mode, zh, en]) => {
                const button = document.createElement('button');
                button.type = 'button';
                button.textContent = MWI_Calculator_I18n.isChinese() ? zh : en;
                button.style.cssText = 'flex:1;color:#fff;border:none;border-radius:4px;padding:4px;margin:2px;cursor:pointer';
                button.addEventListener('click', () => {
                    this.setMaterialPlanningMode(mode);
                    update();
                });
                buttons[mode] = button;
                selector.appendChild(button);
            });
            update();
            return selector;
        }
        // 创建建筑获取方式枚举（独立于建筑添加控件）
        static createHouseAcquisitionModeSelector() {
            const modeSelector = document.createElement('div');
            modeSelector.style.background = MWI_Calculator_UITheme.surface;
            modeSelector.style.borderRadius = '4px';
            modeSelector.style.padding = '4px';
            modeSelector.style.margin = '2px';
            modeSelector.style.display = 'flex';
            const modeButtons = {};
            const updateModeButtons = () => Object.entries(modeButtons).forEach(([mode, button]) => {
                const selected = MWI_Calculator_Calculator.houseAcquisitionMode === mode;
                button.style.background = selected ? (mode === 'craft' ? '#1976D2' : '#F2B01E') : '#6B7280';
            });
            [['craft', '制作', 'Craft'], ['buy', '购买', 'Buy']].forEach(([mode, zh, en]) => {
                const button = document.createElement('button');
                button.type = 'button';
                button.textContent = MWI_Calculator_I18n.isChinese() ? zh : en;
                button.style.flex = '1';
                button.style.background = '#6B7280';
                button.style.color = MWI_Calculator_UITheme.onAction;
                button.style.border = 'none';
                button.style.borderRadius = '4px';
                button.style.padding = '4px';
                button.style.margin = '2px';
                button.style.cursor = 'pointer';
                button.addEventListener('click', () => {
                    MWI_Calculator_Calculator.houseAcquisitionMode = mode;
                    updateModeButtons();
                });
                modeButtons[mode] = button;
                modeSelector.appendChild(button);
            });
            updateModeButtons();
            return modeSelector;
        }
        static isIronCowMode() {
            const gameObject = MWI_Calculator.gameObject;
            const gameMode = String(
                gameObject?.state?.character?.gameMode ??
                gameObject?.props?.character?.gameMode ??
                MWI_Calculator.initClientData?.character?.gameMode ??
                MWI_Calculator.characterGameMode ?? ''
            ).toLowerCase();
            return gameMode === 'ironcow' || gameMode === 'legacy_ironcow';
        }
        // 创建房屋选择区域
        static createHouseRoomSelectionComponent() {
            const HouseRoomSelectionComponent = document.createElement('div');
            HouseRoomSelectionComponent.style.background = MWI_Calculator_UITheme.surface;
            HouseRoomSelectionComponent.style.border = 'none';
            HouseRoomSelectionComponent.style.borderRadius = '4px';
            HouseRoomSelectionComponent.style.padding = '4px';
            HouseRoomSelectionComponent.style.margin = '2px';
            HouseRoomSelectionComponent.style.display = 'flex';
            HouseRoomSelectionComponent.style.flexDirection = 'column';
            const controls = document.createElement('div');
            controls.style.display = 'flex';
            controls.style.width = '100%';
            // 下拉菜单
            const dropdown = MWI_Calculator_Calculator.createHouseRoomTypeDropdown();
            // 等级输入框
            const levelInput = document.createElement('input');
            levelInput.type = 'number';
            levelInput.min = '1';
            levelInput.max = '8';
            levelInput.step = '1';
            levelInput.value = '1';
            levelInput.placeholder = (MWI_Calculator_I18n.isChinese()) ? '等级' : 'Level';
            levelInput.style.background = '#dde2f8';
            levelInput.style.color = '#000000';
            levelInput.style.border = 'none';
            levelInput.style.borderRadius = '4px';
            levelInput.style.padding = '4px';
            levelInput.style.margin = '2px';
            Object.assign(levelInput.style, MWI_Calculator_UIStyles.quantityInput);
            // 添加按钮
            const addListButton = document.createElement('button');
            addListButton.textContent = (MWI_Calculator_I18n.isChinese()) ? '添加' : 'Add';
            addListButton.style.background = '#4CAF50';
            addListButton.style.color = MWI_Calculator_UITheme.onAction;
            addListButton.style.border = 'none';
            addListButton.style.borderRadius = '4px';
            addListButton.style.padding = '4px';
            addListButton.style.margin = '2px';
            addListButton.style.width = '35px';
            addListButton.style.cursor = 'pointer';
            // 绑定事件
            MWI_Calculator_Calculator.bindHouseRoomSelectionComponentEvents(dropdown, levelInput, addListButton);
            controls.appendChild(dropdown);
            controls.appendChild(levelInput);
            controls.appendChild(addListButton);
            MWI_Calculator_Calculator.compactSelectionControls(controls);
            HouseRoomSelectionComponent.appendChild(controls);
            return HouseRoomSelectionComponent;
        }
        static addAllHouseRooms(level = 1) {
            if (!this.canUseCharacterData()) return;
            const houseRoomDetailMap = MWI_Calculator.initClientData?.houseRoomDetailMap;
            if (!houseRoomDetailMap) return;
            const normalizedLevel = Math.min(8, Math.max(1, parseInt(level, 10) || 1));
            let addedCount = 0;
            Object.values(houseRoomDetailMap).forEach(houseRoom => {
                if (!houseRoom?.hrid) return;
                const existing = MWI_Calculator_Calculator.targetItemsMap.get(houseRoom.hrid);
                if (existing) {
                    existing.count = normalizedLevel;
                    existing.updateDisplayElement();
                }
                else {
                    MWI_Calculator_Calculator.targetItemsMap.set(houseRoom.hrid, new TargetHouseRoom(houseRoom.hrid, normalizedLevel));
                }
                addedCount++;
            });
            if (addedCount > 0) MWI_Calculator_Calculator.saveAndScheduleRender();
        }
        // 创建房屋类型下拉菜单
        static createHouseRoomTypeDropdown() {
            // 创建容器
            const dropdown = document.createElement('div');
            dropdown.style.display = 'flex';
            dropdown.style.minWidth = '20px';
            dropdown.style.flex = '1';
            dropdown.style.position = 'relative';
            // 选中项显示区
            const selected = document.createElement('div');
            selected.style.background = MWI_Calculator_UITheme.heading;
            selected.style.color = MWI_Calculator_UITheme.onAction;
            selected.style.border = 'none';
            selected.style.borderRadius = '4px';
            selected.style.paddingLeft = '4px';
            selected.style.margin = '2px';
            selected.style.minWidth = '40px';
            selected.style.flex = '1';
            selected.style.cursor = 'pointer';
            selected.style.display = 'flex';
            selected.style.alignItems = 'center';
            // 下拉菜单列表
            const list = document.createElement('div');
            list.style.background = MWI_Calculator_UITheme.surface;
            list.style.border = 'none';
            list.style.borderRadius = '4px';
            list.style.padding = '4px';
            list.style.margin = '2px';
            list.style.width = '150px';
            list.style.maxHeight = '335px';
            list.style.overflowY = 'auto';
            list.style.zIndex = '1000';
            list.style.display = 'none';
            list.style.position = 'absolute';
            list.style.left = '0px';
            list.style.top = '32px';
            const HouseRoomTypeOptions = MWI_Calculator_Calculator.createHouseRoomTypeOptions(selected, dropdown);
            HouseRoomTypeOptions.forEach(optionItem => { list.appendChild(optionItem); });
            selected.textContent = MWI_Calculator_I18n.isChinese() ? '选择房屋' : 'Select house';
            dropdown.appendChild(selected);
            dropdown.appendChild(list);
            // 点击展开/收起
            selected.addEventListener('click', (e) => {
                e.stopPropagation();
                MWI_Calculator_Calculator.toggleCalculatorDropdown(list);
            });
            MWI_Calculator_Calculator.registerCalculatorDropdown(dropdown, list);
            return dropdown;
        }
        // 创建房屋类型选项
        static createHouseRoomTypeOptions(selected, dropdown) {
            const houseRoomDetailMap = MWI_Calculator.initClientData?.houseRoomDetailMap;
            if (!houseRoomDetailMap) {
                return [];
            }
            const allOption = document.createElement('div');
            allOption.style.borderBottom = '1px solid #98a7e9';
            allOption.style.borderRadius = '4px';
            allOption.style.padding = '4px';
            allOption.style.alignItems = 'center';
            allOption.style.display = 'flex';
            allOption.style.cursor = 'pointer';
            allOption.textContent = MWI_Calculator_I18n.isChinese() ? '所有房屋' : 'All houses';
            allOption.dataset.houseRoomHrid = '__all_house_rooms__';
            allOption.addEventListener('mouseenter', () => { allOption.style.background = '#4a4c6a'; });
            allOption.addEventListener('mouseleave', () => { allOption.style.background = 'transparent'; });
            allOption.addEventListener('click', (event) => {
                event.stopPropagation();
                selected.textContent = allOption.textContent;
                dropdown.dataset.houseRoomHrid = '__all_house_rooms__';
                allOption.parentElement.style.display = 'none';
            });
            const roomOptions = Object.values(houseRoomDetailMap)
                .sort((a, b) => (a.sortIndex ?? 9999) - (b.sortIndex ?? 9999))
                .map(houseRoomDetail => {
                const optionItem = document.createElement('div');
                optionItem.style.borderBottom = '1px solid #98a7e9';
                optionItem.style.borderRadius = '4px';
                optionItem.style.padding = '4px';
                optionItem.style.alignItems = 'center';
                optionItem.style.display = 'flex';
                optionItem.style.cursor = 'pointer';
                // 房屋房间图标
                const houseRoomIcon = document.createElement('div');
                const iconHref = MWI_Calculator_Utils.getIconHrefBySkillHrid(houseRoomDetail.skillHrid);
                const svg = MWI_Calculator_Utils.createIconSvg(iconHref);
                houseRoomIcon.appendChild(svg);
                // 房屋房间名称
                const houseRoomName = document.createElement('span');
                houseRoomName.textContent = MWI_Calculator_I18n?.getName(houseRoomDetail.hrid, "houseRoomNames") || houseRoomDetail.hrid;
                houseRoomName.style.marginLeft = '2px';
                houseRoomName.style.whiteSpace = 'nowrap';
                houseRoomName.style.overflow = 'hidden';
                optionItem.appendChild(houseRoomIcon);
                optionItem.appendChild(houseRoomName);
                optionItem.addEventListener('click', () => {
                    selected.innerHTML = '';
                    const selectedIcon = houseRoomIcon.cloneNode(true);
                    selected.appendChild(selectedIcon);
                    const selectedName = houseRoomName.cloneNode(true);
                    selectedName.style.color = MWI_Calculator_UITheme.onAction;
                    selected.appendChild(selectedName);
                    dropdown.dataset.houseRoomHrid = houseRoomDetail.hrid;
                    optionItem.parentElement.style.display = 'none';
                });
                // 悬停高亮
                optionItem.addEventListener('mouseenter', () => {
                    optionItem.style.background = '#4a4c6a';
                });
                optionItem.addEventListener('mouseleave', () => {
                    optionItem.style.background = 'transparent';
                });
                optionItem.dataset.houseRoomHrid = houseRoomDetail.hrid;
                return optionItem;
            });
            return [allOption, ...roomOptions];
        }
        // 绑定房屋选择相关事件
        static bindHouseRoomSelectionComponentEvents(dropdown, levelInput, addListButton) {
            // 输入框获得焦点时全选内容
            levelInput.addEventListener('focus', function () {
                setTimeout(() => {
                    levelInput.select();
                }, 0);
            });
            // 添加按钮事件
            addListButton.addEventListener('click', () => {
                const houseRoomHrid = dropdown.dataset.houseRoomHrid;
                const level = parseInt(levelInput.value) || 1;
                if (houseRoomHrid === '__all_house_rooms__') {
                    MWI_Calculator_Calculator.addAllHouseRooms(level);
                    return;
                }
                if (!houseRoomHrid) return;
                MWI_Calculator_Calculator.updateTargetItem(houseRoomHrid, level);
            });
        }
        // 渲染物品列表
        static renderItemsDisplay() {
            MWI_Calculator_Calculator.targetItemCategoryMap.forEach((category) => {
                category.updateDisplayElement();
            });
            // 这里只需要新增或更新，删除在targetItems变动时进行处理
            MWI_Calculator_Calculator.itemCategoryList.forEach(categoryHrid => {
                const details = MWI_Calculator_Calculator.targetItemDetailsMap.get(categoryHrid);
                let lastElement = details.querySelector('summary');
                let itemCount = 0;
                [...MWI_Calculator_Calculator.targetItemsMap.values()]
                    .sort((a, b) => a.sortIndex - b.sortIndex)
                    .forEach(targetItem => {
                    if (targetItem.categoryHrid !== categoryHrid) {
                        return;
                    }
                    if (!targetItem.displayElement) {
                        MWI_Calculator_Calculator.createTargetItemDisplayElement(targetItem);
                        lastElement.insertAdjacentElement('afterend', targetItem.displayElement);
                    }
                    targetItem.updateDisplayElement();
                    lastElement = targetItem.displayElement;
                    itemCount++;
                });
                details.hidden = itemCount === 0;
            });
            const inventoryMap = MWI_Calculator_ItemsMap.getInventoryMap();
            const totalNeeds = MWI_Calculator_Calculator.calculateAllRequiredItems(new Map());
            const remainNeeds = MWI_Calculator_Calculator.calculateAllRequiredItems(inventoryMap);
            // 移除不存在的物品
            [...MWI_Calculator_Calculator.requiredItemsMap.keys()].forEach(itemHrid => {
                if (!totalNeeds.has(itemHrid)) {
                    MWI_Calculator_Calculator.requiredItemsMap.get(itemHrid)?.removeDisplayElement();
                    MWI_Calculator_Calculator.requiredItemsMap.delete(itemHrid);
                }
            });
            [...totalNeeds.keys()].forEach(itemHrid => {
                const item = MWI_Calculator_Calculator.requiredItemsMap.get(itemHrid);
                if (item) {
                    item.count = totalNeeds.get(itemHrid) || 0;
                    item.shortageCount = remainNeeds.get(itemHrid) || 0;
                    item.overflowCount = inventoryMap.get(itemHrid) || 0;
                }
                else {
                    MWI_Calculator_Calculator.requiredItemsMap.set(itemHrid, new RequiredItem(itemHrid, totalNeeds.get(itemHrid) || 0, remainNeeds.get(itemHrid) || 0, inventoryMap.get(itemHrid) || 0));
                }
            });
            MWI_Calculator_Calculator.itemCategoryList.forEach(categoryHrid => {
                const shortageDetails = MWI_Calculator_Calculator.shortageItemDetailsMap.get(categoryHrid);
                const requiredDetails = MWI_Calculator_Calculator.requiredItemDetailsMap.get(categoryHrid);
                let lastShortageElement = shortageDetails.querySelector('summary');
                let lastRequiredElement = requiredDetails.querySelector('summary');
                let shortageItemCount = 0;
                let requiredItemCount = 0;
                [...MWI_Calculator_Calculator.requiredItemsMap.values()]
                    .sort((a, b) => a.sortIndex - b.sortIndex)
                    .forEach(requiredItem => {
                    if (requiredItem.categoryHrid !== categoryHrid) {
                        return;
                    }
                    if (!requiredItem.shortageDisplayElement) {
                        MWI_Calculator_Calculator.createShortageItemDisplayElement(requiredItem);
                        lastShortageElement.insertAdjacentElement('afterend', requiredItem.shortageDisplayElement);
                    }
                    if (!requiredItem.requiredDisplayElement) {
                        MWI_Calculator_Calculator.createRequiredItemDisplayElement(requiredItem);
                        lastRequiredElement.insertAdjacentElement('afterend', requiredItem.requiredDisplayElement);
                    }
                    requiredItem.updateDisplayElement();
                    lastShortageElement = requiredItem.shortageDisplayElement;
                    lastRequiredElement = requiredItem.requiredDisplayElement;
                    shortageItemCount += requiredItem.shortageCount > 0 ? 1 : 0;
                    requiredItemCount++;
                });
                shortageDetails.hidden = shortageItemCount === 0;
                requiredDetails.hidden = requiredItemCount === 0;
            });
        }
        // 创建目标物品元素
        static createTargetItemDisplayElement(targetItem) {
            const { container, itemContainer, leftDiv, rightDiv } = MWI_Calculator_Calculator.createBaseItemDisplayItem(targetItem);
            const needCalcCheckbox = document.createElement('input');
            needCalcCheckbox.type = 'checkbox';
            container.prepend(needCalcCheckbox);
            needCalcCheckbox.addEventListener('change', () => {
                targetItem.needCalc = needCalcCheckbox.checked;
                MWI_Calculator_Calculator.saveAndScheduleRender();
            });
            // 拥有数量
            const ownedSpan = document.createElement('span');
            ownedSpan.style.padding = '4px 1px';
            ownedSpan.style.marginLeft = '4px';
            // 斜杠分隔符
            const slash = document.createElement('span');
            slash.textContent = "/";
            slash.style.padding = '4px 1px';
            // 可编辑的需求数量输入框
            const targetInput = document.createElement('input');
            targetInput.type = 'text';
            targetInput.placeholder = '需求';
            targetInput.style.background = '#dde2f8';
            targetInput.style.color = '#000000';
            targetInput.style.border = 'none';
            targetInput.style.borderRadius = '4px';
            targetInput.style.padding = '4px';
            targetInput.style.margin = '2px';
            Object.assign(targetInput.style, MWI_Calculator_UIStyles.quantityInput);
            // 绑定输入事件
            targetInput.addEventListener('input', function () {
                // 清理非数字字符
                this.value = this.value.replace(/(?!^)-|[^\d-]/g, '');
                const newCount = parseInt(this.value) || 0;
                MWI_Calculator_Calculator.updateTargetItem(targetItem.itemHrid, newCount);
            });
            // 输入框获得焦点时全选内容
            targetInput.addEventListener('focus', function () {
                setTimeout(() => {
                    targetInput.select();
                }, 0);
            });
            // 删除按钮
            const removeButton = document.createElement('button');
            MWI_Calculator_UI.styleDangerButton(removeButton);
            const iconHref = MWI_Calculator_Utils.getIconHrefByMiscHrid('remove');
            const removeSvg = MWI_Calculator_Utils.createIconSvg(iconHref);
            removeButton.appendChild(removeSvg);
            removeButton.addEventListener('click', () => {
                MWI_Calculator_Calculator.removeTargetItem(targetItem.itemHrid);
            });
            rightDiv.appendChild(ownedSpan);
            rightDiv.appendChild(slash);
            rightDiv.appendChild(targetInput);
            rightDiv.appendChild(removeButton);
            targetItem.displayElement = container;
            targetItem.needCalcCheckbox = needCalcCheckbox;
            targetItem.ownedSpan = ownedSpan;
            targetItem.targetInput = targetInput;
            leftDiv.remove();
            MWI_Calculator_UI.attachTargetLayout(container, itemContainer, rightDiv, ownedSpan, targetInput, removeButton);
            targetInput.addEventListener('input', () => MWI_Calculator_UI.scheduleTargetLayout(container));
        }
        // 创建缺口物品元素
        static createShortageItemDisplayElement(requiredItem) {
            const { container, itemContainer, leftDiv, rightDiv } = MWI_Calculator_Calculator.createBaseItemDisplayItem(requiredItem);
            // 将图标和名称包裹在可点击按钮中，按“制作/购买”枚举跳转
            const itemJumpButton = document.createElement('button');
            itemJumpButton.type = 'button';
            itemJumpButton.style.display = 'flex';
            itemJumpButton.style.alignItems = 'center';
            // 占据数量区域之前的全部剩余宽度，同时保留图标和名称的最小可见宽度
            itemJumpButton.style.flex = '1 1 auto';
            itemJumpButton.style.minWidth = '0';
            itemJumpButton.style.maxWidth = 'none';
            itemJumpButton.style.width = 'auto';
            itemJumpButton.style.padding = '0';
            itemJumpButton.style.margin = '0';
            itemJumpButton.style.border = 'none';
            itemJumpButton.style.background = 'transparent';
            itemJumpButton.style.color = 'inherit';
            itemJumpButton.style.font = 'inherit';
            itemJumpButton.style.textAlign = 'left';
            itemJumpButton.style.cursor = 'pointer';
            itemJumpButton.title = MWI_Calculator_I18n.isChinese() ? '点击跳转' : 'Click to navigate';
            itemContainer.style.cursor = 'pointer';
            itemContainer.style.width = '100%';
            itemContainer.style.minWidth = '0';
            const displayNameSpan = itemContainer.querySelector('span');
            if (displayNameSpan) {
                displayNameSpan.style.flex = '1 1 auto';
                displayNameSpan.style.minWidth = '0';
                displayNameSpan.style.overflow = 'hidden';
                displayNameSpan.style.textOverflow = 'ellipsis';
            }
            // 基础项中的空白占位仅用于非按钮项；缺口项由跳转按钮直接填充
            leftDiv?.remove();
            itemJumpButton.appendChild(itemContainer);
            container.insertBefore(itemJumpButton, container.firstChild);
            itemJumpButton.addEventListener('click', () => {
                if (MWI_Calculator_Calculator.houseAcquisitionMode === 'buy') {
                    MWI_Calculator_Calculator.TryGotoMarketplaceByRequiredItem(requiredItem);
                }
                else {
                    MWI_Calculator_Calculator.TryGotoActionDetailByRequiredItem(requiredItem);
                }
            });
            const shortageSpan = document.createElement('span');
            shortageSpan.style.background = MWI_Calculator_UITheme.heading;
            shortageSpan.style.borderRadius = '4px';
            shortageSpan.style.padding = '2px 6px';
            shortageSpan.style.marginLeft = '4px';
            // 数量区域保持自身宽度，跳转按钮仅占据其左侧剩余空间
            rightDiv.style.flex = '0 0 auto';
            rightDiv.appendChild(shortageSpan);
            requiredItem.shortageDisplayElement = container;
            requiredItem.shortageSpan = shortageSpan;
            requiredItem.itemJumpButton = itemJumpButton;
        }
        // 创建需求物品元素
        static createRequiredItemDisplayElement(requiredItem) {
            const { container, itemContainer, rightDiv } = MWI_Calculator_Calculator.createBaseItemDisplayItem(requiredItem);
            const RequiredCountDiv = document.createElement('div');
            RequiredCountDiv.style.padding = '4px 1px';
            RequiredCountDiv.style.marginLeft = '4px';
            const overflowSpan = document.createElement('span');
            const requiredSpan = document.createElement('span');
            requiredSpan.style.display = 'inline-block';
            requiredSpan.style.textAlign = 'right';
            requiredSpan.style.width = '45px';
            const slash = document.createElement('span');
            slash.textContent = '/';
            slash.style.margin = '0px 2px';
            rightDiv.appendChild(overflowSpan);
            rightDiv.appendChild(slash);
            rightDiv.appendChild(requiredSpan);
            requiredItem.requiredDisplayElement = container;
            requiredItem.overflowSpan = overflowSpan;
            requiredItem.requiredSpan = requiredSpan;
            requiredItem.displayNameSpan = itemContainer.querySelector('span');
            rightDiv.appendChild(RequiredCountDiv);
        }
        // 创建基础物品显示项（包含图标+名称+右侧区域）
        static createBaseItemDisplayItem(displayItem) {
            const container = document.createElement('div');
            container.className = 'Toolkit_Calculator_Container';
            Object.assign(container.style, MWI_Calculator_UIStyles.itemRow);
            const itemContainer = MWI_Calculator_Calculator.createItemContainer(displayItem);
            container.appendChild(itemContainer);
            const leftDiv = document.createElement('div');
            leftDiv.style.flex = '1';
            container.appendChild(leftDiv);
            // 右侧内容
            const rightDiv = document.createElement('div');
            rightDiv.style.display = 'flex';
            container.appendChild(rightDiv);
            return { container, itemContainer, leftDiv, rightDiv };
        }
        // 创建物品容器（图标+名称）
        static createItemContainer(displayItem) {
            const container = document.createElement('div');
            container.style.minWidth = '40px';
            container.style.alignItems = 'center';
            container.style.display = 'flex';
            // 物品图标
            const iconContainer = document.createElement('div');
            iconContainer.style.marginLeft = '2px';
            const svg = MWI_Calculator_Utils.createIconSvg(displayItem.iconHref);
            iconContainer.appendChild(svg);
            // 物品名称
            const displayNameSpan = document.createElement('span');
            displayNameSpan.textContent = displayItem.displayName;
            displayNameSpan.style.padding = "4px 1px";
            displayNameSpan.style.marginLeft = '2px';
            displayNameSpan.style.whiteSpace = 'nowrap';
            displayNameSpan.style.overflow = 'hidden';
            container.appendChild(iconContainer);
            container.appendChild(displayNameSpan);
            return container;
        }
        // 尝试打开动作面板
        static TryGotoActionDetailByRequiredItem(requiredItem) {
            const actionHrid = MWI_Calculator_ActionDetailPlus.getActionHrid(requiredItem.displayName)
                ?? MWI_Calculator_ActionDetailPlus.processableActionMap.get(requiredItem.itemHrid);
            if (!actionHrid) {
                return;
            }
            const { upgradeItemHrid, inputItems, outputItems } = MWI_Calculator_ActionDetailPlus.calculateActionDetail(actionHrid);
            const outputCount = outputItems.find(oi => oi.itemHrid === requiredItem.itemHrid)?.count;
            if (!outputCount) {
                return;
            }
            if (!actionHrid.includes('/milking/') && !actionHrid.includes('/foraging/') && !actionHrid.includes('/woodcutting/')) {
                // 与备料展开共用产出参数、模式和保底上限。
                const production = MWI_Calculator_ActionDetailPlus.getProductionOutputStats(
                    actionHrid, requiredItem.itemHrid, outputCount);
                const actionCount = MWI_Calculator_Calculator.getProductionActionCount(production, requiredItem.shortageCount);
                MWI_Calculator.gameObject.handleGoToAction(actionHrid, actionCount);
            }
            else {
                // 三采使用单侧99.9%正态近似增加随机产出余量
                const processedItemHrid = MWI_Calculator_ActionDetailPlus.processableItemMap.get(requiredItem.itemHrid);
                if (processedItemHrid) {
                    // 对于可加工物品，检查加工茶和工匠茶的影响
                    const processedItemOutputCount = outputItems.find(oi => oi.itemHrid === processedItemHrid)?.count || 0;
                    const processedItemShortageCount = MWI_Calculator_Calculator.requiredItemsMap.get(processedItemHrid)?.shortageCount || 0;
                    if (processedItemOutputCount !== 0 && processedItemShortageCount !== 0) {
                        const processedItemInputCount = MWI_Calculator_ActionDetailPlus.tryGetRecipe(processedItemHrid)
                            .inputs.find(ii => ii.itemHrid === requiredItem.itemHrid)?.count || 2;
                        if (requiredItem.shortageCount < (processedItemShortageCount / processedItemOutputCount * outputCount)) {
                            // 加工茶效果产物不能完全覆盖需求，按比例计算
                            const actionCount = MWI_Calculator_Calculator.getRequiredTrials999(outputCount, requiredItem.shortageCount / (outputCount + processedItemOutputCount * processedItemInputCount) * outputCount);
                            MWI_Calculator.gameObject.handleGoToAction(actionHrid, actionCount);
                        }
                        else {
                            // 加工茶效果产物可以完全覆盖需求，从原材料中扣除总数对应原料
                            const actionCount = MWI_Calculator_Calculator.getRequiredTrials999(outputCount, requiredItem.shortageCount - processedItemShortageCount * processedItemInputCount);
                            MWI_Calculator.gameObject.handleGoToAction(actionHrid, actionCount);
                        }
                        return;
                    }
                }
                // 使用单侧99.9%正态近似计算所需次数
                const actionCount = MWI_Calculator_Calculator.getRequiredTrials999(outputCount, requiredItem.shortageCount);
                MWI_Calculator.gameObject.handleGoToAction(actionHrid, actionCount);
            }
        }
        // 购买模式进入游戏市场并预选物品（独立实现）
        static TryGotoMarketplaceByRequiredItem(requiredItem) {
            const itemHrid = String(requiredItem?.itemHrid || '');
            if (!itemHrid) return false;
            const level = Number(requiredItem?.enhancementLevel) || 0;
            const resolved = MWI_Calculator_Calculator.resolveMarketplaceHandler();
            if (!resolved) return false;
            const target = itemHrid.startsWith('/items/') ? itemHrid : `/items/${itemHrid}`;
            const bareItemId = target.replace(/^\/items\//, '');
            MWI_Calculator_Calculator.marketAutoFillTarget = {
                itemHrid: target,
                quantity: Math.max(1, Math.ceil(Number(requiredItem?.shortageCount) || 1)),
                // 市场组件切换和购买弹窗渲染可能跨越多个 React 更新周期，保留目标一段时间
                expiresAt: Date.now() + 30000
            };
            MWI_Calculator_Calculator.ensureMarketAutoFillObserver();
            try {
                if (resolved.floating && typeof resolved.host.setState === 'function') {
                    resolved.host.setState({
                        showMarketplaceModal: true,
                        marketViewOverrideData: { itemHrid: target, enhancementLevel: level }
                    });
                    return true;
                }
                const argumentSets = [[target, level], [target], [bareItemId, level], [bareItemId]];
                for (const args of argumentSets) {
                    try {
                        resolved.fn.call(resolved.host, ...args);
                        return true;
                    }
                    catch { /* 尝试下一个兼容参数签名 */ }
                }
            }
            catch (error) {
                console.warn('[MWI_Calculator] 市场跳转失败', error);
            }
            return false;
        }
        // 从 React Fiber 树中查找游戏市场导航组件
        static resolveMarketplaceHandler() {
            const root = document.getElementById('root');
            const fibers = [];
            const pushFiber = value => {
                const fiber = value?.current ?? value;
                if (fiber && typeof fiber === 'object' && !fibers.includes(fiber)) fibers.push(fiber);
            };
            pushFiber(root?._reactRootContainer?.current);
            pushFiber(root?._reactRootContainer?._internalRoot?.current);
            for (const element of [root, document.body]) {
                for (const key of Object.getOwnPropertyNames(element || {})) {
                    if (key.startsWith('__reactContainer') || key.startsWith('__reactFiber') || key.startsWith('__reactInternalInstance')) pushFiber(element[key]);
                }
            }
            const seen = new Set();
            let fallback = null;
            while (fibers.length && seen.size < 50000) {
                const fiber = fibers.pop();
                if (!fiber || seen.has(fiber)) continue;
                seen.add(fiber);
                const host = fiber.stateNode;
                if (typeof host?.handleGoToMarketplace === 'function' && typeof host?.handleCloseMarketplaceModal === 'function' && typeof host?.setState === 'function') return { host, fn: host.handleGoToMarketplace, floating: true };
                const fn = host?.handleGoToMarketplace ?? host?.goToMarketplace ?? host?.openMarketplace;
                if (!fallback && typeof fn === 'function') fallback = { host, fn, floating: false };
                if (fiber.child) fibers.push(fiber.child);
                if (fiber.sibling) fibers.push(fiber.sibling);
            }
            return fallback;
        }
        // 监听市场购买弹窗并自动填入当前缺口数量。市场按钮点击后，弹窗
        // 是异步渲染的，因此不能只给按钮绑定 click 事件。
        static ensureMarketAutoFillObserver() {
            if (MWI_Calculator_Calculator.marketAutoFillObserver || typeof MutationObserver === 'undefined') {
                MWI_Calculator_Calculator.prefillMarketplacePurchaseModal();
            }
            else {
                MWI_Calculator_Calculator.marketAutoFillObserver = new MutationObserver(() => {
                    MWI_Calculator_Calculator.prefillMarketplacePurchaseModal();
                });
                const root = document.body || document.documentElement;
                if (root) {
                    MWI_Calculator_Calculator.marketAutoFillObserver.observe(root, {
                        childList: true,
                        subtree: true,
                        attributes: true,
                        attributeFilter: ['class', 'style', 'aria-hidden']
                    });
                }
            }
            MWI_Calculator_Calculator.prefillMarketplacePurchaseModal();
            // 某些版本的市场弹窗只切换既有节点的可见状态，不会产生 childList
            // 变更；短时轮询可覆盖这类 React 渲染路径。
            if (!MWI_Calculator_Calculator.marketAutoFillTimer) {
                MWI_Calculator_Calculator.marketAutoFillTimer = setInterval(() => {
                    const active = MWI_Calculator_Calculator.marketAutoFillTarget;
                    if (!active || Date.now() > active.expiresAt) {
                        clearInterval(MWI_Calculator_Calculator.marketAutoFillTimer);
                        MWI_Calculator_Calculator.marketAutoFillTimer = null;
                        return;
                    }
                    MWI_Calculator_Calculator.prefillMarketplacePurchaseModal();
                }, 100);
            }
        }
        static prefillMarketplacePurchaseModal() {
            let target = MWI_Calculator_Calculator.marketAutoFillTarget;
            if (target && Date.now() > target.expiresAt) {
                MWI_Calculator_Calculator.marketAutoFillTarget = null;
                target = null;
            }
            const visible = element => element && element.getClientRects && element.getClientRects().length > 0;
            const modals = document.querySelectorAll('[class*="MarketplacePanel_modalContent"]');
            for (const modal of modals) {
                if (!visible(modal)) continue;
                const header = modal.querySelector('[class*="MarketplacePanel_header"]')?.textContent || '';
                if (!/立即购买|购买挂牌|购买订单|buy|purchase/i.test(header)) continue;
                const use = modal.querySelector('svg use');
                const href = use?.getAttribute('href') || use?.getAttribute('xlink:href') || '';
                const rawId = String(href).split('#').pop()?.replace(/^\/items\//, '') || '';
                if (!rawId) continue;
                const modalItemHrid = `/items/${rawId}`;
                const targetItemHrid = target ? String(target.itemHrid).replace(/^([^/])/, '/$1') : '';
                if (target && modalItemHrid !== targetItemHrid) continue;
                // 未通过缺口按钮跳转时，直接从当前缺口清单匹配物品和数量
                const shortage = MWI_Calculator_Calculator.requiredItemsMap?.get(modalItemHrid);
                const quantity = target ? target.quantity : Number(shortage?.shortageCount) || 0;
                if (!quantity || (!target && !shortage)) continue;
                if (modal.dataset.mwiCalculatorPrefilled === modalItemHrid) continue;
                const input = [...modal.querySelectorAll('[class*="MarketplacePanel_quantityInputs"] input, input[type="number"]')].find(visible);
                if (!input) continue;
                const value = String(quantity);
                try {
                    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
                    if (setter) setter.call(input, value);
                    else input.value = value;
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                    modal.dataset.mwiCalculatorPrefilled = modalItemHrid;
                    MWI_Calculator_Calculator.marketAutoFillTarget = null;
                    return true;
                }
                catch (error) {
                    console.debug('[MWI_Calculator] 市场数量填充失败', error);
                }
            }
            return false;
        }
        // 制作备料与跳转共用：冗余取概率次数，极限取平均次数；均不超过保底次数。
        static getProductionActionCount(recipe, target) {
            const count = this.getRequiredTrials999(recipe.outputCount, target,
                this.materialPlanningMode === 'redundant' ? (recipe.outputStdDev || 0) : 0);
            const minimum = recipe.minimumOutputCount;
            return Number.isFinite(minimum) && minimum > 0
                ? Math.min(count, Math.max(0, Math.ceil(target / minimum))) : count;
        }
        // 单侧99.9%正态近似；默认标准差沿用0.3mu估算，并非实际掉落分布保证。
        static getRequiredTrials999(mu, target, stdDev = 0.3 * mu) {
            if (!Number.isFinite(target)) throw new RangeError('Invalid target');
            if (target <= 0) return 0;
            if (!Number.isFinite(mu) || mu <= 0 || !Number.isFinite(stdDev) || stdDev < 0) {
                throw new RangeError('Invalid output distribution');
            }
            if (stdDev === 0) return Math.ceil(target / mu);
            const margin = 3.090232306167813 * stdDev;
            // 解 n*mu - z*stdDev*sqrt(n) >= target，向上取整。
            const x = (margin + Math.sqrt(margin * margin + 4 * mu * target)) / (2 * mu);
            return Math.ceil(x * x);
        }
    }
    MWI_Calculator_Calculator.targetItemCategoryMap = new Map();
    MWI_Calculator_Calculator.targetItemsMap = new Map();
    MWI_Calculator_Calculator.requiredItemsMap = new Map();
    MWI_Calculator_Calculator.houseAcquisitionMode = 'craft';
    MWI_Calculator_Calculator.materialPlanningMode = 'redundant';
    MWI_Calculator_Calculator.tabButton = null;
    MWI_Calculator_Calculator.tabPanel = null;
    MWI_Calculator_Calculator.targetItemDetailsMap = new Map();
    MWI_Calculator_Calculator.shortageItemDetailsMap = new Map();
    MWI_Calculator_Calculator.requiredItemDetailsMap = new Map();
    MWI_Calculator_Calculator.itemCategoryList = [
        '/item_categories/house_rooms',
        '/item_categories/currency',
        '/item_categories/loot',
        '/item_categories/key',
        '/item_categories/labyrinth',
        "/item_categories/dungeon_key",
        '/item_categories/food',
        '/item_categories/tea',
        '/item_categories/coffee',
        '/item_categories/drink',
        '/item_categories/ability_book',
        '/item_categories/equipment',
        '/item_categories/materials',
        '/item_categories/resource'
    ];
    MWI_Calculator_Calculator.renderTimeout = null;
    MWI_Calculator_Calculator.marketAutoFillTarget = null;
    MWI_Calculator_Calculator.marketAutoFillObserver = null;
    MWI_Calculator_Calculator.marketAutoFillTimer = null;
    //#endregion
    //#region ActionDetailPlus
    class UpgradeItemComponent {
    }
    class InputItemComponent {
    }
    class OutputItemComponent {
    }
    class ProcessingTeaComponent {
    }
    class MWI_Calculator_ActionDetailPlus {
        // 初始化监听器
        static initialize() {
            let lastPanel = null;
            const observer = new MutationObserver(() => {
                const panel = document.querySelector('[class^="SkillActionDetail_regularComponent"]');
                if (panel && panel !== lastPanel) {
                    lastPanel = panel;
                    setTimeout(() => {
                        MWI_Calculator_ActionDetailPlus.enhanceSkillActionDetail();
                    }, 50);
                }
            });
            observer.observe(document.body, { childList: true, subtree: true });
        }
        // 增强技能动作详情面板
        static enhanceSkillActionDetail() {
            const actionName = MWI_Calculator_ActionDetailPlus.getActionName();
            const actionHrid = MWI_Calculator_ActionDetailPlus.getActionHrid(actionName);
            const { upgradeItemHrid, inputItems, outputItems } = MWI_Calculator_ActionDetailPlus.calculateActionDetail(actionHrid);
            const skillActionTimeInput = document.querySelector('[class^="SkillActionDetail_maxActionCountInput"]').querySelector('input');
            const skillActionTimeButtons = document.querySelector('[class^="SkillActionDetail_maxActionCountInput"]').querySelectorAll('button');
            MWI_Calculator_ActionDetailPlus.createUpgradeItemComponent(upgradeItemHrid);
            MWI_Calculator_ActionDetailPlus.createInputItemComponents(inputItems);
            MWI_Calculator_ActionDetailPlus.createOutputItemComponents(outputItems);
            // 联动
            let linking = false;
            function updateSkillActionDetail(e) {
                if (linking)
                    return;
                linking = true;
                const target = e.target;
                const index = MWI_Calculator_ActionDetailPlus.outputItemComponents.findIndex(component => component.outputItemInput === target);
                const targetValue = parseInt(target.value, 10);
                if (index !== -1) {
                    skillActionTimeInput.value = (isNaN(targetValue)) ? '∞' : Math.ceil(targetValue / MWI_Calculator_ActionDetailPlus.outputItemComponents[index].count).toString();
                    MWI_Calculator_Utils.reactInputTriggerHack(skillActionTimeInput);
                }
                const skillActionTimes = parseInt(skillActionTimeInput.value, 10);
                MWI_Calculator_ActionDetailPlus.outputItemComponents.forEach(component => {
                    if (component.outputItemInput !== target) {
                        component.outputItemInput.value = (isNaN(skillActionTimes)) ? '∞' : Math.ceil(skillActionTimes * component.count).toString();
                    }
                });
                MWI_Calculator_ActionDetailPlus.inputItemComponents.forEach(component => {
                    const inventoryCount = MWI_Calculator_ItemsMap.getCount(component.itemHrid);
                    const requiredCount = component.count * skillActionTimes;
                    if (isNaN(skillActionTimes)) {
                        component.shortageCountSpan.textContent = '';
                        component.inventoryCountSpan.style.color = '';
                    }
                    else {
                        if (requiredCount > inventoryCount) {
                            component.shortageCountSpan.textContent = MWI_Calculator_Utils.formatNumber(requiredCount - inventoryCount);
                            component.inventoryCountSpan.style.color = MWI_Calculator_UITheme.danger;
                        }
                        else {
                            component.shortageCountSpan.textContent = ' ';
                            component.inventoryCountSpan.style.color = '#E7E7E7';
                        }
                    }
                    component.inputCountSpan.textContent = '\u00A0/ ' + MWI_Calculator_Utils.formatNumber(component.count * ((isNaN(skillActionTimes) ? 1 : skillActionTimes))) + '\u00A0';
                });
                if (MWI_Calculator_ActionDetailPlus.upgradeItemComponent) {
                    if (isNaN(skillActionTimes)) {
                        MWI_Calculator_ActionDetailPlus.upgradeItemComponent.shortageCountSpan.textContent = '';
                    }
                    else {
                        const requiredCount = MWI_Calculator_ActionDetailPlus.upgradeItemComponent.count * skillActionTimes;
                        const inventoryCount = MWI_Calculator_ItemsMap.getCount(MWI_Calculator_ActionDetailPlus.upgradeItemComponent.itemHrid);
                        if (requiredCount > inventoryCount) {
                            MWI_Calculator_ActionDetailPlus.upgradeItemComponent.shortageCountSpan.textContent = MWI_Calculator_Utils.formatNumber(requiredCount - inventoryCount);
                        }
                        else {
                            MWI_Calculator_ActionDetailPlus.upgradeItemComponent.shortageCountSpan.textContent = ' ';
                        }
                    }
                }
                if (MWI_Calculator_ActionDetailPlus.processingTeaComponent) {
                    MWI_Calculator_ActionDetailPlus.processingTeaComponent.CountSpan.textContent =
                        (isNaN(skillActionTimes)) ? '∞' : Math.ceil(skillActionTimes * MWI_Calculator_ActionDetailPlus.processingTeaComponent.count).toString();
                }
                linking = false;
            }
            // React 受控输入会在当前事件结束后才提交状态；使用下一帧统一刷新，避免预期产物滞后一拍
            let refreshFramePending = false;
            let pendingTarget = skillActionTimeInput;
            const scheduleSkillActionDetailRefresh = (target = skillActionTimeInput) => {
                pendingTarget = target || skillActionTimeInput;
                if (refreshFramePending)
                    return;
                refreshFramePending = true;
                const refresh = () => {
                    refreshFramePending = false;
                    const targetToRefresh = pendingTarget;
                    pendingTarget = skillActionTimeInput;
                    updateSkillActionDetail({ target: targetToRefresh, deferred: true });
                };
                if (typeof requestAnimationFrame === 'function')
                    requestAnimationFrame(refresh);
                else
                    setTimeout(refresh, 0);
            };
            skillActionTimeInput.addEventListener('input', event => scheduleSkillActionDetailRefresh(event.target));
            skillActionTimeInput.addEventListener('change', event => scheduleSkillActionDetailRefresh(event.target));
            MWI_Calculator_ActionDetailPlus.outputItemComponents.forEach(component => {
                component.outputItemInput.addEventListener('input', event => scheduleSkillActionDetailRefresh(event.target));
                component.outputItemInput.addEventListener('change', event => scheduleSkillActionDetailRefresh(event.target));
            });
            skillActionTimeButtons.forEach(btn => {
                btn.addEventListener('click', () => {
                    scheduleSkillActionDetailRefresh(skillActionTimeInput);
                });
            });
            MWI_Calculator_ItemsMap.itemsUpdatedCallbacks.push(() => {
                scheduleSkillActionDetailRefresh(skillActionTimeInput);
            });
            // 初次填充
            scheduleSkillActionDetailRefresh(skillActionTimeInput);
        }
        // 创建升级物品组件
        static createUpgradeItemComponent(upgradeItemHrid) {
            MWI_Calculator_ActionDetailPlus.upgradeItemComponent = null;
            if (!upgradeItemHrid) {
                return;
            }
            const shortageCountContainer = document.querySelector('[class^="SkillActionDetail_upgradeItemSelectorInput"]')?.parentElement?.previousElementSibling;
            if (!shortageCountContainer) {
                return;
            }
            const newTextSpan = document.createElement('span');
            newTextSpan.textContent = shortageCountContainer.textContent;
            newTextSpan.style.height = window.getComputedStyle(document.querySelector('[class*="SkillActionDetail_levelRequirement"]')).height;
            shortageCountContainer.innerHTML = '';
            shortageCountContainer.appendChild(newTextSpan);
            const shortageCountDiv = document.createElement('div');
            shortageCountDiv.style.display = 'flex';
            shortageCountDiv.style.alignItems = 'flex-end';
            shortageCountDiv.style.flexDirection = 'column';
            const shortageCountSpan = document.createElement('span');
            shortageCountSpan.style.display = 'flex';
            shortageCountSpan.style.alignItems = 'center';
            shortageCountSpan.style.color = '#faa21e';
            shortageCountDiv.appendChild(shortageCountSpan);
            shortageCountContainer.appendChild(shortageCountDiv);
            MWI_Calculator_ActionDetailPlus.upgradeItemComponent = new UpgradeItemComponent();
            MWI_Calculator_ActionDetailPlus.upgradeItemComponent.itemHrid = upgradeItemHrid;
            MWI_Calculator_ActionDetailPlus.upgradeItemComponent.count = 1; // 升级物品固定需求1个
            MWI_Calculator_ActionDetailPlus.upgradeItemComponent.shortageCountSpan = shortageCountSpan;
        }
        // 创建所有输入物品组件
        static createInputItemComponents(inputItems) {
            MWI_Calculator_ActionDetailPlus.inputItemComponents = new Array();
            if (!inputItems || inputItems.length === 0) {
                return;
            }
            const inputItemComponentContainer = document.querySelector('[class^="SkillActionDetail_itemRequirements"]');
            const shortageCountContainer = inputItemComponentContainer?.parentElement?.previousElementSibling;
            if (shortageCountContainer) {
                const newTextSpan = document.createElement('span');
                newTextSpan.textContent = shortageCountContainer.textContent;
                newTextSpan.style.height = window.getComputedStyle(document.querySelector('[class*="SkillActionDetail_levelRequirement"]')).height;
                const shortageCountComponent = document.createElement('div');
                shortageCountComponent.style.display = 'flex';
                shortageCountComponent.style.alignItems = 'flex-end';
                shortageCountComponent.style.flexDirection = 'column';
                shortageCountContainer.innerHTML = '';
                shortageCountContainer.appendChild(newTextSpan);
                shortageCountContainer.appendChild(shortageCountComponent);
                const inventoryCountSpans = inputItemComponentContainer?.querySelectorAll('[class*="SkillActionDetail_inventoryCount"]');
                const inputCountSpans = inputItemComponentContainer?.querySelectorAll('[class*="SkillActionDetail_inputCount"]');
                const itemContainers = inputItemComponentContainer?.querySelectorAll('[class*="Item_itemContainer"]');
                for (let i = 0; i < itemContainers.length; i++) {
                    inputCountSpans[i].style.color = '#E7E7E7';
                    const inputItemHrid = '/items/' + itemContainers[i].querySelector('svg use').getAttribute('href').split('#').pop();
                    const inputItemCount = inputItems.find(item => item.itemHrid === inputItemHrid)?.count || 0;
                    const shortageCountSpan = document.createElement('span');
                    shortageCountSpan.style.height = window.getComputedStyle(itemContainers[i]).height;
                    shortageCountSpan.style.display = 'flex';
                    shortageCountSpan.style.alignItems = 'center';
                    shortageCountSpan.style.color = '#faa21e';
                    shortageCountComponent.appendChild(shortageCountSpan);
                    const inputItemComponent = new InputItemComponent();
                    inputItemComponent.itemHrid = inputItemHrid;
                    inputItemComponent.count = inputItemCount;
                    inputItemComponent.shortageCountSpan = shortageCountSpan;
                    inputItemComponent.inventoryCountSpan = inventoryCountSpans[i];
                    inputItemComponent.inputCountSpan = inputCountSpans[i];
                    MWI_Calculator_ActionDetailPlus.inputItemComponents.push(inputItemComponent);
                }
            }
        }
        // 创建所有输出物品组件
        static createOutputItemComponents(outputItems) {
            MWI_Calculator_ActionDetailPlus.outputItemComponents = Array();
            MWI_Calculator_ActionDetailPlus.processingTeaComponent = null;
            let lastOutputItemComponent = document.querySelector('[class^="SkillActionDetail_maxActionCountInput"]');
            for (const outputItem of outputItems) {
                if (outputItem.count === 1 && outputItems.length === 1)
                    break; // 仅有一个产出且数量为1时不创建额外输入框
                const processedItemHrid = [...MWI_Calculator_ActionDetailPlus.processableItemMap.values()].find(v => v === outputItem.itemHrid);
                if (processedItemHrid) {
                    // 加工茶产物
                    const processedItemComponent = MWI_Calculator_ActionDetailPlus.createProcessingTeaComponent(outputItem, outputItems);
                    lastOutputItemComponent.insertAdjacentElement('afterend', processedItemComponent);
                    lastOutputItemComponent = processedItemComponent;
                }
                else {
                    // 直接采集产物
                    const outputItemComponent = MWI_Calculator_ActionDetailPlus.createOutputItemComponent(outputItem);
                    lastOutputItemComponent.insertAdjacentElement('afterend', outputItemComponent);
                    lastOutputItemComponent = outputItemComponent;
                }
            }
        }
        // 创建输出物品组件
        static createOutputItemComponent(outputItem) {
            const origComponent = document.querySelector('[class^="SkillActionDetail_maxActionCountInput"]');
            if (!origComponent)
                return null;
            // 克隆外层div（不带子内容）
            const component = origComponent.cloneNode(false);
            const originalActionLabel = document.querySelector('[class^="SkillActionDetail_actionContainer"] [class^="SkillActionDetail_label"]');
            // 物品图标
            const itemIcon = document.createElement('div');
            itemIcon.style.width = window.getComputedStyle(originalActionLabel).width;
            itemIcon.style.marginRight = '2px';
            itemIcon.style.display = 'flex';
            itemIcon.style.alignItems = 'center';
            itemIcon.style.justifyContent = 'center';
            const iconHref = MWI_Calculator_Utils.getIconHrefByItemHrid(outputItem.itemHrid);
            const svg = MWI_Calculator_Utils.createIconSvg(iconHref);
            itemIcon.appendChild(svg);
            component.appendChild(itemIcon);
            // 输入框
            const origInputWrap = origComponent.querySelector('[class^="SkillActionDetail_input"]');
            const inputWrap = origInputWrap.cloneNode(true);
            const origInput = origInputWrap.querySelector('input');
            const input = inputWrap.querySelector('input');
            input.addEventListener('focus', () => { input.select(); });
            input.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' && origInput) {
                    origInput.dispatchEvent(event);
                }
            });
            component.appendChild(inputWrap);
            // 快捷填充按钮
            const btns = [
                { val: 1000, txt: '1k' },
                { val: 2000, txt: '2k' },
                { val: 5000, txt: '5k' }
            ];
            const origButtons = origComponent.querySelectorAll('button');
            const buttonClass = origButtons.length > 0 ? origButtons[0].className : '';
            btns.forEach(({ val, txt }) => {
                const btn = document.createElement('button');
                btn.className = buttonClass;
                btn.textContent = txt;
                btn.addEventListener('click', () => {
                    input.value = val.toString();
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                });
                component.appendChild(btn);
            });
            const outputItemComponent = new OutputItemComponent();
            outputItemComponent.count = outputItem.count;
            outputItemComponent.outputItemInput = input;
            MWI_Calculator_ActionDetailPlus.outputItemComponents.push(outputItemComponent);
            return component;
        }
        // 创建加工茶产出组件
        static createProcessingTeaComponent(processedItem, outputItems) {
            const origComponent = document.querySelector('[class^="SkillActionDetail_maxActionCountInput"]');
            if (!origComponent)
                return null;
            // 克隆外层div（不带子内容）
            const component = origComponent.cloneNode(false);
            // 制表符
            const originalActionLabel = document.querySelector('[class^="SkillActionDetail_actionContainer"] [class^="SkillActionDetail_label"]');
            const tab = originalActionLabel.cloneNode(false);
            tab.textContent = '┗';
            tab.style.width = '24px';
            component.appendChild(tab);
            // 物品图标
            const itemIcon = document.createElement('div');
            itemIcon.style.width = '24px';
            itemIcon.style.marginRight = '2px';
            itemIcon.style.display = 'flex';
            itemIcon.style.alignItems = 'center';
            itemIcon.style.justifyContent = 'center';
            const iconHref = MWI_Calculator_Utils.getIconHrefByItemHrid(processedItem.itemHrid);
            const svg = MWI_Calculator_Utils.createIconSvg(iconHref);
            itemIcon.appendChild(svg);
            component.appendChild(itemIcon);
            // 输入框
            const origInputWrap = origComponent.querySelector('[class^="SkillActionDetail_input"]');
            const origInput = origInputWrap.querySelector('input');
            const inputWrap = origInputWrap.cloneNode(true);
            const input = inputWrap.querySelector('input');
            input.disabled = (processedItem.count === 0);
            input.addEventListener('focus', () => { input.select(); });
            input.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' && origInput) {
                    origInput.dispatchEvent(event);
                }
            });
            component.appendChild(inputWrap);
            const outputItemComponent = new OutputItemComponent();
            outputItemComponent.count = processedItem.count;
            outputItemComponent.outputItemInput = input;
            MWI_Calculator_ActionDetailPlus.outputItemComponents.push(outputItemComponent);
            const processableItemHrid = [...MWI_Calculator_ActionDetailPlus.processableItemMap.entries()]
                .find(([, v]) => v === processedItem.itemHrid)?.[0];
            const processableItem = outputItems.find(oi => oi.itemHrid === processableItemHrid);
            const recipeInputItem = MWI_Calculator_ActionDetailPlus.tryGetRecipe(processedItem.itemHrid).inputs[0];
            const slash1 = document.createElement('span');
            slash1.textContent = '+';
            slash1.style.margin = '0px 2px';
            const processingTeaSpan = document.createElement('span');
            const slash2 = document.createElement('span');
            slash2.textContent = '=';
            slash2.style.margin = '0px 2px';
            component.appendChild(slash1);
            component.appendChild(processingTeaSpan);
            component.appendChild(slash2);
            const processingTeaComponent = new ProcessingTeaComponent();
            processingTeaComponent.count = processableItem.count / recipeInputItem.count;
            processingTeaComponent.CountSpan = processingTeaSpan;
            MWI_Calculator_ActionDetailPlus.processingTeaComponent = processingTeaComponent;
            const totalInputWrap = origInputWrap.cloneNode(true);
            const totalInput = totalInputWrap.querySelector('input');
            totalInput.addEventListener('focus', () => { totalInput.select(); });
            totalInput.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' && origInput) {
                    origInput.dispatchEvent(event);
                }
            });
            component.appendChild(totalInputWrap);
            const totalItemComponent = new OutputItemComponent();
            totalItemComponent.count = processedItem.count + processableItem.count / recipeInputItem.count;
            totalItemComponent.outputItemInput = totalInput;
            MWI_Calculator_ActionDetailPlus.outputItemComponents.push(totalItemComponent);
            return component;
        }
        // 获取物品配方
        static tryGetRecipe(itemHrid) {
            const itemName = itemHrid.split('/').pop() || '';
            // 检查商店兑换
            const shopHrid = `/shop_items/${itemName}`;
            if (MWI_Calculator.initClientData?.shopItemDetailMap?.hasOwnProperty(shopHrid)) {
                const shopItemDetail = MWI_Calculator.initClientData?.shopItemDetailMap[shopHrid];
                if (shopItemDetail.category === "/shop_categories/dungeon") {
                    const recipe = { inputs: new Array, outputCount: 1 };
                    shopItemDetail.costs.forEach(cost => {
                        recipe.inputs.push({ itemHrid: cost.itemHrid, count: cost.count });
                    });
                    return recipe;
                }
            }
            // 检查制造配方
            const actionTypes = ["cheesesmithing", "crafting", "tailoring", "cooking", "brewing"];
            for (const actionType of actionTypes) {
                const actionHrid = `/actions/${actionType}/${itemName}`;
                if (MWI_Calculator.initClientData?.actionDetailMap?.hasOwnProperty(actionHrid)) {
                    // 复用 MWI_Calculator_ActionDetailPlus 的计算逻辑以获得输入/输出（考虑茶水等加成在 calculateRequiredItems 中已处理）
                    const { upgradeItemHrid, inputItems, outputItems } = MWI_Calculator_ActionDetailPlus.calculateActionDetail(actionHrid);
                    if (upgradeItemHrid) {
                        inputItems.push({ itemHrid: upgradeItemHrid, count: 1 });
                    } // 升级物品固定需求数量1，添加到输入中
                    let outputCount = 1;
                    if (outputItems && outputItems.length > 0) {
                        const matching = outputItems.find(o => o.itemHrid === itemHrid);
                        if (matching)
                            outputCount = matching.count || 1;
                    }
                    return { inputs: inputItems,
                        ...MWI_Calculator_ActionDetailPlus.getProductionOutputStats(actionHrid, itemHrid, outputCount) };
                }
            }
            return null;
        }
        // 保底只读取制造配方的固定outputItems，不将三采平均掉落当成保底。
        static getProductionOutputStats(actionHrid, itemHrid, outputCount) {
            const actionType = actionHrid.split('/')[2];
            const production = ['cheesesmithing', 'crafting', 'tailoring', 'cooking', 'brewing'].includes(actionType);
            const baseOutput = production
                ? MWI_Calculator_ActionDetailPlus.getActionDetail(actionHrid)?.outputItems?.find(item => item.itemHrid === itemHrid)?.count
                : 0;
            const randomOutput = ['cooking', 'brewing'].includes(actionType)
                && MWI_Calculator_ActionDetailPlus.getActionTypeDrinkSlots(actionType).includes('/items/gourmet_tea');
            return { outputCount, outputStdDev: randomOutput ? 0.3 * outputCount : 0,
                minimumOutputCount: Number.isFinite(baseOutput) && baseOutput > 0 ? baseOutput : 0 };
        }
        // 计算动作详情
        static calculateActionDetail(actionHrid) {
            const actionDetail = MWI_Calculator_ActionDetailPlus.getActionDetail(actionHrid);
            const actionType = actionDetail?.type?.split('/').pop() || '';
            // 仅支持八种常规类型
            if (!actionDetail || !actionType || !['milking', 'foraging', 'woodcutting', 'cheesesmithing', 'crafting', 'tailoring', 'cooking', 'brewing'].includes(actionType)) {
                console.warn('[MWI_Calculator] 无法获取动作详情' + actionHrid);
                return { upgradeItemHrid: null, inputItems: [], outputItems: [] };
            }
            // console.log('MWI_Calculator_ActionDetailPlus: 获取到动作详情', actionDetail);
            const upgradeItemHrid = actionDetail.upgradeItemHrid;
            const inputItems = actionDetail.inputItems ? JSON.parse(JSON.stringify(actionDetail.inputItems)) : Array();
            const outputItems = actionDetail.outputItems ? JSON.parse(JSON.stringify(actionDetail.outputItems)) : Array();
            const drinkSlots = MWI_Calculator_ActionDetailPlus.getActionTypeDrinkSlots(actionType);
            const drinkConcentration = MWI_Calculator_ActionDetailPlus.getDrinkConcentration();
            // console.log('MWI_Calculator_ActionDetailPlus: 获取到茶列表', drinkSlots, drinkConcentration);
            // 检查采集数量加成
            const gatheringBuff = (drinkSlots?.some(itemHrid => itemHrid === '/items/gathering_tea') ? 0.15 * drinkConcentration : 0)
                + MWI_Calculator_ActionDetailPlus.getEquipmentGatheringBuff() + MWI_Calculator_ActionDetailPlus.getCommunityGatheringBuff();
            // 检查加工茶加成
            const processingBuff = (drinkSlots?.some(itemHrid => itemHrid === '/items/processing_tea') ? 0.15 * drinkConcentration : 0);
            // 检查美食茶加成
            const gourmetBuff = (drinkSlots?.some(itemHrid => itemHrid === '/items/gourmet_tea') ? 0.12 * drinkConcentration : 0);
            // 检查工匠茶加成
            const artisanBuff = (drinkSlots?.some(itemHrid => itemHrid === '/items/artisan_tea') ? 0.1 * drinkConcentration : 0);
            if (['milking', 'foraging', 'woodcutting', /*'cheesesmithing', 'crafting', 'tailoring', 'cooking', 'brewing'*/].includes(actionType)) {
                const dropTable = actionDetail.dropTable;
                for (const dropItem of dropTable) {
                    const averageCount = dropItem.dropRate * (dropItem.minCount + dropItem.maxCount) / 2 * (1 + gatheringBuff);
                    const processedItemHrid = MWI_Calculator_ActionDetailPlus.processableItemMap.get(dropItem.itemHrid);
                    if (processedItemHrid) {
                        outputItems.push({ itemHrid: dropItem.itemHrid, count: averageCount * (1 - processingBuff), });
                        outputItems.push({ itemHrid: processedItemHrid, count: averageCount * processingBuff / 2, });
                    }
                    else {
                        outputItems.push({ itemHrid: dropItem.itemHrid, count: averageCount, });
                    }
                }
            }
            if ([/*'milking', 'foraging', 'woodcutting', 'cheesesmithing', 'crafting', 'tailoring',*/ 'cooking', 'brewing'].includes(actionType)) {
                for (const outputItem of outputItems) {
                    outputItem.count = outputItem.count * (1 + gourmetBuff);
                }
            }
            if ([/*'milking', 'foraging', 'woodcutting',*/ 'cheesesmithing', 'crafting', 'tailoring', 'cooking', 'brewing'].includes(actionType)) {
                for (const inputItem of inputItems) {
                    inputItem.count = inputItem.count * (1 - artisanBuff);
                    // 仅工匠茶的非整数消耗有随机取整方差；过滤浮点误差。
                    const nearest = Math.round(inputItem.count);
                    const fractional = Math.abs(inputItem.count - nearest) < 1e-9
                        ? 0 : inputItem.count - Math.floor(inputItem.count);
                    inputItem.consumptionVariance = artisanBuff > 0 ? fractional * (1 - fractional) : 0;
                }
            }
            return { upgradeItemHrid, inputItems, outputItems };
        }
        // 获取当前动作名称
        static getActionName() {
            const actionNameDiv = document.querySelector('[class^="SkillActionDetail_name"]');
            return actionNameDiv ? actionNameDiv.textContent : '';
        }
        // 获取动作HRID
        static getActionHrid(actionName) {
            return MWI_Calculator_I18n.getHridByName(actionName, 'actionNames');
        }
        // 获取动作详情
        static getActionDetail(actionHrid) {
            return MWI_Calculator.initClientData?.actionDetailMap?.[`${actionHrid}`];
        }
        // 获取动作类型对应的饮品栏物品列表
        static getActionTypeDrinkSlots(actionType) {
            if (!actionType) {
                return [];
            }
            const drinkSlots = [];
            MWI_Calculator.gameObject?.state?.actionTypeDrinkSlotsDict?.[`/action_types/${actionType}`].forEach(drink => {
                if (drink && drink.itemHrid) {
                    drinkSlots.push(drink.itemHrid);
                }
            });
            // 对三采添加对应的工匠茶数据用于计算加工数量
            const processActionType = { milking: 'cheesesmithing', foraging: 'tailoring', woodcutting: 'crafting' }[actionType] || null;
            if (processActionType) {
                const processDrinkSlots = MWI_Calculator.gameObject?.state?.actionTypeDrinkSlotsDict?.[`/action_types/${processActionType}`];
                processDrinkSlots.forEach(drink => {
                    if (drink && drink.itemHrid == '/items/artisan_tea') {
                        drinkSlots.push(drink.itemHrid);
                    }
                });
            }
            return drinkSlots;
        }
        // 获取饮品浓缩倍率
        static getDrinkConcentration() {
            const enhancementLevel = MWI_Calculator_ItemsMap.getMaxEnhancementLevel("/items/guzzling_pouch");
            if (enhancementLevel != -1) {
                return 1
                    + MWI_Calculator.initClientData?.itemDetailMap?.[`/items/guzzling_pouch`].equipmentDetail.noncombatStats.drinkConcentration
                    + MWI_Calculator.initClientData?.itemDetailMap?.[`/items/guzzling_pouch`].equipmentDetail.noncombatEnhancementBonuses.drinkConcentration
                        * MWI_Calculator.initClientData?.enhancementLevelTotalBonusMultiplierTable[enhancementLevel];
            }
            return 1;
        }
        // 获取装备采集数量加成
        static getEquipmentGatheringBuff() {
            let equipmentGatheringBuff = 0;
            const philosophers_earrings_enhancementLevel = MWI_Calculator_ItemsMap.getMaxEnhancementLevel("/items/philosophers_earrings");
            const earrings_of_gathering_enhancementLevel = MWI_Calculator_ItemsMap.getMaxEnhancementLevel("/items/earrings_of_gathering");
            const philosophers_ring_enhancementLevel = MWI_Calculator_ItemsMap.getMaxEnhancementLevel("/items/philosophers_ring");
            const ring_of_gathering_enhancementLevel = MWI_Calculator_ItemsMap.getMaxEnhancementLevel("/items/ring_of_gathering");
            if (philosophers_earrings_enhancementLevel != -1) {
                equipmentGatheringBuff = equipmentGatheringBuff
                    + MWI_Calculator.initClientData?.itemDetailMap?.[`/items/philosophers_earrings`].equipmentDetail.noncombatStats.gatheringQuantity
                    + MWI_Calculator.initClientData?.itemDetailMap?.[`/items/philosophers_earrings`].equipmentDetail.noncombatEnhancementBonuses.gatheringQuantity
                        * MWI_Calculator.initClientData?.enhancementLevelTotalBonusMultiplierTable[philosophers_earrings_enhancementLevel];
            }
            else if (earrings_of_gathering_enhancementLevel != -1) {
                equipmentGatheringBuff = equipmentGatheringBuff
                    + MWI_Calculator.initClientData?.itemDetailMap?.[`/items/earrings_of_gathering`].equipmentDetail.noncombatStats.gatheringQuantity
                    + MWI_Calculator.initClientData?.itemDetailMap?.[`/items/earrings_of_gathering`].equipmentDetail.noncombatEnhancementBonuses.gatheringQuantity
                        * MWI_Calculator.initClientData?.enhancementLevelTotalBonusMultiplierTable[earrings_of_gathering_enhancementLevel];
            }
            if (philosophers_ring_enhancementLevel != -1) {
                equipmentGatheringBuff = equipmentGatheringBuff
                    + MWI_Calculator.initClientData?.itemDetailMap?.[`/items/philosophers_ring`].equipmentDetail.noncombatStats.gatheringQuantity
                    + MWI_Calculator.initClientData?.itemDetailMap?.[`/items/philosophers_ring`].equipmentDetail.noncombatEnhancementBonuses.gatheringQuantity
                        * MWI_Calculator.initClientData?.enhancementLevelTotalBonusMultiplierTable[philosophers_ring_enhancementLevel];
            }
            else if (ring_of_gathering_enhancementLevel != -1) {
                equipmentGatheringBuff = equipmentGatheringBuff
                    + MWI_Calculator.initClientData?.itemDetailMap?.[`/items/ring_of_gathering`].equipmentDetail.noncombatStats.gatheringQuantity
                    + MWI_Calculator.initClientData?.itemDetailMap?.[`/items/ring_of_gathering`].equipmentDetail.noncombatEnhancementBonuses.gatheringQuantity
                        * MWI_Calculator.initClientData?.enhancementLevelTotalBonusMultiplierTable[ring_of_gathering_enhancementLevel];
            }
            return equipmentGatheringBuff;
        }
        // 获取社区采集数量加成
        static getCommunityGatheringBuff() {
            const communityBuffs = MWI_Calculator.gameObject?.state?.communityBuffs || [];
            for (const buff of communityBuffs) {
                if (buff.hrid === "/community_buff_types/gathering_quantity" && !buff.isDone) {
                    return buff.level * 0.005 + 0.195;
                }
            }
            return 0;
        }
    }
    MWI_Calculator_ActionDetailPlus.processableActionMap = new Map([
        ["/items/milk", "/actions/milking/cow"],
        ["/items/verdant_milk", "/actions/milking/verdant_cow"],
        ["/items/azure_milk", "/actions/milking/azure_cow"],
        ["/items/burble_milk", "/actions/milking/burble_cow"],
        ["/items/crimson_milk", "/actions/milking/crimson_cow"],
        ["/items/rainbow_milk", "/actions/milking/unicow"],
        ["/items/holy_milk", "/actions/milking/holy_cow"],
        ["/items/log", "/actions/woodcutting/tree"],
        ["/items/birch_log", "/actions/woodcutting/birch_tree"],
        ["/items/cedar_log", "/actions/woodcutting/cedar_tree"],
        ["/items/purpleheart_log", "/actions/woodcutting/purpleheart_tree"],
        ["/items/ginkgo_log", "/actions/woodcutting/ginkgo_tree"],
        ["/items/redwood_log", "/actions/woodcutting/redwood_tree"],
        ["/items/arcane_log", "/actions/woodcutting/arcane_tree"],
        ["/items/cotton", "/actions/foraging/cotton"],
        ["/items/flax", "/actions/foraging/flax"],
        ["/items/bamboo_branch", "/actions/foraging/bamboo_branch"],
        ["/items/cocoon", "/actions/foraging/cocoon"],
        ["/items/radiant_fiber", "/actions/foraging/radiant_fiber"]
    ]);
    MWI_Calculator_ActionDetailPlus.processableItemMap = new Map([
        ["/items/milk", "/items/cheese"],
        ["/items/verdant_milk", "/items/verdant_cheese"],
        ["/items/azure_milk", "/items/azure_cheese"],
        ["/items/burble_milk", "/items/burble_cheese"],
        ["/items/crimson_milk", "/items/crimson_cheese"],
        ["/items/rainbow_milk", "/items/rainbow_cheese"],
        ["/items/holy_milk", "/items/holy_cheese"],
        ["/items/log", "/items/lumber"],
        ["/items/birch_log", "/items/birch_lumber"],
        ["/items/cedar_log", "/items/cedar_lumber"],
        ["/items/purpleheart_log", "/items/purpleheart_lumber"],
        ["/items/ginkgo_log", "/items/ginkgo_lumber"],
        ["/items/redwood_log", "/items/redwood_lumber"],
        ["/items/arcane_log", "/items/arcane_lumber"],
        ["/items/cotton", "/items/cotton_fabric"],
        ["/items/flax", "/items/linen_fabric"],
        ["/items/bamboo_branch", "/items/bamboo_fabric"],
        ["/items/cocoon", "/items/silk_fabric"],
        ["/items/radiant_fiber", "/items/radiant_fabric"],
        ["/items/rough_hide", "/items/rough_leather"],
        ["/items/reptile_hide", "/items/reptile_leather"],
        ["/items/gobo_hide", "/items/gobo_leather"],
        ["/items/beast_hide", "/items/beast_leather"],
        ["/items/umbral_hide", "/items/umbral_leather"]
    ]);
    //#endregion
    //#region Utils
    class MWI_Calculator_Utils {
        // 格式化数字
        static formatNumber(num) {
            // 类型和有效性检查
            if (!Number.isFinite(num)) {
                return '0';
            }
            // // 确保非负数
            // const normalizedNum = Math.max(0, num);
            const normalizedNum = num;
            // 小于1000：保留1位小数，但如果小数为0则只显示整数
            if (normalizedNum <= 999) {
                const fixed = normalizedNum.toFixed(1);
                return fixed.endsWith('.0') ? Math.round(normalizedNum).toString() : fixed;
            }
            // 小于100,000：向上取整
            if (normalizedNum <= 99999) {
                return Math.ceil(normalizedNum).toString();
            }
            // 小于10,000,000：显示xxxK (100K~9999K)
            if (normalizedNum <= 9999999) {
                return `${Math.floor(normalizedNum / 1000)}K`;
            }
            // 小于10,000,000,000：显示xxxM (100M~9999M)
            if (normalizedNum <= 9999999999) {
                return `${Math.floor(normalizedNum / 1000000)}M`;
            }
            // 小于10,000,000,000,000：显示xxxB (100B~9999B)
            if (normalizedNum <= 9999999999999) {
                return `${Math.floor(normalizedNum / 1000000000)}B`;
            }
            // 更大的数值显示NaN
            return 'NaN';
        }
        // 获取物品排序索引
        static getSortIndexByItemHrid(hrid) {
            return (MWI_Calculator.initClientData?.itemDetailMap?.[hrid]?.sortIndex || 9999);
        }
        // 获取技能排序索引
        static getSortIndexByHouseRoomHrid(hrid) {
            return (MWI_Calculator.initClientData?.houseRoomDetailMap?.[hrid]?.sortIndex || 0) - 9999;
        }
        // 获取物品图标链接
        static getIconHrefByItemHrid(itemHrid) {
            return '/static/media/items_sprite.9c39e2ec.svg#' + (itemHrid.split('/').pop() || '');
        }
        // 获取技能图标链接
        static getIconHrefBySkillHrid(skillHrid) {
            return '/static/media/skills_sprite.3bb4d936.svg#' + (skillHrid.split('/').pop() || '');
        }
        // 获取房屋图标链接
        static getIconHrefByHouseRoomHrid(houseRoomHrid) {
            return MWI_Calculator_Utils.getIconHrefBySkillHrid(MWI_Calculator.initClientData?.houseRoomDetailMap?.[houseRoomHrid]?.skillHrid || houseRoomHrid);
        }
        // 获取杂项图标链接
        static getIconHrefByMiscHrid(hrid) {
            return '/static/media/misc_sprite.6fa5e97c.svg#' + (hrid.split('/').pop() || '');
        }
        // 创建图标SVG元素
        static createIconSvg(iconHref) {
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('width', '18px');
            svg.setAttribute('height', '18px');
            svg.style.display = 'block';
            const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
            use.setAttributeNS('http://www.w3.org/1999/xlink', 'href', iconHref);
            svg.appendChild(use);
            return svg;
        }
        // 触发React对input元素的变更检测
        static reactInputTriggerHack(inputElem) {
            const lastValue = inputElem.value;
            const event = new Event("input", { bubbles: true });
            // 添加自定义标记
            event.simulated = true;
            // 访问React内部的value tracker
            const tracker = inputElem._valueTracker;
            if (tracker) {
                // 触发变更：设置为不同的值以触发React的change检测
                tracker.setValue(lastValue === '' ? ' ' : '');
            }
            inputElem.dispatchEvent(event);
        }
    }
    //#endregion
    //#region I18n
    class MWI_Calculator_I18n {
        // 获取当前游戏语言
        static getGameLanguage() {
            return MWI_Calculator.gameObject?.props.i18n.language || 'zh';
        }
        static isChinese() {
            return String(this.getGameLanguage() || '').replaceAll('_', '-').toLowerCase().startsWith('zh');
        }
        // 获取物品名称
        static getItemName(itemHrid) {
            return MWI_Calculator_I18n.getName(itemHrid, "itemNames");
        }
        // 获取名称
        static getName(hrid, category) {
            if (!hrid || !category) {
                return hrid;
            }
            // 特例自定义itemCategory名称
            if (category === 'itemCategoryNames') {
                switch (hrid) {
                    case '/item_categories/house_rooms':
                        return MWI_Calculator_I18n.isChinese() ? '房屋' : 'House';
                    case '/item_categories/tea':
                        return MWI_Calculator_I18n.isChinese() ? '茶' : 'Tea';
                    case '/item_categories/coffee':
                        return MWI_Calculator_I18n.isChinese() ? '咖啡' : 'Coffee';
                    case '/item_categories/materials':
                        return MWI_Calculator_I18n.isChinese() ? '材料' : 'Materials';
                }
            }
            const resources = MWI_Calculator.gameObject?.props?.i18n?.options?.resources || {};
            const language = String(MWI_Calculator_I18n.getGameLanguage() || "").replaceAll("_", "-");
            const localeCandidates = [language, language.split("-")[0], language.toLowerCase(), language.toLowerCase().split("-")[0]];
            for (const locale of localeCandidates) {
                const translated = resources?.[locale]?.translation?.[category]?.[hrid];
                if (translated) return translated;
                const matchedKey = Object.keys(resources).find((key) => key.toLowerCase() === locale.toLowerCase());
                const matched = matchedKey && resources?.[matchedKey]?.translation?.[category]?.[hrid];
                if (matched) return matched;
            }
            const detailName = category === "itemNames" ? MWI_Calculator.initClientData?.itemDetailMap?.[hrid]?.name : null;
            if (detailName) return detailName;
            return hrid;
        }
        // 通过物品名称获取物品HRID
        static getItemHridByName(itemName) {
            return MWI_Calculator_I18n.getHridByName(itemName, "itemNames");
        }
        // 通过名称获取HRID
        static getHridByName(name, category) {
            if (!name || !category) {
                return null;
            }
            const resources = MWI_Calculator.gameObject?.props?.i18n?.options?.resources || {};
            const language = String(MWI_Calculator_I18n.getGameLanguage() || "").replaceAll("_", "-");
            const locales = [language, language.split("-")[0], language.toLowerCase()];
            for (const locale of locales) {
                const key = Object.keys(resources).find((candidate) => candidate.toLowerCase() === locale.toLowerCase());
                const table = resources?.[locale]?.translation?.[category] || resources?.[key]?.translation?.[category] || {};
                const found = Object.entries(table).find(([, value]) => (value || "").toLowerCase() === name.toLowerCase().trim());
                if (found) return found[0];
            }
            return null;
        }
    }
    //#endregion
    //#region ItemsMap
    class MWI_Calculator_ItemsMap {
        // 获取物品数量
        static getCount(itemHrid, enhancementLevel = 0) {
            return MWI_Calculator_ItemsMap.map.get(itemHrid)?.get(enhancementLevel) ?? 0;
        }
        // 获取所有物品数量
        static getInventoryMap() {
            const inventoryMap = new Map();
            MWI_Calculator_ItemsMap.map.forEach((enhancementMap, itemHrid) => {
                inventoryMap.set(itemHrid, enhancementMap.get(0) || 0);
            });
            return inventoryMap;
        }
        // 获取物品最高强化等级
        static getMaxEnhancementLevel(itemHrid) {
            const m = MWI_Calculator_ItemsMap.map.get(itemHrid);
            if (!m) {
                return -1;
            }
            let max = -1;
            for (const [level, count] of m) {
                if (count > 0 && level > max) {
                    max = level;
                }
            }
            return max;
        }
        // 更新物品数据
        static update(endCharacterItems) {
            if (!endCharacterItems) {
                return;
            }
            for (const item of endCharacterItems) {
                if (!MWI_Calculator_ItemsMap.map.has(item.itemHrid)) {
                    MWI_Calculator_ItemsMap.map.set(item.itemHrid, new Map());
                }
                MWI_Calculator_ItemsMap.map.get(item.itemHrid).set(item.enhancementLevel, item.count);
            }
            MWI_Calculator_ItemsMap.itemsUpdatedCallbacks.forEach(cb => {
                try {
                    cb(endCharacterItems);
                }
                catch (e) {
                    console.error('[MWI_Calculator] Error in item updated callback:', e);
                }
            });
        }
        // 清空物品数据
        static clear() {
            MWI_Calculator_ItemsMap.map.clear();
        }
    }
    /** 物品数据映射表：itemHrid -> (enhancementLevel -> count) */
    MWI_Calculator_ItemsMap.map = new Map();
    MWI_Calculator_ItemsMap.itemsUpdatedCallbacks = [];
    //#endregion
    //#region MWI_Calculator
    class MWI_Calculator {
        // 启动
        static start() {
            MWI_Calculator.setupWebSocketInterceptor();
            MWI_Calculator.waitForElement('[class^="GamePage"]', () => {
                MWI_Calculator.initialize();
            });
        }
        /**
         * 设置 WebSocket 消息拦截器（**只读取**，不发送任何东西）。
         * ⚠️ 与其它 MWI 系列脚本共存时必须"协作"，否则互相包裹 getter：
         *    前一个脚本把 data 定义成实例自有属性（默认 configurable:false），
         *    后一个脚本再 defineProperty 会抛 TypeError，异常从 getter 冒出去打断游戏收包 → 游戏卡死。
         * 做法：① 共享消息总线 unsafeWindow.MWI_MessageBus；
         *      ② 共享标记 unsafeWindow.MWI_WS_HOOKED，只挂一层；
         *      ③ 防重入的 defineProperty 带 configurable:true 且 try/catch 兜住。
         * 游戏消息的筛选由 handleWebSocketMessage 按消息类型完成（非游戏消息解析失败会被忽略）。
         */
        static setupWebSocketInterceptor() {
            const win = (typeof unsafeWindow !== "undefined" && unsafeWindow) || window;
            const bus = win.MWI_MessageBus || (win.MWI_MessageBus = new Set());
            bus.add(message => {
                try {
                    MWI_Calculator?.handleWebSocketMessage(message);
                }
                catch (e) {
                    // 拦截失败不能影响游戏本身的收发
                }
            });
            if (win.MWI_WS_HOOKED) {
                console.log("[MWI_Calculator] 已有 MWI 脚本挂过 WebSocket 拦截，这里只订阅（避免双重包装导致卡死）");
                return;
            }
            const oriGet = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "data")?.get;
            if (!oriGet) {
                return;
            }
            win.MWI_WS_HOOKED = true;
            Object.defineProperty(MessageEvent.prototype, "data", {
                get: function () {
                    const message = oriGet.call(this);
                    // 防重入：实例自有属性。configurable 必须为 true，
                    // 否则别的 MWI 脚本再定义会抛 TypeError（就是卡死的真凶）
                    try {
                        Object.defineProperty(this, "data", { value: message, configurable: true, writable: true });
                    }
                    catch (e) {
                        // 已被别的脚本定义过，忽略
                    }
                    try {
                        bus.forEach(listener => listener(message));
                    }
                    catch (e) {
                        // 拦截失败不能影响游戏本身的收发
                    }
                    return message;
                }
            });
        }
        // 处理 WebSocket 消息
        static handleWebSocketMessage(message) {
            try {
                const obj = JSON.parse(message);
                // 类型守卫：检查是否为对象
                if (!obj || typeof obj !== 'object')
                    return;
                const msgObj = obj;
                // 处理角色初始化消息（使用双重断言）
                if (msgObj.type === "init_character_data" && Array.isArray(msgObj.characterItems)) {
                    MWI_Calculator.handleInitCharacterData(obj);
                }
                // 处理物品变更消息（使用双重断言）
                else if (Array.isArray(msgObj.endCharacterItems)) {
                    MWI_Calculator.handleEndCharacterItems(obj);
                }
            }
            catch {
                // 忽略解析错误（非JSON消息或其他错误）
            }
        }
        // 收到新角色时先使旧清单失效，再等待 React 实例切到对应角色。
        static handleInitCharacterData(data) {
            MWI_Calculator.hasCharacterSession = true;
            MWI_Calculator.characterID = MWI_Calculator_Calculator.normalizeCharacterID(data?.character?.id);
            MWI_Calculator.characterGameMode = String(data?.character?.gameMode || '').toLowerCase();
            MWI_Calculator_Calculator.prepareCharacterSession(MWI_Calculator.characterID);
            MWI_Calculator_ItemsMap.clear();
            MWI_Calculator_ItemsMap.update(data.characterItems);
            if (MWI_Calculator.initialized) MWI_Calculator.syncCharacterSession();
        }
        static syncCharacterSession(attempt = 0) {
            clearTimeout(MWI_Calculator.characterSyncTimer);
            const calculator = MWI_Calculator_Calculator;
            if (calculator.pendingCharacterID == null || !MWI_Calculator.initialized) return;
            const game = MWI_Calculator.getGameObject();
            if (game) MWI_Calculator.gameObject = game;
            if (calculator.pendingCharacterID === calculator.getLiveCharacterID()) {
                calculator.initializeCalculatorUI();
                calculator.tryLoadActiveCharacter();
                calculator.scheduleRender();
                return;
            }
            if (attempt < 100) {
                const generation = calculator.characterGeneration;
                MWI_Calculator.characterSyncTimer = setTimeout(() => {
                    if (generation === calculator.characterGeneration) MWI_Calculator.syncCharacterSession(attempt + 1);
                }, 100);
            }
        }
        // 处理物品变更数据
        static handleEndCharacterItems(data) {
            // 更新物品映射表
            MWI_Calculator_ItemsMap.update(data.endCharacterItems);
        }
        // 等待元素出现
        static waitForElement(selector, callback) {
            const el = document.querySelector(selector);
            if (el) {
                // 元素已存在，直接执行回调
                callback();
                return;
            }
            // 元素不存在，监听DOM变化
            const observer = new MutationObserver(() => {
                const el = document.querySelector(selector);
                if (el) {
                    observer.disconnect();
                    callback();
                }
            });
            observer.observe(document.body, { childList: true, subtree: true });
        }
        // 初始化
        static initialize() {
            MWI_Calculator.gameObject = MWI_Calculator.getGameObject();
            MWI_Calculator.initClientData = MWI_Calculator.getInitClientData();
            if (!MWI_Calculator.gameObject || !MWI_Calculator.initClientData) {
                console.error("[MWI_Calculator] 初始化失败");
                return;
            }
            MWI_Calculator_Calculator.prepareCharacterSession(MWI_Calculator_Calculator.getSessionCharacterID());
            MWI_Calculator.initialized = true;
            MWI_Calculator_ActionDetailPlus.initialize();
            MWI_Calculator_Calculator.initialize();
            MWI_Calculator.syncCharacterSession();
            console.log("[MWI_Calculator] 已初始化");
            console.log(MWI_Calculator.gameObject, MWI_Calculator.initClientData);
        }
        // 获取游戏主组件实例
        static getGameObject() {
            // (e => e?.[Object.keys(e).find(k => k.startsWith('__reactFiber$'))]?.return?.stateNode)(document.querySelector('[class^="GamePage"]'))
            const gamePageElement = document.querySelector('[class^="GamePage"]');
            if (!gamePageElement)
                return null;
            // 查找React Fiber的key（格式：__reactFiber$xxx）
            const reactKey = Reflect.ownKeys(gamePageElement).find(k => typeof k === 'string' && k.startsWith('__reactFiber$'));
            if (!reactKey)
                return null;
            // 通过Fiber节点获取组件实例
            const fiber = gamePageElement[reactKey];
            return fiber?.return?.stateNode || null;
        }
        // 获取初始化客户端数据
        static getInitClientData() {
            const compressedData = localStorage.getItem("initClientData");
            if (compressedData) {
                const decompressedData = LZString.decompressFromUTF16(compressedData);
                return JSON.parse(decompressedData);
            }
            return null;
        }
    }
    MWI_Calculator.gameObject = null;
    MWI_Calculator.initClientData = null;
    MWI_Calculator.characterGameMode = '';
    MWI_Calculator.initialized = false;
    //#endregion
    // 防止重复加载
    if (unsafeWindow.MWI_Calculator_Started) {
        return;
    }
    unsafeWindow.MWI_Calculator_Started = true;
    // 启动工具包
    MWI_Calculator.start();
})();
