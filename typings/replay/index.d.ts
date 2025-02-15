import { Mirror } from 'rrweb-snapshot';
import { RRDocument } from 'rrdom';
import { Timer } from './timer';
import { createPlayerService, createSpeedService } from './machine';
import type { playerConfig } from '../types';
import { eventWithTime, playerMetaData, Handler } from '@rrweb/types';
import './styles/style.css';
export declare class Replayer {
    wrapper: HTMLDivElement;
    iframe: HTMLIFrameElement;
    service: ReturnType<typeof createPlayerService>;
    speedService: ReturnType<typeof createSpeedService>;
    get timer(): Timer;
    config: playerConfig;
    usingVirtualDom: boolean;
    virtualDom: RRDocument;
    private mouse;
    private mouseTail;
    private tailPositions;
    private emitter;
    private nextUserInteractionEvent;
    private legacy_missingNodeRetryMap;
    private cache;
    private imageMap;
    private canvasEventMap;
    private mirror;
    private styleMirror;
    private firstFullSnapshot;
    private newDocumentQueue;
    private mousePos;
    private touchActive;
    private lastSelectionData;
    private constructedStyleMutations;
    private adoptedStyleSheets;
    constructor(events: Array<eventWithTime | string>, config?: Partial<playerConfig>);
    on(event: string, handler: Handler): this;
    off(event: string, handler: Handler): this;
    setConfig(config: Partial<playerConfig>): void;
    getMetaData(): playerMetaData;
    getCurrentTime(): number;
    getTimeOffset(): number;
    getMirror(): Mirror;
    play(timeOffset?: number): void;
    pause(timeOffset?: number): void;
    resume(timeOffset?: number): void;
    destroy(): void;
    startLive(baselineTime?: number): void;
    addEvent(rawEvent: eventWithTime | string): void;
    enableInteract(): void;
    disableInteract(): void;
    resetCache(): void;
    private setupDom;
    private handleResize;
    private applyEventsSynchronously;
    private getCastFn;
    private rebuildFullSnapshot;
    private insertStyleRules;
    private attachDocumentToIframe;
    private collectIframeAndAttachDocument;
    private waitForStylesheetLoad;
    private preloadAllImages;
    private preloadImages;
    private deserializeAndPreloadCanvasEvents;
    private applyIncremental;
    private applyMutation;
    private applyScroll;
    private applyInput;
    private applySelection;
    private applyStyleSheetMutation;
    private applyStyleSheetRule;
    private applyStyleDeclaration;
    private applyAdoptedStyleSheet;
    private legacy_resolveMissingNode;
    private moveAndHover;
    private drawMouseTail;
    private hoverElements;
    private isUserInteraction;
    private backToNormal;
    private warnNodeNotFound;
    private warnCanvasMutationFailed;
    private debugNodeNotFound;
    private warn;
    private debug;
}
