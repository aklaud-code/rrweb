import { __awaiter } from './../../../../ext/tslib/tslib.es6.js';
import { createCache, createMirror, rebuild, buildNodeWithSN, NodeType } from '../../../rrweb-snapshot/es/rrweb-snapshot.js';
import { RRDocument, diff, createOrGetNode, getDefaultSN, buildFromDom, buildFromNode } from '../../../rrdom/es/rrdom.js';
import * as mitt$1 from './../../../../ext/mitt/dist/mitt.mjs.js';
import mitt$2 from './../../../../ext/mitt/dist/mitt.mjs.js';
import { polyfill } from './smoothscroll.js';
import { Timer } from './timer.js';
import { createPlayerService, createSpeedService } from './machine.js';
import { EventType, ReplayerEvents, IncrementalSource, MouseInteractions } from '../../../types/dist/types.js';
import { StyleSheetMirror, polyfill as polyfill$1, isSerializedIframe, hasShadowRoot, queueToResolveTrees, iterateResolveTree, uniqueTextMutations, getPositionsAndIndex, getNestedRule, getBaseDimension } from '../utils.js';
import rules from './styles/inject-style.js';
import canvasMutation from './canvas/index.js';
import { deserializeArg } from './canvas/deserialize-args.js';

const SKIP_TIME_THRESHOLD = 10 * 1000;
const SKIP_TIME_INTERVAL = 5 * 1000;
const mitt = mitt$2 || mitt$1;
const REPLAY_CONSOLE_PREFIX = '[replayer]';
const defaultMouseTailConfig = {
    duration: 500,
    lineCap: 'round',
    lineWidth: 3,
    strokeStyle: 'red',
};
function indicatesTouchDevice(e) {
    return (e.type == EventType.IncrementalSnapshot &&
        (e.data.source == IncrementalSource.TouchMove ||
            (e.data.source == IncrementalSource.MouseInteraction &&
                e.data.type == MouseInteractions.TouchStart)));
}
class Replayer {
    constructor(events, config) {
        this.usingVirtualDom = false;
        this.virtualDom = new RRDocument();
        this.mouseTail = null;
        this.tailPositions = [];
        this.emitter = mitt();
        this.legacy_missingNodeRetryMap = {};
        this.cache = createCache();
        this.imageMap = new Map();
        this.canvasEventMap = new Map();
        this.mirror = createMirror();
        this.styleMirror = new StyleSheetMirror();
        this.firstFullSnapshot = null;
        this.newDocumentQueue = [];
        this.mousePos = null;
        this.touchActive = null;
        this.lastSelectionData = null;
        this.constructedStyleMutations = [];
        this.adoptedStyleSheets = [];
        this.handleResize = (dimension) => {
            this.iframe.style.display = 'inherit';
            for (const el of [this.mouseTail, this.iframe]) {
                if (!el) {
                    continue;
                }
                el.setAttribute('width', String(dimension.width));
                el.setAttribute('height', String(dimension.height));
            }
        };
        this.applyEventsSynchronously = (events) => {
            for (const event of events) {
                switch (event.type) {
                    case EventType.DomContentLoaded:
                    case EventType.Load:
                    case EventType.Custom:
                        continue;
                    case EventType.FullSnapshot:
                    case EventType.Meta:
                    case EventType.Plugin:
                    case EventType.IncrementalSnapshot:
                        break;
                }
                const castFn = this.getCastFn(event, true);
                castFn();
            }
            if (this.touchActive === true) {
                this.mouse.classList.add('touch-active');
            }
            else if (this.touchActive === false) {
                this.mouse.classList.remove('touch-active');
            }
            this.touchActive = null;
        };
        this.getCastFn = (event, isSync = false) => {
            let castFn;
            switch (event.type) {
                case EventType.DomContentLoaded:
                case EventType.Load:
                    break;
                case EventType.Custom:
                    castFn = () => {
                        this.emitter.emit(ReplayerEvents.CustomEvent, event);
                    };
                    break;
                case EventType.Meta:
                    castFn = () => this.emitter.emit(ReplayerEvents.Resize, {
                        width: event.data.width,
                        height: event.data.height,
                    });
                    break;
                case EventType.FullSnapshot:
                    castFn = () => {
                        var _a;
                        if (this.firstFullSnapshot) {
                            if (this.firstFullSnapshot === event) {
                                this.firstFullSnapshot = true;
                                return;
                            }
                        }
                        else {
                            this.firstFullSnapshot = true;
                        }
                        this.rebuildFullSnapshot(event, isSync);
                        (_a = this.iframe.contentWindow) === null || _a === void 0 ? void 0 : _a.scrollTo(event.data.initialOffset);
                        this.styleMirror.reset();
                    };
                    break;
                case EventType.IncrementalSnapshot:
                    castFn = () => {
                        this.applyIncremental(event, isSync);
                        if (isSync) {
                            return;
                        }
                        if (event === this.nextUserInteractionEvent) {
                            this.nextUserInteractionEvent = null;
                            this.backToNormal();
                        }
                        if (this.config.skipInactive && !this.nextUserInteractionEvent) {
                            for (const _event of this.service.state.context.events) {
                                if (_event.timestamp <= event.timestamp) {
                                    continue;
                                }
                                if (this.isUserInteraction(_event)) {
                                    if (_event.delay - event.delay >
                                        SKIP_TIME_THRESHOLD *
                                            this.speedService.state.context.timer.speed) {
                                        this.nextUserInteractionEvent = _event;
                                    }
                                    break;
                                }
                            }
                            if (this.nextUserInteractionEvent) {
                                const skipTime = this.nextUserInteractionEvent.delay - event.delay;
                                const payload = {
                                    speed: Math.min(Math.round(skipTime / SKIP_TIME_INTERVAL), this.config.maxSpeed),
                                };
                                this.speedService.send({ type: 'FAST_FORWARD', payload });
                                this.emitter.emit(ReplayerEvents.SkipStart, payload);
                            }
                        }
                    };
                    break;
            }
            const wrappedCastFn = () => {
                if (castFn) {
                    castFn();
                }
                for (const plugin of this.config.plugins || []) {
                    if (plugin.handler)
                        plugin.handler(event, isSync, { replayer: this });
                }
                this.service.send({ type: 'CAST_EVENT', payload: { event } });
                const last_index = this.service.state.context.events.length - 1;
                if (event === this.service.state.context.events[last_index]) {
                    const finish = () => {
                        if (last_index < this.service.state.context.events.length - 1) {
                            return;
                        }
                        this.backToNormal();
                        this.service.send('END');
                        this.emitter.emit(ReplayerEvents.Finish);
                    };
                    if (event.type === EventType.IncrementalSnapshot &&
                        event.data.source === IncrementalSource.MouseMove &&
                        event.data.positions.length) {
                        setTimeout(() => {
                            finish();
                        }, Math.max(0, -event.data.positions[0].timeOffset + 50));
                    }
                    else {
                        finish();
                    }
                }
                this.emitter.emit(ReplayerEvents.EventCast, event);
            };
            return wrappedCastFn;
        };
        if (!(config === null || config === void 0 ? void 0 : config.liveMode) && events.length < 2) {
            throw new Error('Replayer need at least 2 events.');
        }
        const defaultConfig = {
            speed: 1,
            maxSpeed: 360,
            root: document.body,
            loadTimeout: 0,
            skipInactive: false,
            showWarning: true,
            showDebug: false,
            blockClass: 'rr-block',
            liveMode: false,
            insertStyleRules: [],
            triggerFocus: true,
            UNSAFE_replayCanvas: false,
            pauseAnimation: true,
            mouseTail: defaultMouseTailConfig,
            useVirtualDom: true,
        };
        this.config = Object.assign({}, defaultConfig, config);
        this.handleResize = this.handleResize.bind(this);
        this.getCastFn = this.getCastFn.bind(this);
        this.applyEventsSynchronously = this.applyEventsSynchronously.bind(this);
        this.emitter.on(ReplayerEvents.Resize, this.handleResize);
        this.setupDom();
        for (const plugin of this.config.plugins || []) {
            if (plugin.getMirror)
                plugin.getMirror({ nodeMirror: this.mirror });
        }
        this.emitter.on(ReplayerEvents.Flush, () => {
            if (this.usingVirtualDom) {
                const replayerHandler = {
                    mirror: this.mirror,
                    applyCanvas: (canvasEvent, canvasMutationData, target) => {
                        void canvasMutation({
                            event: canvasEvent,
                            mutation: canvasMutationData,
                            target,
                            imageMap: this.imageMap,
                            canvasEventMap: this.canvasEventMap,
                            errorHandler: this.warnCanvasMutationFailed.bind(this),
                        });
                    },
                    applyInput: this.applyInput.bind(this),
                    applyScroll: this.applyScroll.bind(this),
                    applyStyleSheetMutation: (data, styleSheet) => {
                        if (data.source === IncrementalSource.StyleSheetRule)
                            this.applyStyleSheetRule(data, styleSheet);
                        else if (data.source === IncrementalSource.StyleDeclaration)
                            this.applyStyleDeclaration(data, styleSheet);
                    },
                };
                this.iframe.contentDocument &&
                    diff(this.iframe.contentDocument, this.virtualDom, replayerHandler, this.virtualDom.mirror);
                this.virtualDom.destroyTree();
                this.usingVirtualDom = false;
                if (Object.keys(this.legacy_missingNodeRetryMap).length) {
                    for (const key in this.legacy_missingNodeRetryMap) {
                        try {
                            const value = this.legacy_missingNodeRetryMap[key];
                            const realNode = createOrGetNode(value.node, this.mirror, this.virtualDom.mirror);
                            diff(realNode, value.node, replayerHandler, this.virtualDom.mirror);
                            value.node = realNode;
                        }
                        catch (error) {
                            if (this.config.showWarning) {
                                console.warn(error);
                            }
                        }
                    }
                }
                this.constructedStyleMutations.forEach((data) => {
                    this.applyStyleSheetMutation(data);
                });
                this.constructedStyleMutations = [];
                this.adoptedStyleSheets.forEach((data) => {
                    this.applyAdoptedStyleSheet(data);
                });
                this.adoptedStyleSheets = [];
            }
            if (this.mousePos) {
                this.moveAndHover(this.mousePos.x, this.mousePos.y, this.mousePos.id, true, this.mousePos.debugData);
                this.mousePos = null;
            }
            if (this.lastSelectionData) {
                this.applySelection(this.lastSelectionData);
                this.lastSelectionData = null;
            }
        });
        this.emitter.on(ReplayerEvents.PlayBack, () => {
            this.firstFullSnapshot = null;
            this.mirror.reset();
            this.styleMirror.reset();
        });
        const timer = new Timer([], {
            speed: this.config.speed,
            liveMode: this.config.liveMode,
        });
        this.service = createPlayerService({
            events: events
                .map((e) => {
                if (config && config.unpackFn) {
                    return config.unpackFn(e);
                }
                return e;
            })
                .sort((a1, a2) => a1.timestamp - a2.timestamp),
            timer,
            timeOffset: 0,
            baselineTime: 0,
            lastPlayedEvent: null,
        }, {
            getCastFn: this.getCastFn,
            applyEventsSynchronously: this.applyEventsSynchronously,
            emitter: this.emitter,
        });
        this.service.start();
        this.service.subscribe((state) => {
            this.emitter.emit(ReplayerEvents.StateChange, {
                player: state,
            });
        });
        this.speedService = createSpeedService({
            normalSpeed: -1,
            timer,
        });
        this.speedService.start();
        this.speedService.subscribe((state) => {
            this.emitter.emit(ReplayerEvents.StateChange, {
                speed: state,
            });
        });
        const firstMeta = this.service.state.context.events.find((e) => e.type === EventType.Meta);
        const firstFullsnapshot = this.service.state.context.events.find((e) => e.type === EventType.FullSnapshot);
        if (firstMeta) {
            const { width, height } = firstMeta.data;
            setTimeout(() => {
                this.emitter.emit(ReplayerEvents.Resize, {
                    width,
                    height,
                });
            }, 0);
        }
        if (firstFullsnapshot) {
            setTimeout(() => {
                var _a;
                if (this.firstFullSnapshot) {
                    return;
                }
                this.firstFullSnapshot = firstFullsnapshot;
                this.rebuildFullSnapshot(firstFullsnapshot);
                (_a = this.iframe.contentWindow) === null || _a === void 0 ? void 0 : _a.scrollTo(firstFullsnapshot.data.initialOffset);
            }, 1);
        }
        if (this.service.state.context.events.find(indicatesTouchDevice)) {
            this.mouse.classList.add('touch-device');
        }
    }
    get timer() {
        return this.service.state.context.timer;
    }
    on(event, handler) {
        this.emitter.on(event, handler);
        return this;
    }
    off(event, handler) {
        this.emitter.off(event, handler);
        return this;
    }
    setConfig(config) {
        Object.keys(config).forEach((key) => {
            config[key];
            this.config[key] = config[key];
        });
        if (!this.config.skipInactive) {
            this.backToNormal();
        }
        if (typeof config.speed !== 'undefined') {
            this.speedService.send({
                type: 'SET_SPEED',
                payload: {
                    speed: config.speed,
                },
            });
        }
        if (typeof config.mouseTail !== 'undefined') {
            if (config.mouseTail === false) {
                if (this.mouseTail) {
                    this.mouseTail.style.display = 'none';
                }
            }
            else {
                if (!this.mouseTail) {
                    this.mouseTail = document.createElement('canvas');
                    this.mouseTail.width = Number.parseFloat(this.iframe.width);
                    this.mouseTail.height = Number.parseFloat(this.iframe.height);
                    this.mouseTail.classList.add('replayer-mouse-tail');
                    this.wrapper.insertBefore(this.mouseTail, this.iframe);
                }
                this.mouseTail.style.display = 'inherit';
            }
        }
    }
    getMetaData() {
        const firstEvent = this.service.state.context.events[0];
        const lastEvent = this.service.state.context.events[this.service.state.context.events.length - 1];
        return {
            startTime: firstEvent.timestamp,
            endTime: lastEvent.timestamp,
            totalTime: lastEvent.timestamp - firstEvent.timestamp,
        };
    }
    getCurrentTime() {
        return this.timer.timeOffset + this.getTimeOffset();
    }
    getTimeOffset() {
        const { baselineTime, events } = this.service.state.context;
        return baselineTime - events[0].timestamp;
    }
    getMirror() {
        return this.mirror;
    }
    play(timeOffset = 0) {
        var _a, _b;
        if (this.service.state.matches('paused')) {
            this.service.send({ type: 'PLAY', payload: { timeOffset } });
        }
        else {
            this.service.send({ type: 'PAUSE' });
            this.service.send({ type: 'PLAY', payload: { timeOffset } });
        }
        (_b = (_a = this.iframe.contentDocument) === null || _a === void 0 ? void 0 : _a.getElementsByTagName('html')[0]) === null || _b === void 0 ? void 0 : _b.classList.remove('rrweb-paused');
        this.emitter.emit(ReplayerEvents.Start);
    }
    pause(timeOffset) {
        var _a, _b;
        if (timeOffset === undefined && this.service.state.matches('playing')) {
            this.service.send({ type: 'PAUSE' });
        }
        if (typeof timeOffset === 'number') {
            this.play(timeOffset);
            this.service.send({ type: 'PAUSE' });
        }
        (_b = (_a = this.iframe.contentDocument) === null || _a === void 0 ? void 0 : _a.getElementsByTagName('html')[0]) === null || _b === void 0 ? void 0 : _b.classList.add('rrweb-paused');
        this.emitter.emit(ReplayerEvents.Pause);
    }
    resume(timeOffset = 0) {
        console.warn(`The 'resume' was deprecated in 1.0. Please use 'play' method which has the same interface.`);
        this.play(timeOffset);
        this.emitter.emit(ReplayerEvents.Resume);
    }
    destroy() {
        this.pause();
        this.config.root.removeChild(this.wrapper);
        this.emitter.emit(ReplayerEvents.Destroy);
    }
    startLive(baselineTime) {
        this.service.send({ type: 'TO_LIVE', payload: { baselineTime } });
    }
    addEvent(rawEvent) {
        const event = this.config.unpackFn
            ? this.config.unpackFn(rawEvent)
            : rawEvent;
        if (indicatesTouchDevice(event)) {
            this.mouse.classList.add('touch-device');
        }
        void Promise.resolve().then(() => this.service.send({ type: 'ADD_EVENT', payload: { event } }));
    }
    enableInteract() {
        this.iframe.setAttribute('scrolling', 'auto');
        this.iframe.style.pointerEvents = 'auto';
    }
    disableInteract() {
        this.iframe.setAttribute('scrolling', 'no');
        this.iframe.style.pointerEvents = 'none';
    }
    resetCache() {
        this.cache = createCache();
    }
    setupDom() {
        this.wrapper = document.createElement('div');
        this.wrapper.classList.add('replayer-wrapper');
        this.config.root.appendChild(this.wrapper);
        this.mouse = document.createElement('div');
        this.mouse.classList.add('replayer-mouse');
        this.wrapper.appendChild(this.mouse);
        if (this.config.mouseTail !== false) {
            this.mouseTail = document.createElement('canvas');
            this.mouseTail.classList.add('replayer-mouse-tail');
            this.mouseTail.style.display = 'inherit';
            this.wrapper.appendChild(this.mouseTail);
        }
        this.iframe = document.createElement('iframe');
        const attributes = ['allow-same-origin'];
        if (this.config.UNSAFE_replayCanvas) {
            attributes.push('allow-scripts');
        }
        this.iframe.style.display = 'none';
        this.iframe.setAttribute('sandbox', attributes.join(' '));
        this.disableInteract();
        this.wrapper.appendChild(this.iframe);
        if (this.iframe.contentWindow && this.iframe.contentDocument) {
            polyfill(this.iframe.contentWindow, this.iframe.contentDocument);
            polyfill$1(this.iframe.contentWindow);
        }
    }
    rebuildFullSnapshot(event, isSync = false) {
        if (!this.iframe.contentDocument) {
            return console.warn('Looks like your replayer has been destroyed.');
        }
        if (Object.keys(this.legacy_missingNodeRetryMap).length) {
            console.warn('Found unresolved missing node map', this.legacy_missingNodeRetryMap);
        }
        this.legacy_missingNodeRetryMap = {};
        const collected = [];
        const afterAppend = (builtNode, id) => {
            this.collectIframeAndAttachDocument(collected, builtNode);
            for (const plugin of this.config.plugins || []) {
                if (plugin.onBuild)
                    plugin.onBuild(builtNode, {
                        id,
                        replayer: this,
                    });
            }
        };
        rebuild(event.data.node, {
            doc: this.iframe.contentDocument,
            afterAppend,
            cache: this.cache,
            mirror: this.mirror,
        });
        afterAppend(this.iframe.contentDocument, event.data.node.id);
        for (const { mutationInQueue, builtNode } of collected) {
            this.attachDocumentToIframe(mutationInQueue, builtNode);
            this.newDocumentQueue = this.newDocumentQueue.filter((m) => m !== mutationInQueue);
        }
        const { documentElement, head } = this.iframe.contentDocument;
        this.insertStyleRules(documentElement, head);
        if (!this.service.state.matches('playing')) {
            this.iframe.contentDocument
                .getElementsByTagName('html')[0]
                .classList.add('rrweb-paused');
        }
        this.emitter.emit(ReplayerEvents.FullsnapshotRebuilded, event);
        if (!isSync) {
            this.waitForStylesheetLoad();
        }
        if (this.config.UNSAFE_replayCanvas) {
            void this.preloadAllImages();
        }
    }
    insertStyleRules(documentElement, head) {
        var _a;
        const injectStylesRules = rules(this.config.blockClass).concat(this.config.insertStyleRules);
        if (this.config.pauseAnimation) {
            injectStylesRules.push('html.rrweb-paused *, html.rrweb-paused *:before, html.rrweb-paused *:after { animation-play-state: paused !important; }');
        }
        if (this.usingVirtualDom) {
            const styleEl = this.virtualDom.createElement('style');
            this.virtualDom.mirror.add(styleEl, getDefaultSN(styleEl, this.virtualDom.unserializedId));
            documentElement.insertBefore(styleEl, head);
            styleEl.rules.push({
                source: IncrementalSource.StyleSheetRule,
                adds: injectStylesRules.map((cssText, index) => ({
                    rule: cssText,
                    index,
                })),
            });
        }
        else {
            const styleEl = document.createElement('style');
            documentElement.insertBefore(styleEl, head);
            for (let idx = 0; idx < injectStylesRules.length; idx++) {
                (_a = styleEl.sheet) === null || _a === void 0 ? void 0 : _a.insertRule(injectStylesRules[idx], idx);
            }
        }
    }
    attachDocumentToIframe(mutation, iframeEl) {
        const mirror = this.usingVirtualDom
            ? this.virtualDom.mirror
            : this.mirror;
        const collected = [];
        const afterAppend = (builtNode, id) => {
            this.collectIframeAndAttachDocument(collected, builtNode);
            const sn = mirror.getMeta(builtNode);
            if ((sn === null || sn === void 0 ? void 0 : sn.type) === NodeType.Element &&
                (sn === null || sn === void 0 ? void 0 : sn.tagName.toUpperCase()) === 'HTML') {
                const { documentElement, head } = iframeEl.contentDocument;
                this.insertStyleRules(documentElement, head);
            }
            for (const plugin of this.config.plugins || []) {
                if (plugin.onBuild)
                    plugin.onBuild(builtNode, {
                        id,
                        replayer: this,
                    });
            }
        };
        buildNodeWithSN(mutation.node, {
            doc: iframeEl.contentDocument,
            mirror: mirror,
            hackCss: true,
            skipChild: false,
            afterAppend,
            cache: this.cache,
        });
        afterAppend(iframeEl.contentDocument, mutation.node.id);
        for (const { mutationInQueue, builtNode } of collected) {
            this.attachDocumentToIframe(mutationInQueue, builtNode);
            this.newDocumentQueue = this.newDocumentQueue.filter((m) => m !== mutationInQueue);
        }
    }
    collectIframeAndAttachDocument(collected, builtNode) {
        if (isSerializedIframe(builtNode, this.mirror)) {
            const mutationInQueue = this.newDocumentQueue.find((m) => m.parentId === this.mirror.getId(builtNode));
            if (mutationInQueue) {
                collected.push({
                    mutationInQueue,
                    builtNode: builtNode,
                });
            }
        }
    }
    waitForStylesheetLoad() {
        var _a;
        const head = (_a = this.iframe.contentDocument) === null || _a === void 0 ? void 0 : _a.head;
        if (head) {
            const unloadSheets = new Set();
            let timer;
            let beforeLoadState = this.service.state;
            const stateHandler = () => {
                beforeLoadState = this.service.state;
            };
            this.emitter.on(ReplayerEvents.Start, stateHandler);
            this.emitter.on(ReplayerEvents.Pause, stateHandler);
            const unsubscribe = () => {
                this.emitter.off(ReplayerEvents.Start, stateHandler);
                this.emitter.off(ReplayerEvents.Pause, stateHandler);
            };
            head
                .querySelectorAll('link[rel="stylesheet"]')
                .forEach((css) => {
                if (!css.sheet) {
                    unloadSheets.add(css);
                    css.addEventListener('load', () => {
                        unloadSheets.delete(css);
                        if (unloadSheets.size === 0 && timer !== -1) {
                            if (beforeLoadState.matches('playing')) {
                                this.play(this.getCurrentTime());
                            }
                            this.emitter.emit(ReplayerEvents.LoadStylesheetEnd);
                            if (timer) {
                                clearTimeout(timer);
                            }
                            unsubscribe();
                        }
                    });
                }
            });
            if (unloadSheets.size > 0) {
                this.service.send({ type: 'PAUSE' });
                this.emitter.emit(ReplayerEvents.LoadStylesheetStart);
                timer = setTimeout(() => {
                    if (beforeLoadState.matches('playing')) {
                        this.play(this.getCurrentTime());
                    }
                    timer = -1;
                    unsubscribe();
                }, this.config.loadTimeout);
            }
        }
    }
    preloadAllImages() {
        return __awaiter(this, void 0, void 0, function* () {
            this.service.state;
            const stateHandler = () => {
                this.service.state;
            };
            this.emitter.on(ReplayerEvents.Start, stateHandler);
            this.emitter.on(ReplayerEvents.Pause, stateHandler);
            const promises = [];
            for (const event of this.service.state.context.events) {
                if (event.type === EventType.IncrementalSnapshot &&
                    event.data.source === IncrementalSource.CanvasMutation) {
                    promises.push(this.deserializeAndPreloadCanvasEvents(event.data, event));
                    const commands = 'commands' in event.data ? event.data.commands : [event.data];
                    commands.forEach((c) => {
                        this.preloadImages(c, event);
                    });
                }
            }
            return Promise.all(promises);
        });
    }
    preloadImages(data, event) {
        if (data.property === 'drawImage' &&
            typeof data.args[0] === 'string' &&
            !this.imageMap.has(event)) {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            const imgd = ctx === null || ctx === void 0 ? void 0 : ctx.createImageData(canvas.width, canvas.height);
            imgd === null || imgd === void 0 ? void 0 : imgd.data;
            JSON.parse(data.args[0]);
            ctx === null || ctx === void 0 ? void 0 : ctx.putImageData(imgd, 0, 0);
        }
    }
    deserializeAndPreloadCanvasEvents(data, event) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.canvasEventMap.has(event)) {
                const status = {
                    isUnchanged: true,
                };
                if ('commands' in data) {
                    const commands = yield Promise.all(data.commands.map((c) => __awaiter(this, void 0, void 0, function* () {
                        const args = yield Promise.all(c.args.map(deserializeArg(this.imageMap, null, status)));
                        return Object.assign(Object.assign({}, c), { args });
                    })));
                    if (status.isUnchanged === false)
                        this.canvasEventMap.set(event, Object.assign(Object.assign({}, data), { commands }));
                }
                else {
                    const args = yield Promise.all(data.args.map(deserializeArg(this.imageMap, null, status)));
                    if (status.isUnchanged === false)
                        this.canvasEventMap.set(event, Object.assign(Object.assign({}, data), { args }));
                }
            }
        });
    }
    applyIncremental(e, isSync) {
        var _a, _b, _c;
        const { data: d } = e;
        switch (d.source) {
            case IncrementalSource.Mutation: {
                try {
                    this.applyMutation(d, isSync);
                }
                catch (error) {
                    this.warn(`Exception in mutation ${error.message || error}`, d);
                }
                break;
            }
            case IncrementalSource.Drag:
            case IncrementalSource.TouchMove:
            case IncrementalSource.MouseMove:
                if (isSync) {
                    const lastPosition = d.positions[d.positions.length - 1];
                    this.mousePos = {
                        x: lastPosition.x,
                        y: lastPosition.y,
                        id: lastPosition.id,
                        debugData: d,
                    };
                }
                else {
                    d.positions.forEach((p) => {
                        const action = {
                            doAction: () => {
                                this.moveAndHover(p.x, p.y, p.id, isSync, d);
                            },
                            delay: p.timeOffset +
                                e.timestamp -
                                this.service.state.context.baselineTime,
                        };
                        this.timer.addAction(action);
                    });
                    this.timer.addAction({
                        doAction() {
                        },
                        delay: e.delay - ((_a = d.positions[0]) === null || _a === void 0 ? void 0 : _a.timeOffset),
                    });
                }
                break;
            case IncrementalSource.MouseInteraction: {
                if (d.id === -1 || isSync) {
                    break;
                }
                const event = new Event(MouseInteractions[d.type].toLowerCase());
                const target = this.mirror.getNode(d.id);
                if (!target) {
                    return this.debugNodeNotFound(d, d.id);
                }
                this.emitter.emit(ReplayerEvents.MouseInteraction, {
                    type: d.type,
                    target,
                });
                const { triggerFocus } = this.config;
                switch (d.type) {
                    case MouseInteractions.Blur:
                        if ('blur' in target) {
                            target.blur();
                        }
                        break;
                    case MouseInteractions.Focus:
                        if (triggerFocus && target.focus) {
                            target.focus({
                                preventScroll: true,
                            });
                        }
                        break;
                    case MouseInteractions.Click:
                    case MouseInteractions.TouchStart:
                    case MouseInteractions.TouchEnd:
                        if (isSync) {
                            if (d.type === MouseInteractions.TouchStart) {
                                this.touchActive = true;
                            }
                            else if (d.type === MouseInteractions.TouchEnd) {
                                this.touchActive = false;
                            }
                            this.mousePos = {
                                x: d.x,
                                y: d.y,
                                id: d.id,
                                debugData: d,
                            };
                        }
                        else {
                            if (d.type === MouseInteractions.TouchStart) {
                                this.tailPositions.length = 0;
                            }
                            this.moveAndHover(d.x, d.y, d.id, isSync, d);
                            if (d.type === MouseInteractions.Click) {
                                this.mouse.classList.remove('active');
                                void this.mouse.offsetWidth;
                                this.mouse.classList.add('active');
                            }
                            else if (d.type === MouseInteractions.TouchStart) {
                                void this.mouse.offsetWidth;
                                this.mouse.classList.add('touch-active');
                            }
                            else if (d.type === MouseInteractions.TouchEnd) {
                                this.mouse.classList.remove('touch-active');
                            }
                        }
                        break;
                    case MouseInteractions.TouchCancel:
                        if (isSync) {
                            this.touchActive = false;
                        }
                        else {
                            this.mouse.classList.remove('touch-active');
                        }
                        break;
                    default:
                        target.dispatchEvent(event);
                }
                break;
            }
            case IncrementalSource.Scroll: {
                if (d.id === -1) {
                    break;
                }
                if (this.usingVirtualDom) {
                    const target = this.virtualDom.mirror.getNode(d.id);
                    if (!target) {
                        return this.debugNodeNotFound(d, d.id);
                    }
                    target.scrollData = d;
                    break;
                }
                this.applyScroll(d, isSync);
                break;
            }
            case IncrementalSource.ViewportResize:
                this.emitter.emit(ReplayerEvents.Resize, {
                    width: d.width,
                    height: d.height,
                });
                break;
            case IncrementalSource.Input: {
                if (d.id === -1) {
                    break;
                }
                if (this.usingVirtualDom) {
                    const target = this.virtualDom.mirror.getNode(d.id);
                    if (!target) {
                        return this.debugNodeNotFound(d, d.id);
                    }
                    target.inputData = d;
                    break;
                }
                this.applyInput(d);
                break;
            }
            case IncrementalSource.MediaInteraction: {
                const target = this.usingVirtualDom
                    ? this.virtualDom.mirror.getNode(d.id)
                    : this.mirror.getNode(d.id);
                if (!target) {
                    return this.debugNodeNotFound(d, d.id);
                }
                const mediaEl = target;
                try {
                    if (d.currentTime) {
                        mediaEl.currentTime = d.currentTime;
                    }
                    if (d.volume) {
                        mediaEl.volume = d.volume;
                    }
                    if (d.muted) {
                        mediaEl.muted = d.muted;
                    }
                    if (d.type === 1) {
                        mediaEl.pause();
                    }
                    if (d.type === 0) {
                        void mediaEl.play();
                    }
                    if (d.type === 4) {
                        mediaEl.playbackRate = d.playbackRate;
                    }
                }
                catch (error) {
                    if (this.config.showWarning) {
                        console.warn(`Failed to replay media interactions: ${error.message || error}`);
                    }
                }
                break;
            }
            case IncrementalSource.StyleSheetRule:
            case IncrementalSource.StyleDeclaration: {
                if (this.usingVirtualDom) {
                    if (d.styleId)
                        this.constructedStyleMutations.push(d);
                    else if (d.id)
                        (_b = this.virtualDom.mirror.getNode(d.id)) === null || _b === void 0 ? void 0 : _b.rules.push(d);
                }
                else
                    this.applyStyleSheetMutation(d);
                break;
            }
            case IncrementalSource.CanvasMutation: {
                if (!this.config.UNSAFE_replayCanvas) {
                    return;
                }
                if (this.usingVirtualDom) {
                    const target = this.virtualDom.mirror.getNode(d.id);
                    if (!target) {
                        return this.debugNodeNotFound(d, d.id);
                    }
                    target.canvasMutations.push({
                        event: e,
                        mutation: d,
                    });
                }
                else {
                    const target = this.mirror.getNode(d.id);
                    if (!target) {
                        return this.debugNodeNotFound(d, d.id);
                    }
                    void canvasMutation({
                        event: e,
                        mutation: d,
                        target: target,
                        imageMap: this.imageMap,
                        canvasEventMap: this.canvasEventMap,
                        errorHandler: this.warnCanvasMutationFailed.bind(this),
                    });
                }
                break;
            }
            case IncrementalSource.Font: {
                try {
                    const fontFace = new FontFace(d.family, d.buffer
                        ? new Uint8Array(JSON.parse(d.fontSource))
                        : d.fontSource, d.descriptors);
                    (_c = this.iframe.contentDocument) === null || _c === void 0 ? void 0 : _c.fonts.add(fontFace);
                }
                catch (error) {
                    if (this.config.showWarning) {
                        console.warn(error);
                    }
                }
                break;
            }
            case IncrementalSource.Selection: {
                if (isSync) {
                    this.lastSelectionData = d;
                    break;
                }
                this.applySelection(d);
                break;
            }
            case IncrementalSource.AdoptedStyleSheet: {
                if (this.usingVirtualDom)
                    this.adoptedStyleSheets.push(d);
                else
                    this.applyAdoptedStyleSheet(d);
                break;
            }
        }
    }
    applyMutation(d, isSync) {
        if (this.config.useVirtualDom && !this.usingVirtualDom && isSync) {
            this.usingVirtualDom = true;
            buildFromDom(this.iframe.contentDocument, this.mirror, this.virtualDom);
            if (Object.keys(this.legacy_missingNodeRetryMap).length) {
                for (const key in this.legacy_missingNodeRetryMap) {
                    try {
                        const value = this.legacy_missingNodeRetryMap[key];
                        const virtualNode = buildFromNode(value.node, this.virtualDom, this.mirror);
                        if (virtualNode)
                            value.node = virtualNode;
                    }
                    catch (error) {
                        if (this.config.showWarning) {
                            console.warn(error);
                        }
                    }
                }
            }
        }
        const mirror = this.usingVirtualDom ? this.virtualDom.mirror : this.mirror;
        d.removes.forEach((mutation) => {
            var _a;
            const target = mirror.getNode(mutation.id);
            if (!target) {
                if (d.removes.find((r) => r.id === mutation.parentId)) {
                    return;
                }
                return this.warnNodeNotFound(d, mutation.id);
            }
            let parent = mirror.getNode(mutation.parentId);
            if (!parent) {
                return this.warnNodeNotFound(d, mutation.parentId);
            }
            if (mutation.isShadow && hasShadowRoot(parent)) {
                parent = parent.shadowRoot;
            }
            mirror.removeNodeFromMap(target);
            if (parent)
                try {
                    parent.removeChild(target);
                    if (this.usingVirtualDom &&
                        target.nodeName === '#text' &&
                        parent.nodeName === 'STYLE' &&
                        ((_a = parent.rules) === null || _a === void 0 ? void 0 : _a.length) > 0)
                        parent.rules = [];
                }
                catch (error) {
                    if (error instanceof DOMException) {
                        this.warn('parent could not remove child in mutation', parent, target, d);
                    }
                    else {
                        throw error;
                    }
                }
        });
        const legacy_missingNodeMap = Object.assign({}, this.legacy_missingNodeRetryMap);
        const queue = [];
        const nextNotInDOM = (mutation) => {
            let next = null;
            if (mutation.nextId) {
                next = mirror.getNode(mutation.nextId);
            }
            if (mutation.nextId !== null &&
                mutation.nextId !== undefined &&
                mutation.nextId !== -1 &&
                !next) {
                return true;
            }
            return false;
        };
        const appendNode = (mutation) => {
            var _a;
            if (!this.iframe.contentDocument) {
                return console.warn('Looks like your replayer has been destroyed.');
            }
            let parent = mirror.getNode(mutation.parentId);
            if (!parent) {
                if (mutation.node.type === NodeType.Document) {
                    return this.newDocumentQueue.push(mutation);
                }
                return queue.push(mutation);
            }
            if (mutation.node.isShadow) {
                if (!hasShadowRoot(parent)) {
                    parent.attachShadow({ mode: 'open' });
                    parent = parent.shadowRoot;
                }
                else
                    parent = parent.shadowRoot;
            }
            let previous = null;
            let next = null;
            if (mutation.previousId) {
                previous = mirror.getNode(mutation.previousId);
            }
            if (mutation.nextId) {
                next = mirror.getNode(mutation.nextId);
            }
            if (nextNotInDOM(mutation)) {
                return queue.push(mutation);
            }
            if (mutation.node.rootId && !mirror.getNode(mutation.node.rootId)) {
                return;
            }
            const targetDoc = mutation.node.rootId
                ? mirror.getNode(mutation.node.rootId)
                : this.usingVirtualDom
                    ? this.virtualDom
                    : this.iframe.contentDocument;
            if (isSerializedIframe(parent, mirror)) {
                this.attachDocumentToIframe(mutation, parent);
                return;
            }
            const afterAppend = (node, id) => {
                for (const plugin of this.config.plugins || []) {
                    if (plugin.onBuild)
                        plugin.onBuild(node, { id, replayer: this });
                }
            };
            const target = buildNodeWithSN(mutation.node, {
                doc: targetDoc,
                mirror: mirror,
                skipChild: true,
                hackCss: true,
                cache: this.cache,
                afterAppend,
            });
            if (mutation.previousId === -1 || mutation.nextId === -1) {
                legacy_missingNodeMap[mutation.node.id] = {
                    node: target,
                    mutation,
                };
                return;
            }
            const parentSn = mirror.getMeta(parent);
            if (parentSn &&
                parentSn.type === NodeType.Element &&
                parentSn.tagName === 'textarea' &&
                mutation.node.type === NodeType.Text) {
                const childNodeArray = Array.isArray(parent.childNodes)
                    ? parent.childNodes
                    : Array.from(parent.childNodes);
                for (const c of childNodeArray) {
                    if (c.nodeType === parent.TEXT_NODE) {
                        parent.removeChild(c);
                    }
                }
            }
            if (previous && previous.nextSibling && previous.nextSibling.parentNode) {
                parent.insertBefore(target, previous.nextSibling);
            }
            else if (next && next.parentNode) {
                parent.contains(next)
                    ? parent.insertBefore(target, next)
                    : parent.insertBefore(target, null);
            }
            else {
                if (parent === targetDoc) {
                    while (targetDoc.firstChild) {
                        targetDoc.removeChild(targetDoc.firstChild);
                    }
                }
                parent.appendChild(target);
            }
            afterAppend(target, mutation.node.id);
            if (this.usingVirtualDom &&
                target.nodeName === '#text' &&
                parent.nodeName === 'STYLE' &&
                ((_a = parent.rules) === null || _a === void 0 ? void 0 : _a.length) > 0)
                parent.rules = [];
            if (isSerializedIframe(target, this.mirror)) {
                const targetId = this.mirror.getId(target);
                const mutationInQueue = this.newDocumentQueue.find((m) => m.parentId === targetId);
                if (mutationInQueue) {
                    this.attachDocumentToIframe(mutationInQueue, target);
                    this.newDocumentQueue = this.newDocumentQueue.filter((m) => m !== mutationInQueue);
                }
            }
            if (mutation.previousId || mutation.nextId) {
                this.legacy_resolveMissingNode(legacy_missingNodeMap, parent, target, mutation);
            }
        };
        d.adds.forEach((mutation) => {
            appendNode(mutation);
        });
        const startTime = Date.now();
        while (queue.length) {
            const resolveTrees = queueToResolveTrees(queue);
            queue.length = 0;
            if (Date.now() - startTime > 500) {
                this.warn('Timeout in the loop, please check the resolve tree data:', resolveTrees);
                break;
            }
            for (const tree of resolveTrees) {
                const parent = mirror.getNode(tree.value.parentId);
                if (!parent) {
                    this.debug('Drop resolve tree since there is no parent for the root node.', tree);
                }
                else {
                    iterateResolveTree(tree, (mutation) => {
                        appendNode(mutation);
                    });
                }
            }
        }
        if (Object.keys(legacy_missingNodeMap).length) {
            Object.assign(this.legacy_missingNodeRetryMap, legacy_missingNodeMap);
        }
        uniqueTextMutations(d.texts).forEach((mutation) => {
            var _a;
            const target = mirror.getNode(mutation.id);
            if (!target) {
                if (d.removes.find((r) => r.id === mutation.id)) {
                    return;
                }
                return this.warnNodeNotFound(d, mutation.id);
            }
            target.textContent = mutation.value;
            if (this.usingVirtualDom) {
                const parent = target.parentNode;
                if (((_a = parent === null || parent === void 0 ? void 0 : parent.rules) === null || _a === void 0 ? void 0 : _a.length) > 0)
                    parent.rules = [];
            }
        });
        d.attributes.forEach((mutation) => {
            const target = mirror.getNode(mutation.id);
            if (!target) {
                if (d.removes.find((r) => r.id === mutation.id)) {
                    return;
                }
                return this.warnNodeNotFound(d, mutation.id);
            }
            for (const attributeName in mutation.attributes) {
                if (typeof attributeName === 'string') {
                    const value = mutation.attributes[attributeName];
                    if (value === null) {
                        target.removeAttribute(attributeName);
                    }
                    else if (typeof value === 'string') {
                        try {
                            if (attributeName === '_cssText' &&
                                (target.nodeName === 'LINK' || target.nodeName === 'STYLE')) {
                                try {
                                    const newSn = mirror.getMeta(target);
                                    Object.assign(newSn.attributes, mutation.attributes);
                                    const newNode = buildNodeWithSN(newSn, {
                                        doc: target.ownerDocument,
                                        mirror: mirror,
                                        skipChild: true,
                                        hackCss: true,
                                        cache: this.cache,
                                    });
                                    const siblingNode = target.nextSibling;
                                    const parentNode = target.parentNode;
                                    if (newNode && parentNode) {
                                        parentNode.removeChild(target);
                                        parentNode.insertBefore(newNode, siblingNode);
                                        mirror.replace(mutation.id, newNode);
                                        break;
                                    }
                                }
                                catch (e) {
                                }
                            }
                            target.setAttribute(attributeName, value);
                        }
                        catch (error) {
                            if (this.config.showWarning) {
                                console.warn('An error occurred may due to the checkout feature.', error);
                            }
                        }
                    }
                    else if (attributeName === 'style') {
                        const styleValues = value;
                        const targetEl = target;
                        for (const s in styleValues) {
                            if (styleValues[s] === false) {
                                targetEl.style.removeProperty(s);
                            }
                            else if (styleValues[s] instanceof Array) {
                                const svp = styleValues[s];
                                targetEl.style.setProperty(s, svp[0], svp[1]);
                            }
                            else {
                                const svs = styleValues[s];
                                targetEl.style.setProperty(s, svs);
                            }
                        }
                    }
                }
            }
        });
    }
    applyScroll(d, isSync) {
        var _a, _b;
        const target = this.mirror.getNode(d.id);
        if (!target) {
            return this.debugNodeNotFound(d, d.id);
        }
        const sn = this.mirror.getMeta(target);
        if (target === this.iframe.contentDocument) {
            (_a = this.iframe.contentWindow) === null || _a === void 0 ? void 0 : _a.scrollTo({
                top: d.y,
                left: d.x,
                behavior: isSync ? 'auto' : 'smooth',
            });
        }
        else if ((sn === null || sn === void 0 ? void 0 : sn.type) === NodeType.Document) {
            (_b = target.defaultView) === null || _b === void 0 ? void 0 : _b.scrollTo({
                top: d.y,
                left: d.x,
                behavior: isSync ? 'auto' : 'smooth',
            });
        }
        else {
            try {
                target.scrollTo({
                    top: d.y,
                    left: d.x,
                    behavior: isSync ? 'auto' : 'smooth',
                });
            }
            catch (error) {
            }
        }
    }
    applyInput(d) {
        const target = this.mirror.getNode(d.id);
        if (!target) {
            return this.debugNodeNotFound(d, d.id);
        }
        try {
            target.checked = d.isChecked;
            target.value = d.text;
        }
        catch (error) {
        }
    }
    applySelection(d) {
        try {
            const selectionSet = new Set();
            const ranges = d.ranges.map(({ start, startOffset, end, endOffset }) => {
                const startContainer = this.mirror.getNode(start);
                const endContainer = this.mirror.getNode(end);
                if (!startContainer || !endContainer)
                    return;
                const result = new Range();
                result.setStart(startContainer, startOffset);
                result.setEnd(endContainer, endOffset);
                const doc = startContainer.ownerDocument;
                const selection = doc === null || doc === void 0 ? void 0 : doc.getSelection();
                selection && selectionSet.add(selection);
                return {
                    range: result,
                    selection,
                };
            });
            selectionSet.forEach((s) => s.removeAllRanges());
            ranges.forEach((r) => { var _a; return r && ((_a = r.selection) === null || _a === void 0 ? void 0 : _a.addRange(r.range)); });
        }
        catch (error) {
        }
    }
    applyStyleSheetMutation(data) {
        var _a;
        let styleSheet = null;
        if (data.styleId)
            styleSheet = this.styleMirror.getStyle(data.styleId);
        else if (data.id)
            styleSheet =
                ((_a = this.mirror.getNode(data.id)) === null || _a === void 0 ? void 0 : _a.sheet) || null;
        if (!styleSheet)
            return;
        if (data.source === IncrementalSource.StyleSheetRule)
            this.applyStyleSheetRule(data, styleSheet);
        else if (data.source === IncrementalSource.StyleDeclaration)
            this.applyStyleDeclaration(data, styleSheet);
    }
    applyStyleSheetRule(data, styleSheet) {
        var _a, _b, _c, _d;
        (_a = data.adds) === null || _a === void 0 ? void 0 : _a.forEach(({ rule, index: nestedIndex }) => {
            try {
                if (Array.isArray(nestedIndex)) {
                    const { positions, index } = getPositionsAndIndex(nestedIndex);
                    const nestedRule = getNestedRule(styleSheet.cssRules, positions);
                    nestedRule.insertRule(rule, index);
                }
                else {
                    const index = nestedIndex === undefined
                        ? undefined
                        : Math.min(nestedIndex, styleSheet.cssRules.length);
                    styleSheet === null || styleSheet === void 0 ? void 0 : styleSheet.insertRule(rule, index);
                }
            }
            catch (e) {
            }
        });
        (_b = data.removes) === null || _b === void 0 ? void 0 : _b.forEach(({ index: nestedIndex }) => {
            try {
                if (Array.isArray(nestedIndex)) {
                    const { positions, index } = getPositionsAndIndex(nestedIndex);
                    const nestedRule = getNestedRule(styleSheet.cssRules, positions);
                    nestedRule.deleteRule(index || 0);
                }
                else {
                    styleSheet === null || styleSheet === void 0 ? void 0 : styleSheet.deleteRule(nestedIndex);
                }
            }
            catch (e) {
            }
        });
        if (data.replace)
            try {
                void ((_c = styleSheet.replace) === null || _c === void 0 ? void 0 : _c.call(styleSheet, data.replace));
            }
            catch (e) {
            }
        if (data.replaceSync)
            try {
                (_d = styleSheet.replaceSync) === null || _d === void 0 ? void 0 : _d.call(styleSheet, data.replaceSync);
            }
            catch (e) {
            }
    }
    applyStyleDeclaration(data, styleSheet) {
        if (data.set) {
            const rule = getNestedRule(styleSheet.rules, data.index);
            rule.style.setProperty(data.set.property, data.set.value, data.set.priority);
        }
        if (data.remove) {
            const rule = getNestedRule(styleSheet.rules, data.index);
            rule.style.removeProperty(data.remove.property);
        }
    }
    applyAdoptedStyleSheet(data) {
        var _a;
        const targetHost = this.mirror.getNode(data.id);
        if (!targetHost)
            return;
        (_a = data.styles) === null || _a === void 0 ? void 0 : _a.forEach((style) => {
            var _a;
            let newStyleSheet = null;
            let hostWindow = null;
            if (hasShadowRoot(targetHost))
                hostWindow = ((_a = targetHost.ownerDocument) === null || _a === void 0 ? void 0 : _a.defaultView) || null;
            else if (targetHost.nodeName === '#document')
                hostWindow = targetHost.defaultView;
            if (!hostWindow)
                return;
            try {
                newStyleSheet = new hostWindow.CSSStyleSheet();
                this.styleMirror.add(newStyleSheet, style.styleId);
                this.applyStyleSheetRule({
                    source: IncrementalSource.StyleSheetRule,
                    adds: style.rules,
                }, newStyleSheet);
            }
            catch (e) {
            }
        });
        const MAX_RETRY_TIME = 10;
        let count = 0;
        const adoptStyleSheets = (targetHost, styleIds) => {
            const stylesToAdopt = styleIds
                .map((styleId) => this.styleMirror.getStyle(styleId))
                .filter((style) => style !== null);
            if (hasShadowRoot(targetHost))
                targetHost.shadowRoot.adoptedStyleSheets = stylesToAdopt;
            else if (targetHost.nodeName === '#document')
                targetHost.adoptedStyleSheets = stylesToAdopt;
            if (stylesToAdopt.length !== styleIds.length && count < MAX_RETRY_TIME) {
                setTimeout(() => adoptStyleSheets(targetHost, styleIds), 0 + 100 * count);
                count++;
            }
        };
        adoptStyleSheets(targetHost, data.styleIds);
    }
    legacy_resolveMissingNode(map, parent, target, targetMutation) {
        const { previousId, nextId } = targetMutation;
        const previousInMap = previousId && map[previousId];
        const nextInMap = nextId && map[nextId];
        if (previousInMap) {
            const { node, mutation } = previousInMap;
            parent.insertBefore(node, target);
            delete map[mutation.node.id];
            delete this.legacy_missingNodeRetryMap[mutation.node.id];
            if (mutation.previousId || mutation.nextId) {
                this.legacy_resolveMissingNode(map, parent, node, mutation);
            }
        }
        if (nextInMap) {
            const { node, mutation } = nextInMap;
            parent.insertBefore(node, target.nextSibling);
            delete map[mutation.node.id];
            delete this.legacy_missingNodeRetryMap[mutation.node.id];
            if (mutation.previousId || mutation.nextId) {
                this.legacy_resolveMissingNode(map, parent, node, mutation);
            }
        }
    }
    moveAndHover(x, y, id, isSync, debugData) {
        const target = this.mirror.getNode(id);
        if (!target) {
            return this.debugNodeNotFound(debugData, id);
        }
        const base = getBaseDimension(target, this.iframe);
        const _x = x * base.absoluteScale + base.x;
        const _y = y * base.absoluteScale + base.y;
        this.mouse.style.left = `${_x}px`;
        this.mouse.style.top = `${_y}px`;
        if (!isSync) {
            this.drawMouseTail({ x: _x, y: _y });
        }
        this.hoverElements(target);
    }
    drawMouseTail(position) {
        if (!this.mouseTail) {
            return;
        }
        const { lineCap, lineWidth, strokeStyle, duration } = this.config.mouseTail === true
            ? defaultMouseTailConfig
            : Object.assign({}, defaultMouseTailConfig, this.config.mouseTail);
        const draw = () => {
            if (!this.mouseTail) {
                return;
            }
            const ctx = this.mouseTail.getContext('2d');
            if (!ctx || !this.tailPositions.length) {
                return;
            }
            ctx.clearRect(0, 0, this.mouseTail.width, this.mouseTail.height);
            ctx.beginPath();
            ctx.lineWidth = lineWidth;
            ctx.lineCap = lineCap;
            ctx.strokeStyle = strokeStyle;
            ctx.moveTo(this.tailPositions[0].x, this.tailPositions[0].y);
            this.tailPositions.forEach((p) => ctx.lineTo(p.x, p.y));
            ctx.stroke();
        };
        this.tailPositions.push(position);
        draw();
        setTimeout(() => {
            this.tailPositions = this.tailPositions.filter((p) => p !== position);
            draw();
        }, duration / this.speedService.state.context.timer.speed);
    }
    hoverElements(el) {
        var _a;
        (_a = this.iframe.contentDocument) === null || _a === void 0 ? void 0 : _a.querySelectorAll('.\\:hover').forEach((hoveredEl) => {
            hoveredEl.classList.remove(':hover');
        });
        let currentEl = el;
        while (currentEl) {
            if (currentEl.classList) {
                currentEl.classList.add(':hover');
            }
            currentEl = currentEl.parentElement;
        }
    }
    isUserInteraction(event) {
        if (event.type !== EventType.IncrementalSnapshot) {
            return false;
        }
        return (event.data.source > IncrementalSource.Mutation &&
            event.data.source <= IncrementalSource.Input);
    }
    backToNormal() {
        this.nextUserInteractionEvent = null;
        if (this.speedService.state.matches('normal')) {
            return;
        }
        this.speedService.send({ type: 'BACK_TO_NORMAL' });
        this.emitter.emit(ReplayerEvents.SkipEnd, {
            speed: this.speedService.state.context.normalSpeed,
        });
    }
    warnNodeNotFound(d, id) {
        this.warn(`Node with id '${id}' not found. `, d);
    }
    warnCanvasMutationFailed(d, error) {
        this.warn(`Has error on canvas update`, error, 'canvas mutation:', d);
    }
    debugNodeNotFound(d, id) {
        this.debug(REPLAY_CONSOLE_PREFIX, `Node with id '${id}' not found. `, d);
    }
    warn(...args) {
        if (!this.config.showWarning) {
            return;
        }
        console.warn(REPLAY_CONSOLE_PREFIX, ...args);
    }
    debug(...args) {
        if (!this.config.showDebug) {
            return;
        }
        console.log(REPLAY_CONSOLE_PREFIX, ...args);
    }
}

export { Replayer };
