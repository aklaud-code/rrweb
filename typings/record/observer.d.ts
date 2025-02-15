import type { observerParam, MutationBufferParam } from '../types';
import { listenerHandler, hooksParam } from '@rrweb/types';
import MutationBuffer from './mutation';
export declare const mutationBuffers: MutationBuffer[];
export declare function initMutationObserver(options: MutationBufferParam, rootEl: Node): MutationObserver;
export declare function initScrollObserver({ scrollCb, doc, mirror, blockClass, blockSelector, sampling, }: Pick<observerParam, 'scrollCb' | 'doc' | 'mirror' | 'blockClass' | 'blockSelector' | 'sampling'>): listenerHandler;
export declare const INPUT_TAGS: string[];
export declare function initAdoptedStyleSheetObserver({ mirror, stylesheetManager, }: Pick<observerParam, 'mirror' | 'stylesheetManager'>, host: Document | ShadowRoot): listenerHandler;
export declare function initObservers(o: observerParam, hooks?: hooksParam): listenerHandler;
